import path from 'node:path';
import { SERVER_DEFAULTS } from '../shared/dialect';
import type {
  ConnectionColor,
  ConnectionInput,
  ConnectSecrets,
  DbType,
  SshSettings,
} from '../shared/models';

/** What the command line asks for. */
export type CliCommand =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'version' }
  /** A saved connection, by name. */
  | { kind: 'saved'; name: string; secrets: ConnectSecrets }
  /** A connection described on the command line; `save` keeps it as a profile. */
  | { kind: 'connect'; input: ConnectionInput; save: boolean }
  | { kind: 'error'; message: string; hint?: string };

export interface CliContext {
  /** Directory the command was typed in: relative paths resolve against it. */
  cwd: string;
  env: Record<string, string | undefined>;
  /** True for an existing file (a SQLite database given as a bare path). */
  isFile(p: string): boolean;
}

export const USAGE = `Gebruik: db-viewer [verbinding] [opties]

Verbinding (één van):
  "Naam"                         een opgeslagen verbinding
  --connection, -c "Naam"        idem
  mysql://user:ww@host:3306/db   een URL (mysql, mariadb, postgres, mssql, sqlite)
  C:\\data\\app.db                 een SQLite-bestand
  --type mysql --host ...        losse opties

Opties:
  --type, -t       mysql | mariadb | postgres | mssql | sqlite
  --host, -h       host (standaard localhost)
  --port, -P       poort (standaard die van het type)
  --user, -u       gebruiker
  --password, -p   wachtwoord (veiliger: omgevingsvariabele DBV_PASSWORD)
  --database, -d   database (bij sqlite: het bestand)
  --ssl            SSL/TLS gebruiken
  --allow-self-signed  self-signed certificaat toestaan
  --read-only      alleen-lezen
  --color          groen | oranje | rood | blauw
  --name           naam in de lijst
  --save           als verbinding bewaren (anders tijdelijk, tot de app sluit)

SSH-tunnel:
  --ssh-host, --ssh-port (22), --ssh-user
  --ssh-password   wachtwoord (veiliger: DBV_SSH_PASSWORD)
  --ssh-key        privésleutel; --ssh-passphrase voor de wachtwoordzin
  --ssh-agent      inloggen via de SSH-agent
  --ssh-pageant    inloggen via Pageant
  --ssh-host-key   vertrouwde vingerafdruk (SHA256:...)

  --help           deze uitleg
  --version        versienummer

In een URL: ?ssl=true&read-only=true&ssh=user@host:22&ssh-key=pad&name=Naam`;

const TYPES: Record<string, DbType> = {
  mysql: 'mysql',
  mariadb: 'mysql',
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  mssql: 'mssql',
  sqlserver: 'mssql',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
};

const COLORS: Record<string, ConnectionColor> = {
  groen: 'green',
  green: 'green',
  oranje: 'orange',
  orange: 'orange',
  rood: 'red',
  red: 'red',
  blauw: 'blue',
  blue: 'blue',
};

/** Options that take a value, with their short forms. */
const VALUE_OPTIONS: Record<string, string> = {
  '--type': 'type',
  '-t': 'type',
  '--host': 'host',
  '-h': 'host',
  '--port': 'port',
  '-P': 'port',
  '--user': 'user',
  '-u': 'user',
  '--password': 'password',
  '-p': 'password',
  '--database': 'database',
  '-d': 'database',
  '--file': 'database',
  '--color': 'color',
  '--name': 'name',
  '--connection': 'connection',
  '-c': 'connection',
  '--ssh-host': 'sshHost',
  '--ssh-port': 'sshPort',
  '--ssh-user': 'sshUser',
  '--ssh-password': 'sshSecret',
  '--ssh-passphrase': 'sshSecret',
  '--ssh-key': 'sshKey',
  '--ssh-host-key': 'sshHostKey',
};

const FLAG_OPTIONS: Record<string, string> = {
  '--ssl': 'ssl',
  '--allow-self-signed': 'allowSelfSigned',
  '--read-only': 'readOnly',
  '--readonly': 'readOnly',
  '--save': 'save',
  '--ssh-agent': 'sshAgent',
  '--ssh-pageant': 'sshPageant',
  '--help': 'help',
  '-?': 'help',
  '/?': 'help',
  '--version': 'version',
  '-v': 'version',
};

/**
 * Chromium and Electron switches that may arrive in argv (the second-instance event passes the
 * full command line, dev runs add their own). They are not ours and are skipped silently.
 */
const FOREIGN =
  /^--(no-sandbox|user-data-dir|inspect|remote-debugging|enable-|disable-|allow-|original-process-start-time|js-flags|lang|force-|squirrel|ozone-|gtk-|use-gl|in-process-gpu|no-zygote|headless|app-path|log-|v=|vmodule|trace-|proxy-|ignore-|unhandled-rejections)/;

type Values = Partial<Record<string, string>>;
type Flags = Partial<Record<string, boolean>>;

/** Parses the arguments after the executable (and after the app path in development). */
export function parseCli(args: string[], ctx: CliContext): CliCommand {
  const values: Values = {};
  const flags: Flags = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_OPTIONS[name]) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined) return error(`Optie ${name} mist een waarde.`);
      values[VALUE_OPTIONS[name]] = value;
    } else if (FLAG_OPTIONS[name] && eq < 0) {
      flags[FLAG_OPTIONS[name]] = true;
    } else if (FOREIGN.test(arg) || arg === '.' || arg === '') {
      continue;
    } else if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      return error(`Onbekende optie: ${name}`, 'db-viewer --help toont alle opties.');
    } else {
      positional.push(arg);
    }
  }

  if (flags['help']) return { kind: 'help' };
  if (flags['version']) return { kind: 'version' };
  if (positional.length > 1) {
    return error(
      `Te veel argumenten: ${positional.map((p) => `"${p}"`).join(' ')}.`,
      'Zet een naam met spaties tussen aanhalingstekens.',
    );
  }

  const sshSecretEnv = ctx.env['DBV_SSH_PASSWORD'] || ctx.env['DBV_SSH_PASSPHRASE'];
  const passwordEnv = ctx.env['DBV_PASSWORD'];
  const arg = positional[0];
  const hasConnectionOptions = Object.keys(values).some(
    (k) => k !== 'connection' && k !== 'password' && k !== 'sshSecret',
  );

  // A saved connection: -c "Naam", or a bare word that is no URL or file.
  const savedName =
    values['connection'] ??
    (arg && !isUrl(arg) && !looksLikeFile(arg, ctx) && !hasConnectionOptions ? arg : undefined);
  if (savedName !== undefined) {
    if (!savedName.trim()) return error('Geef de naam van een opgeslagen verbinding.');
    if (arg && values['connection'])
      return error(`Onverwacht argument: "${arg}".`, 'Gebruik -c "Naam" of een URL, niet beide.');
    const password = values['password'] ?? passwordEnv;
    const sshSecret = values['sshSecret'] ?? sshSecretEnv;
    return {
      kind: 'saved',
      name: savedName.trim(),
      secrets: { ...(password && { password }), ...(sshSecret && { sshSecret }) },
    };
  }

  if (!arg && !hasConnectionOptions) {
    return values['password'] || values['sshSecret']
      ? error('Wachtwoord gegeven, maar geen verbinding.', 'db-viewer --help toont hoe.')
      : { kind: 'none' };
  }

  // Start from the URL or file, then let options override.
  let base: Values = {};
  if (arg && isUrl(arg)) {
    const parsed = parseUrl(arg);
    if ('error' in parsed) return error(parsed.error, parsed.hint);
    base = parsed.values;
    for (const f of parsed.flags) flags[f] ??= true;
  } else if (arg) {
    base = { type: 'sqlite', database: arg };
  }
  const v: Values = { ...base, ...values };

  const type =
    TYPES[
      (
        v['type'] ??
        (v['database'] && /\.(db|sqlite3?|db3|s3db)$/i.test(v['database']) ? 'sqlite' : '')
      ).toLowerCase()
    ];
  if (!type) {
    return v['type']
      ? error(
          `Onbekend databasetype: ${v['type']}.`,
          'Kies mysql, mariadb, postgres, mssql of sqlite.',
        )
      : error(
          'Geef het databasetype met --type, of gebruik een URL.',
          'Bijvoorbeeld: --type mysql',
        );
  }

  let color: ConnectionColor = 'green';
  if (v['color']) {
    const c = COLORS[v['color'].toLowerCase()];
    if (!c) return error(`Onbekende kleur: ${v['color']}.`, 'Kies groen, oranje, rood of blauw.');
    color = c;
  }

  if (type === 'sqlite') {
    if (!v['database'])
      return error('Geef het SQLite-bestand.', 'Bijvoorbeeld: db-viewer C:\\data\\app.db');
    if (hasSsh(v, flags)) return error('Een SQLite-bestand kan niet via een SSH-tunnel.');
    const file = path.resolve(ctx.cwd, v['database']);
    return {
      kind: 'connect',
      save: Boolean(flags['save']),
      input: {
        name: v['name']?.trim() || path.basename(file).replace(/\.(db|sqlite3?|db3|s3db)$/i, ''),
        type,
        host: '',
        port: 0,
        database: file,
        user: '',
        ssl: false,
        allowSelfSigned: false,
        color,
        readOnly: Boolean(flags['readOnly']),
        password: '',
        savePassword: false,
        ssh: null,
      },
    };
  }

  const defaults = SERVER_DEFAULTS[type];
  const port = v['port'] ? Number(v['port']) : defaults.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return error(`Ongeldige poort: ${v['port']}.`);
  const host = v['host'] || 'localhost';
  const user = v['user'] || defaults.user;
  const database = v['database'] ?? '';

  let ssh: SshSettings | null = null;
  if (hasSsh(v, flags)) {
    if (!v['sshHost']) return error('Geef de SSH-server met --ssh-host.');
    const sshPort = v['sshPort'] ? Number(v['sshPort']) : 22;
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)
      return error(`Ongeldige SSH-poort: ${v['sshPort']}.`);
    const sshUser = v['sshUser'] || ctx.env['USERNAME'] || ctx.env['USER'] || '';
    if (!sshUser) return error('Geef de SSH-gebruiker met --ssh-user.');
    const methods = [
      v['sshKey'] && 'key',
      flags['sshAgent'] && 'agent',
      flags['sshPageant'] && 'pageant',
    ].filter(Boolean);
    if (methods.length > 1)
      return error('Kies één manier van inloggen: --ssh-key, --ssh-agent of --ssh-pageant.');
    const hostKey = v['sshHostKey'] ?? '';
    if (hostKey && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey))
      return error(
        'Ongeldige --ssh-host-key.',
        'Verwacht: SHA256: gevolgd door 43 tekens, zoals ssh-keygen -lf toont.',
      );
    ssh = {
      host: v['sshHost'],
      port: sshPort,
      user: sshUser,
      auth: v['sshKey']
        ? 'key'
        : flags['sshAgent']
          ? 'agent'
          : flags['sshPageant']
            ? 'pageant'
            : 'password',
      keyFile: v['sshKey'] ? path.resolve(ctx.cwd, v['sshKey']) : '',
      hostKey,
    };
  }

  const password = v['password'] ?? passwordEnv ?? '';
  const sshSecret =
    ssh && (ssh.auth === 'password' || ssh.auth === 'key')
      ? (v['sshSecret'] ?? sshSecretEnv ?? '')
      : '';
  const where = ssh ? `${host === 'localhost' || host === '127.0.0.1' ? ssh.host : host}` : host;
  return {
    kind: 'connect',
    save: Boolean(flags['save']),
    input: {
      name: v['name']?.trim() || `${user}@${where}${database ? '/' + database : ''}`,
      type,
      host,
      port,
      database,
      user,
      ssl: Boolean(flags['ssl']),
      allowSelfSigned: Boolean(flags['ssl'] && flags['allowSelfSigned']),
      color,
      readOnly: Boolean(flags['readOnly']),
      password,
      savePassword: Boolean(flags['save']),
      ssh,
      sshSecret,
    },
  };
}

function hasSsh(v: Values, flags: Flags): boolean {
  return Boolean(
    v['sshHost'] ||
    v['sshUser'] ||
    v['sshKey'] ||
    v['sshPort'] ||
    v['sshHostKey'] ||
    flags['sshAgent'] ||
    flags['sshPageant'],
  );
}

function isUrl(arg: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) || /^sqlite3?:/i.test(arg);
}

function looksLikeFile(arg: string, ctx: CliContext): boolean {
  if (/\.(db|sqlite3?|db3|s3db)$/i.test(arg)) return true;
  return /[\\/]/.test(arg) && ctx.isFile(path.resolve(ctx.cwd, arg));
}

type UrlResult = { values: Values; flags: string[] } | { error: string; hint?: string };

/** mysql://user:pass@host:port/db?ssl=true&read-only=true&ssh=user@host:22&ssh-key=... */
function parseUrl(raw: string): UrlResult {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)![1]!.toLowerCase();
  if (!TYPES[scheme]) {
    return {
      error: `Onbekend URL-type: ${scheme}://`,
      hint: 'Gebruik mysql://, postgres://, mssql:// of sqlite://',
    };
  }
  if (TYPES[scheme] === 'sqlite') {
    // sqlite:///abs/path, sqlite://C:/path, sqlite:relative.db
    let file = raw.replace(/^[a-z0-9]+:(\/\/)?/i, '');
    const q = file.indexOf('?');
    const query = q >= 0 ? new URLSearchParams(file.slice(q + 1)) : new URLSearchParams();
    if (q >= 0) file = file.slice(0, q);
    if (/^\/[A-Za-z]:[\\/]/.test(file)) file = file.slice(1); // sqlite:///C:/data.db
    return {
      values: { type: 'sqlite', database: decodeURIComponent(file), ...queryValues(query) },
      flags: queryFlags(query),
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Ongeldige URL: ${raw}` };
  }
  const values: Values = { type: scheme };
  if (url.hostname) values['host'] = url.hostname.replace(/^\[|\]$/g, '');
  if (url.port) values['port'] = url.port;
  if (url.username) values['user'] = decodeURIComponent(url.username);
  if (url.password) values['password'] = decodeURIComponent(url.password);
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (db) values['database'] = db;
  Object.assign(values, queryValues(url.searchParams));
  const ssh = url.searchParams.get('ssh');
  if (ssh) {
    const m = /^(?:([^@]+)@)?([^:@]+)(?::(\d+))?$/.exec(ssh);
    if (!m)
      return {
        error: `Ongeldige ssh= in de URL: ${ssh}`,
        hint: 'Verwacht: ssh=gebruiker@server:22',
      };
    if (m[1]) values['sshUser'] = m[1];
    values['sshHost'] = m[2];
    if (m[3]) values['sshPort'] = m[3];
  }
  return { values, flags: queryFlags(url.searchParams) };
}

function queryValues(q: URLSearchParams): Values {
  const out: Values = {};
  const map: Record<string, string> = {
    name: 'name',
    color: 'color',
    'ssh-key': 'sshKey',
    sshkey: 'sshKey',
    'ssh-host-key': 'sshHostKey',
    'ssh-user': 'sshUser',
    'ssh-port': 'sshPort',
  };
  for (const [k, v] of q) {
    const key = map[k.toLowerCase()];
    if (key) out[key] = v;
  }
  return out;
}

function queryFlags(q: URLSearchParams): string[] {
  const out: string[] = [];
  const truthy = (k: string) => {
    const v = q.get(k);
    return v !== null && !/^(0|false|no|nee)$/i.test(v);
  };
  if (truthy('ssl') || (truthy('sslmode') && !/disable/i.test(q.get('sslmode') ?? '')))
    out.push('ssl');
  if (truthy('read-only') || truthy('readonly')) out.push('readOnly');
  if (truthy('allow-self-signed')) out.push('allowSelfSigned');
  if (truthy('save')) out.push('save');
  if (truthy('ssh-agent')) out.push('sshAgent');
  if (truthy('ssh-pageant')) out.push('sshPageant');
  return out;
}

function error(message: string, hint?: string): CliCommand {
  return hint ? { kind: 'error', message, hint } : { kind: 'error', message };
}

/**
 * The user's arguments: argv without the executable, and in development without the app path
 * (`electron . args` or `electron /path/to/app args`, with Chromium switches anywhere).
 */
export function userArgs(argv: string[], packaged: boolean, appPath: string): string[] {
  const rest = argv.slice(1);
  if (packaged) return rest;
  const i = rest.findIndex((a) => !a.startsWith('-') && path.resolve(a) === path.resolve(appPath));
  return i < 0 ? rest : [...rest.slice(0, i), ...rest.slice(i + 1)];
}
