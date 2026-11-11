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
}

/** MySQL / Node network errors translated for the UI. Keyed by `err.code`. */
const KNOWN: Record<string, KnownError> = {
  ECONNREFUSED: {
    message: 'Server weigert verbinding.',
    hint: 'Draait MySQL en klopt de poort (standaard 3306)?',
  },
  ENOTFOUND: { message: 'Host niet gevonden.', hint: 'Controleer de hostnaam of je VPN.' },
  EAI_AGAIN: { message: 'Host niet gevonden.', hint: 'Controleer de hostnaam of je netwerk.' },
  ETIMEDOUT: {
    message: 'Verbinding verlopen na 8 seconden.',
    hint: 'Firewall, bind-address van MySQL of verkeerde host.',
  },
  ECONNRESET: { message: 'Verbinding onverwacht verbroken.', hint: 'Vereist de server SSL?' },
  ER_ACCESS_DENIED_ERROR: {
    message: 'Inloggen mislukt.',
    hint: "Controleer gebruiker, wachtwoord en of de gebruiker vanaf deze host mag inloggen (user@'%').",
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
  PROTOCOL_CONNECTION_LOST: {
    message: 'Verbinding met de server verbroken.',
    hint: 'Verbreek en verbind opnieuw.',
  },
};

/** Turns anything thrown into a DbError safe to send to the renderer. Never includes secrets. */
export function toDbError(err: unknown): DbError {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, hint: err.hint };
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
    const hint = known.serverHint && typeof serverMessage === 'string' ? serverMessage : known.hint;
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
  if (known.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION') {
    return {
      code: known.code,
      message: 'Deze verbinding is alleen-lezen.',
      hint: 'De server weigert wijzigingen.',
    };
  }
  if (known.code === 'ER_QUERY_INTERRUPTED')
    return { code: known.code, message: 'Query afgebroken.' };
  const sqlMessage = (err as { sqlMessage?: unknown })?.sqlMessage;
  return typeof sqlMessage === 'string' ? { code: known.code, message: sqlMessage } : known;
}
