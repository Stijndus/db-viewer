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
import { ConnectionsStore } from '../../connections/connections.store';
import { SqlStore, type WriteConfirmation } from '../sql.store';

const SHOWN = 5;

/** Asks before statements that change data run, with an extra warning for UPDATE/DELETE without WHERE. */
@Component({
  selector: 'app-confirm-write',
  templateUrl: './confirm-write.html',
})
export class ConfirmWrite {
  readonly request = input.required<WriteConfirmation>();

  private readonly sql = inject(SqlStore);
  private readonly connections = inject(ConnectionsStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private answered = false;

  protected readonly dontAskAgain = signal(false);
  protected readonly shown = computed(() => this.request().statements.slice(0, SHOWN));
  protected readonly hidden = computed(() => Math.max(0, this.request().statements.length - SHOWN));
  protected readonly unbounded = computed(() => this.request().statements.some((s) => s.unbounded));
  protected readonly connectionName = computed(
    () =>
      this.connections.connections().find((c) => c.id === this.request().connectionId)?.name ?? '',
  );

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  protected preview(sql: string): string {
    const flat = sql.replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? flat.slice(0, 160) + '…' : flat;
  }

  protected answer(run: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.sql.answerConfirmation(run, run && this.dontAskAgain());
    this.dialog().nativeElement.close();
  }
}
