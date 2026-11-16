import { describe, expect, it } from "vitest";
import { filterRows, toDisplayRows, totals } from "./agentList";
import { buildSearchable, normalizeArabic, scoreMatch } from "./arabic";
import { classifyError } from "./errors";
import { loginEmail } from "./env";
import { formatFull, formatK, parseK } from "./money";
import { PaymentQueue, type KeyValueStore, type SendResult } from "./paymentQueue";
import type { SubscriberRow } from "./types";

describe("money in thousands", () => {
  it.each([[100_000, "100"], [1_000_000, "1,000"], [12_345_000, "12,345"], [2_500, "2.5"], [0, "0"], [-150_000, "-150"]])("formatK(%i)", (v, out) =>
    expect(formatK(v)).toBe(out));
  it("full and parse", () => {
    expect(formatFull(106_100_000)).toBe("106,100,000");
    expect(formatFull(-1_000)).toBe("-1,000");
    expect(parseK("١٬٠٠٠".replace("٬", ","))).toBe(1_000_000);
  });
});

describe("arabic search", () => {
  const s = buildSearchable({ fullName: "علي أحمد عروس", fatherName: "أحمد", username: "hnadi7", code: "S-0001", phone: "0933123456" });
  it("matches across hamza/ta-marbuta variations and order", () => {
    expect(scoreMatch("علي عروس", s)).toBeGreaterThan(0);
    expect(scoreMatch("احمد", s)).toBeGreaterThan(0);
    expect(scoreMatch("hnadi7", s)).toBe(1000);
    expect(scoreMatch("0933", s)).toBe(700);
    expect(scoreMatch("محمود", s)).toBe(0);
    expect(normalizeArabic("فاطمة")).toBe(normalizeArabic("فاطمه"));
  });
});

describe("login email", () => {
  it("usernames get the agent domain, emails stay", () => {
    expect(loginEmail(" Ali.Kadar ")).toBe("ali.kadar@agents.tahseel.app");
    expect(loginEmail("Boss@Mail.com")).toBe("boss@mail.com");
  });
});

describe("error classification", () => {
  it("business errors are final, network errors retry", () => {
    expect(classifyError({ code: "P0001", message: "علي: مدفوع مسبقاً" })).toEqual({ message: "علي: مدفوع مسبقاً", retry: false });
    expect(classifyError(new TypeError("Network request failed")).retry).toBe(true);
    expect(classifyError({ message: "AbortError: Aborted" })).toEqual({ message: "انتهت المهلة — الشبكة بطيئة، أعد المحاولة", retry: true });
    expect(classifyError({ code: "23505", message: "duplicate key value" })).toEqual({ message: "خطأ من الخادم (23505): duplicate key value", retry: true });
    expect(classifyError({ code: "42P01", message: "relation missing" })).toEqual({ message: "خطأ من الخادم (42P01): relation missing", retry: false });
    expect(classifyError({ code: "", message: "TypeError: Network request failed" }).retry).toBe(true);
    expect(classifyError({ message: "Invalid login credentials" }).retry).toBe(false);
  });
});

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => void data.set(k, v) };
}
const base = { subscriberId: "s1", month: "2026-11", name: "علي", areaName: "الهنادي", amount: 200_000 };

describe("payment outbox", () => {
  it("keeps the payment while offline and sends it later exactly once", async () => {
    const store = memStore();
    let online = false;
    const sent: string[] = [];
    const send = async (p: { clientKey: string }): Promise<SendResult> => {
      if (!online) return { ok: false, retry: true, message: "offline" };
      sent.push(p.clientKey);
      return { ok: true };
    };
    const q = new PaymentQueue(store, "k", send);
    await q.add({ ...base, clientKey: "c1" });
    expect(await q.flush()).toBe(0);
    expect(q.pendingCount()).toBe(1);

    // app restarted: a new queue instance reads the same storage
    const q2 = new PaymentQueue(store, "k", send);
    await q2.load();
    expect(q2.pendingCount()).toBe(1);
    online = true;
    const [a, b] = await Promise.all([q2.flush(), q2.flush()]); // concurrent flushes share one run
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(sent).toEqual(["c1"]);
    expect(q2.list()).toHaveLength(0);
  });

  it("a final server refusal becomes a visible failed item that only the agent can dismiss", async () => {
    const q = new PaymentQueue(memStore(), "k", async () => ({ ok: false, retry: false, message: "علي: مدفوع مسبقاً" }));
    await q.add({ ...base, clientKey: "c1" });
    await q.flush();
    expect(q.list()[0]).toMatchObject({ state: "failed", error: "علي: مدفوع مسبقاً" });
    await q.dismiss("c1");
    expect(q.list()).toHaveLength(0);
  });

  it("refuses a second pending tap for the same invoice and stops at the first network failure", async () => {
    const calls: string[] = [];
    const q = new PaymentQueue(memStore(), "k", async (p) => {
      calls.push(p.clientKey);
      return { ok: false, retry: true, message: "offline" };
    });
    const first = await q.add({ ...base, clientKey: "c1" });
    const again = await q.add({ ...base, clientKey: "c2" });
    expect(again.clientKey).toBe(first.clientKey);
    await q.add({ ...base, subscriberId: "s2", clientKey: "c3" });
    await q.flush();
    expect(calls).toEqual(["c1"]);
  });

  it("survives corrupt storage", async () => {
    const store = memStore();
    store.data.set("k", "{not json");
    const q = new PaymentQueue(store, "k", async () => ({ ok: true }));
    expect(await q.load()).toEqual([]);
  });
});

function row(p: Partial<SubscriberRow>): SubscriberRow {
  return {
    id: "x", code: "S-1", full_name: "x", father_name: null, username: null, phone: null, area_id: "A", area_name: "الهنادي",
    package_label: "2M", monthly_amount: 100_000, sub_status: "active", invoice_id: "i", amount: 100_000, paid: 0, exempt: 0,
    remaining: 100_000, status: "unpaid", paid_by_agent: false, last_paid_at: null, paid_via: null, ...p, display_name: p.full_name ?? "x",
  };
}

describe("agent list", () => {
  const rows = [
    row({ id: "1", full_name: "علي أحمد", status: "unpaid" }),
    row({ id: "2", full_name: "أحمد محمد", status: "paid", paid: 100_000, remaining: 0 }),
    row({ id: "3", full_name: "محمود", status: "partial", amount: 200_000, paid: 50_000, remaining: 150_000 }),
    row({ id: "4", full_name: "نقطة", status: "exempt", amount: 0, remaining: 0 }),
    row({ id: "5", full_name: "فادي", area_id: "B", area_name: "فديو" }),
  ];
  const pending = [{ clientKey: "c", subscriberId: "1", month: "2026-11", name: "", areaName: "", amount: 100_000, createdAt: "", state: "pending" as const, attempts: 0 }];
  const d = toDisplayRows(rows, pending, "2026-11");

  it("an unsent tap shows as sending and cannot be tapped again", () => {
    expect(d[0]).toMatchObject({ display: "sending", canMark: false });
    expect(d[2]).toMatchObject({ display: "partial", canMark: true, due: 150_000 });
    expect(d[3].canMark).toBe(false);
    expect(toDisplayRows(rows, pending, "2026-10")[0].display).toBe("unpaid");
  });

  it("filters by status and area; a search finds paid people too", () => {
    expect(filterRows(d, "", "unpaid", null).map((r) => r.id)).toEqual(["3", "5"]);
    expect(filterRows(d, "", "paid", null).map((r) => r.id)).toEqual(["1", "2", "4"]);
    expect(filterRows(d, "", "all", "B").map((r) => r.id)).toEqual(["5"]);
    expect(filterRows(d, "احمد", "unpaid", null).map((r) => r.id).sort()).toEqual(["1", "2"]);
  });

  it("totals", () => {
    expect(totals(d)).toEqual({ collectedCount: 2, collected: 250_000, openCount: 2, open: 250_000 });
  });
});

describe("three-part names", async () => {
  const { displayName } = await import("./names");
  it.each([
    ["علي عروس", "أحمد", "علي أحمد عروس"],
    ["أحمد سلطان", "فايز", "أحمد فايز سلطان"],
    ["عبد الله غضبان", "سمير", "عبد الله سمير غضبان"],
    ["نور الدين راعي", "ميهوب", "نور الدين ميهوب راعي"],
    ["ذو الفقار غضبان", "علي", "ذو الفقار علي غضبان"],
    ["هدى عبد الله", "علي", "هدى علي عبد الله"],
    ["يوسف الذكرى", "عبد الرحمن", "يوسف عبد الرحمن الذكرى"],
    ["سمير الفاضل", "عبد الحميد", "سمير عبد الحميد الفاضل"],
    ["زياد سامي عروس", "سامي", "زياد سامي عروس"],
    ["علي صالح", "صالح", "علي صالح"],
    ["علي صالح 2", "محمود", "علي محمود صالح 2"],
    ["أبو عبدو", null, "أبو عبدو"],
    ["أبو عبدو", "مدجنة", "أبو عبدو مدجنة"],
    ["عبد مسعود", "ابراهيم", "عبد مسعود ابراهيم"],
    ["مخفر الهنادي", "", "مخفر الهنادي"],
  ])("%s + %s → %s", (full, father, out) => expect(displayName(full, father)).toBe(out));
});

describe("daily summary text", async () => {
  const { dailyLine, dayTitle } = await import("./dailyText");
  it("reads like the manager asked", () => {
    expect(dailyLine({ amount: 4_000_000, area_name: "الهنادي", agent_name: "علي قدار" })).toBe("تم دفع 4,000,000 ل.س لمعتمد الهنادي علي قدار");
    expect(dailyLine({ amount: 1_500_000, area_name: "الخلالة", agent_name: "علي بليدي" })).toBe("تم دفع 1,500,000 ل.س لمعتمد الخلالة علي بليدي");
    const now = new Date(2026, 10, 15, 22, 0);
    expect(dayTitle("2026-11-15", now)).toBe("اليوم");
    expect(dayTitle("2026-11-14", now)).toBe("أمس");
    expect(dayTitle("2026-11-12", now)).toBe("الخميس 12/11");
  });
});

describe("agent unpaid export", async () => {
  const { unpaidSheet } = await import("./agentExport");
  it("lists only open invoices with the remaining amount and a total row", () => {
    const rows = [
      row({ id: "1", full_name: "علي عروس", father_name: "أحمد", status: "unpaid", remaining: 100_000 }),
      row({ id: "2", full_name: "سامر", status: "paid", remaining: 0 }),
      row({ id: "3", full_name: "محمود", status: "partial", remaining: 150_000 }),
      row({ id: "4", full_name: "نقطة", status: "exempt", remaining: 0 }),
    ].map((r) => ({ ...r, display_name: r.id === "1" ? "علي أحمد عروس" : r.full_name }));
    const x = unpaidSheet(rows, "علي قدار", "2026-11");
    expect(x.sheets[0].rows.slice(1).map((r) => [r[1], r[5]])).toEqual([["علي أحمد عروس", 100_000], ["محمود", 150_000], ["2 مشترك", 250_000]]);
    expect(x.message).toBe("غير المدفوعين — تشرين الثاني 2026 — علي قدار: 2 مشترك، المجموع 250,000 ل.س");
  });
});
