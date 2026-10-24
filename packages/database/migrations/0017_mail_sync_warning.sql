-- Mailbox sync cursor expiry (ADR 0026 amendment). When Gmail no longer has the stored
-- startHistoryId (404) or Graph rejects the stored delta link (410 Gone), mail.sync restarts the
-- cursor from "now" and records a warning the owner sees in Settings › Mail: mail that arrived
-- in the gap may not have been imported. The status shows it for 7 days after sync_warning_at.
-- No message content is stored here.
ALTER TABLE provider_connections
  ADD COLUMN sync_warning text CHECK (sync_warning IN ('cursor_reset')),
  ADD COLUMN sync_warning_at timestamptz;
