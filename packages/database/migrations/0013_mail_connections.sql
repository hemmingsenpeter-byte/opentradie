-- Mailbox OAuth connections (ADR 0026). Gmail and Microsoft Graph reuse the accounting OAuth
-- tables: hashed single-use state in oauth_authorisations and sealed tokens in
-- provider_connections. `fake_mail` is the MOCK mailbox (MAIL_PROVIDER=fake, demos and tests).
-- Both lists restate every earlier value (packages/database/src/check-values.ts).

ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_provider_check;
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_provider_check
  CHECK (provider IN ('xero', 'gmail', 'microsoft_graph', 'whatsapp_business', 'test', 'fake_mail'));

ALTER TABLE oauth_authorisations DROP CONSTRAINT oauth_authorisations_provider_check;
ALTER TABLE oauth_authorisations ADD CONSTRAINT oauth_authorisations_provider_check
  CHECK (provider IN ('xero', 'test', 'gmail', 'microsoft_graph', 'fake_mail'));
