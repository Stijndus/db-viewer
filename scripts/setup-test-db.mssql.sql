-- Test fixtures for the SQL Server integration tests. Batches are separated by GO.
-- Run with: node scripts/setup-test-db.mssql.mjs   (as sa; see that file for the connection)
IF DB_ID('app_dev') IS NOT NULL
BEGIN
  ALTER DATABASE app_dev SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE app_dev;
END
GO
CREATE DATABASE app_dev;
GO
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'viewer')
  CREATE LOGIN viewer WITH PASSWORD = 'Test123!viewer', CHECK_POLICY = OFF;
GO
USE app_dev;
GO
CREATE USER viewer FOR LOGIN viewer;
ALTER ROLE db_owner ADD MEMBER viewer;
GO
CREATE SCHEMA shop;
GO
CREATE TABLE dbo.orders (id bigint PRIMARY KEY, total decimal(20, 2), created_at datetime2(0));
-- 2^53 + 1: would lose precision as a JavaScript number.
INSERT INTO dbo.orders VALUES (9007199254740993, 129.95, '2026-11-10 14:10:00');

CREATE TABLE dbo.customers (
  id int IDENTITY PRIMARY KEY,
  email nvarchar(255) NOT NULL UNIQUE,
  status varchar(10) NOT NULL DEFAULT 'open',
  note nvarchar(50) DEFAULT N'it''s',
  created_at datetime DEFAULT GETDATE()
);
CREATE INDEX idx_status ON dbo.customers (status);
EXEC sp_addextendedproperty 'MS_Description', 'Klanten', 'SCHEMA', 'dbo', 'TABLE', 'customers';

CREATE TABLE dbo.[Order Items] (id int PRIMARY KEY, [Unit Price] decimal(10, 2) NOT NULL);
GO
CREATE VIEW dbo.paid_orders AS SELECT id, total FROM dbo.orders;
GO
CREATE PROCEDURE dbo.refresh_stats AS SELECT 1 AS one; SELECT 2 AS two;
GO
CREATE FUNCTION dbo.order_count() RETURNS int AS BEGIN RETURN (SELECT COUNT(*) FROM dbo.orders) END;
GO
CREATE TABLE dbo.events (
  id int PRIMARY KEY,
  kind varchar(20) NOT NULL,
  amount decimal(10, 2),
  created_at datetime2(0) NOT NULL
);
WITH n AS (SELECT TOP (2500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
             FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.events
SELECT i,
       CASE i % 3 WHEN 0 THEN 'click' WHEN 1 THEN 'view' ELSE 'buy' END,
       CASE WHEN i % 10 = 0 THEN NULL ELSE ROUND(i * 1.5, 2) END,
       DATEADD(MINUTE, i, '2026-01-01 00:00:00')
  FROM n;
UPDATE STATISTICS dbo.events;

CREATE TABLE dbo.value_types (
  id int PRIMARY KEY,
  big decimal(20, 0),
  money_value money,
  payload varbinary(10),
  flag bit,
  body nvarchar(max),
  missing nvarchar(10),
  uid uniqueidentifier,
  at datetimeoffset(3),
  day date,
  moment time(3),
  precise datetime2(7),
  legacy datetime
);
INSERT INTO dbo.value_types VALUES
  (1, 18446744073709551615, 1234.5678, 0xDEADBEEF, 1, REPLICATE(CAST(N'x' AS nvarchar(max)), 5000), NULL,
   '6F9619FF-8B86-D011-B42D-00C04FC964FF', '2026-11-10 14:10:00.123 +01:00', '2026-11-10', '14:10:00.5',
   '2026-11-10 14:10:00.1234567', '2026-11-10 14:10:00.997');

CREATE TABLE dbo.[we]]ird] (id int PRIMARY KEY, label nvarchar(10));
INSERT INTO dbo.[we]]ird] VALUES (1, N'ok');

CREATE TABLE dbo.counter (n int);

CREATE TABLE dbo.editable (
  id int IDENTITY PRIMARY KEY,
  name nvarchar(20) NOT NULL,
  qty int,
  note nvarchar(50) DEFAULT N'n/a'
);
INSERT INTO dbo.editable (name, qty, note) VALUES (N'appel', 3, N'rood'), (N'peer', 5, NULL), (N'kiwi', 7, N'groen');

CREATE TABLE dbo.pairs (a int, b int, v nvarchar(10), PRIMARY KEY (a, b));
INSERT INTO dbo.pairs VALUES (1, 1, N'een'), (1, 2, N'twee');

CREATE TABLE dbo.nopk (x int);

CREATE TABLE dbo.[wat?] (id int PRIMARY KEY, label nvarchar(20));
INSERT INTO dbo.[wat?] VALUES (1, N'echt?'), (2, N'ja');

CREATE TABLE shop.orders (id int PRIMARY KEY, item nvarchar(20));
INSERT INTO shop.orders VALUES (1, N'boek');
GO
