import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/models';

const RELEASES = 'https://github.com/Stijndus/db-viewer/releases';
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Checks GitHub Releases for a newer version. The installed app downloads it in the background
 * and installs on restart (or on quit); the portable exe only links to the download.
 */
export class Updater {
  private state: UpdateState = { status: 'unsupported' };
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly window: () => BrowserWindow | null) {}

  /** True for the portable exe: electron-builder's launcher sets this variable. */
  private readonly portable = Boolean(process.env['PORTABLE_EXECUTABLE_DIR']);

  start(): void {
    if (!app.isPackaged || process.platform !== 'win32') return; // stays 'unsupported'
    this.set({ status: 'idle' });

    autoUpdater.autoDownload = !this.portable;
    autoUpdater.autoInstallOnAppQuit = !this.portable;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => {
      if (this.state.status !== 'ready' && this.state.status !== 'downloading') {
        this.set({ status: 'checking' });
      }
    });
    autoUpdater.on('update-not-available', () => this.set({ status: 'current' }));
    autoUpdater.on('update-available', (info) => {
      this.set(
        this.portable
          ? { status: 'manual', version: info.version, url: `${RELEASES}/tag/v${info.version}` }
          : { status: 'downloading', version: info.version, percent: 0 },
      );
    });
    autoUpdater.on('download-progress', (p) => {
      if (this.state.status === 'downloading') {
        this.set({ ...this.state, percent: Math.round(p.percent) });
      }
    });
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => {
      // A failed check (offline, GitHub down) must never disturb work: keep a ready update ready.
      if (this.state.status !== 'ready') {
        this.set({ status: 'error', message: friendly(err) });
      }
    });

    setTimeout(() => void this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  getState(): UpdateState {
    return this.state;
  }

  async check(): Promise<UpdateState> {
    if (this.state.status === 'unsupported' || this.state.status === 'ready') return this.state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.set({ status: 'error', message: friendly(err) });
    }
    return this.state;
  }

  /** Restarts into the downloaded version: silent install, then the app starts again. */
  install(): void {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall(true, true);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.window()?.webContents.send('updates:state', state);
  }
}

function friendly(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(text)) {
    return 'Geen verbinding met GitHub.';
  }
  return 'Controleren op updates is mislukt.';
}
