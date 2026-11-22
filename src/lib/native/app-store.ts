/**
 * App Store purchases from the Botflow iOS app.
 *
 * The app sends the transaction exactly as StoreKit hands it over: a JWS
 * signed by Apple. Nothing in it is trusted until the signature is checked
 * against a certificate chain that ends at Apple's root, so a modified app
 * cannot grant itself a plan.
 */
import { createHash, createVerify, X509Certificate } from "node:crypto";
import { getIdentityDb } from "@/lib/auth/database";
import type { Tier } from "@/lib/tier-shared";

export const APP_BUNDLE_ID = "io.botflow.app";

/** SHA-256 of "Apple Root CA - G3" (apple.com/certificateauthority), valid to 2039. */
export const APPLE_ROOT_G3_SHA256 = "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179";

/** Product ids, mirrored in ios/Botflow/Core/StoreManager.swift and Botflow.storekit. */
export const APPLE_PRODUCTS: Record<string, { plan: "pro" | "max"; interval: "month" | "year" }> = {
  "io.botflow.pro.monthly": { plan: "pro", interval: "month" },
  "io.botflow.pro.yearly": { plan: "pro", interval: "year" },
  "io.botflow.max.monthly": { plan: "max", interval: "month" },
  "io.botflow.max.yearly": { plan: "max", interval: "year" },
};

export interface AppStoreTransaction {
  bundleId: string;
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  purchaseDate: number;
  expiresDate?: number;
  revocationDate?: number;
  environment: "Production" | "Sandbox" | "Xcode" | string;
  appAccountToken?: string;
  type?: string;
}

export class AppStoreError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

function fingerprint(cert: X509Certificate): string {
  return createHash("sha256").update(cert.raw).digest("hex").toUpperCase();
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

export interface VerifyOptions {
  /** Trusted root fingerprints (SHA-256, upper-case hex). Apple's G3 root unless a test says otherwise. */
  trustedRoots?: string[];
  now?: number;
}

/**
 * Verify a JWS from the App Store (a transaction or a server notification)
 * and return its payload. Throws AppStoreError on anything short of a valid
 * Apple signature.
 */
export function verifyAppStoreJws<T>(jws: string, options: VerifyOptions = {}): T {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new AppStoreError("Malformed transaction");
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header: { alg?: string; x5c?: string[] };
  try {
    header = decodeSegment(headerSegment);
  } catch {
    throw new AppStoreError("Malformed transaction");
  }
  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length < 2) {
    throw new AppStoreError("Unsupported transaction signature");
  }

  let chain: X509Certificate[];
  try {
    chain = header.x5c.map((der) => new X509Certificate(Buffer.from(der, "base64")));
  } catch {
    throw new AppStoreError("Unreadable certificate chain");
  }

  // Each certificate must be signed by the next, be within its dates, and the
  // last must be a root we pin.
  const now = new Date(options.now ?? Date.now());
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) {
      throw new AppStoreError("Certificate is outside its validity period");
    }
    const issuer = chain[i + 1] ?? cert;
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) {
      throw new AppStoreError("Certificate chain does not verify");
    }
  }
  const trusted = options.trustedRoots ?? [APPLE_ROOT_G3_SHA256];
  if (!trusted.includes(fingerprint(chain[chain.length - 1]))) {
    throw new AppStoreError("Transaction is not signed by Apple");
  }

  const verifier = createVerify("SHA256");
  verifier.update(`${headerSegment}.${payloadSegment}`);
  const valid = verifier.verify(
    { key: chain[0].publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signatureSegment, "base64url"),
  );
  if (!valid) throw new AppStoreError("Transaction signature is invalid");

  try {
    return decodeSegment<T>(payloadSegment);
  } catch {
    throw new AppStoreError("Malformed transaction");
  }
}

/**
 * Which App Store environments grant a plan. Production always does. Sandbox
 * purchases cost nothing, so they count only where explicitly allowed
 * (TestFlight testing); never by default.
 */
export function environmentAllowed(environment: string): boolean {
  if (environment === "Production") return true;
  if (environment === "Sandbox") return process.env.APPLE_IAP_ALLOW_SANDBOX === "true";
  return false;
}

/** The token the app attaches to a purchase so it can only be claimed by the account that made it. */
export function appAccountTokenFor(userId: string): string {
  const hex = createHash("sha256").update(`botflow-app-account:${userId}`).digest("hex");
  // Shaped as a version-5-style UUID, which is what StoreKit requires.
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export interface AppleSubscriptionRow {
  original_transaction_id: string;
  user_id: string;
  product_id: string;
  plan: "pro" | "max";
  interval: string;
  environment: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/** True when the table has not been created yet (migration 002 not applied). */
function isMissingTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "42P01";
}

/** Record a verified transaction for `userId`. Returns the row as stored. */
export async function recordAppleTransaction(userId: string, tx: AppStoreTransaction): Promise<AppleSubscriptionRow> {
  if (tx.bundleId !== APP_BUNDLE_ID) throw new AppStoreError("This purchase belongs to a different app");
  const product = APPLE_PRODUCTS[tx.productId];
  if (!product) throw new AppStoreError("Unknown product");
  if (!environmentAllowed(tx.environment)) throw new AppStoreError("Test purchases are not accepted here", 403);
  if (!tx.expiresDate) throw new AppStoreError("This purchase is not a subscription");
  if (tx.appAccountToken && tx.appAccountToken.toLowerCase() !== appAccountTokenFor(userId)) {
    throw new AppStoreError("This purchase was made by a different Botflow account", 409);
  }

  const db = getIdentityDb();
  try {
    const { rows: existing } = await db.query<{ user_id: string }>(
      "SELECT user_id FROM botflow_apple_subscription WHERE original_transaction_id=$1",
      [tx.originalTransactionId],
    );
    if (existing[0] && existing[0].user_id !== userId) {
      throw new AppStoreError("This subscription is already linked to another Botflow account", 409);
    }
    const { rows } = await db.query<AppleSubscriptionRow>(
      `INSERT INTO botflow_apple_subscription
         (original_transaction_id,user_id,product_id,plan,interval,environment,transaction_id,purchased_at,expires_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000),to_timestamp($9::double precision/1000),
               CASE WHEN $10::double precision IS NULL THEN NULL ELSE to_timestamp($10::double precision/1000) END)
       ON CONFLICT (original_transaction_id) DO UPDATE SET
         product_id=EXCLUDED.product_id, plan=EXCLUDED.plan, interval=EXCLUDED.interval, environment=EXCLUDED.environment,
         transaction_id=EXCLUDED.transaction_id, purchased_at=EXCLUDED.purchased_at,
         -- A late-arriving older transaction must not shorten the subscription.
         expires_at=GREATEST(botflow_apple_subscription.expires_at, EXCLUDED.expires_at),
         revoked_at=EXCLUDED.revoked_at, updated_at=now()
       WHERE botflow_apple_subscription.user_id=EXCLUDED.user_id
       RETURNING *`,
      [
        tx.originalTransactionId,
        userId,
        tx.productId,
        product.plan,
        product.interval,
        tx.environment,
        tx.transactionId,
        tx.purchaseDate,
        tx.expiresDate,
        tx.revocationDate ?? null,
      ],
    );
    if (!rows[0]) throw new AppStoreError("This subscription is already linked to another Botflow account", 409);
    return rows[0];
  } catch (error) {
    if (isMissingTable(error)) throw new AppStoreError("In-app purchases are not available yet", 503);
    throw error;
  }
}

/** Apply a renewal, expiry or refund Apple told us about. Unknown subscriptions are ignored. */
export async function applyAppleUpdate(tx: AppStoreTransaction): Promise<boolean> {
  if (tx.bundleId !== APP_BUNDLE_ID || !APPLE_PRODUCTS[tx.productId] || !tx.expiresDate) return false;
  const product = APPLE_PRODUCTS[tx.productId];
  try {
    const { rowCount } = await getIdentityDb().query(
      `UPDATE botflow_apple_subscription SET
         product_id=$2, plan=$3, interval=$4, transaction_id=$5,
         expires_at=to_timestamp($6::double precision/1000),
         revoked_at=CASE WHEN $7::double precision IS NULL THEN NULL ELSE to_timestamp($7::double precision/1000) END,
         updated_at=now()
       WHERE original_transaction_id=$1`,
      [tx.originalTransactionId, tx.productId, product.plan, product.interval, tx.transactionId, tx.expiresDate, tx.revocationDate ?? null],
    );
    return (rowCount ?? 0) > 0;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

/** The plan a person's App Store subscriptions give them right now. */
export async function getAppleTier(userId: string, now = Date.now()): Promise<Tier> {
  const active = await getActiveAppleSubscription(userId, now);
  return active?.plan ?? "free";
}

/** Set when the table is found missing, so requests stop asking for a while. */
let tableMissingUntil = 0;

export async function getActiveAppleSubscription(userId: string, now = Date.now()): Promise<AppleSubscriptionRow | null> {
  if (Date.now() < tableMissingUntil) return null;
  try {
    const { rows } = await getIdentityDb().query<AppleSubscriptionRow>(
      "SELECT * FROM botflow_apple_subscription WHERE user_id=$1 AND revoked_at IS NULL",
      [userId],
    );
    const live = rows.filter((r) => new Date(r.expires_at).getTime() > now);
    return live.find((r) => r.plan === "max") ?? live[0] ?? null;
  } catch (error) {
    // Before migration 002 is applied nobody has an App Store plan. Plan
    // lookups run on every request, so don't repeat a query known to fail.
    if (isMissingTable(error)) {
      tableMissingUntil = Date.now() + 10 * 60 * 1000;
      return null;
    }
    throw error;
  }
}
