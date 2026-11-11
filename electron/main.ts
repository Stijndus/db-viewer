import { app, BrowserWindow, dialog, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LAUNCH_EVENT } from '../shared/ipc-contract';
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

// ── Command line ───────────────────────────────────────────────────
// `db-viewer "Productie"`, `db-viewer mysql://…`, `db-viewer app.db`, `db-viewer --type …`.
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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0E1014',
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

  win.once('ready-to-show', () => win.show());

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

function isAppUrl(url: string): boolean {
  return DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith('file://');
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return event.sender === mainWindow?.webContents && isAppUrl(url);
}

function startApp(): void {
  app.whenReady().then(() => {
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
