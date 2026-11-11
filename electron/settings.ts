import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Window settings that must be known before the page loads: background colour and zoom. */
export interface WindowSettings {
  background: string;
  zoom: number;
}

const DEFAULTS: WindowSettings = { background: '#0E1014', zoom: 1 };

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
