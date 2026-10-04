BEGIN;
CREATE TABLE IF NOT EXISTS identity_user (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false, image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  username text UNIQUE, "displayUsername" text,
  role text NOT NULL DEFAULT 'user', banned boolean DEFAULT false, "banReason" text, "banExpires" timestamptz
);
CREATE TABLE IF NOT EXISTS identity_session (
  id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  "impersonatedBy" text
);
CREATE INDEX IF NOT EXISTS identity_session_user_idx ON identity_session("userId");
CREATE TABLE IF NOT EXISTS identity_account (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  scope text, password text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX IF NOT EXISTS identity_account_user_idx ON identity_account("userId");
CREATE TABLE IF NOT EXISTS identity_verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_verification_identifier_idx ON identity_verification(identifier);
CREATE TABLE IF NOT EXISTS identity_rate_limit (id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, "lastRequest" bigint NOT NULL);
CREATE TABLE IF NOT EXISTS identity_profile (
  user_id text PRIMARY KEY REFERENCES identity_user(id) ON DELETE CASCADE,
  source_primary_email text, first_name text, last_name text, username text, email_addresses jsonb NOT NULL DEFAULT '[]',
  public_metadata jsonb NOT NULL DEFAULT '{}', unsafe_metadata jsonb NOT NULL DEFAULT '{}',
  private_metadata_encrypted text NOT NULL, last_sign_in_at timestamptz,
  source_updated_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS identity_avatar (
  user_id text PRIMARY KEY REFERENCES identity_user(id) ON DELETE CASCADE,
  data bytea NOT NULL, digest text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS identity_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id text NOT NULL,
  target_id text, action text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS botflow_subscription (
  user_id text PRIMARY KEY REFERENCES identity_user(id), source text NOT NULL CHECK (source IN ('clerk','stripe')),
  stripe_customer_id text UNIQUE, stripe_subscription_id text UNIQUE,
  clerk_subscription_id text, clerk_item_id text,
  plan text NOT NULL CHECK (plan IN ('free','pro','max','staff')), status text NOT NULL,
  amount integer NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'usd', interval text NOT NULL DEFAULT 'month',
  period_start timestamptz, period_end timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false,
  stripe_event_created bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS botflow_billing_event (
  event_id text PRIMARY KEY, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE TABLE IF NOT EXISTS identity_migration_run (
  id text PRIMARY KEY, source_instance text NOT NULL, user_count integer NOT NULL, manifest_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One email namespace prevents signup/OAuth races from taking a verified alias.
CREATE TABLE IF NOT EXISTS identity_email (
  email text PRIMARY KEY CHECK (email=lower(email)),
  user_id text NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_email_user_idx ON identity_email(user_id);
CREATE OR REPLACE FUNCTION identity_sync_primary_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO identity_email(email,user_id,verified) VALUES(lower(NEW.email),NEW.id,NEW."emailVerified")
  ON CONFLICT(email) DO UPDATE SET verified=EXCLUDED.verified
  WHERE identity_email.user_id=EXCLUDED.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Email is already assigned' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS identity_primary_email_namespace ON identity_user;
CREATE TRIGGER identity_primary_email_namespace AFTER INSERT OR UPDATE OF email,"emailVerified" ON identity_user
FOR EACH ROW EXECUTE FUNCTION identity_sync_primary_email();
INSERT INTO identity_email(email,user_id,verified) SELECT lower(email),id,"emailVerified" FROM identity_user
ON CONFLICT(email) DO NOTHING;
CREATE TABLE IF NOT EXISTS identity_email_challenge (
  user_id text NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE, email text NOT NULL,
  digest text NOT NULL, attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,email)
);
COMMIT;

ALTER TABLE botflow_subscription ADD COLUMN IF NOT EXISTS legacy_billing_cutover_at timestamptz;
