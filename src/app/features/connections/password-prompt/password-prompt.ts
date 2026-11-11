import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { connectionAddress, ConnectionsStore, type SecretsPrompt } from '../connections.store';

/** Asks for a database password and/or SSH secret that isn't stored. Used once, never saved. */
@Component({
  selector: 'app-password-prompt',
  template: `
    <dialog
      #dialog
      class="dialog dialog-sm"
      aria-labelledby="pw-title"
      (close)="store.passwordPrompt.set(null)"
    >
      <form class="dialog-body" (submit)="submit($event)">
        <h2 id="pw-title">Inloggen op {{ prompt().profile.name }}</h2>
        <p class="muted small mono">{{ address() }}</p>
        @if (prompt().error; as error) {
          <div class="banner banner-error" role="alert">
            <strong>{{ error.message }}</strong>
            @if (error.hint) {
              <span class="small">{{ error.hint }}</span>
            }
          </div>
        }
        @if (prompt().askSsh) {
          <div class="field">
            <label for="ssh-secret-input" class="field-label">{{ sshLabel() }}</label>
            <input
              #ssh
              id="ssh-secret-input"
              class="input"
              type="password"
              autocomplete="off"
              (input)="sshSecret.set(ssh.value)"
            />
          </div>
        }
        @if (prompt().askPassword) {
          <div class="field">
            <label for="pw-input" class="field-label">Databasewachtwoord</label>
            <input
              #pw
              id="pw-input"
              class="input"
              type="password"
              autocomplete="current-password"
              (input)="password.set(pw.value)"
            />
          </div>
        }
        <span class="muted small">Wordt alleen voor deze sessie gebruikt, niet opgeslagen.</span>
        <div class="row">
          <span class="grow"></span>
          <button type="button" class="btn btn-ghost" (click)="dialog.close()">Annuleren</button>
          <button type="submit" class="btn btn-primary" [disabled]="!complete()">Verbinden</button>
        </div>
      </form>
    </dialog>
  `,
})
export class PasswordPrompt {
  readonly prompt = input.required<SecretsPrompt>();
  protected readonly store = inject(ConnectionsStore);
  protected readonly password = signal('');
  protected readonly sshSecret = signal('');
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly address = computed(() => connectionAddress(this.prompt().profile));
  protected readonly sshLabel = computed(() => {
    const ssh = this.prompt().profile.ssh;
    return ssh?.auth === 'key'
      ? 'Wachtwoordzin van de SSH-sleutel'
      : `SSH-wachtwoord voor ${ssh?.user}@${ssh?.host}`;
  });
  protected readonly complete = computed(
    () =>
      (!this.prompt().askPassword || Boolean(this.password())) &&
      (!this.prompt().askSsh || Boolean(this.sshSecret())),
  );

  constructor() {
    afterNextRender(() => {
      const el = this.dialog().nativeElement;
      el.showModal();
      el.querySelector<HTMLInputElement>('input')?.focus();
    });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.complete()) return;
    const id = this.prompt().profile.id;
    const secrets = {
      ...(this.password() && { password: this.password() }),
      ...(this.sshSecret() && { sshSecret: this.sshSecret() }),
    };
    this.dialog().nativeElement.close();
    void this.store.connect(id, secrets);
  }
}
