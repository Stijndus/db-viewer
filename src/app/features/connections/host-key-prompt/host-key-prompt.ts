import { afterNextRender, Component, ElementRef, input, viewChild } from '@angular/core';
import type { HostKeyPrompt as Prompt } from '../connections.store';

/**
 * First connection to an SSH server, or a server whose key changed: show the fingerprint and let
 * the user decide. Like `ssh` asking "Are you sure you want to continue connecting?".
 */
@Component({
  selector: 'app-host-key-prompt',
  template: `
    <dialog
      #dialog
      class="dialog dialog-sm"
      aria-labelledby="hk-title"
      (cancel)="$event.preventDefault(); prompt().answer(false)"
    >
      <div class="dialog-body">
        @if (prompt().changed) {
          <h2 id="hk-title">Sleutel van {{ prompt().host }} is veranderd</h2>
          <div class="banner banner-error" role="alert">
            <strong>Mogelijk onderschept iemand de verbinding.</strong>
            <span class="small"
              >Is de server opnieuw geïnstalleerd of kreeg hij een nieuwe sleutel, vergelijk de
              vingerafdruk dan eerst met de beheerder.</span
            >
          </div>
        } @else {
          <h2 id="hk-title">Nieuwe SSH-server: {{ prompt().host }}</h2>
          <p class="small">
            De app kent deze server nog niet. Vertrouw hem alleen als de vingerafdruk klopt met die
            van de server (<span class="mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span
            >).
          </p>
        }
        <div class="field">
          <span class="field-label">Vingerafdruk</span>
          <code class="fingerprint mono" data-testid="fingerprint">{{ prompt().fingerprint }}</code>
        </div>
        <div class="row">
          <span class="grow"></span>
          <button type="button" class="btn btn-ghost" (click)="prompt().answer(false)">
            Annuleren
          </button>
          <button
            type="button"
            [class]="prompt().changed ? 'btn btn-danger' : 'btn btn-primary'"
            (click)="prompt().answer(true)"
          >
            {{ prompt().changed ? 'Nieuwe sleutel vertrouwen' : 'Vertrouwen en verbinden' }}
          </button>
        </div>
      </div>
    </dialog>
  `,
})
export class HostKeyPrompt {
  readonly prompt = input.required<Prompt>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }
}
