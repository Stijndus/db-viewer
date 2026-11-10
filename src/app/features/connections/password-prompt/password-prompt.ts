import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { ConnectionProfile } from '../../../../../shared/models';
import { ConnectionsStore } from '../connections.store';

/** Asks for a password when connecting to a profile that has none stored. Not saved. */
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
        <h2 id="pw-title">Wachtwoord voor {{ profile().name }}</h2>
        <p class="muted small mono">
          {{ profile().user }}&#64;{{ profile().host }}:{{ profile().port }}
        </p>
        <div class="field">
          <label for="pw-input" class="field-label">Wachtwoord</label>
          <input
            #pw
            id="pw-input"
            class="input"
            type="password"
            autocomplete="current-password"
            (input)="value.set(pw.value)"
          />
          <span class="muted small">Wordt alleen voor deze sessie gebruikt, niet opgeslagen.</span>
        </div>
        <div class="row">
          <span class="grow"></span>
          <button type="button" class="btn btn-ghost" (click)="dialog.close()">Annuleren</button>
          <button type="submit" class="btn btn-primary" [disabled]="!value()">Verbinden</button>
        </div>
      </form>
    </dialog>
  `,
})
export class PasswordPrompt {
  readonly profile = input.required<ConnectionProfile>();
  protected readonly store = inject(ConnectionsStore);
  protected readonly value = signal('');
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const id = this.profile().id;
    const password = this.value();
    this.dialog().nativeElement.close();
    void this.store.connect(id, password);
  }
}
