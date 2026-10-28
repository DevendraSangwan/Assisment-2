import { Pool } from "pg";
import { config } from "./config.js";

export const db = new Pool({ connectionString: config.DATABASE_URL });

export async function initializeDatabase(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS senders (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      hourly_limit INTEGER NOT NULL DEFAULT 200 CHECK (hourly_limit > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, email)
    );
    ALTER TABLE senders
      ADD COLUMN IF NOT EXISTS hourly_limit INTEGER NOT NULL DEFAULT 200;
    CREATE TABLE IF NOT EXISTS email_jobs (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES senders(id) ON DELETE RESTRICT,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'sending', 'sent', 'failed')),
      batch_id UUID NOT NULL,
      idempotency_key TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, idempotency_key, recipient)
    );
    CREATE INDEX IF NOT EXISTS email_jobs_user_status_schedule
      ON email_jobs(user_id, status, scheduled_at);
    CREATE INDEX IF NOT EXISTS email_jobs_sender_schedule
      ON email_jobs(sender_id, scheduled_at);
    CREATE TABLE IF NOT EXISTS email_outbox (
      email_id UUID PRIMARY KEY REFERENCES email_jobs(id) ON DELETE CASCADE,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS idempotency_requests (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      batch_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS email_outbox_unpublished
      ON email_outbox(created_at) WHERE published_at IS NULL;
    CREATE TABLE IF NOT EXISTS slack_connections (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_webhook TEXT NOT NULL,
      team_name TEXT,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
