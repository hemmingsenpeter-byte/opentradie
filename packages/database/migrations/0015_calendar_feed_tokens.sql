-- Private ICS calendar feed links (ADR 0019 amendment). Only the SHA-256 of the random token is
-- stored; the URL is shown to the owner once. One active link per user; rotation revokes the old one.

CREATE TABLE calendar_feed_tokens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES businesses(id),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE UNIQUE INDEX calendar_feed_tokens_one_active
  ON calendar_feed_tokens (tenant_id, user_id) WHERE revoked_at IS NULL;
