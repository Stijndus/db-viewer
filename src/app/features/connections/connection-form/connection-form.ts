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
  type SshAuth,
  type SshSettings,
  type DbError,
  type TestResult,
} from '../../../../../shared/models';
import { DB_API } from '../../../core/db-api';
import { ConnectionsStore, isHostKeyError } from '../connections.store';

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
  protected readonly showSshSecret = signal(false);
  /** Trusted fingerprint of the SSH server; set by "Test verbinding" or from the profile. */
  protected readonly hostKey = signal('');
  protected readonly isWindows = /win/i.test(navigator.platform);
  protected readonly sshAuths: { value: SshAuth; label: string }[] = [
    { value: 'password', label: 'Wachtwoord' },
    { value: 'key', label: 'Sleutelbestand' },
    { value: 'agent', label: 'SSH-agent' },
    ...(this.isWindows ? [{ value: 'pageant' as const, label: 'Pageant' }] : []),
  ];
  protected readonly colors: { value: ConnectionColor; label: string }[] = [
    { value: 'green', label: 'Groen' },
    { value: 'orange', label: 'Oranje' },
    { value: 'red', label: 'Rood' },
    { value: 'blue', label: 'Blauw' },
    { value: 'purple', label: 'Paars' },
    { value: 'pink', label: 'Roze' },
    { value: 'yellow', label: 'Geel' },
    { value: 'teal', label: 'Turquoise' },
    { value: 'brown', label: 'Bruin' },
    { value: 'gray', label: 'Grijs' },
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
    sshEnabled: [false],
    sshHost: ['', [Validators.required, Validators.maxLength(255)]],
    sshPort: [22, [Validators.required, Validators.min(1), Validators.max(65535)]],
    sshUser: ['', [Validators.required, Validators.maxLength(255)]],
    sshAuth: ['password' as SshAuth],
    sshKeyFile: ['', [Validators.required, Validators.maxLength(4096)]],
    sshSecret: [''],
  });

  protected readonly sshEnabled = signal(false);
  protected readonly sshAuth = signal<SshAuth>('password');

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
    this.form.controls.sshEnabled.valueChanges.subscribe((on) => {
      this.sshEnabled.set(on);
      if (on && !this.form.controls.sshHost.value) {
        // Typical setup: the database host was the remote machine, which is now the SSH host.
        const host = this.form.controls.host.value;
        if (host && host !== 'localhost' && host !== '127.0.0.1') {
          this.form.controls.sshHost.setValue(host);
          this.form.controls.host.setValue('localhost');
        }
      }
      this.applySsh();
    });
    this.form.controls.sshAuth.valueChanges.subscribe((auth) => {
      this.sshAuth.set(auth);
      this.applySsh();
    });
    // A different SSH server must be confirmed again.
    this.form.controls.sshHost.valueChanges.subscribe(() => this.hostKey.set(''));
    this.form.controls.sshPort.valueChanges.subscribe(() => this.hostKey.set(''));
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
        if (p.ssh) {
          this.form.patchValue({
            sshEnabled: true,
            sshHost: p.ssh.host,
            sshPort: p.ssh.port,
            sshUser: p.ssh.user,
            sshAuth: p.ssh.auth,
            sshKeyFile: p.ssh.keyFile,
          });
          this.hostKey.set(p.ssh.hostKey);
        }
      }
      this.applySsh();
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

  /** SSH fields only count when the tunnel is on; the key file only for key login. */
  private applySsh(): void {
    const c = this.form.controls;
    const on = this.sshEnabled() && this.type() !== 'sqlite';
    for (const ctrl of [c.sshHost, c.sshPort, c.sshUser, c.sshAuth, c.sshSecret]) {
      if (on) ctrl.enable({ emitEvent: false });
      else ctrl.disable({ emitEvent: false });
    }
    if (on && this.sshAuth() === 'key') c.sshKeyFile.enable({ emitEvent: false });
    else c.sshKeyFile.disable({ emitEvent: false });
    if (on && (this.sshAuth() === 'agent' || this.sshAuth() === 'pageant'))
      c.sshSecret.disable({ emitEvent: false });
  }

  protected sshSecretLabel(): string {
    return this.sshAuth() === 'key'
      ? 'Wachtwoordzin (als de sleutel er een heeft)'
      : 'SSH-wachtwoord';
  }

  protected async browseKey(): Promise<void> {
    const result = await this.api.pickKeyFile(this.form.controls.sshKeyFile.value || undefined);
    if (result.ok && result.data) {
      this.form.controls.sshKeyFile.setValue(result.data);
      this.form.controls.sshKeyFile.markAsDirty();
    }
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
    this.applySsh();
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
    let result = await this.store.test(this.value(), this.profile()?.id);
    if (!result.ok && isHostKeyError(result.error)) {
      const trust = await this.store.confirmHostKey(this.form.controls.sshHost.value, result.error);
      if (trust) {
        this.hostKey.set(result.error.fingerprint!);
        result = await this.store.test(this.value(), this.profile()?.id);
      }
    }
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
    const keep = this.form.controls.savePassword.value;
    const v = this.form.getRawValue();
    const secrets = {
      ...(!keep && v.password && { password: v.password }),
      ...(!keep && v.sshEnabled && v.sshSecret && { sshSecret: v.sshSecret }),
    };
    this.close();
    if (connectAfter) await this.store.connect(result.data.id, secrets);
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
    const { sshEnabled, sshHost, sshPort, sshUser, sshAuth, sshKeyFile, sshSecret, ...v } =
      this.form.getRawValue();
    const type = this.type();
    const ssh: SshSettings | null =
      sshEnabled && type !== 'sqlite'
        ? {
            host: sshHost.trim(),
            port: Number(sshPort),
            user: sshUser.trim(),
            auth: sshAuth,
            keyFile: sshAuth === 'key' ? sshKeyFile.trim() : '',
            hostKey: this.hostKey(),
          }
        : null;
    const sshPart = {
      ssh,
      sshSecret: ssh && (sshAuth === 'password' || sshAuth === 'key') ? sshSecret : '',
    };
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
        ssh: null,
        sshSecret: '',
      };
    }
    return {
      ...v,
      ...sshPart,
      type,
      port: Number(v.port),
      allowSelfSigned: v.ssl && v.allowSelfSigned,
      savePassword: this.form.controls.savePassword.enabled && v.savePassword,
    };
  }
}
