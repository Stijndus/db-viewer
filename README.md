# DB Viewer

Lichtgewicht database viewer als desktop-app, gebouwd met **Angular**, **Electron** en **Node.js**.
Stap 1 is klaar: MySQL/MariaDB-verbindingen aanmaken, testen, opslaan en openen.

## Snel starten

```bash
npm install
npm run dev        # Angular dev-server + Electron-venster
```

Een lokale MySQL om tegen te testen:

```bash
docker run -d --name dbv-mysql -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8.4
```

Maak in de app een verbinding met host `127.0.0.1`, poort `3306`, gebruiker `root`, wachtwoord `root`.

## Scripts

| Script | Wat het doet |
| --- | --- |
| `npm run dev` | Ontwikkelen met hot reload |
| `npm run start:prod` | Productiebuild draaien in Electron |
| `npm run dist` | Installer bouwen in `release/` (Windows, macOS of Linux) |
| `npm test` | Unit-tests: main-proces (Vitest) en Angular |
| `npm run test:integration` | Driver-tests tegen een echte MySQL (zie hieronder) |
| `npm run typecheck` | TypeScript-check van Electron- en Angular-code |

### Integratietests

```bash
docker run -d --name dbv-mysql -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8.4
mysql -h 127.0.0.1 -uroot -proot < scripts/setup-test-db.sql
npm run test:integration
```

De CI-workflow doet hetzelfde tegen een MySQL 8.4-container.

## Architectuur

```
Angular (renderer, geen Node)  ──window.dbApi──▶  preload (contextBridge)  ──IPC──▶  Electron main (Node.js)
                                                                                    ├─ IPC-handlers (zod-validatie)
                                                                                    ├─ ConnectionManager (pools per profiel)
                                                                                    ├─ MySQL-driver (mysql2)
                                                                                    └─ ConnectionStore (JSON + safeStorage)
```

- **De renderer ziet nooit een wachtwoord of driver.** Hij kan alleen de functies uit
  `shared/ipc-contract.ts` aanroepen; elk antwoord is een `Result` (`ok` + data, of een `DbError`).
- **Wachtwoorden** worden versleuteld met Electron `safeStorage` (Keychain, DPAPI, libsecret) en opgeslagen in
  `connections.json` in de userData-map. Is er geen sleutelhanger (bijv. Linux zonder keyring), dan slaat de app
  geen wachtwoord op en vraagt het bij verbinden.
- **Exacte waarden:** `BIGINT`, `DECIMAL` en `DATETIME` komen als tekst binnen, zodat er geen precisie of
  tijdzone verloren gaat.
- **Venster:** `contextIsolation`, `sandbox`, geen `nodeIntegration`, een Content-Security-Policy, en IPC
  wordt alleen beantwoord voor ons eigen venster.

## Mappen

```
electron/        main-proces: main.ts, preload.ts, db/, ipc/, store/
shared/          types en IPC-contract, gedeeld door Electron en Angular
src/app/         Angular-UI: core/db-api.ts, features/connections/
scripts/         build van de Electron-bundels, test-database
```

## Volgende stappen

1. ~~Verbinding maken (MySQL)~~
2. Schema-boom: databases, tabellen, views, kolommen
3. Tabeldata met paginering en virtual scroll
4. SQL-editor met resultaatgrid
5. Meer drivers: PostgreSQL, SQL Server, SQLite
