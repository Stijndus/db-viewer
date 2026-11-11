import { afterNextRender, Component, ElementRef, inject, input, viewChild } from '@angular/core';
import { UpdateStore, type WhatsNew as Content } from '../update.store';

/** Release notes in a dialog: after an update, for a pending update, or all of them. */
@Component({
  selector: 'app-whats-new',
  template: `
    <dialog
      #dialog
      class="dialog dialog-notes"
      aria-labelledby="wn-title"
      (close)="updates.whatsNew.set(null)"
    >
      <div class="dialog-head">
        <h2 id="wn-title">{{ content().title }}</h2>
        <button
          type="button"
          class="icon-btn borderless"
          aria-label="Sluiten"
          (click)="dialog.close()"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div class="dialog-body notes">
        @for (entry of content().entries; track entry.version) {
          <section class="note">
            @if (content().entries.length > 1 || !content().pending) {
              <h2 class="note-version">Versie {{ entry.version }}</h2>
            }
            <div class="note-body" [innerHTML]="entry.html"></div>
          </section>
        } @empty {
          <p class="muted">Geen release notes gevonden.</p>
        }
      </div>
      <div class="dialog-foot">
        <a
          class="btn btn-ghost"
          href="https://github.com/Stijndus/db-viewer/releases"
          target="_blank"
          rel="noopener"
          >Op GitHub</a
        >
        <span class="grow"></span>
        @if (content().pending && updates.state().status === 'ready') {
          <button type="button" class="btn btn-primary" (click)="updates.install()">
            Herstarten en bijwerken
          </button>
        } @else {
          <button type="button" class="btn btn-primary" (click)="dialog.close()">Sluiten</button>
        }
      </div>
    </dialog>
  `,
})
export class WhatsNew {
  readonly content = input.required<Content>();
  protected readonly updates = inject(UpdateStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }
}
