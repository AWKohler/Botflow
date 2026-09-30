import { APIError } from "better-auth/api";
import { getIdentityDb } from "./database";
import { ownerIds } from "./policy";
import { billingStripe } from "@/lib/billing/stripe";

/** Called only after Better Auth consumes the user's emailed deletion token. */
export async function prepareAccountDeletion(user: { id: string }) {
  if (ownerIds().includes(user.id))
    throw new APIError("FORBIDDEN", {
      message:
        "Transfer administrative ownership before deleting this account.",
    });
  const db = await getIdentityDb().connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `billing:${user.id}`,
    ]);
    const { rows } = await db.query(
      "SELECT * FROM botflow_subscription WHERE user_id=$1 FOR UPDATE",
      [user.id],
    );
    const row = rows[0];
    if (
      row?.source === "clerk" &&
      row.plan !== "free" &&
      row.period_end &&
      new Date(row.period_end).getTime() > Date.now()
    )
      throw new APIError("BAD_REQUEST", {
        message:
          "Your existing billing migration must finish before deleting this account.",
      });
    if (row?.source === "stripe" && row.stripe_customer_id) {
      const stripe = billingStripe();
      for await (const checkout of stripe.checkout.sessions.list({
        customer: row.stripe_customer_id,
        status: "open",
        limit: 100,
      })) {
        if (checkout.metadata?.botflow_user_id === user.id)
          await stripe.checkout.sessions.expire(checkout.id);
      }
      for await (const subscription of stripe.subscriptions.list({
        customer: row.stripe_customer_id,
        status: "all",
        limit: 100,
      })) {
        if (
          subscription.metadata.botflow_user_id === user.id &&
          !["canceled", "incomplete_expired"].includes(subscription.status)
        )
          await stripe.subscriptions.cancel(subscription.id, {
            prorate: false,
            invoice_now: false,
          });
      }
    }
    // Fail closed if the identity deletion itself subsequently fails. An operator
    // can recover the account from the audit record; no session may keep billing.
    await db.query("UPDATE identity_user SET banned=true WHERE id=$1", [
      user.id,
    ]);
    await db.query('DELETE FROM identity_session WHERE "userId"=$1', [user.id]);
    await db.query("DELETE FROM botflow_subscription WHERE user_id=$1", [
      user.id,
    ]);
    await db.query(
      "INSERT INTO identity_audit(actor_id,target_id,action)VALUES($1,$1,'account.deletion.verified')",
      [user.id],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
