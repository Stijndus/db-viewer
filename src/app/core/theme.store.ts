import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { DB_API } from './db-api';
import {
  applyTheme,
  resolveTheme,
  saveCustomThemes,
  savedCustomThemes,
  savedThemeChoice,
  SYSTEM,
  THEME_KEY,
  THEMES,
  type Theme,
} from './themes';

/**
 * The colour theme: the user's choice ("system" follows the OS between Donker and Licht), and a
 * preview while the picker is open. Saved per user; the window background follows for a clean start.
 */
@Injectable({ providedIn: 'root' })
export class ThemeStore {
  private readonly api = inject(DB_API);
  /** Imported VS Code themes, after the built-in ones. */
  readonly custom = signal<Theme[]>(savedCustomThemes());
  readonly themes = computed(() => [...THEMES, ...this.custom()]);
  readonly choice = signal(savedThemeChoice());
  /** A theme shown while choosing; null = the chosen one. */
  readonly preview = signal<string | null>(null);
  readonly pickerOpen = signal(false);
  private readonly systemDark = signal(true);

  readonly active = computed<Theme>(() =>
    resolveTheme(this.choice(), this.systemDark(), this.custom()),
  );
  readonly shown = computed<Theme>(() =>
    resolveTheme(this.preview() ?? this.choice(), this.systemDark(), this.custom()),
  );
  readonly label = computed(() =>
    this.choice() === SYSTEM ? `Systeem (${this.active().name})` : this.active().name,
  );

  constructor() {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (media) {
      this.systemDark.set(media.matches);
      media.addEventListener?.('change', (e) => this.systemDark.set(e.matches));
    }
    effect(() => applyTheme(this.shown()));
    // The window's own background (seen before the page paints) follows the chosen theme.
    effect(() => void this.api.setAppearance({ background: this.active().colors.bg }));
  }

  choose(id: string): void {
    this.choice.set(id);
    this.preview.set(null);
    try {
      localStorage.setItem(THEME_KEY, id);
    } catch {
      // Not remembered; the theme still applies now.
    }
  }

  /** Adds an imported theme (replacing one with the same id) and chooses it. */
  addCustom(theme: Theme): void {
    const list = [...this.custom().filter((t) => t.id !== theme.id), theme];
    this.custom.set(list);
    saveCustomThemes(list);
    this.choose(theme.id);
  }

  /** Removes an imported theme; if it was the chosen one, Donker takes over. */
  removeCustom(id: string): void {
    const list = this.custom().filter((t) => t.id !== id);
    this.custom.set(list);
    saveCustomThemes(list);
    if (this.choice() === id) this.choose('donker');
    if (this.preview() === id) this.preview.set(null);
  }

  openPicker(): void {
    this.pickerOpen.set(true);
  }
}
