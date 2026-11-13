-- Test fixtures for `npm run test:integration`. Run as root:
--   mysql -h 127.0.0.1 -u root -p < scripts/setup-test-db.sql
CREATE DATABASE IF NOT EXISTS app_dev;
CREATE DATABASE IF NOT EXISTS secret_db;

CREATE USER IF NOT EXISTS 'viewer'@'%' IDENTIFIED BY 'test123';
CREATE USER IF NOT EXISTS 'viewer'@'localhost' IDENTIFIED BY 'test123';
GRANT ALL ON app_dev.* TO 'viewer'@'%';
-- MySQL 8 logs binary by default: triggers from a non-SUPER user (as in an imported dump) need this.
SET GLOBAL log_bin_trust_function_creators = 1;
GRANT ALL ON app_dev.* TO 'viewer'@'localhost';
-- The context-menu test creates and drops this database.
GRANT ALL ON ctx_weg.* TO 'viewer'@'%';
GRANT ALL ON ctx_weg.* TO 'viewer'@'localhost';
-- …and create one from the tree ("Nieuwe database…").
GRANT ALL ON ctx_nieuw.* TO 'viewer'@'%';
GRANT ALL ON ctx_nieuw.* TO 'viewer'@'localhost';
FLUSH PRIVILEGES;

CREATE TABLE IF NOT EXISTS app_dev.orders (
  id BIGINT PRIMARY KEY,
  total DECIMAL(20, 2),
  created_at DATETIME
);
-- 2^53 + 1: would lose precision as a JavaScript number.
REPLACE INTO app_dev.orders VALUES (9007199254740993, 129.95, '2026-11-10 14:10:00');

-- Schema fixtures (step 2): keys, defaults, a view, routines and an awkward table name.
CREATE TABLE IF NOT EXISTS app_dev.customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  note VARCHAR(50) DEFAULT 'it''s',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_status (status)
) COMMENT = 'Klanten';

CREATE TABLE IF NOT EXISTS app_dev.`Order Items` (
  id INT PRIMARY KEY,
  `Unit Price` DECIMAL(10, 2) NOT NULL
);

CREATE OR REPLACE VIEW app_dev.paid_orders AS SELECT id, total FROM app_dev.orders;

DROP PROCEDURE IF EXISTS app_dev.refresh_stats;
CREATE PROCEDURE app_dev.refresh_stats() SELECT 1;

DROP FUNCTION IF EXISTS app_dev.order_count;
CREATE FUNCTION app_dev.order_count() RETURNS INT READS SQL DATA RETURN (SELECT COUNT(*) FROM app_dev.orders);

-- Must stay invisible to the viewer user.
CREATE TABLE IF NOT EXISTS secret_db.hidden (id INT PRIMARY KEY);

-- Data fixtures (step 3): enough rows to page and scroll, and every awkward kind of value.
DROP TABLE IF EXISTS app_dev.events;
CREATE TABLE app_dev.events (
  id INT PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,
  amount DECIMAL(10, 2),
  created_at DATETIME NOT NULL
);
INSERT INTO app_dev.events (id, kind, amount, created_at)
SELECT n,
       ELT(1 + n % 3, 'click', 'view', 'buy'),
       CASE WHEN n % 10 = 0 THEN NULL ELSE ROUND(n * 1.5, 2) END,
       TIMESTAMPADD(MINUTE, n, '2026-01-01 00:00:00')
  FROM (SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 1 AS n
          FROM (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a,
               (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b,
               (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c,
               (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2) e) numbers
 WHERE n <= 2500;

DROP TABLE IF EXISTS app_dev.value_types;
CREATE TABLE app_dev.value_types (
  id INT PRIMARY KEY,
  big BIGINT UNSIGNED,
  doc JSON,
  payload BLOB,
  flags BIT(8),
  body LONGTEXT,
  missing VARCHAR(10)
);
INSERT INTO app_dev.value_types VALUES
  (1, 18446744073709551615, '{"a": 1, "b": [true, null]}', UNHEX('DEADBEEF'), b'10100101', REPEAT('x', 5000), NULL);

-- A table name containing a backtick: must be quoted correctly, never injectable.
DROP TABLE IF EXISTS app_dev.`we``ird`;
CREATE TABLE app_dev.`we``ird` (id INT PRIMARY KEY, label VARCHAR(10));
INSERT INTO app_dev.`we``ird` VALUES (1, 'ok');

-- SQL editor fixtures (step 4): a function that writes, to prove read-only connections hold.
DROP TABLE IF EXISTS app_dev.counter;
CREATE TABLE app_dev.counter (n INT);
DROP FUNCTION IF EXISTS app_dev.bump;
DELIMITER $$
CREATE FUNCTION app_dev.bump() RETURNS INT DETERMINISTIC MODIFIES SQL DATA
BEGIN
  INSERT INTO app_dev.counter VALUES (1);
  RETURN 1;
END$$
DELIMITER ;

-- Grid editing fixtures (step 5).
DROP TABLE IF EXISTS app_dev.editable;
CREATE TABLE app_dev.editable (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(20) NOT NULL,
  qty INT,
  note VARCHAR(50) DEFAULT 'n/a'
);
INSERT INTO app_dev.editable (name, qty, note) VALUES ('appel', 3, 'rood'), ('peer', 5, NULL), ('kiwi', 7, 'groen');

DROP TABLE IF EXISTS app_dev.pairs;
CREATE TABLE app_dev.pairs (a INT, b INT, v VARCHAR(10), PRIMARY KEY (a, b));
INSERT INTO app_dev.pairs VALUES (1, 1, 'een'), (1, 2, 'twee');

DROP TABLE IF EXISTS app_dev.nopk;
CREATE TABLE app_dev.nopk (x INT);

-- A question mark in a table name and in data: must never be taken for a query parameter.
DROP TABLE IF EXISTS app_dev.`wat?`;
CREATE TABLE app_dev.`wat?` (id INT PRIMARY KEY, label VARCHAR(20));
INSERT INTO app_dev.`wat?` VALUES (1, 'echt?'), (2, 'ja');
