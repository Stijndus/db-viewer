import { z } from 'zod';

export const idSchema = z.string().uuid();

export const connectionInputSchema = z.object({
  name: z.string().trim().min(1, 'Naam is verplicht').max(100),
  type: z.enum(['mysql', 'postgres', 'mssql', 'sqlite']),
  host: z.string().trim().min(1, 'Host is verplicht').max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().max(64),
  user: z.string().trim().min(1, 'Gebruiker is verplicht').max(255),
  ssl: z.boolean(),
  allowSelfSigned: z.boolean(),
  color: z.enum(['green', 'orange', 'red', 'blue']),
  password: z.string().max(1024).optional(),
  savePassword: z.boolean(),
});

export const optionalIdSchema = idSchema.optional();
export const optionalPasswordSchema = z.string().max(1024).optional();

/**
 * A database, table or view name. MySQL allows almost any character (spaces, quotes, unicode),
 * so no trimming or pattern: names only travel as query parameters, never as SQL text.
 */
export const identifierSchema = z
  .string()
  .min(1, 'Naam ontbreekt')
  .max(64, 'Naam is langer dan 64 tekens')
  .refine((s) => !s.includes('\0'), 'Ongeldig teken in naam');

export const whereSchema = z.string().max(10_000, 'Filter is langer dan 10.000 tekens').optional();

export const rowsRequestSchema = z.object({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(1000),
  orderBy: z
    .array(z.object({ column: identifierSchema, direction: z.enum(['asc', 'desc']) }))
    .max(16),
  where: whereSchema,
});
