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
import {
  DEFAULT_PORTS,
  type ConnectionColor,
  type ConnectionInput,
  type ConnectionProfile,
  type DbError,
  type TestResult,
} from '../../../../../shared/models';
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
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly encryptionAvailable = this.store.encryptionAvailable;
  protected readonly busy = signal<'test' | 'save' | 'delete' | null>(null);
  protected readonly feedback = signal<Feedback>(null);
  protected readonly showPassword = signal(false);
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
    database: ['', Validators.maxLength(64)],
    user: ['root', [Validators.required, Validators.maxLength(255)]],
    password: [''],
    savePassword: [true],
    ssl: [false],
    allowSelfSigned: [{ value: false, disabled: true }],
    color: ['green' as ConnectionColor],
  });

  constructor() {
    this.form.controls.ssl.valueChanges.subscribe((on) => {
      const ctrl = this.form.controls.allowSelfSigned;
      if (on) {
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
      if (!this.encryptionAvailable()) {
        this.form.controls.savePassword.setValue(false);
        this.form.controls.savePassword.disable();
      }
      this.feedback.set(null);
      this.dialog().nativeElement.showModal();
    });
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
    return {
      ...v,
      type: 'mysql',
      port: Number(v.port),
      allowSelfSigned: v.ssl && v.allowSelfSigned,
    };
  }
}
