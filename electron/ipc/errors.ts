import { ZodError } from 'zod';
import type { DbError } from '../../shared/models';

/** An error raised by our own code, with a code and Dutch user message. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

interface KnownError {
  message: string;
  hint?: string;
  /** Use the server's own message as hint: it names the exact spot in the user's SQL. */
  serverHint?: boolean;
  /**
   * Put the server's own message before the hint. For a refused login it says which user@host
   * the server saw and whether a password came along, which points straight at the cause.
   */
  withServerMessage?: boolean;
}

/**
 * Network, MySQL, PostgreSQL (SQLSTATE), SQL Server (MSSQL_<number>) and SQLite errors translated
 * for the UI. Keyed by `err.code`; drivers put the server's own text in `sqlMessage`.
 */
const KNOWN: Record<string, KnownError> = {
  ECONNREFUSED: {
    message: 'Server weigert verbinding.',
    hint: 'Draait de databaseserver en klopt de poort?',
  },
  ENOTFOUND: { message: 'Host niet gevonden.', hint: 'Controleer de hostnaam of je VPN.' },
  EAI_AGAIN: { message: 'Host niet gevonden.', hint: 'Controleer de hostnaam of je netwerk.' },
  ETIMEDOUT: {
    message: 'Verbinding verlopen na 8 seconden.',
    hint: 'Firewall, een server die alleen lokaal luistert, of een verkeerde host.',
  },
  ECONNRESET: { message: 'Verbinding onverwacht verbroken.', hint: 'Vereist de server SSL?' },
  ER_ACCESS_DENIED_ERROR: {
    message: 'Inloggen mislukt.',
    hint: "Controleer gebruiker, wachtwoord en of de gebruiker vanaf deze host mag inloggen (user@'%'). Via een SSH-tunnel komt de verbinding van de server zelf (localhost of 127.0.0.1).",
    withServerMessage: true,
  },
  ER_BAD_DB_ERROR: { message: 'Database bestaat niet.', hint: 'Controleer de databasenaam.' },
  ER_DBACCESS_DENIED_ERROR: {
    message: 'Geen rechten op deze database.',
    hint: 'Vraag een GRANT SELECT aan voor deze gebruiker.',
  },
  HANDSHAKE_NO_SSL_SUPPORT: {
    message: 'Server ondersteunt geen SSL.',
    hint: 'Zet SSL uit voor deze verbinding.',
  },
  HANDSHAKE_SSL_ERROR: {
    message: 'SSL-handshake mislukt.',
    hint: 'Controleer het servercertificaat of sta self-signed toe.',
  },
  DEPTH_ZERO_SELF_SIGNED_CERT: {
    message: 'Server gebruikt een self-signed certificaat.',
    hint: 'Zet "Self-signed certificaat toestaan" aan als je de server vertrouwt.',
  },
  SELF_SIGNED_CERT_IN_CHAIN: {
    message: 'Certificaatketen bevat een self-signed certificaat.',
    hint: 'Zet "Self-signed certificaat toestaan" aan als je de server vertrouwt.',
  },

  // Reading data (step 3): mostly mistakes in the user's filter.
  ER_PARSE_ERROR: { message: 'Fout in het filter.', serverHint: true },
  ER_BAD_FIELD_ERROR: { message: 'Onbekende kolom in het filter.', serverHint: true },
  ER_WRONG_VALUE_COUNT_ON_ROW: { message: 'Fout in het filter.', serverHint: true },
  ER_OPERAND_COLUMNS: { message: 'Fout in het filter.', serverHint: true },
  ER_SUBQUERY_NO_1_ROW: {
    message: 'Subquery in het filter geeft meer dan één rij.',
    serverHint: true,
  },
  ER_TRUNCATED_WRONG_VALUE: { message: 'Ongeldige waarde in het filter.', serverHint: true },
  ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: {
    message: 'Het filter mag geen gegevens wijzigen.',
    hint: 'De data-weergave is alleen-lezen.',
  },
  ER_NO_SUCH_TABLE: {
    message: 'Tabel bestaat niet (meer).',
    hint: 'Vernieuw het schema met de knop boven de boom.',
  },
  ER_TABLEACCESS_DENIED_ERROR: {
    message: 'Geen leesrechten op deze tabel.',
    hint: 'Vraag een GRANT SELECT aan voor deze gebruiker.',
  },
  ER_VIEW_INVALID: {
    message: 'Deze view verwijst naar iets dat niet (meer) bestaat.',
    serverHint: true,
  },
  PROTOCOL_SEQUENCE_TIMEOUT: {
    message: 'Query duurde langer dan 30 seconden en is afgebroken.',
    hint: 'Verfijn het filter, of sorteer op een kolom met een index.',
  },
  ER_QUERY_INTERRUPTED: { message: 'Query afgebroken.' },
  BUSY: { message: 'Er loopt al een query in dit tabblad.' },

  // PostgreSQL (SQLSTATE codes).
  '28P01': {
    message: 'Inloggen mislukt.',
    hint: 'Controleer gebruiker en wachtwoord, en of pg_hba.conf deze verbinding toestaat.',
  },
  '28000': {
    message: 'Inloggen mislukt.',
    hint: 'De server staat deze gebruiker of verbinding niet toe (pg_hba.conf).',
  },
  '3D000': { message: 'Database bestaat niet.', hint: 'Controleer de databasenaam.' },
  '42501': {
    message: 'Geen rechten.',
    hint: 'Vraag een GRANT aan (CONNECT op de database, USAGE op het schema, SELECT op de tabel).',
  },
  '42601': { message: 'Fout in het filter.', serverHint: true },
  '42703': { message: 'Onbekende kolom in het filter.', serverHint: true },
  '42883': { message: 'Fout in het filter.', serverHint: true },
  '42804': { message: 'Fout in het filter.', serverHint: true },
  '42P01': {
    message: 'Tabel bestaat niet (meer).',
    hint: 'Vernieuw het schema met de knop boven de boom.',
  },
  '22P02': { message: 'Ongeldige waarde in het filter.', serverHint: true },
  '22007': { message: 'Ongeldige waarde in het filter.', serverHint: true },
  '22008': { message: 'Ongeldige waarde in het filter.', serverHint: true },
  '21000': { message: 'Subquery in het filter geeft meer dan één rij.', serverHint: true },
  '25006': {
    message: 'Het filter mag geen gegevens wijzigen.',
    hint: 'De data-weergave is alleen-lezen.',
  },
  '57014': { message: 'Query afgebroken.' },

  // SQL Server (error numbers).
  MSSQL_18456: {
    message: 'Inloggen mislukt.',
    hint: 'Controleer gebruiker en wachtwoord, of de database bestaat en de gebruiker er toegang toe heeft, en of SQL Server-authenticatie aan staat.',
  },
  MSSQL_4060: {
    message: 'Database bestaat niet of je hebt er geen toegang toe.',
    hint: 'Controleer de databasenaam.',
  },
  MSSQL_102: { message: 'Fout in het filter.', serverHint: true },
  MSSQL_156: { message: 'Fout in het filter.', serverHint: true },
  // An incomplete filter can make SQL Server stumble over the OFFSET/FETCH that follows it.
  MSSQL_153: { message: 'Fout in het filter.', serverHint: true },
  MSSQL_207: { message: 'Onbekende kolom in het filter.', serverHint: true },
  MSSQL_208: {
    message: 'Tabel bestaat niet (meer).',
    hint: 'Vernieuw het schema met de knop boven de boom.',
  },
  MSSQL_229: {
    message: 'Geen leesrechten op deze tabel.',
    hint: 'Vraag een GRANT SELECT aan voor deze gebruiker.',
  },
  MSSQL_245: { message: 'Ongeldige waarde in het filter.', serverHint: true },
  MSSQL_8114: { message: 'Ongeldige waarde in het filter.', serverHint: true },
  MSSQL_512: { message: 'Subquery in het filter geeft meer dan één rij.', serverHint: true },
  ECANCEL: { message: 'Query afgebroken.' },
  ESOCKET: {
    message: 'Verbinding met de server mislukt.',
    hint: 'Draait SQL Server, staat TCP/IP aan en klopt de poort?',
  },
  ELOGIN: { message: 'Inloggen mislukt.', hint: 'Controleer gebruiker en wachtwoord.' },
  ETIMEOUT: {
    message: 'Query duurde langer dan 30 seconden en is afgebroken.',
    hint: 'Verfijn het filter, of sorteer op een kolom met een index.',
  },

  // SQLite.
  SQLITE_CANTOPEN: {
    message: 'Databasebestand kan niet worden geopend.',
    hint: 'Bestaat het bestand en mag de app het lezen?',
  },
  SQLITE_NOTADB: { message: 'Dit is geen SQLite-database.', hint: 'Kies een ander bestand.' },
  SQLITE_READONLY: {
    message: 'Deze verbinding is alleen-lezen.',
    hint: 'De database is alleen-lezen geopend.',
  },
  SQLITE_BUSY: {
    message: 'De database is bezet.',
    hint: 'Een ander programma of tabblad houdt een schrijfslot vast. Probeer het zo opnieuw.',
  },
  SQLITE_SYNTAX: { message: 'Fout in het filter.', serverHint: true },
  SQLITE_NO_COLUMN: { message: 'Onbekende kolom in het filter.', serverHint: true },
  SQLITE_NO_TABLE: {
    message: 'Tabel bestaat niet (meer).',
    hint: 'Vernieuw het schema met de knop boven de boom.',
  },
  SQLITE_INTERRUPT: { message: 'Query afgebroken.' },
  PROTOCOL_CONNECTION_LOST: {
    message: 'Verbinding met de server verbroken.',
    hint: 'Verbreek en verbind opnieuw.',
  },
};

/** "The server refuses writes" and "the query was stopped", in every driver's codes. */
const READ_ONLY_CODES = new Set([
  'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
  '25006',
  'SQLITE_READONLY',
]);
const INTERRUPTED_CODES = new Set(['ER_QUERY_INTERRUPTED', '57014', 'ECANCEL', 'SQLITE_INTERRUPT']);

/** Turns anything thrown into a DbError safe to send to the renderer. Never includes secrets. */
export function toDbError(err: unknown): DbError {
  if (err instanceof AppError) {
    const fingerprint = (err as AppError & { fingerprint?: string }).fingerprint;
    return {
      code: err.code,
      message: err.message,
      ...(err.hint !== undefined && { hint: err.hint }),
      ...(fingerprint && { fingerprint }),
    };
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join('.') || 'invoer';
    return { code: 'VALIDATION', message: `Ongeldige invoer: ${field}.`, hint: first?.message };
  }
  const code =
    typeof (err as { code?: unknown })?.code === 'string'
      ? (err as { code: string }).code
      : undefined;
  const known = code ? KNOWN[code] : undefined;
  if (code && known) {
    const serverMessage = (err as { sqlMessage?: unknown }).sqlMessage;
    const hint =
      known.serverHint && typeof serverMessage === 'string'
        ? serverMessage
        : known.withServerMessage && typeof serverMessage === 'string' && serverMessage
          ? `Server: ${serverMessage.replace(/\.?$/, '.')} ${known.hint ?? ''}`.trim()
          : known.hint;
    return hint === undefined
      ? { code, message: known.message }
      : { code, message: known.message, hint };
  }
  const message = err instanceof Error && err.message ? err.message : 'Onbekende fout.';
  return { code: code ?? 'UNKNOWN', message };
}

/**
 * Errors from the SQL editor. The user wrote the SQL, so the server's own message (which names
 * the exact spot) is the most useful; only a few cases get a Dutch explanation.
 */
export function toSqlError(err: unknown): DbError {
  const known = toDbError(err);
  if (READ_ONLY_CODES.has(known.code)) {
    return {
      code: known.code,
      message: 'Deze verbinding is alleen-lezen.',
      hint: 'De server weigert wijzigingen.',
    };
  }
  if (INTERRUPTED_CODES.has(known.code)) return { code: known.code, message: 'Query afgebroken.' };
  const sqlMessage = (err as { sqlMessage?: unknown })?.sqlMessage;
  return typeof sqlMessage === 'string' ? { code: known.code, message: sqlMessage } : known;
}
