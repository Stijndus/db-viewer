// Loads scripts/setup-test-db.mssql.sql into a SQL Server as sa, batch by batch (split on GO).
//   MSSQL_TEST_HOST=127.0.0.1 MSSQL_SA_PASSWORD=... node scripts/setup-test-db.mssql.mjs
import { readFileSync } from 'node:fs';
import sql from 'mssql';

const text = readFileSync(new URL('./setup-test-db.mssql.sql', import.meta.url), 'utf8');
const batches = text
  .split(/^\s*GO\s*$/im)
  .map((b) => b.trim())
  .filter(Boolean);

const pool = await sql.connect({
  server: process.env.MSSQL_TEST_HOST ?? '127.0.0.1',
  port: Number(process.env.MSSQL_TEST_PORT ?? 1433),
  user: 'sa',
  password: process.env.MSSQL_SA_PASSWORD ?? 'Str0ng!Passw0rd',
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 120_000,
  pool: { max: 1 }, // USE must stick: every batch on the same connection
});
for (const batch of batches) await pool.request().batch(batch);
await pool.close();
console.log(`SQL Server: ${batches.length} batches geladen.`);
