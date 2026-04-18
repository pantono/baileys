# Installation

## Prerequisites

- Node.js ≥ 18
- MySQL 5.7+ or MariaDB 10.3+

## 1. Create the database and user

Connect to MySQL as root (or another privileged user) and run:

```sql
CREATE DATABASE IF NOT EXISTS baileys CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'baileys'@'%' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON baileys.* TO 'baileys'@'%';
FLUSH PRIVILEGES;
```

Replace `'change-me'` with a strong password and restrict the host (`%`) as needed.

## 2. Create the tables

Run the following against the `baileys` database:

```sql
-- Per-number configuration.
-- One row per WhatsApp number; all webhook/reconnect settings live here.
CREATE TABLE IF NOT EXISTS wa_numbers (
  id                       INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  phone_number             VARCHAR(30)     NOT NULL,
  webhook_url              VARCHAR(500)    NOT NULL DEFAULT '',
  webhook_timeout_ms       INT UNSIGNED    NOT NULL DEFAULT 8000,
  webhook_max_retries      TINYINT UNSIGNED NOT NULL DEFAULT 8,
  webhook_retry_base_ms    INT UNSIGNED    NOT NULL DEFAULT 1000,
  webhook_retry_max_ms     INT UNSIGNED    NOT NULL DEFAULT 30000,
  event_retention          INT UNSIGNED    NOT NULL DEFAULT 2000,
  reconnect_base_ms        INT UNSIGNED    NOT NULL DEFAULT 1500,
  reconnect_max_ms         INT UNSIGNED    NOT NULL DEFAULT 30000,
  full_history_on_reconnect TINYINT(1)    NOT NULL DEFAULT 1,
  created_at               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_phone_number (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Main WhatsApp credentials (one row per number).
CREATE TABLE IF NOT EXISTS wa_auth_creds (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_number VARCHAR(30)  NOT NULL,
  creds_data   LONGTEXT     NOT NULL,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_phone_number (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Signal protocol keys (pre-keys, sessions, sender-keys, etc.).
CREATE TABLE IF NOT EXISTS wa_auth_keys (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  phone_number VARCHAR(30)   NOT NULL,
  key_type     VARCHAR(100)  NOT NULL,
  key_id       VARCHAR(255)  NOT NULL,
  key_data     LONGTEXT,
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_phone_type_id (phone_number, key_type, key_id),
  INDEX idx_phone_number (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Event log (replaces the flat events.log file).
CREATE TABLE IF NOT EXISTS wa_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_number    VARCHAR(30)     NOT NULL,
  event_timestamp DATETIME(3)     NOT NULL,
  event_type      VARCHAR(100)    NOT NULL,
  payload         LONGTEXT,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_phone_timestamp (phone_number, event_timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Webhook delivery targets (multiple URLs per number).
CREATE TABLE IF NOT EXISTS wa_webhook_targets (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_number VARCHAR(30)  NOT NULL,
  url          VARCHAR(500) NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_phone_number (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Persistent webhook delivery queue (survives restarts; rows deleted on success).
CREATE TABLE IF NOT EXISTS wa_webhook_queue (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  phone_number  VARCHAR(30)      NOT NULL,
  webhook_url   VARCHAR(500)     NOT NULL DEFAULT '',
  payload       LONGTEXT         NOT NULL,
  attempt       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  enqueued_at   DATETIME(3)      NOT NULL,
  next_retry_at DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_phone_enqueued (phone_number, enqueued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## Migrating from a previous version

If you have an existing installation (with `webhook_url` in `wa_numbers`), run:

```sql
-- Add webhook_url column to the queue table
ALTER TABLE wa_webhook_queue
  ADD COLUMN webhook_url VARCHAR(500) NOT NULL DEFAULT '' AFTER phone_number;

-- Create the new targets table
CREATE TABLE IF NOT EXISTS wa_webhook_targets (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_number VARCHAR(30)  NOT NULL,
  url          VARCHAR(500) NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_phone_number (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Migrate existing single webhook URLs to the new targets table (skips empty URLs)
INSERT INTO wa_webhook_targets (phone_number, url)
  SELECT phone_number, webhook_url FROM wa_numbers WHERE webhook_url != '';

-- Clear the old queue (in-flight items have no target URL and cannot be delivered)
TRUNCATE TABLE wa_webhook_queue;
```

After migrating, the `webhook_url` column in `wa_numbers` is no longer used.

## 3. Configure the application

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Key variables:

| Variable           | Description                                                  |
|--------------------|--------------------------------------------------------------|
| `WHATSAPP_NUMBER`  | The phone number this instance manages (digits only, no `+`) |
| `API_KEY`          | Shared secret for all API requests                           |
| `DB_HOST`          | MySQL host                                                   |
| `DB_PORT`          | MySQL port (default `3306`)                                  |
| `DB_USER`          | MySQL user                                                   |
| `DB_PASSWORD`      | MySQL password                                               |
| `DB_NAME`          | MySQL database name                                          |

## 4. Install dependencies and start

```bash
npm install
npm start
```

On first start the service will create a row in `wa_numbers` for the configured
`WHATSAPP_NUMBER` using default values. Webhook targets are managed via the
`/webhook-targets` API endpoints (changes take effect immediately, no restart needed).
Other settings (timeouts, retry counts) can be updated directly in the `wa_numbers`
table; restart the service to apply them.

## 5. Multiple numbers

Each additional WhatsApp number requires its own running process with a different
`WHATSAPP_NUMBER` value in its `.env`. All processes can share the same MySQL
database; rows are partitioned by `phone_number` in every table.

To pre-configure a number before starting it:

```sql
INSERT INTO wa_numbers (phone_number) VALUES ('15559876543')
ON DUPLICATE KEY UPDATE phone_number = phone_number;

INSERT INTO wa_webhook_targets (phone_number, url)
VALUES ('15559876543', 'https://your-server/webhook');
```
