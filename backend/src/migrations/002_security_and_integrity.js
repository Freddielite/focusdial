// Account security (password reset, MFA, audit log), idempotency keys,
// and data-integrity constraints. All additive.
export const name = "security_and_integrity";

export async function up(client) {
  await client.query(`
    -- A session can never end before it starts. NOT VALID: enforced for
    -- every new INSERT/UPDATE immediately, without scanning (and locking)
    -- the existing table. Validate separately once any legacy bad rows
    -- are fixed: ALTER TABLE sessions VALIDATE CONSTRAINT sessions_end_after_start;
    ALTER TABLE sessions ADD CONSTRAINT sessions_end_after_start
      CHECK (ended_at IS NULL OR ended_at > started_at) NOT VALID;
    ALTER TABLE deadlines ADD CONSTRAINT deadlines_hours_positive
      CHECK (estimated_hours > 0 AND manual_hours_logged >= 0) NOT VALID;
    ALTER TABLE budgets ADD CONSTRAINT budgets_target_positive
      CHECK (weekly_target_seconds > 0) NOT VALID;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
    -- Last accepted TOTP step, so the same 6-digit code can't be replayed
    -- within its 30-90s validity window.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_counter BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash  TEXT NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user ON mfa_recovery_codes(user_id);

    -- Only a SHA-256 of each reset token is stored; tokens expire after
    -- 30 minutes and are single-use (used_at).
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

    -- Client-supplied Idempotency-Key per POST: a retried request (double
    -- click, network retry) replays the first response instead of
    -- creating a second row. Pruned after 24h by the cron tick.
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status_code INTEGER,
      response    JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, key)
    );

    -- Security-relevant events (logins, failed logins, password/MFA
    -- changes, resets, session revocation, account deletion). Never holds
    -- passwords, tokens or codes. user_id is SET NULL on account deletion
    -- so the trail survives without identifying the person; rows older
    -- than 365 days are pruned by the cron tick.
    CREATE TABLE IF NOT EXISTS audit_log (
      id         BIGSERIAL PRIMARY KEY,
      user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
      event      TEXT NOT NULL,
      ip         TEXT,
      detail     JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at);

    -- Lets the cron skip retraining attempts for users without enough
    -- labeled data, instead of reloading their whole history every tick.
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS quality_model_attempted_at TIMESTAMPTZ;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE settings DROP COLUMN IF EXISTS quality_model_attempted_at;
    DROP TABLE IF EXISTS audit_log;
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS password_reset_tokens;
    DROP TABLE IF EXISTS mfa_recovery_codes;
    ALTER TABLE users DROP COLUMN IF EXISTS password_changed_at;
    ALTER TABLE users DROP COLUMN IF EXISTS totp_last_counter;
    ALTER TABLE users DROP COLUMN IF EXISTS totp_enabled;
    ALTER TABLE users DROP COLUMN IF EXISTS totp_secret;
    ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_target_positive;
    ALTER TABLE deadlines DROP CONSTRAINT IF EXISTS deadlines_hours_positive;
    ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_end_after_start;
  `);
}
