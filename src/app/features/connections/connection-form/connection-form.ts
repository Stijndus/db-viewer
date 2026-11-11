import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { DIALECTS, SERVER_DEFAULTS } from '../../../../../shared/dialect';
import {
  DEFAULT_PORTS,
  type DbType,
  type ConnectionColor,
  type ConnectionInput,
  type ConnectionProfile,
  type DbError,
  type TestResult,
} from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { ConnectionsStore } from '../connections.store';

type Feedback = { kind: 'ok'; result: TestResult } | { kind: 'error'; error: DbError } | null;

/** Modal dialog to create or edit a connection, with "Test verbinding". */
@Component({
  selector: 'app-connection-form',
  imports: [ReactiveFormsModule],
  templateUrl: './connection-form.html',
})
export class ConnectionForm {
  /** The profile being edited, or null for a new connection. */
  readonly profile = input<ConnectionProfile | null>(null);
  readonly closed = output<void>();

  private readonly store = inject(ConnectionsStore);
  private readonly api = inject(DB_API);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly encryptionAvailable = this.store.encryptionAvailable;
  protected readonly busy = signal<'test' | 'save' | 'delete' | null>(null);
  protected readonly feedback = signal<Feedback>(null);
  protected readonly showPassword = signal(false);
  protected readonly type = signal<DbType>('mysql');
  protected readonly types: { value: DbType; label: string }[] = [
    { value: 'mysql', label: 'MySQL / MariaDB' },
    { value: 'postgres', label: DIALECTS.postgres.label },
    { value: 'mssql', label: DIALECTS.mssql.label },
    { value: 'sqlite', label: DIALECTS.sqlite.label },
  ];
  protected readonly colors: { value: ConnectionColor; label: string }[] = [
    { value: 'green', label: 'Groen' },
    { value: 'orange', label: 'Oranje' },
    { value: 'red', label: 'Rood' },
    { value: 'blue', label: 'Blauw' },
  ];

  protected readonly form = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(100)]],
    host: ['localhost', [Validators.required, Validators.maxLength(255)]],
    port: [DEFAULT_PORTS.mysql, [Validators.required, Validators.min(1), Validators.max(65535)]],
    database: ['', Validators.maxLength(128)],
    user: ['root', [Validators.required, Validators.maxLength(255)]],
    password: [''],
    savePassword: [true],
    ssl: [false],
    allowSelfSigned: [{ value: false, disabled: true }],
    color: ['green' as ConnectionColor],
    readOnly: [false],
  });

  constructor() {
    this.form.controls.ssl.valueChanges.subscribe((on) => {
      const ctrl = this.form.controls.allowSelfSigned;
      if (on && this.type() !== 'sqlite') {
        ctrl.enable({ emitEvent: false });
      } else {
        ctrl.setValue(false, { emitEvent: false });
        ctrl.disable({ emitEvent: false });
      }
    });
    // Any change makes an earlier test result stale.
    this.form.valueChanges.subscribe(() => this.feedback.set(null));

    afterNextRender(() => {
      const p = this.profile();
      if (p) {
        this.form.patchValue({
          ...p,
          password: '',
          savePassword: p.hasPassword || this.encryptionAvailable(),
        });
      }
      this.applyType(p?.type ?? 'mysql');
      this.feedback.set(null);
      this.dialog().nativeElement.showModal();
    });
  }

  /**
   * Switching type: a port and user still at the old type's default follow the new one. SQLite
   * needs only a file; the server fields are disabled so they don't block saving.
   */
  protected setType(next: DbType): void {
    const prev = this.type();
    if (prev === next) return;
    const c = this.form.controls;
    if (next !== 'sqlite') {
      const before = prev === 'sqlite' ? null : SERVER_DEFAULTS[prev];
      const after = SERVER_DEFAULTS[next];
      if (!before || Number(c.port.value) === before.port || !c.port.value)
        c.port.setValue(after.port);
      if (!before || c.user.value === before.user || !c.user.value) c.user.setValue(after.user);
      if (!c.host.value) c.host.setValue('localhost');
    }
    if (prev === 'sqlite' || next === 'sqlite') c.database.setValue('');
    this.applyType(next);
  }

  private applyType(type: DbType): void {
    this.type.set(type);
    const c = this.form.controls;
    const server = [c.host, c.port, c.user, c.password, c.ssl] as const;
    if (type === 'sqlite') {
      for (const ctrl of server) ctrl.disable({ emitEvent: false });
      c.savePassword.disable({ emitEvent: false });
      c.allowSelfSigned.disable({ emitEvent: false });
      c.database.setValidators([Validators.required, Validators.maxLength(4096)]);
    } else {
      for (const ctrl of server) ctrl.enable({ emitEvent: false });
      if (this.encryptionAvailable()) c.savePassword.enable({ emitEvent: false });
      if (c.ssl.value) c.allowSelfSigned.enable({ emitEvent: false });
      c.database.setValidators([Validators.maxLength(128)]);
    }
    if (!this.encryptionAvailable()) {
      c.savePassword.setValue(false, { emitEvent: false });
      c.savePassword.disable({ emitEvent: false });
    }
    c.database.updateValueAndValidity();
  }

  protected async browse(): Promise<void> {
    const result = await this.api.pickDatabaseFile(this.form.controls.database.value || undefined);
    if (result.ok && result.data) {
      this.form.controls.database.setValue(result.data);
      this.form.controls.database.markAsDirty();
      if (!this.form.controls.name.value) {
        const file = result.data.split(/[\\/]/).pop() ?? '';
        this.form.controls.name.setValue(file.replace(/\.(db|sqlite3?|db3|s3db)$/i, ''));
      }
    }
  }

  protected databaseHint(): string {
    switch (this.type()) {
      case 'postgres':
        return 'standaard postgres';
      case 'mssql':
        return 'standaard master';
      default:
        return 'optioneel';
    }
  }

  protected get isEdit(): boolean {
    return this.profile() !== null;
  }

  protected async test(): Promise<void> {
    if (!this.validate()) return;
    this.busy.set('test');
    const result = await this.store.test(this.value(), this.profile()?.id);
    this.busy.set(null);
    this.feedback.set(
      result.ok ? { kind: 'ok', result: result.data } : { kind: 'error', error: result.error },
    );
  }

  protected async save(connectAfter: boolean): Promise<void> {
    if (!this.validate()) return;
    this.busy.set('save');
    const result = await this.store.save(this.value(), this.profile()?.id);
    this.busy.set(null);
    if (!result.ok) {
      this.feedback.set({ kind: 'error', error: result.error });
      return;
    }
    const password = this.form.controls.savePassword.value
      ? undefined
      : this.form.controls.password.value;
    this.close();
    if (connectAfter) await this.store.connect(result.data.id, password || undefined);
  }

  protected async remove(): Promise<void> {
    const p = this.profile();
    if (!p || !confirm(`Verbinding "${p.name}" verwijderen? Dit kan niet ongedaan worden gemaakt.`))
      return;
    this.busy.set('delete');
    const result = await this.store.remove(p.id);
    this.busy.set(null);
    if (result.ok) this.close();
    else this.feedback.set({ kind: 'error', error: result.error });
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /** Native <dialog> fires `close` for Escape, the X button and programmatic close alike. */
  protected onDialogClose(): void {
    this.closed.emit();
  }

  protected invalid(name: keyof typeof this.form.controls): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.touched || c.dirty);
  }

  private validate(): boolean {
    this.form.markAllAsTouched();
    return this.form.valid;
  }

  private value(): ConnectionInput {
    const v = this.form.getRawValue();
    const type = this.type();
    if (type === 'sqlite') {
      return {
        ...v,
        type,
        host: '',
        port: 0,
        user: '',
        password: '',
        savePassword: false,
        ssl: false,
        allowSelfSigned: false,
      };
    }
    return {
      ...v,
      type,
      port: Number(v.port),
      allowSelfSigned: v.ssl && v.allowSelfSigned,
      savePassword: this.form.controls.savePassword.enabled && v.savePassword,
    };
  }
}
