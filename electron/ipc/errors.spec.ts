import { describe, expect, it } from 'vitest';
import { connectionInputSchema } from './schemas';
import { AppError, toDbError } from './errors';

describe('toDbError', () => {
  it.each([
    ['ECONNREFUSED', 'Server weigert verbinding.'],
    ['ENOTFOUND', 'Host niet gevonden.'],
    ['ETIMEDOUT', 'Verbinding verlopen na 8 seconden.'],
    ['ER_ACCESS_DENIED_ERROR', 'Inloggen mislukt.'],
    ['ER_BAD_DB_ERROR', 'Database bestaat niet.'],
    ['ER_DBACCESS_DENIED_ERROR', 'Geen rechten op deze database.'],
  ])('maps %s to a Dutch message with a hint', (code, message) => {
    const err = Object.assign(new Error("Access denied for user 'x'@'y' (using password: YES)"), {
      code,
    });
    const result = toDbError(err);
    expect(result).toMatchObject({ code, message });
    expect(result.hint).toBeTruthy();
  });

  it('shows what the server saw when a login is refused', () => {
    const err = Object.assign(new Error('x'), {
      code: 'ER_ACCESS_DENIED_ERROR',
      sqlMessage: "Access denied for user 'dbadmin'@'localhost' (using password: NO)",
    });
    expect(toDbError(err).hint).toMatch(
      /^Server: Access denied for user 'dbadmin'@'localhost' \(using password: NO\)\. Controleer/,
    );
  });

  it('keeps AppError code, message and hint', () => {
    expect(toDbError(new AppError('NOT_FOUND', 'Weg.', 'Kijk elders.'))).toEqual({
      code: 'NOT_FOUND',
      message: 'Weg.',
      hint: 'Kijk elders.',
    });
  });

  it('reports the failing field of a validation error', () => {
    const parsed = connectionInputSchema.safeParse({ name: '' });
    expect(parsed.success).toBe(false);
    const result = toDbError(parsed.error);
    expect(result.code).toBe('VALIDATION');
    expect(result.message).toContain('name');
  });

  it('falls back to UNKNOWN for anything else', () => {
    expect(toDbError('boom')).toEqual({ code: 'UNKNOWN', message: 'Onbekende fout.' });
  });
});
