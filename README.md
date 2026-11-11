# DB Viewer

Lichtgewicht database viewer als desktop-app, gebouwd met **Angular**, **Electron** en **Node.js**.
Klaar: MySQL/MariaDB-verbindingen beheren (stap 1) en het schema verkennen (stap 2).

## Downloaden

Kant-en-klare Windows-versies staan bij [Releases](https://github.com/Stijndus/db-viewer/releases/latest):
een installer (`DB-Viewer-Setup-x.y.z.exe`) en een portable versie zonder installatie
(`DB-Viewer-x.y.z-portable.exe`). De app is nog niet ondertekend: bij de melding van SmartScreen
klik je op **Meer info** en **Toch uitvoeren**.

## Snel starten

Vereist **Node.js 24 LTS** (of 22.22.3+). Controleer met `node --version`.

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

## Releases

Elke afgeronde stap krijgt een release: stap *N* wordt versie `0.N.0`. Een versietag start de
workflow `.github/workflows/release.yml`, die op Windows test, bouwt en de `.exe`-bestanden publiceert.

```bash
# 1. Release notes schrijven in .github/release-notes/v0.3.0.md (optioneel; anders automatisch)
# 2. Versie ophogen, committen en taggen, dan pushen:
npm version 0.3.0 -m "Release v%s"
git push --follow-tags
```

De workflow stopt als de tag niet overeenkomt met de versie in `package.json`.

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
src/app/         Angular-UI: core/db-api.ts, features/connections/, features/schema/
scripts/         build van de Electron-bundels, test-database
```

## Volgende stappen

1. ~~Verbinding maken (MySQL)~~
2. ~~Schema-boom: databases, tabellen, views, kolommen~~
3. Tabeldata met paginering en virtual scroll
4. SQL-editor met resultaatgrid
5. Meer drivers: PostgreSQL, SQL Server, SQLite
