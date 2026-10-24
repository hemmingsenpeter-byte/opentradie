-- Account security (ADR 0031): session metadata, password change tracking, TOTP two-factor,
-- recovery codes and single-use auth tokens (pending MFA logins and password resets).
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
-- Browser and OS family only ("Chrome on Android"); no raw user agent and no IP address.
ALTER TABLE sessions ADD COLUMN user_agent_family text NOT NULL DEFAULT 'Unknown';
ALTER TABLE sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX sessions_id ON sessions(tenant_id, id);
CREATE INDEX sessions_user ON sessions(tenant_id, user_id);

ALTER TABLE users ADD COLUMN password_changed_at timestamptz;

-- One TOTP secret per user, sealed with the credential envelope (AES-256-GCM, key id beside it).
-- enabled_at is null while enrolment awaits its confirming code.
CREATE TABLE user_mfa (
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  user_id uuid NOT NULL,
  secret_key_id text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  enabled_at timestamptz,
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE user_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  user_id uuid NOT NULL,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, code_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE auth_tokens (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  user_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('mfa_login', 'password_reset')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  user_agent_family text NOT NULL DEFAULT 'Unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX auth_tokens_user ON auth_tokens(tenant_id, user_id, purpose);
CREATE INDEX auth_tokens_expiry ON auth_tokens(expires_at);
