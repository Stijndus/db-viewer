import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Window settings that must be known before the page loads: background colour, zoom, and where
 * the window was (its normal size and position, and whether it was maximized).
 */
export interface WindowSettings {
  background: string;
  zoom: number;
  bounds: Rect | null;
  maximized: boolean;
}

const DEFAULTS: WindowSettings = { background: '#0E1014', zoom: 1, bounds: null, maximized: false };

function isRect(value: unknown): value is Rect {
  const r = value as Rect | null;
  return Boolean(
    r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n)),
  );
}

export class SettingsFile {
  private value: WindowSettings;

  constructor(private readonly file: string) {
    let stored: Partial<WindowSettings> = {};
    try {
      stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowSettings>;
    } catch {
      // First start or unreadable: defaults.
    }
    this.value = {
      background: /^#[0-9a-f]{6}$/i.test(stored.background ?? '')
        ? stored.background!
        : DEFAULTS.background,
      zoom:
        typeof stored.zoom === 'number' && stored.zoom >= 0.5 && stored.zoom <= 3
          ? stored.zoom
          : DEFAULTS.zoom,
      bounds: isRect(stored.bounds) ? stored.bounds : null,
      maximized: stored.maximized === true,
    };
  }

  get(): WindowSettings {
    return this.value;
  }

  update(patch: Partial<WindowSettings>): void {
    this.value = { ...this.value, ...patch };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    } catch {
      // Not saved; it still applies now.
    }
  }
}

/** Zoom steps, like a browser: Ctrl+scroll, Ctrl+= and Ctrl+- move one step. */
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function nextZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((s) => s > current + 0.001) ?? ZOOM_STEPS.at(-1)!;
  return [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001) ?? ZOOM_STEPS[0]!;
}

/**
 * Where to open the window: the saved size and position when it is still (mostly) on a screen,
 * shrunk to fit that screen; null for the default (centred) when there is nothing usable, e.g.
 * after unplugging the monitor it was on.
 */
export function restoreBounds(
  saved: Rect | null,
  workAreas: Rect[],
  min: { width: number; height: number },
): Rect | null {
  if (!saved) return null;
  // The screen that shows most of the window; at least a strip of the title bar must be visible.
  let best: { area: Rect; overlap: number } | null = null;
  for (const area of workAreas) {
    const w = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
    const h = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y);
    const titleVisible = saved.y >= area.y - 10 && saved.y < area.y + area.height - 40 && w >= 120;
    if (w > 0 && h > 0 && titleVisible && (!best || w * h > best.overlap)) {
      best = { area, overlap: w * h };
    }
  }
  if (!best) return null;
  const a = best.area;
  const width = Math.max(min.width, Math.min(saved.width, a.width));
  const height = Math.max(min.height, Math.min(saved.height, a.height));
  const x = Math.min(Math.max(saved.x, a.x), a.x + a.width - width);
  const y = Math.min(Math.max(saved.y, a.y), a.y + a.height - height);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}
