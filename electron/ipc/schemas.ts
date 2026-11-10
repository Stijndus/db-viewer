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
