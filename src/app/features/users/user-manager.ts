import {
  afterRenderEffect,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { ConnectionProfile } from '../../../../shared/models';
import {
  diffPrivileges,
  MSSQL_COMMON_ROLES,
  privilegeOptions,
  quickSets,
  scopeLevel,
  userChangeSql,
  userLabel,
  type DbRoleRef,
  type DbUserRef,
  type DbUserSummary,
  type PrivilegeScope,
  type UserChange,
  type UserDetails,
  type UserDialect,
} from '../../../../shared/user-sql';
import { ConfirmDangerStore } from '../../core/confirm-danger/confirm-danger';
import { DB_API } from '../../core/db-api';
import { ConnectionsStore } from '../connections/connections.store';
import { SchemaStore } from '../schema/schema.store';

type Load<T> =
  { status: 'loading' } | { status: 'loaded'; data: T } | { status: 'error'; message: string };

const scopeKey = (s: PrivilegeScope) => `${s.database ?? ''}\u0001${s.table ?? ''}`;
const roleKey = (r: DbRoleRef) => `${r.server ? 's' : 'd'}\u0001${r.name}`;
const sameUser = (a: DbUserRef | null, b: DbUserRef | null) =>
  !!a && !!b && a.name === b.name && (a.host ?? '') === (b.host ?? '');

/** A strong random password: 20 letters, digits and a few signs that need no quoting anywhere. */
export function generatePassword(length = 20): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%*-_+';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/**
 * Users of a database server, like HeidiSQL's user manager: the users on the left; on the right
 * the privileges per server, database and table as checkboxes, roles, password and delete. Every
 * change shows its SQL before it runs.
 */
@Component({
  selector: 'app-user-manager',
  templateUrl: './user-manager.html',
})
export class UserManager {
  readonly connectionId = input.required<string>();

  private readonly api = inject(DB_API);
  private readonly connections = inject(ConnectionsStore);
  protected readonly schema = inject(SchemaStore);
  private readonly danger = inject(ConfirmDangerStore);

  protected readonly profile = computed<ConnectionProfile | undefined>(() =>
    this.connections.connections().find((c) => c.id === this.connectionId()),
  );
  protected readonly dialect = computed<UserDialect>(() => {
    const t = this.profile()?.type;
    return t === 'postgres' || t === 'mssql' ? t : 'mysql';
  });
  protected readonly readOnly = computed(() => this.profile()?.readOnly ?? false);
  /** "database" in MySQL, "schema" where the tree shows schemas. */
  protected readonly containerWord = computed(() =>
    this.dialect() === 'mysql' ? 'database' : 'schema',
  );

  protected readonly users = signal<Load<DbUserSummary[]>>({ status: 'loading' });
  protected readonly find = signal('');
  protected readonly shown = computed(() => {
    const u = this.users();
    if (u.status !== 'loaded') return [];
    const q = this.find().trim().toLowerCase();
    return q ? u.data.filter((x) => userLabel(x).toLowerCase().includes(q)) : u.data;
  });
  protected readonly selected = signal<DbUserRef | null>(null);
  protected readonly details = signal<Load<UserDetails> | null>(null);

  // ── Edits, until saved ─────────────────────────────────────────────
  /** Privileges as ticked now, per scope (only scopes that were touched or added). */
  protected readonly ticked = signal<Map<string, { scope: PrivilegeScope; privileges: string[] }>>(
    new Map(),
  );
  protected readonly roleTicks = signal<Map<string, boolean>>(new Map());

  /** Every scope shown: the user's grants, then scopes added in this session. */
  protected readonly scopes = computed(() => {
    const d = this.details();
    const grants = d?.status === 'loaded' ? d.data.grants : [];
    const out = new Map<string, { scope: PrivilegeScope; before: string[]; after: string[] }>();
    // The server row first (MySQL privileges, PostgreSQL role attributes), always shown.
    if (this.dialect() !== 'mssql') out.set(scopeKey({}), { scope: {}, before: [], after: [] });
    for (const g of grants)
      out.set(scopeKey(g.scope), { scope: g.scope, before: g.privileges, after: g.privileges });
    for (const [key, t] of this.ticked()) {
      const e = out.get(key);
      out.set(key, { scope: t.scope, before: e?.before ?? [], after: t.privileges });
    }
    return [...out.values()].sort((a, b) => {
      const la = ['server', 'database', 'table'].indexOf(scopeLevel(a.scope));
      const lb = ['server', 'database', 'table'].indexOf(scopeLevel(b.scope));
      return (
        la - lb ||
        (a.scope.database ?? '').localeCompare(b.scope.database ?? '') ||
        (a.scope.table ?? '').localeCompare(b.scope.table ?? '')
      );
    });
  });

  protected readonly roles = computed(() => {
    const d = this.details();
    if (d?.status !== 'loaded') return [];
    const member = new Set(d.data.roles.map(roleKey));
    const all = [...d.data.availableRoles];
    for (const r of d.data.roles) if (!all.some((x) => roleKey(x) === roleKey(r))) all.push(r);
    const ticks = this.roleTicks();
    return all.map((role) => ({
      role,
      before: member.has(roleKey(role)),
      after: ticks.get(roleKey(role)) ?? member.has(roleKey(role)),
      common: !role.server && MSSQL_COMMON_ROLES.includes(role.name),
    }));
  });

  /** The changes the edits add up to, in the order they run. */
  protected readonly changes = computed<UserChange[]>(() => {
    const user = this.selected();
    if (!user) return [];
    const out: UserChange[] = [];
    for (const s of this.scopes()) out.push(...diffPrivileges(s.scope, s.before, s.after, user));
    for (const r of this.roles())
      if (r.before !== r.after) out.push({ action: 'role', user, role: r.role, member: r.after });
    return out;
  });

  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);
  protected readonly busy = signal(false);

  // ── Dialogs: new user, password, the SQL before saving ─────────────
  protected readonly form = signal<
    | { kind: 'create'; name: string; host: string; password: string; show: boolean }
    | { kind: 'password'; password: string; show: boolean }
    | null
  >(null);
  protected readonly preview = signal<{
    title: string;
    changes: UserChange[];
    after?: DbUserRef;
  } | null>(null);
  private readonly formDialog = viewChild<ElementRef<HTMLDialogElement>>('formDialog');
  private readonly previewDialog = viewChild<ElementRef<HTMLDialogElement>>('previewDialog');

  /** Add privileges on: the database (and table) chosen. */
  protected readonly addDb = signal('');
  protected readonly addTable = signal('');
  protected readonly databases = computed(() => {
    const d = this.schema.databases(this.connectionId());
    return d?.status === 'loaded' ? d.data.filter((x) => !x.system).map((x) => x.name) : [];
  });
  protected readonly tablesOfAddDb = computed(() => {
    const db = this.addDb();
    const o = db ? this.schema.objects(this.connectionId(), db) : undefined;
    return o?.status === 'loaded'
      ? o.data.filter((x) => x.kind === 'table' || x.kind === 'view').map((x) => x.name)
      : [];
  });

  constructor() {
    effect(() => {
      const id = this.connectionId();
      untracked(() => {
        void this.loadUsers();
        if (!this.schema.databases(id)) void this.schema.loadDatabases(id);
      });
    });
    effect(() => {
      const db = this.addDb();
      const id = this.connectionId();
      if (db) untracked(() => !this.schema.objects(id, db) && void this.schema.loadObjects(id, db));
    });
    afterRenderEffect(() => {
      const f = this.formDialog()?.nativeElement;
      if (f && !f.open) {
        f.showModal();
        f.querySelector<HTMLInputElement>('input')?.focus();
      }
      const p = this.previewDialog()?.nativeElement;
      if (p && !p.open) p.showModal();
    });
  }

  protected label = userLabel;
  protected newPassword = () => generatePassword();

  protected scopeLabel(scope: PrivilegeScope): string {
    if (scope.table) return `${scope.database}.${scope.table}`;
    if (scope.database) return scope.database;
    return this.dialect() === 'postgres' ? 'Rol (hele server)' : 'Hele server';
  }

  protected options(scope: PrivilegeScope): string[] {
    return privilegeOptions(this.dialect(), scopeLevel(scope));
  }

  protected sets(scope: PrivilegeScope) {
    return quickSets(this.dialect(), scopeLevel(scope));
  }

  async loadUsers(): Promise<void> {
    this.users.set({ status: 'loading' });
    const r = await this.api.listUsers(this.connectionId());
    if (!r.ok) {
      this.users.set({
        status: 'error',
        message: r.error.hint ? `${r.error.message} ${r.error.hint}` : r.error.message,
      });
      return;
    }
    this.users.set({ status: 'loaded', data: r.data });
    const sel = this.selected();
    const keep = sel && r.data.find((u) => sameUser(u, sel));
    if (keep) void this.select(keep, true);
    else if (r.data[0]) void this.select(r.data[0], true);
    else this.selected.set(null);
  }

  async select(user: DbUserRef, force = false): Promise<void> {
    if (!force && sameUser(user, this.selected())) return;
    if (
      this.changes().length &&
      !confirm('Je wijzigingen voor deze gebruiker zijn nog niet opgeslagen. Weggooien?')
    )
      return;
    this.selected.set({ name: user.name, ...(user.host !== undefined && { host: user.host }) });
    this.resetEdits();
    this.details.set({ status: 'loading' });
    const r = await this.api.userDetails(this.connectionId(), this.selected()!);
    if (!sameUser(user, this.selected())) return;
    this.details.set(
      r.ok
        ? { status: 'loaded', data: r.data }
        : {
            status: 'error',
            message: r.error.hint ? `${r.error.message} ${r.error.hint}` : r.error.message,
          },
    );
  }

  private resetEdits(): void {
    this.ticked.set(new Map());
    this.roleTicks.set(new Map());
    this.error.set(null);
  }

  protected toggle(scope: PrivilegeScope, privilege: string, on: boolean): void {
    // What is ticked now (not what the template last drew: two quick clicks both count).
    const current = this.scopes().find((s) => scopeKey(s.scope) === scopeKey(scope))?.after ?? [];
    const next = on
      ? [...new Set([...current, privilege])]
      : current.filter((p) => p !== privilege);
    this.setTicks(scope, next);
  }

  protected setTicks(scope: PrivilegeScope, privileges: string[]): void {
    const order = this.options(scope);
    const sorted = [...privileges].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    this.ticked.update((m) => new Map(m).set(scopeKey(scope), { scope, privileges: sorted }));
  }

  protected toggleRole(role: DbRoleRef, on: boolean): void {
    this.roleTicks.update((m) => new Map(m).set(roleKey(role), on));
  }

  protected addScope(): void {
    const database = this.addDb();
    if (!database) return;
    const table = this.addTable();
    const scope: PrivilegeScope = table ? { database, table } : { database };
    if (!this.scopes().some((s) => scopeKey(s.scope) === scopeKey(scope))) this.setTicks(scope, []);
    this.addDb.set('');
    this.addTable.set('');
  }

  protected discard(): void {
    this.resetEdits();
  }

  // ── Saving: the SQL first ──────────────────────────────────────────
  protected sqlOf(changes: UserChange[]): string {
    return changes.map((c) => userChangeSql(this.dialect(), c)).join('\n');
  }

  protected review(): void {
    const user = this.selected();
    if (!user || !this.changes().length) return;
    this.preview.set({ title: `Rechten van ${userLabel(user)} opslaan`, changes: this.changes() });
  }

  protected async runPreview(): Promise<void> {
    const p = this.preview();
    if (!p) return;
    this.busy.set(true);
    this.error.set(null);
    const r = await this.api.applyUserChanges(this.connectionId(), p.changes);
    this.busy.set(false);
    if (!r.ok) {
      this.error.set(r.error.hint ? `${r.error.message} ${r.error.hint}` : r.error.message);
      return;
    }
    this.closePreview();
    this.note.set('Opgeslagen.');
    setTimeout(() => this.note.set(null), 3000);
    if (p.after) this.selected.set(p.after);
    this.resetEdits();
    await this.loadUsers();
  }

  protected closePreview(): void {
    this.previewDialog()?.nativeElement.close();
    this.preview.set(null);
  }

  // ── New user, password, delete ─────────────────────────────────────
  protected newUser(): void {
    this.form.set({
      kind: 'create',
      name: '',
      host: '%',
      password: generatePassword(),
      show: true,
    });
  }

  protected changePassword(): void {
    this.form.set({ kind: 'password', password: generatePassword(), show: true });
  }

  protected updateForm(
    patch: Partial<{ name: string; host: string; password: string; show: boolean }>,
  ): void {
    const f = this.form();
    if (f) this.form.set({ ...f, ...patch } as typeof f);
  }

  protected submitForm(): void {
    const f = this.form();
    if (!f || !f.password) return;
    if (f.kind === 'create') {
      const name = f.name.trim();
      if (!name) return;
      const user: DbUserRef =
        this.dialect() === 'mysql' ? { name, host: f.host.trim() || '%' } : { name };
      this.closeForm();
      this.preview.set({
        title: `Gebruiker ${userLabel(user)} aanmaken`,
        changes: [{ action: 'create', user, password: f.password }],
        after: user,
      });
      void navigator.clipboard?.writeText(f.password).catch(() => undefined);
    } else {
      const user = this.selected();
      if (!user) return;
      this.closeForm();
      this.preview.set({
        title: `Wachtwoord van ${userLabel(user)} wijzigen`,
        changes: [{ action: 'password', user, password: f.password }],
      });
      void navigator.clipboard?.writeText(f.password).catch(() => undefined);
    }
  }

  protected closeForm(): void {
    this.formDialog()?.nativeElement.close();
    this.form.set(null);
  }

  protected async remove(): Promise<void> {
    const user = this.selected();
    if (!user) return;
    const change: UserChange = { action: 'drop', user };
    const ok = await this.danger.ask({
      title: `Gebruiker ${userLabel(user)} verwijderen`,
      message:
        this.dialect() === 'postgres'
          ? 'De rol verdwijnt. Wat hij in deze database bezit, gaat naar jouw login; zijn rechten worden ingetrokken.'
          : 'De gebruiker kan daarna niet meer inloggen. Dit kan niet ongedaan worden gemaakt.',
      sql: userChangeSql(this.dialect(), change),
      name: user.name,
      confirm: 'Gebruiker verwijderen',
      run: () => this.api.applyUserChanges(this.connectionId(), [change]),
    });
    if (ok) {
      this.selected.set(null);
      await this.loadUsers();
    }
  }

  /** SQL Server: a login without a user in this database gets one. */
  protected mapUser(): void {
    const user = this.selected();
    if (!user) return;
    this.preview.set({
      title: `${user.name} toegang geven tot deze database`,
      changes: [{ action: 'map', user }],
    });
  }
}
