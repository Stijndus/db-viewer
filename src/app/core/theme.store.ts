import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { DB_API } from './db-api';
import {
  applyTheme,
  resolveTheme,
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
  readonly themes = THEMES;
  readonly choice = signal(savedThemeChoice());
  /** A theme shown while choosing; null = the chosen one. */
  readonly preview = signal<string | null>(null);
  readonly pickerOpen = signal(false);
  private readonly systemDark = signal(true);

  readonly active = computed<Theme>(() => resolveTheme(this.choice(), this.systemDark()));
  readonly shown = computed<Theme>(() =>
    resolveTheme(this.preview() ?? this.choice(), this.systemDark()),
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

  openPicker(): void {
    this.pickerOpen.set(true);
  }
}
