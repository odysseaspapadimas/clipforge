import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { balance, claimCustomerCreation, grantPeriod, releaseMinutes, reserveMinutes } from "../src/server/credits.ts";

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE subscription (user_id TEXT PRIMARY KEY, customer_id TEXT, subscription_id TEXT, status TEXT,
    period_start INTEGER, period_end INTEGER, current_invoice TEXT, checkout_created_at INTEGER, last_event_created INTEGER);
    CREATE TABLE minute_ledger (key TEXT PRIMARY KEY,user_id TEXT,period_key TEXT,delta INTEGER,kind TEXT,project_id TEXT,created_at INTEGER);
    INSERT INTO subscription(user_id,customer_id,subscription_id,status) VALUES ('alice','cus_alice',NULL,'none'),('bob','cus_bob',NULL,'none');`);
  const makeStatement = (sql: string, params: unknown[] = []): any => ({
    bind: (...values: unknown[]) => makeStatement(sql, values),
    first: async () => sqlite.prepare(sql).get(...params as any[]),
    run: async () => { const result = sqlite.prepare(sql).run(...params as any[]); return { meta: { changes: result.changes } }; },
    runSync: () => { const result = sqlite.prepare(sql).run(...params as any[]); return { meta: { changes: result.changes } }; },
  });
  const fake = {
    prepare: (sql: string) => makeStatement(sql),
    batch: async (statements: Array<{ runSync: () => unknown }>) => sqlite.transaction(() =>
      statements.map((statement) => statement.runSync()))(),
  } as unknown as D1Database;
  return { sqlite, db: fake };
}

describe("source minute ledger", () => {
  test("only the atomic claim owner may create an external Stripe customer", async () => {
    const { db, sqlite } = fixture();
    const claims = await Promise.all([claimCustomerCreation(db, "charlie"), claimCustomerCreation(db, "charlie")]);
    expect(claims).toEqual([true, false]);
    expect((sqlite.prepare("SELECT status,customer_id FROM subscription WHERE user_id='charlie'").get() as any).status)
      .toBe("customer_pending");
    sqlite.close();
  });
  test("charges exactly once, releases once and never lets another account spend a period", async () => {
    const { db, sqlite } = fixture();
    // Grant via the database fixture; grantPeriod is covered separately by an atomic batch test.
    const end = Date.now() + 30 * 86_400_000;
    sqlite.prepare("UPDATE subscription SET status='active', subscription_id='sub_alice', current_invoice='in_first',period_end=? WHERE user_id='alice'").run(end);
    sqlite.prepare("INSERT INTO minute_ledger VALUES ('grant:in_first','alice','in_first',120,'grant',NULL,?)").run(Date.now());
    expect(await balance(db, "alice")).toBe(120);
    expect(await balance(db, "bob")).toBe(0);
    expect(await reserveMinutes(db, "alice", "asset-1", 90)).toBe(true);
    expect(await reserveMinutes(db, "alice", "asset-1", 90)).toBe(true);
    expect(await reserveMinutes(db, "bob", "asset-1", 90)).toBe(false);
    expect(await reserveMinutes(db, "alice", "asset-2", 31)).toBe(false);
    expect(await balance(db, "alice")).toBe(30);
    await releaseMinutes(db, "alice", "asset-1");
    await releaseMinutes(db, "alice", "asset-1");
    expect(await balance(db, "alice")).toBe(120);
    expect(await reserveMinutes(db, "alice", "asset-1", 90)).toBe(false);
    sqlite.close();
  });
  test("a paid invoice is granted only once, even if its webhook is redelivered", async () => {
    const { db, sqlite } = fixture();
    const input = { userId: "alice", subscriptionId: "sub_alice", invoiceId: "in_first", minutes: 120,
      periodStart: Date.now(), periodEnd: Date.now() + 30 * 86_400_000 };
    await grantPeriod(db, input);
    await grantPeriod(db, input);
    expect(await balance(db, "alice")).toBe(120);
    const later = { ...input, invoiceId: "in_second", periodStart: input.periodEnd,
      periodEnd: input.periodEnd + 30 * 86_400_000 };
    await grantPeriod(db, later);
    await grantPeriod(db, input);
    expect(await balance(db, "alice")).toBe(120);
    sqlite.close();
  });
  test("a canceled plan cannot be revived by an old or late paid-invoice webhook", async () => {
    const { db, sqlite } = fixture();
    const now = Date.now();
    const invoice = { userId: "alice", subscriptionId: "sub_alice", invoiceId: "in_first", minutes: 120,
      periodStart: now, periodEnd: now + 30 * 86_400_000 };
    await grantPeriod(db, invoice);
    sqlite.prepare("UPDATE subscription SET status='canceled' WHERE user_id='alice'").run();
    await grantPeriod(db, invoice);
    await grantPeriod(db, { ...invoice, invoiceId: "in_late", periodStart: now + 1000,
      periodEnd: invoice.periodEnd + 1000 });
    expect(await balance(db, "alice")).toBe(0);
    expect(sqlite.prepare("SELECT status FROM subscription WHERE user_id='alice'").get()).toEqual({ status: "canceled" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM minute_ledger WHERE key='grant:in_late'").get()).toEqual({ n: 0 });
    sqlite.close();
  });
  test("unused minutes from an old invoice never roll into the next period", async () => {
    const { db, sqlite } = fixture();
    const end = Date.now() + 30 * 86_400_000;
    sqlite.prepare("UPDATE subscription SET status='active',subscription_id='sub_alice',current_invoice='in_old',period_end=? WHERE user_id='alice'").run(end);
    sqlite.prepare("INSERT INTO minute_ledger VALUES ('grant:in_old','alice','in_old',120,'grant',NULL,?)").run(Date.now());
    sqlite.prepare("UPDATE subscription SET current_invoice='in_new',period_end=?,period_start=? WHERE user_id='alice'").run(end + 30 * 86_400_000, Date.now());
    expect(await balance(db, "alice")).toBe(0);
    expect(await reserveMinutes(db, "alice", "asset-3", 1)).toBe(false);
    sqlite.close();
  });
});
