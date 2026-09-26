import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import { applyCheckoutCompletion, applySubscriptionSnapshot, claimCustomerCreation, grantPeriod } from "../server/credits.ts";
import { Database } from "../infra/data.ts";

const priceCents = 2900;
export const monthlyMinutes = 120;
const idOf = (ref: string | { id: string } | null | undefined) =>
  ref === null || ref === undefined ? null : typeof ref === "string" ? ref : ref.id;

export default class Billing extends Cloudflare.Worker<Billing>()(
  "ClipforgeBilling", { main: import.meta.url, workersDev: true,
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true } }, env: {
    INTERNAL_SECRET: Config.Redacted("CLIPFORGE_INTERNAL_SECRET"),
    APP_ORIGIN: Config.String("CLIPFORGE_APP_ORIGIN"),
  } },
  Effect.gen(function* () {
    const product = yield* Stripe.Product("ClipforgePro", { name: "Clipforge Pro", description: "120 source minutes per billing month" });
    const price = yield* Stripe.Price("ClipforgeProMonthly", {
      product, currency: "usd", unitAmount: priceCents, recurring: { interval: "month" },
    });
    const priceId = yield* price.id;
    const database = yield* Cloudflare.D1.QueryDatabase(Database);
    const customer = yield* Stripe.CreateCustomer();
    const checkout = yield* Stripe.CreateCheckoutSession();
    const portal = yield* Stripe.CreateBillingPortalSession();

    yield* Stripe.consumeEvents("ClipforgeStripeEvents", {
      events: [Stripe.CheckoutSessionCompleted, Stripe.CustomerSubscriptionCreated,
        Stripe.CustomerSubscriptionUpdated, Stripe.CustomerSubscriptionDeleted,
        Stripe.InvoicePaid, Stripe.InvoicePaymentFailed],
    }, Effect.fn("billing.handleStripeEvent")(function* (event) {
      const raw = yield* database.raw;
      if (event.type === "invoice.paid") {
        const invoice = event.object;
        if (invoice.id === undefined || invoice.status !== "paid" ||
          !["subscription_create", "subscription_cycle"].includes(invoice.billing_reason ?? "")) return;
        const expectedPrice = yield* priceId;
        const matchedLine = invoice.lines.data.find((line) =>
          idOf(line.pricing?.price_details?.price ?? null) === expectedPrice);
        const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription ?? invoice.subscription ?? null);
        const customerId = idOf(invoice.customer);
        if (!matchedLine || !subscriptionId || !customerId) return;
        const owner = awaitOwner(raw, customerId);
        const userId = yield* Effect.promise(() => owner);
        if (!userId) return;
        yield* Effect.promise(() => grantPeriod(raw, {
          userId, subscriptionId, invoiceId: invoice.id!, minutes: monthlyMinutes,
          periodStart: matchedLine.period.start * 1000, periodEnd: matchedLine.period.end * 1000,
        }));
        return;
      }
      if (event.type === "checkout.session.completed") {
        const object = event.object;
        const customerId = idOf(object.customer);
        if (!customerId) return;
        const subscriptionId = idOf(object.subscription);
        if (subscriptionId) yield* Effect.promise(() => applyCheckoutCompletion(raw, {
          customerId, subscriptionId, sessionId: object.id, createdSeconds: object.created,
        }));
      } else if (event.type === "customer.subscription.created" ||
        event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
        const subscription = event.object;
        const customerId = idOf(subscription.customer);
        if (!customerId) return;
        yield* Effect.promise(() => applySubscriptionSnapshot(raw, {
          customerId, subscriptionId: subscription.id, status: subscription.status,
        }));
      } else if (event.type === "invoice.payment_failed") {
        const customerId = idOf(event.object.customer);
        if (!customerId) return;
        yield* database.prepare("UPDATE subscription SET status = 'past_due' WHERE customer_id = ? AND (period_end IS NULL OR period_end <= ?)")
          .bind(customerId, Date.now()).run();
      }
    }));

    return { fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      // Resolve only at request time: Alchemy imports this module in Bun during plan.
      const runtime = yield* Effect.promise(() => import("cloudflare:workers"));
      const internalEnv = runtime.env as unknown as { INTERNAL_SECRET?: string; APP_ORIGIN?: string };
      if (!internalEnv.INTERNAL_SECRET || request.headers["x-clipforge-internal"] !== internalEnv.INTERNAL_SECRET) {
        return HttpServerResponse.text("Not found", { status: 404 });
      }
      if (request.method !== "POST") return HttpServerResponse.text("Method not allowed", { status: 405 });
      const body = (yield* request.json) as unknown;
      if (typeof body !== "object" || body === null || !("userId" in body) || !("email" in body) ||
        typeof body.userId !== "string" || typeof body.email !== "string") {
        return HttpServerResponse.text("Invalid request", { status: 400 });
      }
      const raw = yield* database.raw;
      const user = yield* Effect.promise(() => raw.prepare("SELECT id,email FROM user WHERE id = ?").bind(body.userId).first<{ id: string; email: string }>());
      if (!user || user.email !== body.email) return HttpServerResponse.text("Not found", { status: 404 });
      const path = new URL(request.url, "https://internal").pathname;
      const origin = internalEnv.APP_ORIGIN;
      if (!origin || !origin.startsWith("https://")) return HttpServerResponse.text("Billing origin unavailable", { status: 503 });
      type BillingRecord = { customer_id: string; status: string; period_end: number | null;
        checkout_url: string | null; checkout_created_at: number | null };
      const lookup = () => raw.prepare(`SELECT customer_id,status,period_end,checkout_url,checkout_created_at
        FROM subscription WHERE user_id = ?`).bind(user.id).first<BillingRecord>();
      let record = yield* Effect.promise(lookup);
      if (path === "/internal/checkout") {
        let ownsCustomerCreation = false;
        if (!record) {
          ownsCustomerCreation = yield* Effect.promise(() => claimCustomerCreation(raw, user.id));
          record = yield* Effect.promise(lookup);
          if (!ownsCustomerCreation) return HttpServerResponse.text("Checkout is already being prepared", { status: 409 });
        }
        if (!record) return HttpServerResponse.text("Checkout unavailable", { status: 503 });
        if (record.status === "active" && (record.period_end ?? 0) > Date.now()) {
          return HttpServerResponse.text("Subscription already active", { status: 409 });
        }
        if (record.customer_id.startsWith("cus_pending_")) {
          // A previous call might have created a Stripe customer but lost its response.
          // Never create another: operators reconcile by clipforgeUserId metadata.
          if (!ownsCustomerCreation) return HttpServerResponse.text("Customer creation is pending; contact support", { status: 409 });
          const created = yield* customer({ email: user.email, metadata: { clipforgeUserId: user.id } });
          const saved = yield* Effect.promise(() => raw.prepare("UPDATE subscription SET customer_id = ?, status = 'none' WHERE user_id = ? AND customer_id = ?")
            .bind(created.id, user.id, record!.customer_id).run());
          if (saved.meta.changes !== 1) return HttpServerResponse.text("Customer reconciliation required", { status: 409 });
          record = yield* Effect.promise(lookup);
        }
        if (!record) return HttpServerResponse.text("Checkout unavailable", { status: 503 });
        if (record.status === "checkout_pending" && (record.checkout_created_at ?? 0) > Date.now() - 25 * 60 * 60 * 1000) {
          return record.checkout_url ? yield* HttpServerResponse.json({ url: record.checkout_url }) :
            HttpServerResponse.text("Checkout is being prepared; contact support if it does not appear", { status: 409 });
        }
        const claimed = yield* Effect.promise(() => raw.prepare(`UPDATE subscription SET status='checkout_pending',
          checkout_created_at=?,checkout_url=NULL,checkout_session_id=NULL WHERE user_id=? AND
          (status!='checkout_pending' OR (status='checkout_pending' AND checkout_created_at < ?))`)
          .bind(Date.now(), user.id, Date.now() - 25 * 60 * 60 * 1000).run());
        if (claimed.meta.changes !== 1) return HttpServerResponse.text("Checkout is already in progress", { status: 409 });
        const session = yield* checkout({ mode: "subscription", customer: record.customer_id,
          line_items: [{ price: yield* priceId, quantity: 1 }],
          success_url: `${origin}/studio?checkout=complete`, cancel_url: `${origin}/pricing` });
        if (!session.url || !session.id?.startsWith("cs_test_")) return HttpServerResponse.text("Checkout unavailable", { status: 503 });
        yield* Effect.promise(() => raw.prepare(`UPDATE subscription SET checkout_url = ?,checkout_session_id = ?
          WHERE user_id = ? AND status = 'checkout_pending'`)
          .bind(session.url, session.id, user.id).run());
        return yield* HttpServerResponse.json({ url: session.url });
      }
      if (path === "/internal/portal") {
        if (!record || record.customer_id.startsWith("cus_pending_")) return HttpServerResponse.text("No billing customer", { status: 404 });
        const session = yield* portal({ customer: record.customer_id, return_url: `${origin}/studio` });
        return yield* HttpServerResponse.json({ url: session.url });
      }
      return HttpServerResponse.text("Not found", { status: 404 });
    }).pipe(Effect.orDie) };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.D1.QueryDatabaseBinding,
    Stripe.CreateCustomerHttp, Stripe.CreateCheckoutSessionHttp,
    Stripe.CreateBillingPortalSessionHttp, Stripe.ConsumeEventsLive))),
) {}

function awaitOwner(raw: import("@cloudflare/workers-types").D1Database, customerId: string) {
  return raw.prepare("SELECT user_id FROM subscription WHERE customer_id = ?").bind(customerId)
    .first<{ user_id: string }>().then((row) => row?.user_id ?? null);
}
