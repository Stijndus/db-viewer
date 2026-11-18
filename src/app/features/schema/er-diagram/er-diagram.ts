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
import { ThemeStore } from '../../../core/theme.store';
import { SchemaStore } from '../schema.store';
import { HEADER_H, layoutModel, PAD_X, ROW_H, type ErEdge, type ErNode } from './er-layout';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;

/**
 * The tables of a database and their foreign keys as a diagram: drag to move around, scroll to
 * zoom, click a table to open it. Can be saved as an SVG picture.
 */
@Component({
  selector: 'app-er-diagram',
  template: `
    @let c = colors();
    <div class="er-bar">
      <h2 class="er-title">
        ER-diagram <span class="mono muted">{{ database() }}</span>
      </h2>
      @if (layout(); as l) {
        <span class="muted small"
          >{{ l.nodes.length }} {{ l.nodes.length === 1 ? 'tabel' : 'tabellen' }} ·
          {{ l.edges.length }} {{ l.edges.length === 1 ? 'relatie' : 'relaties' }}</span
        >
      }
      <span class="push"></span>
      <label class="visually-hidden" for="er-find">Tabel zoeken in het diagram</label>
      <input
        id="er-find"
        class="input er-find"
        type="search"
        placeholder="Tabel zoeken…"
        [value]="find()"
        (input)="find.set($any($event.target).value)"
        (keydown.enter)="focusFound()"
      />
      <div class="er-zoom" role="group" aria-label="Zoomen">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          title="Uitzoomen"
          (click)="zoomBy(1 / 1.25)"
        >
          −
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm er-pct"
          title="Zoom op 100%"
          (click)="setZoom(1)"
        >
          {{ zoomPct() }}%
        </button>
        <button type="button" class="btn btn-ghost btn-sm" title="Inzoomen" (click)="zoomBy(1.25)">
          +
        </button>
        <button type="button" class="btn btn-ghost btn-sm" title="Alles in beeld" (click)="fit()">
          Passend
        </button>
      </div>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        [disabled]="!layout()"
        (click)="saveSvg()"
      >
        Opslaan als afbeelding
      </button>
      <button type="button" class="btn btn-ghost btn-sm" title="Opnieuw laden" (click)="reload()">
        Vernieuwen
      </button>
    </div>
    <div
      #viewport
      class="er-viewport"
      [class.panning]="panning()"
      (pointerdown)="startPan($event)"
      (wheel)="onWheel($event)"
    >
      @switch (state()) {
        @case ('loading') {
          <div class="dt-empty muted">Tabellen en relaties laden…</div>
        }
        @case ('error') {
          <div class="banner banner-error" role="alert">{{ errorText() }}</div>
        }
        @case ('empty') {
          <div class="dt-empty muted">Deze database heeft geen tabellen.</div>
        }
      }
      @if (layout(); as l) {
        <svg
          #svg
          class="er-svg"
          xmlns="http://www.w3.org/2000/svg"
          [attr.width]="l.width * zoom()"
          [attr.height]="l.height * zoom()"
          [attr.viewBox]="'0 0 ' + l.width + ' ' + l.height"
          role="img"
          [attr.aria-label]="'ER-diagram van ' + database()"
          font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
          font-size="12"
        >
          <rect [attr.width]="l.width" [attr.height]="l.height" [attr.fill]="c.bg" />
          @for (e of l.edges; track e.key.table + e.key.name) {
            @let on = isLit(e);
            <g class="er-edge" [attr.opacity]="dim() && !on ? 0.15 : 1">
              <title>
                {{ e.key.table }}({{ e.key.columns.join(', ') }}) → {{ e.key.refTable }}({{
                  e.key.refColumns.join(', ')
                }})
              </title>
              <path
                [attr.d]="e.path"
                fill="none"
                [attr.stroke]="on ? c.accent : c.line"
                [attr.stroke-width]="on ? 2 : 1.4"
              />
              <path
                [attr.d]="crowFoot(e)"
                fill="none"
                [attr.stroke]="on ? c.accent : c.line"
                stroke-width="1.4"
              />
              <path
                [attr.d]="oneBar(e)"
                fill="none"
                [attr.stroke]="on ? c.accent : c.line"
                stroke-width="1.4"
              />
            </g>
          }
          @for (n of l.nodes; track n.name) {
            @let found = isFound(n);
            <g
              class="er-node"
              [attr.transform]="'translate(' + n.x + ',' + n.y + ')'"
              [attr.opacity]="dim() && !isLitNode(n) ? 0.35 : 1"
              (pointerenter)="hover.set(n.name)"
              (pointerleave)="hover.set(null)"
              (click)="open(n)"
            >
              <title>{{ n.name }} openen</title>
              <rect
                [attr.width]="n.width"
                [attr.height]="n.height"
                rx="6"
                [attr.fill]="c.panel"
                [attr.stroke]="found || hover() === n.name ? c.accent : c.border"
                [attr.stroke-width]="found ? 2.5 : 1"
              />
              <path
                [attr.d]="
                  'M0,6 a6,6 0 0 1 6,-6 h' +
                  (n.width - 12) +
                  ' a6,6 0 0 1 6,6 v' +
                  (headerH - 6) +
                  ' h-' +
                  n.width +
                  'z'
                "
                [attr.fill]="c.header"
              />
              <text [attr.x]="padX" [attr.y]="19" font-weight="700" [attr.fill]="c.text">
                {{ n.name }}
              </text>
              @for (col of n.columns; track col.name; let i = $index) {
                <g [attr.transform]="'translate(0,' + (headerH + i * rowH + 4) + ')'">
                  @if (col.primary) {
                    <text [attr.x]="padX - 4" y="14" font-size="10" [attr.fill]="c.key">PK</text>
                  } @else if (col.foreign) {
                    <text [attr.x]="padX - 4" y="14" font-size="10" [attr.fill]="c.accent">FK</text>
                  }
                  <text
                    [attr.x]="padX + 18"
                    y="14"
                    [attr.fill]="col.primary ? c.text : c.text2"
                    [attr.font-weight]="col.primary ? 600 : 400"
                  >
                    {{ col.name }}
                  </text>
                  <text
                    [attr.x]="n.width - padX"
                    y="14"
                    text-anchor="end"
                    font-size="11"
                    [attr.fill]="c.text3"
                  >
                    {{ col.type }}
                  </text>
                </g>
              }
              @if (n.hidden) {
                <text
                  [attr.x]="padX + 18"
                  [attr.y]="headerH + n.columns.length * rowH + 18"
                  font-size="11"
                  [attr.fill]="c.text3"
                >
                  + {{ n.hidden }} kolommen
                </text>
              }
            </g>
          }
        </svg>
      }
    </div>
  `,
})
export class ErDiagram {
  readonly connectionId = input.required<string>();
  readonly database = input.required<string>();

  private readonly schema = inject(SchemaStore);
  private readonly theme = inject(ThemeStore);
  private readonly viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly svg = viewChild<ElementRef<SVGSVGElement>>('svg');

  protected readonly headerH = HEADER_H;
  protected readonly rowH = ROW_H;
  protected readonly padX = PAD_X;
  protected readonly zoom = signal(1);
  protected readonly zoomPct = computed(() => Math.round(this.zoom() * 100));
  protected readonly hover = signal<string | null>(null);
  protected readonly find = signal('');
  protected readonly panning = signal(false);
  private fitted = false;

  private readonly load = computed(() => this.schema.model(this.connectionId(), this.database()));
  protected readonly state = computed(() => {
    const m = this.load();
    if (!m || m.status === 'loading') return 'loading';
    if (m.status === 'error') return 'error';
    return m.data.tables.length ? 'ready' : 'empty';
  });
  protected readonly errorText = computed(() => {
    const m = this.load();
    return m?.status === 'error' ? m.error.message : '';
  });

  protected readonly layout = computed(() => {
    const m = this.load();
    if (m?.status !== 'loaded' || !m.data.tables.length) return null;
    return layoutModel(m.data, this.database(), measurer());
  });

  /** Colours of the theme, written into the SVG (so a saved picture looks the same). */
  protected readonly colors = computed(() => {
    const t = this.theme.shown().colors;
    return {
      bg: t.bg,
      panel: t.panel,
      header: t['panel-2'],
      border: t.border,
      line: t['text-3'],
      accent: t.accent,
      key: t['syn-number'],
      text: t.text,
      text2: t['text-2'],
      text3: t['text-3'],
    };
  });

  /** Hovering a table: it, its relations and the tables they lead to stand out. */
  protected readonly dim = computed(() => this.hover() !== null);

  constructor() {
    effect(() => {
      const conn = this.connectionId();
      const db = this.database();
      untracked(() => void this.schema.ensureModel(conn, db));
    });
    // The first time the diagram is there: fit it in the window.
    afterRenderEffect(() => {
      if (this.layout() && !this.fitted && this.viewport()) {
        this.fitted = true;
        this.fit();
      }
    });
  }

  protected isLit(e: ErEdge): boolean {
    const h = this.hover();
    return h !== null && (e.from === h || e.to === h);
  }

  protected isLitNode(n: ErNode): boolean {
    const h = this.hover();
    if (h === null || n.name === h) return true;
    return (this.layout()?.edges ?? []).some(
      (e) => (e.from === h && e.to === n.name) || (e.to === h && e.from === n.name),
    );
  }

  protected isFound(n: ErNode): boolean {
    const q = this.find().trim().toLowerCase();
    return q !== '' && n.name.toLowerCase().includes(q);
  }

  /** "Many": three short lines fanning out at the key column's end. */
  protected crowFoot(e: ErEdge): string {
    const { x, y, dir } = e.start;
    const t = x + dir * 12;
    return `M${t},${y} L${x},${y - 6} M${t},${y} L${x},${y} M${t},${y} L${x},${y + 6}`;
  }

  /** "One": a bar near the referenced column. */
  protected oneBar(e: ErEdge): string {
    const { x, y, dir } = e.end;
    const b = x + dir * 8;
    return `M${b},${y - 6} L${b},${y + 6}`;
  }

  protected open(n: ErNode): void {
    if (this.moved) return;
    void this.schema.openAs(
      { connectionId: this.connectionId(), database: this.database(), name: n.name, kind: 'table' },
      'data',
    );
  }

  protected reload(): void {
    this.fitted = false;
    void this.schema.reloadModel(this.connectionId(), this.database());
  }

  // ── Zoom and pan ───────────────────────────────────────────────────
  protected setZoom(z: number, around?: { x: number; y: number }): void {
    const vp = this.viewport()?.nativeElement;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (!vp) return this.zoom.set(next);
    // Keep the point under the cursor (or the middle) in place.
    const px = around?.x ?? vp.clientWidth / 2;
    const py = around?.y ?? vp.clientHeight / 2;
    const fx = (vp.scrollLeft + px) / this.zoom();
    const fy = (vp.scrollTop + py) / this.zoom();
    this.zoom.set(next);
    requestAnimationFrame(() => {
      vp.scrollLeft = fx * next - px;
      vp.scrollTop = fy * next - py;
    });
  }

  protected zoomBy(factor: number): void {
    this.setZoom(this.zoom() * factor);
  }

  protected fit(): void {
    const vp = this.viewport()?.nativeElement;
    const l = this.layout();
    if (!vp || !l || !vp.clientWidth) return;
    const z = Math.min(1, (vp.clientWidth - 16) / l.width, (vp.clientHeight - 16) / l.height);
    this.zoom.set(Math.max(MIN_ZOOM, z));
    vp.scrollLeft = 0;
    vp.scrollTop = 0;
  }

  /** Enter in the search box: zoom in on the first table found. */
  protected focusFound(): void {
    const n = this.layout()?.nodes.find((x) => this.isFound(x));
    const vp = this.viewport()?.nativeElement;
    if (!n || !vp) return;
    const z = Math.max(this.zoom(), 0.8);
    this.zoom.set(z);
    requestAnimationFrame(() => {
      vp.scrollLeft = (n.x + n.width / 2) * z - vp.clientWidth / 2;
      vp.scrollTop = (n.y + n.height / 2) * z - vp.clientHeight / 2;
    });
  }

  protected onWheel(event: WheelEvent): void {
    // Ctrl+wheel (and pinch) zooms; the wheel alone scrolls, like a page.
    if (!event.ctrlKey && !event.metaKey) return;
    // The diagram zooms, not the whole window (the app zooms on Ctrl+wheel elsewhere).
    event.preventDefault();
    event.stopPropagation();
    const box = this.viewport()!.nativeElement.getBoundingClientRect();
    // About 20% per wheel step; a trackpad's small steps zoom smoothly.
    const delta = Math.max(-120, Math.min(120, event.deltaY));
    this.setZoom(this.zoom() * Math.exp(-delta / 600), {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
    });
  }

  private moved = false;
  protected startPan(event: PointerEvent): void {
    if (event.button !== 0) return;
    const vp = this.viewport()?.nativeElement;
    if (!vp) return;
    const sx = event.clientX;
    const sy = event.clientY;
    const left = vp.scrollLeft;
    const top = vp.scrollTop;
    this.moved = false;
    const move = (e: PointerEvent) => {
      if (!this.moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
      this.moved = true;
      this.panning.set(true);
      vp.scrollLeft = left - (e.clientX - sx);
      vp.scrollTop = top - (e.clientY - sy);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      this.panning.set(false);
      // The click that ends a drag does not open a table.
      setTimeout(() => (this.moved = false));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }

  /** Saves the diagram as an SVG file (full size, the theme's colours). */
  protected saveSvg(): void {
    const svg = this.svg()?.nativeElement;
    const l = this.layout();
    if (!svg || !l) return;
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute('width', String(l.width));
    copy.setAttribute('height', String(l.height));
    copy.removeAttribute('class');
    // Angular's comment and attribute markers are not needed in the file.
    const text = new XMLSerializer()
      .serializeToString(copy)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/ _ngcontent-[\w-]+=""/g, '');
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.database()}-er-diagram.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Text widths in the diagram's font, measured with a canvas (an estimate without one). */
function measurer(): (text: string, bold?: boolean) => number {
  const ctx = document.createElement('canvas').getContext('2d');
  return (text, bold) => {
    if (!ctx) return text.length * 7.3;
    ctx.font = `${bold ? '700 ' : ''}12px ui-monospace, SFMono-Regular, Consolas, monospace`;
    return ctx.measureText(text).width;
  };
}
