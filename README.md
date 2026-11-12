# DB Viewer

Lichtgewicht database viewer als desktop-app, gebouwd met **Angular**, **Electron** en **Node.js**.
Werkt met **MySQL/MariaDB**, **PostgreSQL**, **SQL Server** en **SQLite**.

Klaar: verbindingen beheren (stap 1), het schema verkennen (stap 2), tabeldata bekijken (stap 3), een
SQL-editor met automatische updates (stap 4), data wijzigen in de grid (stap 5), tabellen en SQL naast
elkaar in tabbladen (stap 6), drivers voor PostgreSQL, SQL Server en SQLite (stap 7) en SSH-tunnels
en release notes in de app (stap 8), openen vanaf de opdrachtregel (stap 9) importeren en exporteren (stap 10) en thema's en zoomen (stap 11).

## Opdrachtregel

```
db-viewer "Productie"                                  opgeslagen verbinding
db-viewer mysql://stijn@db.example.com:3306/shop        URL (mysql, mariadb, postgres, mssql, sqlite)
db-viewer C:\data\app.db                               SQLite-bestand
db-viewer --db-type postgres --host db --user app --save   losse opties, en bewaren
db-viewer mysql://app@localhost/shop?ssh=stijn@server   via SSH-tunnel
db-viewer --help                                        alle opties
```

Wachtwoorden kunnen via `DBV_PASSWORD` en `DBV_SSH_PASSWORD`. Zonder `--save` is de verbinding
tijdelijk. Draait de app al, dan opent de verbinding in hetzelfde venster. De parser staat in
`electron/cli.ts`, het openen in `electron/launch.ts`; de installer zet `db-viewer.cmd` in het PATH
(`build/installer.nsh`, gecontroleerd door de workflow Installer op Windows).

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

Een lokale database om tegen te testen:

```bash
docker run -d --name dbv-mysql -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8.4
docker run -d --name dbv-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
docker run -d --name dbv-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Str0ng!Passw0rd' -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
```

Voor SQLite is niets nodig: kies in de app gewoon een `.db`-bestand.

## Scripts

| Script                     | Wat het doet                                             |
| -------------------------- | -------------------------------------------------------- |
| `npm run dev`              | Ontwikkelen met hot reload                               |
| `npm run start:prod`       | Productiebuild draaien in Electron                       |
| `npm run dist`             | Installer bouwen in `release/` (Windows, macOS of Linux) |
| `npm test`                 | Unit-tests: main-proces (Vitest) en Angular              |
| `npm run test:integration` | Driver-tests tegen echte databases (zie hieronder)       |
| `npm run typecheck`        | TypeScript-check van Electron- en Angular-code           |

### Integratietests

Met de containers van hierboven:

```bash
mysql -h 127.0.0.1 -uroot -proot < scripts/setup-test-db.sql
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -f scripts/setup-test-db.postgres.sql
node scripts/setup-test-db.mssql.mjs
npm run test:integration
```

Tests van een database die niet bereikbaar is worden overgeslagen (`MYSQL_TEST_HOST`, `PG_TEST_HOST`,
`MSSQL_TEST_HOST`). De SQLite-tests draaien altijd mee, ook in `npm test`. De CI-workflow test tegen
MySQL 8.4, PostgreSQL 16 en SQL Server 2022.

## Releases

Elke afgeronde stap krijgt een release: stap _N_ wordt versie `0.N.0`. Zodra er een nieuwe versie
in `package.json` op `main` staat, test en bouwt `.github/workflows/release.yml` de app op Windows,
maakt de tag aan en publiceert de `.exe`-bestanden als GitHub Release. Pushes zonder nieuwe versie
doen niets.

```bash
# 1. Release notes schrijven in .github/release-notes/v0.3.0.md (optioneel; anders automatisch)
# 2. Versie ophogen en pushen:
npm version 0.3.0 --no-git-tag-version
git commit -am "Release v0.3.0"
git push
```

### Automatische updates

De geïnstalleerde app (niet de portable versie) gebruikt `electron-updater` met GitHub Releases als
bron. De release-workflow uploadt daarvoor naast de `.exe` ook `latest.yml` en de `.blockmap`. Updates
werken alleen omdat de repository openbaar is.

## Architectuur

```
Angular (renderer, geen Node)  ──window.dbApi──▶  preload (contextBridge)  ──IPC──▶  Electron main (Node.js)
                                                                                    ├─ IPC-handlers (zod-validatie)
                                                                                    ├─ ConnectionManager (pools per profiel)
                                                                                    ├─ drivers: MySQL (mysql2), PostgreSQL (pg),
                                                                                    │  SQL Server (mssql), SQLite (node:sqlite, eigen proces)
                                                                                    └─ ConnectionStore (JSON + safeStorage)
```

- **De renderer ziet nooit een wachtwoord of driver.** Hij kan alleen de functies uit
  `shared/ipc-contract.ts` aanroepen; elk antwoord is een `Result` (`ok` + data, of een `DbError`).
- **Wachtwoorden** worden versleuteld met Electron `safeStorage` (Keychain, DPAPI, libsecret) en opgeslagen in
  `connections.json` in de userData-map. Is er geen sleutelhanger (bijv. Linux zonder keyring), dan slaat de app
  geen wachtwoord op en vraagt het bij verbinden.
- **Data alleen-lezen:** elke data-query draait in een `READ ONLY`-transactie (SQL Server: een
  transactie die altijd wordt teruggedraaid; SQLite: `PRAGMA query_only`) met een limiet van
  30 seconden. Het WHERE-filter van de gebruiker staat op eigen regels tussen haakjes, zodat een
  `--`-commentaar de `LIMIT` niet kan wegnemen.
- **SQL-editor:** elk tabblad heeft een eigen serververbinding (`USE`, variabelen en transacties
  blijven staan; sluiten draait een open transactie terug). De rijlimiet werkt via
  `sql_select_limit`, Stop via `KILL QUERY`. Schrijvende statements worden eerst bevestigd.
- **Alleen-lezen-verbindingen:** de editor-sessie draait met `SET SESSION TRANSACTION READ ONLY`, dus
  de server weigert wijzigingen; de app blokkeert ook pogingen om dat terug te zetten. Dit beschermt
  tegen vergissingen. Voor echte afscherming gebruik je een databasegebruiker met alleen `SELECT`.
- **Bewerken in de grid:** wijzigingen gaan in één transactie (`shared/changes.ts` maakt de SQL,
  dezelfde die de gebruiker bij "SQL bekijken" ziet). De server controleert eerst dat het een tabel is
  en dat de primaire sleutel klopt; elke `UPDATE`/`DELETE` heeft `LIMIT 1` en moet precies één rij
  raken, anders volgt een rollback.
- **Thema's:** `src/app/core/themes.ts` definieert per thema elke kleurvariabele; `styles.scss` en de
  SQL-editor gebruiken alleen die variabelen. `themes.spec.ts` controleert het contrast (WCAG) van elk
  thema. Het thema staat in `localStorage` en wordt vóór het opstarten van Angular toegepast; de
  achtergrond en de zoom staan ook in `window.json`, zodat het venster meteen in de goede kleur opent.
- **Import en export:** `electron/transfer/`. Een SQL-import leest het bestand in stukken
  (`ScriptSplitter` in `shared/sql.ts` houdt quotes, `DELIMITER` en `GO` bij over de stukken heen) en
  voert het in batches uit op een eigen editor-sessie. Archieven gaan via de meegeleverde 7-Zip
  (`7zip-bin`, uitgepakt naast `app.asar`), als stream: niets onversleuteld op schijf, behalve bij het
  maken van een versleutelde zip. Een export leest rijen per batch (`streamRows` per driver, met
  volledige waarden) en schrijft CSV, JSON, SQL of xlsx (eigen streaming writer in `xlsx.ts`).
- **SSH-tunnel:** `electron/db/ssh-tunnel.ts` logt in met `ssh2` (wachtwoord, sleutelbestand,
  OpenSSH-agent of Pageant) en opent een lokale poort op `127.0.0.1` die elke socket doorstuurt
  naar de database, zoals `ssh -L`. Pool en editor-tabbladen delen één SSH-login; valt SSH weg, dan
  logt de volgende socket opnieuw in. De serversleutel wordt bij het eerste gebruik bevestigd
  (SHA256-vingerafdruk, opgeslagen in het profiel) en daarna gecontroleerd. TLS naar de database
  controleert het certificaat tegen de echte hostnaam, niet tegen `127.0.0.1`.
- **Tabbladen:** `WorkspaceStore` beheert één rij tabbladen per verbinding (tabellen en SQL) en
  bewaart volgorde en actief tabblad in `localStorage`. Geopende tabbladen blijven gerenderd (verborgen
  als ze niet actief zijn), zodat pagina, filter, scrollpositie en niet-opgeslagen wijzigingen blijven.
- **Exacte waarden:** `BIGINT`, `DECIMAL` en `DATETIME` komen als tekst binnen, zodat er geen precisie of
  tijdzone verloren gaat. PostgreSQL levert alles als tekst (alleen `bytea` als bytes); SQL Server zet
  decimalen, geld en datums in de data-weergave server-side om naar tekst; SQLite leest gehele getallen
  als `BigInt`.
- **Per database:**

  |               | Eerste niveau in de boom | Editor: sessie, limiet, Stop                         | Alleen-lezen                                   |
  | ------------- | ------------------------ | ---------------------------------------------------- | ---------------------------------------------- |
  | MySQL/MariaDB | databases                | eigen verbinding, `sql_select_limit`, `KILL QUERY`   | server (`READ ONLY`-sessie) + app              |
  | PostgreSQL    | schema's van de database | eigen verbinding, cursor, `pg_cancel_backend`        | server (`default_transaction_read_only`) + app |
  | SQL Server    | schema's van de database | eigen verbinding, batches op `GO`, attention-signaal | app: alleen lees-statements                    |
  | SQLite        | `main` (en `ATTACH`)     | eigen proces per tabblad; Stop beëindigt dat proces  | bestand alleen-lezen geopend                   |

  SQLite draait in een Electron utility-proces per verbinding: `node:sqlite` is synchroon en alleen
  zo te onderbreken. Bij SQL Server splitst de editor alleen op `GO`, zoals SSMS: variabelen leven per
  batch, en een batch met meerdere statements geeft meerdere resultaten.

- **Venster:** `contextIsolation`, `sandbox`, geen `nodeIntegration`, een Content-Security-Policy, en IPC
  wordt alleen beantwoord voor ons eigen venster.

## Mappen

```
electron/        main-proces: main.ts, preload.ts, db/, ipc/, store/
shared/          types en IPC-contract, gedeeld door Electron en Angular
src/app/         Angular-UI: core/, features/connections/, schema/, data/, sql/, workspace/
scripts/         build van de Electron-bundels, testdatabases per type
```

## Volgende stappen

1. ~~Verbinding maken (MySQL)~~
2. ~~Schema-boom: databases, tabellen, views, kolommen~~
3. ~~Tabeldata met paginering en virtual scroll~~
4. ~~SQL-editor met resultaatgrid~~
5. ~~Data wijzigen in de grid~~
6. ~~Tabellen als tabbladen, in één rij met de SQL-tabbladen~~
7. ~~Meer drivers: PostgreSQL, SQL Server, SQLite~~
8. ~~SSH-tunnel en release notes in de app~~
9. ~~Openen vanaf de opdrachtregel~~ (0.9.0)
10. ~~SQL-import (ook uit versleutelde zip/7z) en export naar CSV, Excel, JSON en SQL~~ (0.10.0)
11. ~~Thema's (zeven, met kiezer en voorbeeld) en zoomen~~ (0.11.0; Codalt Donker en Licht in 0.11.1)
12. ~~Contextmenu's per item in de linkerbalk~~ (0.12.0)
13. CSV, JSON en Excel importeren in een tabel (0.13.0)
14. Query-geschiedenis (0.14.0), daarna testen en 1.0.0
