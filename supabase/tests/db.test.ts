/**
 * Database rule tests on a real PostgreSQL 16 with Supabase's auth emulated
 * (supabase_emulation.sql). Each test gets a fresh database cloned from a
 * migrated template. Calls run as role `authenticated` (or `anon`) with a JWT
 * `sub` claim — exactly how Supabase evaluates RLS and auth.uid().
 *
 * Env: TAHSEEL_PG (default postgres://postgres@/postgres?host=/tmp/pgsock&port=54329)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { NAME_CASES } from "../../src/lib/nameCases";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildImportPlan } from "../../src/lib/importPlan";
import { parseWorkbook } from "../../src/lib/parseWorkbook";
import { readXlsx } from "../../src/lib/xlsx";

const ADMIN = process.env.TAHSEEL_PG ?? "postgres://postgres@localhost:54329/postgres?host=/tmp/pgsock";
const TPL = "tahseel_tpl";
const root = path.resolve(import.meta.dirname, "..");
const urlFor = (db: string) => ADMIN.replace(/\/postgres(\?|$)/, `/${db}$1`);

let dbName = "";
let pool: pg.Pool;
const M = "2026-11";
const NEXT = "2026-12";

async function adminQuery(sql: string) {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await adminQuery(`drop database if exists ${TPL}`);
  await adminQuery(`create database ${TPL}`);
  const c = new pg.Client({ connectionString: urlFor(TPL) });
  await c.connect();
  await c.query(readFileSync(path.join(root, "tests/supabase_emulation.sql"), "utf8"));
  for (const f of readdirSync(path.join(root, "migrations")).sort()) await c.query(readFileSync(path.join(root, "migrations", f), "utf8"));
  await c.end();
});

let n = 0;
beforeEach(async () => {
  if (pool) await pool.end();
  dbName = `tahseel_t${process.pid}_${++n}`;
  await adminQuery(`create database ${dbName} template ${TPL}`);
  pool = new pg.Pool({ connectionString: urlFor(dbName), max: 6 });
});

afterEach(async () => {
  if (pool) await pool.end();
  pool = undefined as unknown as pg.Pool;
  if (dbName) await adminQuery(`drop database if exists ${dbName}`);
});

afterAll(async () => {
  await adminQuery(`drop database if exists ${TPL}`);
});

/** Run SQL as a Supabase user (null = anon). Returns rows. */
async function as<T = Record<string, unknown>>(uid: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${uid ? "authenticated" : "anon"}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as T[];
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const one = async <T = Record<string, unknown>>(uid: string | null, sql: string, params: unknown[] = []) => (await as<T>(uid, sql, params))[0];
const su = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/* ---------------- fixture ---------------- */

async function newUser(email: string | null): Promise<string> {
  return (await su("insert into auth.users (email) values ($1) returning id", [email]))[0].id;
}

async function fixture() {
  const managerId = await newUser("manager@tahseel.app");
  await su("select public.make_manager('manager@tahseel.app', 'المدير', 'manager')");
  await one(managerId, "select public.import_subscribers($1::jsonb)", [JSON.stringify([
    { full_name: "علي أحمد عروس", father_name: "أحمد", username: "hnadi7", area: "الهنادي", speed_mbps: 4, package_label: "4M", monthly_amount: 200000 },
    { full_name: "أحمد محمد", area: "الهنادي", speed_mbps: 2, package_label: "2M", monthly_amount: 100000 },
    { full_name: "محمود خالد", area: "الهنادي", speed_mbps: 3, package_label: "3M", monthly_amount: 150000 },
    { full_name: "نقطة خدمة", area: "الهنادي", package_label: "SPF", monthly_amount: 0, standing_exempt: true },
    { full_name: "بدون سرعة", area: "الهنادي", monthly_amount: null },
    { full_name: "فادي", area: "فديو", speed_mbps: 2, package_label: "2M", monthly_amount: 100000 },
    { full_name: "فراس", area: "فديو", speed_mbps: 4, package_label: "4M", monthly_amount: 200000 },
    { full_name: "كامل", area: "الخرنوبة", speed_mbps: 2, package_label: "2M", monthly_amount: 100000 },
  ])]);
  const areas = Object.fromEntries((await su("select name, id from public.areas")).map((r) => [r.name, r.id])) as Record<string, string>;
  const subs = Object.fromEntries((await su("select full_name, id from public.subscribers")).map((r) => [r.full_name, r.id])) as Record<string, string>;

  async function makeAgent(username: string, name: string, areaNames: string[], comp: [string, number] = ["none", 0], phone: string | null = null) {
    const inv = await one<{ r: { code: string } }>(managerId, "select public.create_agent_invite($1, $2, $3::uuid[], $4, $5, $6) r",
      [name, username, areaNames.map((a) => areas[a]), phone, comp[0], comp[1]]);
    const uid = await newUser(`${username}@agents.tahseel.app`);
    await one(uid, "select public.claim_agent_invite($1)", [inv.r.code]);
    return uid;
  }
  const kadar = await makeAgent("ali.kadar", "علي قدار", ["الهنادي"], ["monthly_salary", 500000]);
  const elia = await makeAgent("elia", "ايليا ضويا", ["فديو"], ["per_invoice", 5000]);
  await one(managerId, "select public.open_month($1)", [M]);
  return { managerId, areas, subs, kadar, elia, makeAgent };
}

const status = async (uid: string, sub: string, month = M) =>
  (await one<{ status: string; remaining: string; paid: string }>(uid, "select status, remaining, paid from public.area_subscribers($1) where id = $2", [month, sub]));

/** Run SQL as the Edge Function does (service_role). */
async function asService<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as T[];
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** Run SQL as a Supabase anonymous (guest) user. */
async function asGuest<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", is_anonymous: true })]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as T[];
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** YYYY-MM shifted by n months. */
const shiftM = (m: string, n: number) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};
const subRow = async (uid: string, sub: string, month = M) =>
  one<Record<string, unknown>>(uid, "select * from public.area_subscribers($1) where id = $2", [month, sub]);

/** A part payment made before 0006 (the API no longer accepts one) — inserted directly as legacy data. */
const legacyPart = (sub: string, amount: number, method: string, recordedBy: string, agentId: string | null = null) =>
  su(`insert into public.payments (invoice_id, subscriber_id, area_id, month, amount, method, agent_id, recorded_by)
      select i.id, i.subscriber_id, i.area_id, i.month, $2, $3, $4, $5 from public.invoices i where i.subscriber_id = $1 and i.month = $6`,
    [sub, amount, method, agentId, recordedBy, M]);

/* ---------------- tests ---------------- */

describe("row-level security", () => {
  it("anon and users without a profile see nothing; agents see only their own areas", async () => {
    const f = await fixture();
    await expect(as(null, "select * from public.subscribers")).rejects.toThrow(/permission denied/);
    const stranger = await newUser("random@x.com");
    expect(await as(stranger, "select * from public.subscribers")).toHaveLength(0);
    await expect(as(stranger, "select * from public.area_subscribers($1)", [M])).rejects.toThrow(/غير مصرح/);

    const kadarRows = await as<{ area_name: string }>(f.kadar, "select area_name from public.area_subscribers($1)", [M]);
    expect(new Set(kadarRows.map((r) => r.area_name))).toEqual(new Set(["الهنادي"]));
    expect(await as(f.kadar, "select * from public.subscribers where area_id = $1", [f.areas["فديو"]])).toHaveLength(0);
    expect(await as(f.kadar, "select * from public.area_subscribers($1, $2)", [M, f.areas["فديو"]])).toHaveLength(0);
    expect(await as(f.kadar, "select * from public.areas")).toHaveLength(1);
    expect(await as(f.kadar, "select * from public.notifications")).toHaveLength(0);
    expect(await as(f.kadar, "select * from public.audit_log")).toHaveLength(0);
    expect(await as(f.kadar, "select * from public.profiles")).toHaveLength(1); // only himself
    expect((await as(f.managerId, "select * from public.subscribers")).length).toBe(8);
  });

  it("nobody can write tables directly — only through functions", async () => {
    const f = await fixture();
    for (const uid of [f.kadar, f.managerId]) {
      await expect(as(uid, "update public.subscribers set monthly_amount = 1")).rejects.toThrow(/permission denied/);
      await expect(as(uid, "delete from public.payments")).rejects.toThrow(/permission denied/);
      await expect(as(uid, "insert into public.agent_areas (agent_id, area_id) values ($1, $2)", [uid, f.areas["فديو"]])).rejects.toThrow(/permission denied/);
    }
    await expect(as(f.kadar, "select public.make_manager('x','y','z')")).rejects.toThrow(/permission denied/);
  });
});

describe("agent invites", () => {
  it("one-time code, username must match, areas cannot be shared — even if the agent has no phone", async () => {
    const f = await fixture();
    const inv = await one<{ r: { code: string } }>(f.managerId, "select public.create_agent_invite('مهند وطفة', 'mohanad', $1::uuid[]) r", [[f.areas["الخرنوبة"]]]);
    expect(inv.r.code).toMatch(/^[A-Z2-9]{8}$/);
    expect((await one<{ r: { full_name: string } }>(null, "select public.invite_info($1) r", [inv.r.code.toLowerCase()])).r.full_name).toBe("مهند وطفة");
    const wrong = await newUser("someoneelse@agents.tahseel.app");
    await expect(as(wrong, "select public.claim_agent_invite($1)", [inv.r.code])).rejects.toThrow(/لا يطابق/);
    const ok = await newUser("mohanad@agents.tahseel.app");
    await as(ok, "select public.claim_agent_invite($1)", [inv.r.code]);
    const again = await newUser("mohanad2@agents.tahseel.app");
    await expect(as(again, "select public.claim_agent_invite($1)", [inv.r.code])).rejects.toThrow(/مسبقاً|غير صالح/);
    expect((await one<{ r: unknown }>(null, "select public.invite_info($1) r", [inv.r.code])).r).toBeNull();
    // area already taken (agent ali.kadar has no phone → regression for composite-null check)
    await expect(as(f.managerId, "select public.create_agent_invite('x', 'xyz', $1::uuid[])", [[f.areas["الهنادي"]]])).rejects.toThrow(/مرتبطة بمعتمد آخر/);
    await expect(as(f.kadar, "select public.create_agent_invite('x', 'xyz', $1::uuid[])", [[f.areas["الهنادي"]]])).rejects.toThrow(/للمدير فقط/);
  });
});

describe("agent «تم الدفع»", () => {
  it("records the full invoice, is idempotent, refuses repeats and other areas, no per-payment notification", async () => {
    const f = await fixture();
    const k = key();
    const r1 = await one<{ r: { amount: number; repeated: boolean } }>(f.kadar, "select public.agent_mark_paid($1, $2, $3) r", [f.subs["علي أحمد عروس"], M, k]);
    expect(r1.r).toMatchObject({ amount: 200000, repeated: false });
    const r2 = await one<{ r: { repeated: boolean } }>(f.kadar, "select public.agent_mark_paid($1, $2, $3) r", [f.subs["علي أحمد عروس"], M, k]);
    expect(r2.r.repeated).toBe(true);
    await expect(as(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["علي أحمد عروس"], M, key()])).rejects.toThrow(/مدفوع مسبقاً/);
    await expect(as(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["فادي"], M, key()])).rejects.toThrow(/ليس من منطقتك/);
    await expect(as(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["بدون سرعة"], M, key()])).rejects.toThrow(/سعر/);
    expect((await su("select count(*)::int c from public.payments"))[0].c).toBe(1);
    expect(await as(f.managerId, "select * from public.notifications")).toHaveLength(0);
    // agent cannot undo
    const pid = (await su("select id from public.payments"))[0].id;
    await expect(as(f.kadar, "select public.manager_reverse('payment', $1, 'خطأ', $2)", [pid, key()])).rejects.toThrow(/للمدير فقط/);
  });

  it("two phones tapping at the same moment → exactly one payment", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => as(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["أحمد محمد"], M, key()])),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await su("select coalesce(sum(amount),0)::int s from public.payments"))[0].s).toBe(100000);
  });

  it("a disabled agent can do nothing", async () => {
    const f = await fixture();
    await as(f.managerId, "select public.set_agent_active($1, false)", [f.kadar]);
    expect(await as(f.kadar, "select * from public.subscribers")).toHaveLength(0);
    await expect(as(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["أحمد محمد"], M, key()])).rejects.toThrow(/غير مفعّل/);
  });
});

describe("manager operations", () => {
  it("full invoice only (part and over amounts refused), agentless area needs manager cash, Sham Cash ref unique, reversal", async () => {
    const f = await fixture();
    const mahmoud = f.subs["محمود خالد"]; // invoice 150,000
    await expect(as(f.managerId, "select public.manager_record_payment($1, $2, 50000, 'manager_cash', $3)", [mahmoud, M, key()])).rejects.toThrow(/كاملة فقط/);
    await expect(as(f.managerId, "select public.manager_record_payment($1, $2, 300000, 'manager_cash', $3)", [f.subs["فراس"], M, key()])).rejects.toThrow(/كاملة فقط/);
    expect(await status(f.managerId, mahmoud)).toMatchObject({ status: "unpaid", paid: "0", remaining: "150000" });
    const r = await one<{ r: { amount: number } }>(f.managerId, "select public.manager_record_payment($1, $2, 150000, 'manager_cash', $3) r", [mahmoud, M, key()]);
    expect(r.r.amount).toBe(150000); // exact remaining is accepted
    expect(await status(f.managerId, mahmoud)).toMatchObject({ status: "paid", remaining: "0" });

    // legacy part-paid invoice: listed as unpaid with only the remainder due; the agent's tap pays the rest
    const ali = f.subs["علي أحمد عروس"]; // invoice 200,000
    await legacyPart(ali, 50000, "manager_cash", f.managerId);
    expect(await status(f.managerId, ali)).toMatchObject({ status: "unpaid", paid: "50000", remaining: "150000" });
    expect((await one<{ r: { amount: number } }>(f.kadar, "select public.agent_mark_paid($1, $2, $3) r", [ali, M, key()])).r.amount).toBe(150000);
    expect((await status(f.managerId, ali)).status).toBe("paid");
    expect(await as(f.managerId, "select 1 from public.area_subscribers($1) where status = 'partial'", [M])).toHaveLength(0);
    await expect(as(f.managerId, "select public.manager_record_payment($1, $2, null, 'agent_cash', $3)", [f.subs["كامل"], M, key()])).rejects.toThrow(/بدون معتمد/);
    await as(f.managerId, "select public.manager_record_payment($1, $2, null, 'shamcash', $3, 'SC-1')", [f.subs["فادي"], M, key()]);
    await expect(as(f.managerId, "select public.manager_record_payment($1, $2, null, 'shamcash', $3, 'SC-1')", [f.subs["فراس"], M, key()])).rejects.toThrow(/مسجّل مسبقاً/);
    const pid = (await su("select id from public.payments where reference = 'SC-1'"))[0].id;
    await as(f.managerId, "select public.manager_reverse('payment', $1, 'رقم خاطئ', $2)", [pid, key()]);
    expect((await status(f.managerId, f.subs["فادي"])).status).toBe("unpaid");
    await expect(as(f.managerId, "select public.manager_reverse('payment', $1, 'مرة ثانية', $2)", [pid, key()])).rejects.toThrow(/مسبقاً/);
    // the same reference is free again after its payment was reversed
    await as(f.managerId, "select public.manager_record_payment($1, $2, null, 'shamcash', $3, 'SC-1')", [f.subs["فادي"], M, key()]);
  });

  it("exempt this month, speed change re-prices only an untouched invoice, disconnect and reconnect", async () => {
    const f = await fixture();
    await as(f.managerId, "select public.set_month_exempt($1, $2, 'عطل', $3)", [f.subs["أحمد محمد"], M, key()]);
    expect((await status(f.managerId, f.subs["أحمد محمد"])).status).toBe("exempt");
    expect((await status(f.managerId, f.subs["نقطة خدمة"])).status).toBe("exempt"); // SPF
    expect((await status(f.managerId, f.subs["بدون سرعة"])).status).toBe("no_price");

    const up = (sub: string, speed: number) =>
      one<{ r: { monthly_amount: number; repriced: boolean } }>(f.managerId, "select public.update_subscriber($1, $2, null, null, $3, false, null, $4) r", [sub, "x", speed, M]);
    expect((await up(f.subs["فراس"], 8)).r).toMatchObject({ monthly_amount: 400000, repriced: true });
    expect((await status(f.managerId, f.subs["فراس"])).remaining).toBe("400000");
    await one(f.elia, "select public.agent_mark_paid($1, $2, $3)", [f.subs["فادي"], M, key()]);
    expect((await up(f.subs["فادي"], 10)).r).toMatchObject({ monthly_amount: 500000, repriced: false });
    expect((await su("select package_label from public.subscribers where id = $1", [f.subs["فادي"]]))[0].package_label).toBe("10M");
    // setting a speed for the no-price subscriber
    expect((await up(f.subs["بدون سرعة"], 2)).r.monthly_amount).toBe(100000);

    await as(f.managerId, "select public.disconnect_subscriber($1, $2)", [f.subs["كامل"], NEXT]);
    await as(f.managerId, "select public.open_month($1)", [NEXT]);
    expect((await su("select count(*)::int c from public.invoices where subscriber_id = $1 and month = $2", [f.subs["كامل"], NEXT]))[0].c).toBe(0);
    expect((await su("select count(*)::int c from public.invoices where subscriber_id = $1 and month = $2", [f.subs["فادي"], NEXT]))[0].c).toBe(1);
    expect((await su("select amount::int from public.invoices where subscriber_id = $1 and month = $2", [f.subs["فادي"], NEXT]))[0].amount).toBe(500000);
    await as(f.managerId, "select public.reconnect_subscriber($1)", [f.subs["كامل"]]);
    expect((await one<{ r: { issued: number } }>(f.managerId, "select public.open_month($1) r", [NEXT])).r.issued).toBe(1);
  });

  it("a speed change re-prices an invoice whose only payment was reversed", async () => {
    const f = await fixture();
    await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["أحمد محمد"], M, key()]);
    const pid = (await su("select id from public.payments"))[0].id;
    const up = () => one<{ r: { repriced: boolean } }>(f.managerId, "select public.update_subscriber($1, 'أحمد محمد', null, null, 8, false, null, $2) r", [f.subs["أحمد محمد"], M]);
    expect((await up()).r.repriced).toBe(false);
    await as(f.managerId, "select public.manager_reverse('payment', $1, 'خطأ', $2)", [pid, key()]);
    await as(f.managerId, "select public.update_subscriber($1, 'أحمد محمد', null, null, 2, false, null, null)", [f.subs["أحمد محمد"]]);
    expect((await up()).r.repriced).toBe(true);
    expect(await status(f.managerId, f.subs["أحمد محمد"])).toMatchObject({ status: "unpaid", remaining: "400000" });
  });

  it("import is blocked once invoices exist", async () => {
    const f = await fixture();
    await expect(as(f.managerId, "select public.import_subscribers('[{\"full_name\":\"x\",\"area\":\"y\"}]'::jsonb)")).rejects.toThrow(/بعد إصدار الفواتير/);
  });
});

describe("agent cash and compensation", () => {
  it("collected − delivered − approved deductions = holding; salary paid separately doesn't change it", async () => {
    const f = await fixture();
    for (const s of ["علي أحمد عروس", "أحمد محمد", "محمود خالد"]) await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs[s], M, key()]);
    await as(f.managerId, "select public.record_agent_tx($1, $2, $3, 'delivery', 300000, $4)", [f.kadar, f.areas["الهنادي"], M, key()]);
    const comp = await one<{ r: { due: number; remaining: number } }>(f.managerId, "select public.agent_compensation($1, $2) r", [f.kadar, M]);
    expect(comp.r).toMatchObject({ due: 500000, remaining: 500000 });
    await as(f.managerId, "select public.record_agent_tx($1, $2, $3, 'deduction', 100000, $4)", [f.kadar, f.areas["الهنادي"], M, key()]);
    await as(f.managerId, "select public.record_agent_tx($1, null, $2, 'salary_paid', 400000, $3)", [f.kadar, M, key()]);
    const cash = await one<{ collected: string; delivered: string; deductions: string; holding: string; collected_count: string }>(
      f.managerId, "select * from public.agent_cash($1) where agent_id = $2", [M, f.kadar]);
    expect(cash).toMatchObject({ collected: "450000", collected_count: "3", delivered: "300000", deductions: "100000", holding: "50000" });
    expect((await one<{ r: { remaining: number } }>(f.managerId, "select public.agent_compensation($1, $2) r", [f.kadar, M])).r.remaining).toBe(0);
    // agent sees only his own cash rows
    expect((await as(f.kadar, "select * from public.agent_cash($1)", [M])).length).toBe(1);
    expect((await as(f.elia, "select * from public.agent_cash($1) where agent_id = $2", [M, f.kadar])).length).toBe(0);
  });

  it("per-invoice commission counts each invoice once, only when it went through the agent", async () => {
    const f = await fixture();
    await legacyPart(f.subs["فادي"], 50000, "agent_cash", f.managerId, f.elia);
    await one(f.elia, "select public.agent_mark_paid($1, $2, $3)", [f.subs["فادي"], M, key()]); // 2 installments (legacy) → 1 invoice
    await as(f.managerId, "select public.manager_record_payment($1, $2, null, 'shamcash', $3, 'X9')", [f.subs["فراس"], M, key()]); // company only → none
    const c = await one<{ r: { invoices: number; due: number } }>(f.managerId, "select public.agent_compensation($1, $2) r", [f.elia, M]);
    expect(c.r).toMatchObject({ invoices: 1, due: 5000 });
  });
});

describe("daily summary (replaces per-payment notifications)", () => {
  it("one line per area per day with the agent's total; reversals net out; tap target lists the payments", async () => {
    const f = await fixture();
    for (const n of ["علي أحمد عروس", "أحمد محمد"]) await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs[n], M, key()]);
    await one(f.elia, "select public.agent_mark_paid($1, $2, $3)", [f.subs["فادي"], M, key()]);
    await as(f.managerId, "select public.manager_record_payment($1, $2, null, 'shamcash', $3, 'SC-9')", [f.subs["فراس"], M, key()]);
    const fadiPay = (await su("select id from public.payments where subscriber_id = $1", [f.subs["فادي"]]))[0].id;
    await as(f.managerId, "select public.manager_reverse('payment', $1, 'خطأ', $2)", [fadiPay, key()]);

    const lines = await as<{ area_name: string; agent_name: string; amount: string; invoices: string; day: string }>(
      f.managerId, "select * from public.daily_collections(7)");
    expect(lines.map((l) => [l.area_name, l.agent_name, l.amount, l.invoices])).toEqual([["الهنادي", "علي قدار", "300000", "2"]]);
    const day = (await su("select (now() at time zone 'Asia/Damascus')::date::text d"))[0].d;
    const list = await as<{ full_name: string; amount: string }>(f.managerId, "select * from public.day_payments($1, $2::date)", [f.areas["الهنادي"], day]);
    expect(list.map((x) => x.full_name).sort()).toEqual(["أحمد محمد", "علي أحمد عروس"]);
    await expect(as(f.kadar, "select * from public.daily_collections(7)")).rejects.toThrow(/للمدير فقط/);
  });

  it("the list shows how each invoice was paid", async () => {
    const f = await fixture();
    await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["أحمد محمد"], M, key()]);
    await as(f.managerId, "select public.manager_record_payment($1, $2, null, 'shamcash', $3, 'SC-1')", [f.subs["فراس"], M, key()]);
    await legacyPart(f.subs["محمود خالد"], 50000, "manager_cash", f.managerId);
    await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["محمود خالد"], M, key()]);
    const via = Object.fromEntries((await as<{ full_name: string; paid_via: string | null }>(f.managerId, "select full_name, paid_via from public.area_subscribers($1)", [M])).map((r) => [r.full_name, r.paid_via]));
    expect(via).toMatchObject({ "أحمد محمد": "agent_cash", "فراس": "shamcash", "محمود خالد": "agent_cash,manager_cash", "فادي": null });
  });
});

describe("agent accounts (Edge Function helpers, service_role only)", () => {
  it("validates like invites, registers profile + areas, refuses apps and non-managers", async () => {
    const f = await fixture();
    const reg = (actor: string, user: string | null, username: string, areas: string[], dry: boolean) =>
      asService<{ r: Record<string, unknown> }>(
        "select public.admin_register_agent($1, $2, $3, $4, $5::uuid[], null, 'none', 0, $6) r", [actor, user, "سامر", username, areas, dry]);
    // apps can never call them
    await expect(as(f.managerId, "select public.admin_register_agent($1, null, 'x', 'samer', $2::uuid[], null, 'none', 0, true)", [f.managerId, [f.areas["الخرنوبة"]]])).rejects.toThrow(/permission denied/);
    await expect(as(f.managerId, "select public.admin_is_manager($1)", [f.managerId])).rejects.toThrow(/permission denied/);
    expect((await asService<{ m: boolean }>("select public.admin_is_manager($1) m", [f.managerId]))[0].m).toBe(true);
    expect((await asService<{ m: boolean }>("select public.admin_is_manager($1) m", [f.kadar]))[0].m).toBe(false);

    await expect(reg(f.kadar, null, "samer", [f.areas["الخرنوبة"]], true)).rejects.toThrow(/للمدير فقط/);
    await expect(reg(f.managerId, null, "ali.kadar", [f.areas["الخرنوبة"]], true)).rejects.toThrow(/مستخدم مسبقاً/);
    await expect(reg(f.managerId, null, "samer", [f.areas["الهنادي"]], true)).rejects.toThrow(/مرتبطة بمعتمد آخر/);
    await expect(reg(f.managerId, null, "Sa mer", [f.areas["الخرنوبة"]], true)).rejects.toThrow(/اسم الدخول/);
    expect((await reg(f.managerId, null, "Samer", [f.areas["الخرنوبة"]], true))[0].r).toMatchObject({ ok: true, username: "samer" });

    const uid = (await su("insert into auth.users (email) values ('samer@agents.tahseel.app') returning id"))[0].id;
    expect((await reg(f.managerId, uid, "samer", [f.areas["الخرنوبة"]], false))[0].r).toMatchObject({ ok: true, username: "samer", areas: "الخرنوبة" });
    expect((await su("select role, username from public.profiles where id = $1", [uid]))[0]).toEqual({ role: "agent", username: "samer" });
    expect(await as(uid, "select name from public.areas")).toEqual([{ name: "الخرنوبة" }]);

    const reset = await asService<{ r: Record<string, unknown> }>("select public.admin_agent_for_reset($1, $2) r", [f.managerId, uid]);
    expect(reset[0].r).toMatchObject({ username: "samer", areas: "الخرنوبة" });
    await expect(asService("select public.admin_agent_for_reset($1, $2)", [f.managerId, f.managerId])).rejects.toThrow(/غير موجود/);
  });
});

describe("guest mode (anonymous, read-only, guest code)", () => {
  it("three-part names match src/lib/names.ts", async () => {
    await fixture();
    for (const [full, father, out] of NAME_CASES) {
      expect((await su("select public._display_name($1, $2) n", [full, father]))[0].n).toBe(out);
    }
  });

  it("a guest gets nothing from tables or manager/agent functions", async () => {
    const f = await fixture();
    await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["أحمد محمد"], M, key()]);
    const g = await newUser(null);
    for (const t of ["settings", "profiles", "areas", "agent_areas", "agent_invites", "subscribers", "billing_months", "invoices",
      "payments", "exemptions", "agent_transactions", "notifications", "audit_log"]) {
      expect(await asGuest(g, `select * from public.${t}`), t).toHaveLength(0);
    }
    for (const t of ["guest_config", "guest_sessions", "guest_attempts"]) {
      await expect(asGuest(g, `select * from public.${t}`), t).rejects.toThrow(/permission denied/);
    }
    for (const sql of [
      "select * from public.area_subscribers($1)", "select * from public.area_overview($1)", "select * from public.agent_cash($1)",
    ]) await expect(asGuest(g, sql, [M]), sql).rejects.toThrow(/غير مصرح|للمدير فقط/);
    await expect(asGuest(g, "select * from public.daily_collections(7)")).rejects.toThrow(/للمدير فقط/);
    await expect(asGuest(g, "select * from public.subscriber_history($1)", [f.subs["أحمد محمد"]])).rejects.toThrow(/للمدير فقط/);
    await expect(asGuest(g, "select public.set_guest_code('123456')")).rejects.toThrow(/للمدير فقط/);
    await expect(asGuest(g, "select public._display_name('a', 'b')")).rejects.toThrow(/permission denied/);
  });

  it("guest code: hash only, rate limit, read-only fields, code change ends sessions", async () => {
    const f = await fixture();
    await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["علي أحمد عروس"], M, key()]);
    const g = await newUser(null);
    await expect(asGuest(g, "select * from public.guest_overview(null)")).rejects.toThrow(/رمز الضيف/);
    expect((await asGuest<{ r: { ok: boolean; error: string } }>(g, "select public.guest_unlock('123456') r"))[0].r).toMatchObject({ ok: false, error: "دخول الضيوف غير مفعّل" });

    await expect(as(f.managerId, "select public.set_guest_code('12345')")).rejects.toThrow(/6 أحرف/);
    await one(f.managerId, "select public.set_guest_code(' Zaytoon26 ')");
    const cfg = (await su("select code_hash, code_salt from public.guest_config"))[0];
    expect(cfg.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(cfg)).not.toContain("zaytoon26");
    expect((await one<{ e: boolean }>(f.managerId, "select public.guest_code_enabled() e")).e).toBe(true);

    // 5 wrong codes → locked for 15 minutes, even with the right code
    for (let i = 0; i < 5; i++) {
      expect((await asGuest<{ r: { ok: boolean } }>(g, "select public.guest_unlock('wrong-code') r"))[0].r.ok).toBe(false);
    }
    expect((await asGuest<{ r: { error: string } }>(g, "select public.guest_unlock('zaytoon26') r"))[0].r.error).toMatch(/محاولات كثيرة/);

    const g2 = await newUser(null);
    expect((await asGuest<{ r: { ok: boolean } }>(g2, "select public.guest_unlock('ZAYTOON26') r"))[0].r.ok).toBe(true);
    const areas = await asGuest<Record<string, unknown>>(g2, "select * from public.guest_overview(null)");
    const hnadi = areas.find((a) => a.area_name === "الهنادي")!;
    expect(Object.keys(hnadi).sort()).toEqual(["area_id", "area_name", "month", "paid_count", "unpaid_count"]);
    expect(hnadi).toMatchObject({ month: M, paid_count: "1" });
    const list = await asGuest<Record<string, unknown>>(g2, "select * from public.guest_area_list(null, $1)", [f.areas["الهنادي"]]);
    expect(Object.keys(list[0]).sort()).toEqual(["area_name", "display_name", "status"]);
    expect(list.find((r) => r.display_name === "علي أحمد عروس")?.status).toBe("paid");
    expect(list.map((r) => r.status).every((x) => ["paid", "unpaid", "exempt"].includes(String(x)))).toBe(true);
    // signed-in staff are not guests
    await expect(as(f.managerId, "select * from public.guest_overview(null)")).rejects.toThrow(/رمز الضيف/);
    await expect(as(f.kadar, "select public.guest_unlock('zaytoon26')")).rejects.toThrow(/للضيوف فقط/);

    // a new code signs every guest out
    await one(f.managerId, "select public.set_guest_code('newcode99')");
    await expect(asGuest(g2, "select * from public.guest_overview(null)")).rejects.toThrow(/رمز الضيف/);
    expect((await asGuest<{ r: { unlocked: boolean } }>(g2, "select public.guest_status() r"))[0].r.unlocked).toBe(false);
  });
});

describe("deferral («تأجيل»)", () => {
  it("defer → cancel → defer, one month max, agent pays both in one idempotent tap", async () => {
    const f = await fixture();
    const N = shiftM(M, 1);
    const ahmad = f.subs["أحمد محمد"]; // 100,000 a month
    const defer = (k = key()) => one<{ r: { deferred_to: string; repeated: boolean } }>(f.managerId, "select public.defer_invoice($1, $2, $3) r", [ahmad, M, k]);
    await expect(as(f.kadar, "select public.defer_invoice($1, $2, $3)", [ahmad, M, key()])).rejects.toThrow(/غير مفعّل|للمدير فقط/);
    const k1 = key();
    expect((await defer(k1)).r).toMatchObject({ deferred_to: N, repeated: false });
    expect((await defer(k1)).r.repeated).toBe(true);
    await expect(defer()).rejects.toThrow(/مؤجلة مسبقاً/);
    expect(await subRow(f.managerId, ahmad)).toMatchObject({ status: "unpaid", deferred_to: N, never_disconnect: true, carried_amount: "0" });
    expect((await asService<{ n: boolean }>("select public.never_disconnect($1) n", [ahmad]))[0].n).toBe(true);
    await expect(as(f.managerId, "select public.never_disconnect($1)", [ahmad])).rejects.toThrow(/permission denied/);

    await as(f.managerId, "select public.cancel_deferral($1, $2)", [ahmad, M]);
    expect(await subRow(f.managerId, ahmad)).toMatchObject({ deferred_to: null, never_disconnect: false });
    expect((await defer()).r.repeated).toBe(false); // allowed again after a cancel

    await one(f.managerId, "select public.open_month($1)", [N]);
    expect(await subRow(f.managerId, ahmad, N)).toMatchObject({ carried_month: M, carried_amount: "100000", remaining: "100000", never_disconnect: true });
    // never two months
    await expect(one(f.managerId, "select public.defer_invoice($1, $2, $3)", [ahmad, N, key()])).rejects.toThrow(/شهر واحد/);
    // the agent sees it too (through his area) and pays both at once
    expect(await subRow(f.kadar, ahmad, N)).toMatchObject({ carried_month: M, carried_amount: "100000" });
    const k = key();
    const p1 = await one<{ r: Record<string, unknown> }>(f.kadar, "select public.agent_mark_paid($1, $2, $3) r", [ahmad, N, k]);
    expect(p1.r).toMatchObject({ amount: 200000, carried_month: M, carried_amount: 100000, repeated: false });
    const p2 = await one<{ r: Record<string, unknown> }>(f.kadar, "select public.agent_mark_paid($1, $2, $3) r", [ahmad, N, k]);
    expect(p2.r).toMatchObject({ amount: 200000, repeated: true });
    expect(await su("select month, amount::int from public.payments where subscriber_id = $1 order by month", [ahmad])).toEqual([
      { month: M, amount: 100000 }, { month: N, amount: 100000 },
    ]);
    expect((await status(f.managerId, ahmad, M)).status).toBe("paid");
    expect(await subRow(f.managerId, ahmad, N)).toMatchObject({ status: "paid", carried_amount: "0", never_disconnect: false });
    await expect(as(f.managerId, "select public.cancel_deferral($1, $2)", [ahmad, M])).rejects.toThrow(/دُفعت/);
  });

  it("manager pays both: only the total is accepted; Sham Cash number on the current row", async () => {
    const f = await fixture();
    const N = shiftM(M, 1);
    const mahmoud = f.subs["محمود خالد"]; // 150,000 a month
    await one(f.managerId, "select public.defer_invoice($1, $2, $3)", [mahmoud, M, key()]);
    await one(f.managerId, "select public.open_month($1)", [N]);
    await expect(as(f.managerId, "select public.manager_record_payment($1, $2, 150000, 'manager_cash', $3)", [mahmoud, N, key()])).rejects.toThrow(/كاملة فقط: 300,000/);
    const r = await one<{ r: Record<string, unknown> }>(f.managerId, "select public.manager_record_payment($1, $2, 300000, 'shamcash', $3, 'SC-7') r", [mahmoud, N, key()]);
    expect(r.r).toMatchObject({ amount: 300000, carried_month: M });
    expect(await su("select month, amount::int, reference, notes from public.payments where subscriber_id = $1 order by month", [mahmoud])).toEqual([
      { month: M, amount: 150000, reference: null, notes: "نفس عملية SC-7" },
      { month: N, amount: 150000, reference: "SC-7", notes: null },
    ]);
  });
});

describe("late-payment notifications", () => {
  it("late = on/after the cutoff of its own month; a carried (deferred) invoice never; one row per late payment", async () => {
    const f = await fixture();
    // months relative to "now" (payments are stamped with now())
    const CUR = (await su("select to_char(now() at time zone 'Asia/Damascus', 'YYYY-MM') m"))[0].m as string;
    const PREV = shiftM(CUR, -1);
    const NEXT = shiftM(CUR, 1);
    for (const m of [PREV, CUR, NEXT]) await one(f.managerId, "select public.open_month($1)", [m]);
    expect((await su("select value from public.settings where key = 'cutoff_day'"))[0].value).toBe("25");
    const late = () => su("select n.body, p.month from public.notifications n join public.payments p on p.id = n.payment_id where n.kind = 'late_payment' order by n.id");
    const ali = f.subs["علي أحمد عروس"]; // 200,000
    const ahmad = f.subs["أحمد محمد"]; // 100,000

    await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [ali, PREV, key()]); // last month's own invoice → late
    expect(await late()).toEqual([{ body: "علي أحمد عروس — الهنادي: كان متأخراً ودفع 200,000 ل.س", month: PREV }]);
    await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [ali, NEXT, key()]); // before its cutoff → not late
    expect(await late()).toHaveLength(1);

    // last month deferred into this month; with cutoff day 1 this month's own invoice is surely late
    await one(f.managerId, "select public.defer_invoice($1, $2, $3)", [ahmad, PREV, key()]);
    await su("update public.settings set value = '1' where key = 'cutoff_day'");
    const both = await one<{ r: { amount: number; carried_month: string } }>(f.kadar, "select public.agent_mark_paid($1, $2, $3) r", [ahmad, CUR, key()]);
    expect(both.r).toMatchObject({ amount: 200000, carried_month: PREV });
    const rows = await late();
    expect(rows).toHaveLength(2); // ONE alert: the current month's own invoice — the carried one never
    expect(rows[1]).toEqual({ body: "أحمد محمد — الهنادي: كان متأخراً ودفع 100,000 ل.س", month: CUR });

    // a correction (reversal row) never alerts
    const pid = (await su("select id from public.payments where subscriber_id = $1 and month = $2", [ali, PREV]))[0].id;
    await as(f.managerId, "select public.manager_reverse('payment', $1, 'خطأ', $2)", [pid, key()]);
    expect(await late()).toHaveLength(2);
    // the manager reads them; agents and guests do not
    expect(await as(f.managerId, "select id from public.notifications where kind = 'late_payment'")).toHaveLength(2);
    expect(await as(f.kadar, "select id from public.notifications")).toHaveLength(0);
  });
});

describe("subscriber history (manager only)", () => {
  it("last 3 billing months: status, net paid, Damascus time, method and recorder; agents refused", async () => {
    const f = await fixture();
    const prev = (n: number) => {
      const [y, m] = M.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
    };
    for (const n of [3, 2, 1]) await as(f.managerId, "select public.open_month($1)", [prev(n)]);
    const ahmad = f.subs["أحمد محمد"]; // 100,000 a month
    await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [ahmad, M, key()]);
    await as(f.managerId, "select public.set_month_exempt($1, $2, 'عطل', $3)", [ahmad, prev(1), key()]);

    const h = await as<{ month: string; invoice_amount: string; status: string; paid_amount: string; paid_at: string | null; method: string | null; recorded_by: string | null }>(
      f.managerId, "select * from public.subscriber_history($1)", [ahmad]);
    expect(h.map((r) => [r.month, r.status, r.paid_amount])).toEqual([[M, "paid", "100000"], [prev(1), "exempt", "0"], [prev(2), "unpaid", "0"]]);
    expect(h[0]).toMatchObject({ invoice_amount: "100000", method: "agent_cash", recorded_by: "علي قدار" });
    const day = (await su("select (now() at time zone 'Asia/Damascus')::date::text d"))[0].d;
    expect(h[0].paid_at).toMatch(new RegExp(`^${day} \\d{2}:\\d{2}$`));
    expect(h[2]).toMatchObject({ paid_at: null, method: null, recorded_by: null });

    await expect(as(f.kadar, "select * from public.subscriber_history($1)", [ahmad])).rejects.toThrow(/للمدير فقط/);
  });
});

describe("overview", () => {
  it("area totals match the rows", async () => {
    const f = await fixture();
    await one(f.kadar, "select public.agent_mark_paid($1, $2, $3)", [f.subs["علي أحمد عروس"], M, key()]);
    const h = await one<{ expected: string; paid: string; remaining: string; paid_count: string; unpaid_count: string; agent_name: string }>(
      f.managerId, "select * from public.area_overview($1) where area_name = 'الهنادي'", [M]);
    expect(h).toMatchObject({ expected: "450000", paid: "200000", remaining: "250000", paid_count: "1", unpaid_count: "2", agent_name: "علي قدار" });
    const agentView = await as(f.kadar, "select * from public.area_overview($1)", [M]);
    expect(agentView).toHaveLength(1);
  });
});

// Real company file (personal data — never committed): set TAHSEEL_REAL_XLSX to its path.
const REAL = process.env.TAHSEEL_REAL_XLSX;
describe.skipIf(!REAL || !existsSync(REAL))("import of the real workbook", () => {
  it("imports 834 subscribers in 12 areas and issues 106,100,000 for the month", async () => {
    const managerId = await newUser("manager@tahseel.app");
    await su("select public.make_manager('manager@tahseel.app', 'المدير', 'manager')");
    const plan = buildImportPlan(parseWorkbook(readXlsx(new Uint8Array(readFileSync(REAL!)))));
    const r = await one<{ r: { imported: number; areas: number } }>(managerId, "select public.import_subscribers($1::jsonb) r", [JSON.stringify(plan.rows)]);
    expect(r.r).toEqual({ imported: 834, areas: 12 });
    const o = await one<{ r: { issued: number; total: number; no_price: number } }>(managerId, "select public.open_month($1) r", [M]);
    expect(o.r).toMatchObject({ issued: 830, total: 106_100_000, no_price: 4 });
    const areas = (await su("select name from public.areas order by name")).map((x) => x.name);
    expect(areas).toContain("ضهر السرياني");
    expect(areas).toContain("الفاخورة");
  });
});
