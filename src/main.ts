import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { applyTheme, resolveTheme, savedThemeChoice } from './app/core/themes';

// The saved theme before the first paint, so the app never flashes the default colours.
applyTheme(
  resolveTheme(
    savedThemeChoice(),
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true,
  ),
);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
