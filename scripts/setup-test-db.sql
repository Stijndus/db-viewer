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
