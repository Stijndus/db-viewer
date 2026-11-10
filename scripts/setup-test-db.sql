-- Test fixtures for `npm run test:integration`. Run as root:
--   mysql -h 127.0.0.1 -u root -p < scripts/setup-test-db.sql
CREATE DATABASE IF NOT EXISTS app_dev;
CREATE DATABASE IF NOT EXISTS secret_db;

CREATE USER IF NOT EXISTS 'viewer'@'%' IDENTIFIED BY 'test123';
CREATE USER IF NOT EXISTS 'viewer'@'localhost' IDENTIFIED BY 'test123';
GRANT ALL ON app_dev.* TO 'viewer'@'%';
GRANT ALL ON app_dev.* TO 'viewer'@'localhost';
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
