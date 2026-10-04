import type Stripe from "stripe";
/** Clerk charged cards directly; retain those receipts alongside native invoices. */
export async function paymentHistory(
  stripe: Stripe,
  customerId: string,
  legacyCutoff?: Date | null,
) {
  const [invoices, charges] = await Promise.all([
    stripe.invoices.list({ customer: customerId, limit: 24 }),
    legacyCutoff
      ? stripe.charges.list({
          customer: customerId,
          created: { lt: Math.floor(new Date(legacyCutoff).getTime() / 1000) },
          limit: 100,
        })
      : null,
  ]);
  return [
    ...invoices.data.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      created: invoice.created,
      status: invoice.status,
      amount: invoice.amount_paid || invoice.amount_due || invoice.total,
      currency: invoice.currency,
      url: invoice.hosted_invoice_url,
      pdf: invoice.invoice_pdf,
      kind: "invoice" as const,
    })),
    ...(charges?.data || [])
      .filter((charge) => charge.paid && charge.receipt_url)
      .map((charge) => ({
        id: charge.id,
        number: null,
        created: charge.created,
        status: charge.refunded
          ? "refunded"
          : charge.amount_refunded
            ? "partially refunded"
            : "paid",
        amount: charge.amount,
        currency: charge.currency,
        url: charge.receipt_url,
        pdf: null,
        kind: "receipt" as const,
      })),
  ]
    .sort((a, b) => b.created - a.created)
    .slice(0, 24);
}
