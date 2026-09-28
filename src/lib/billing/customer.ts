import { getIdentityDb } from "@/lib/auth/database";
import { getIdentityUser } from "@/lib/auth/directory";
import { billingStripe } from "./stripe";

/** Create a free account's payment customer without starting a subscription. */
export async function ensureFreeBillingCustomer(userId: string) {
  const db = await getIdentityDb().connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `billing:${userId}`,
    ]);
    const identity = await db.query(
      "SELECT banned FROM identity_user WHERE id=$1",
      [userId],
    );
    if (!identity.rows[0] || identity.rows[0].banned)
      throw new Error("Account unavailable");
    const { rows } = await db.query(
      "SELECT * FROM botflow_subscription WHERE user_id=$1 FOR UPDATE",
      [userId],
    );
    if (rows[0] && rows[0].plan !== "free")
      throw new Error("Existing subscription must be managed separately");
    let customerId = rows[0]?.stripe_customer_id as string | undefined;
    if (!customerId) {
      const user = await getIdentityUser(userId);
      const customer = await billingStripe().customers.create(
        {
          email: user.primaryEmailAddress.emailAddress,
          name: user.fullName,
          metadata: { botflow_user_id: userId },
        },
        { idempotencyKey: `botflow-customer-v1:${userId}` },
      );
      customerId = customer.id;
    }
    await db.query(
      "INSERT INTO botflow_subscription(user_id,source,stripe_customer_id,plan,status)VALUES($1,'stripe',$2,'free','active')ON CONFLICT(user_id)DO UPDATE SET source='stripe',stripe_customer_id=$2",
      [userId, customerId],
    );
    await db.query("COMMIT");
    return customerId;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
