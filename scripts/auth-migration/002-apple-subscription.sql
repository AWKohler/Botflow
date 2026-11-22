-- App Store subscriptions bought in the Botflow iOS app.
--
-- Kept apart from botflow_subscription (Stripe): the two are paid, renewed and
-- cancelled by different systems, and a person may in principle hold both. A
-- person's plan is the higher of the two (see src/lib/billing/entitlements.ts).
--
-- One row per Apple subscription (its original transaction id), owned by the
-- Botflow account that first claimed it.
CREATE TABLE IF NOT EXISTS botflow_apple_subscription (
  original_transaction_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  plan text NOT NULL CHECK (plan IN ('pro','max')),
  interval text NOT NULL DEFAULT 'month',
  environment text NOT NULL,
  transaction_id text NOT NULL,
  purchased_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS botflow_apple_subscription_user_idx ON botflow_apple_subscription(user_id);
