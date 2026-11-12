import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  safeStorage,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LAUNCH_EVENT, ZOOM_EVENT } from '../shared/ipc-contract';
import { nextZoom, restoreBounds, SettingsFile } from './settings';
import type { LaunchRequest, ReleaseNote } from '../shared/models';
import { parseCli, USAGE, userArgs, type CliCommand } from './cli';
import { launchEnv, resolveLaunch, type LaunchData } from './launch';
import { ConnectionManager } from './db/connection-manager';
import { getDriver } from './db/driver-registry';
import { registerHandlers } from './ipc/register-handlers';
import { Updater } from './updater';
import { ConnectionStore, type SecretCipher } from './store/connection-store';

// Set by `npm run dev`. Without it the built Angular app is loaded from disk.
const DEV_SERVER_URL = app.isPackaged ? undefined : process.env['DB_VIEWER_DEV_URL'];

const cipher: SecretCipher = {
  // On Linux without a keyring safeStorage falls back to a hard-coded key ("basic_text"):
  // treat that as unavailable so we never pretend a password is protected.
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
};

let mainWindow: BrowserWindow | null = null;
let manager: ConnectionManager | null = null;
let settings: SettingsFile | null = null;

/** Sets the zoom factor, remembers it and tells the page (for the indicator in the status bar). */
function setZoom(factor: number): number {
  const win = mainWindow;
  if (!win) return factor;
  win.webContents.setZoomFactor(factor);
  settings?.update({ zoom: factor });
  win.webContents.send(ZOOM_EVENT, factor);
  return factor;
}

function zoom(action: 'in' | 'out' | 'reset' | 'get'): number {
  const current = mainWindow?.webContents.getZoomFactor() ?? 1;
  if (action === 'get') return current;
  return setZoom(action === 'reset' ? 1 : nextZoom(current, action === 'in' ? 1 : -1));
}

// ── Command line ───────────────────────────────────────────────────
// `db-viewer "Productie"`, `db-viewer mysql://…`, `db-viewer app.db`, `db-viewer --db-type …`.
// One app per user: a second start hands its arguments to the running window and quits.
const launchData: LaunchData = {
  args: userArgs(process.argv, app.isPackaged, app.getAppPath()),
  cwd: process.cwd(),
  env: launchEnv(process.env),
};
const parse = (data: LaunchData): CliCommand =>
  parseCli(data.args, {
    cwd: data.cwd,
    env: data.env,
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
  });
const firstCommand = parse(launchData);
/** Handed to the window once it asks (it may load after the launch was resolved). */
let pendingLaunch: Promise<LaunchRequest | null> = Promise.resolve(null);

if (firstCommand.kind === 'help' || firstCommand.kind === 'version') {
  // Printed for terminals; on Windows a GUI app has no console, so it shows a dialog there too.
  const text = firstCommand.kind === 'help' ? USAGE : `DB Viewer ${app.getVersion()}`;
  process.stdout.write(text + '\n');
  if (process.platform === 'win32') {
    void app.whenReady().then(async () => {
      await dialog.showMessageBox({ type: 'info', title: 'DB Viewer', message: text });
      app.exit(0);
    });
  } else {
    app.exit(0);
  }
} else if (!app.requestSingleInstanceLock(launchData)) {
  app.exit(0);
} else {
  startApp();
}

const MIN_SIZE = { width: 900, height: 600 };

function createWindow(): BrowserWindow {
  // Open where it was closed, if that place is still on a screen; else centred at 1280×800.
  const saved = settings?.get();
  const bounds = restoreBounds(
    saved?.bounds ?? null,
    screen.getAllDisplays().map((d) => d.workArea),
    MIN_SIZE,
  );
  const win = new BrowserWindow({
    ...(bounds ?? { width: 1280, height: 800 }),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    backgroundColor: settings?.get().background ?? '#0E1014',
    title: 'DB Viewer',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => {
    if (saved?.maximized) win.maximize();
    win.show();
  });
  rememberBounds(win);

  // Zoom (Ctrl+scroll, Ctrl+= / Ctrl+-, Ctrl+0) is handled by the page and set through IPC, so
  // it is remembered between starts.
  win.webContents.on('did-finish-load', () =>
    win.webContents.setZoomFactor(settings?.get().zoom ?? 1),
  );

  // No popups, no navigating away from the app. External links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'db-viewer', 'browser', 'index.html'));
  }
  return win;
}

/**
 * Saves the window's normal size and position and whether it is maximized: shortly after moving
 * or resizing, and when it closes. A full-screen window counts as maximized.
 */
function rememberBounds(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed() || win.isMinimized()) return;
    settings?.update({
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized() || win.isFullScreen(),
    });
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', later);
  win.on('move', later);
  win.on('maximize', save);
  win.on('unmaximize', save);
  win.on('enter-full-screen', save);
  win.on('leave-full-screen', save);
  win.on('close', save);
}

function isAppUrl(url: string): boolean {
  return DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith('file://');
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return event.sender === mainWindow?.webContents && isAppUrl(url);
}

function startApp(): void {
  app.whenReady().then(() => {
    // No default menu (English File/Edit/View with reload, developer tools and its own zoom).
    // macOS needs an Edit menu for the copy and paste shortcuts.
    Menu.setApplicationMenu(
      process.platform === 'darwin'
        ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
        : null,
    );
    settings = new SettingsFile(path.join(app.getPath('userData'), 'window.json'));
    const store = new ConnectionStore(
      path.join(app.getPath('userData'), 'connections.json'),
      cipher,
    );
    manager = new ConnectionManager(store, getDriver);
    const updater = new Updater(() => mainWindow);
    registerHandlers({
      store,
      manager,
      cipher,
      updater,
      version: app.getVersion(),
      isTrustedSender,
      sshDir: path.join(app.getPath('home'), '.ssh'),
      releaseNotes: async () => {
        try {
          const raw = await readFile(path.join(__dirname, 'release-notes.json'), 'utf8');
          return JSON.parse(raw) as ReleaseNote[];
        } catch {
          return [];
        }
      },
      pickFile: (options) =>
        mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options),
      pickSaveFile: (options) =>
        mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options),
      showInFolder: (file) => shell.showItemInFolder(file),
      documentsDir: app.getPath('documents'),
      setAppearance: (background) => {
        settings?.update({ background });
        mainWindow?.setBackgroundColor(background);
      },
      zoom,
      send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
      takeLaunch: () => {
        const launch = pendingLaunch;
        pendingLaunch = Promise.resolve(null);
        return launch;
      },
    });

    const canSave = () => cipher.isAvailable();
    pendingLaunch = resolveLaunch(firstCommand, store, canSave());

    // A second `db-viewer …` while the app runs: open it here and bring the window forward.
    app.on('second-instance', (_event, argv, workingDirectory, additional) => {
      const data = isLaunchData(additional)
        ? additional
        : {
            args: userArgs(argv, app.isPackaged, app.getAppPath()),
            cwd: workingDirectory,
            env: {},
          };
      const win = mainWindow;
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      void resolveLaunch(parse(data), store, canSave()).then((launch) => {
        if (launch) mainWindow?.webContents.send(LAUNCH_EVENT, launch);
      });
    });

    mainWindow = createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
    updater.start();
  });
}

function isLaunchData(value: unknown): value is LaunchData {
  const v = value as LaunchData | null;
  return Boolean(v && Array.isArray(v.args) && typeof v.cwd === 'string' && v.env);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Close every pool before quitting so MySQL doesn't keep half-open connections.
let closing = false;
app.on('before-quit', (event) => {
  if (closing || !manager) return;
  event.preventDefault();
  closing = true;
  void manager.closeAll().finally(() => app.quit());
});
