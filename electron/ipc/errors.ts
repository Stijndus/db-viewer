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
  if (code && KNOWN[code]) {
    return { code, ...KNOWN[code] };
  }
  const message = err instanceof Error && err.message ? err.message : 'Onbekende fout.';
  return { code: code ?? 'UNKNOWN', message };
}
