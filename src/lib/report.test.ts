import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) } }));
vi.mock("./rpc", () => ({
  rpc: vi.fn(async () => [
    { id: "s1", code: "S-1", full_name: "علي", father_name: "أحمد", username: "u1", phone: null, area_id: "A", area_name: "الهنادي", package_label: "4M", monthly_amount: 200000, sub_status: "active", invoice_id: "i1", amount: "200000", paid: "200000", exempt: 0, remaining: 0, status: "paid", paid_by_agent: true, last_paid_at: null },
    { id: "s2", code: "S-2", full_name: "سامر", father_name: null, username: null, phone: "0933", area_id: "A", area_name: "الهنادي", package_label: "2M", monthly_amount: 100000, sub_status: "active", invoice_id: "i2", amount: "100000", paid: 0, exempt: 0, remaining: "100000", status: "unpaid", paid_by_agent: false, last_paid_at: null },
    { id: "s3", code: "S-3", full_name: "كامل", father_name: null, username: null, phone: null, area_id: "B", area_name: "الخرنوبة", package_label: null, monthly_amount: null, sub_status: "active", invoice_id: null, amount: null, paid: 0, exempt: 0, remaining: 0, status: "no_price", paid_by_agent: false, last_paid_at: null },
  ]),
  q: vi.fn(async () => [
    { invoice_id: "i1", method: "agent_cash", amount: 200000, reversal_of: null, reversed_by: null },
    { invoice_id: "i2", method: "shamcash", amount: 50000, reversal_of: null, reversed_by: "x" },
  ]),
}));
vi.mock("./managerData", () => ({
  loadOverview: async () => [
    { area_id: "A", area_name: "الهنادي", agent_id: "g", agent_name: "علي قدار", subscribers: 2, expected: 300000, paid: 200000, exempt: 0, remaining: 100000, paid_count: 1, unpaid_count: 1, exempt_count: 0 },
    { area_id: "B", area_name: "الخرنوبة", agent_id: null, agent_name: null, subscribers: 1, expected: 0, paid: 0, exempt: 0, remaining: 0, paid_count: 0, unpaid_count: 0, exempt_count: 0 },
  ],
  loadAreaRows: async () => [],
  loadAgents: async () => [{ profile: { id: "g", full_name: "علي قدار", comp_type: "monthly_salary" }, areas: [{ id: "A", name: "الهنادي" }], cash: [], totals: { collected: 200000, delivered: 150000, deductions: 0, holding: 50000, count: 1 } }],
  loadCompensation: async () => ({ type: "monthly_salary", rate: 500000, invoices: 0, due: 500000, deducted: 0, paid_separately: 0, remaining: 500000 }),
}));

import { buildMonthReport } from "./report";
import { readXlsx, writeXlsx } from "./xlsx";

describe("monthly report", () => {
  it("has summary, agents, unpaid and one sheet per area, full SYP amounts", async () => {
    const r = await buildMonthReport("2026-11");
    expect(r.fileName).toBe("تحصيل-2026-11.xlsx");
    expect(r.sheets.map((s) => s.name)).toEqual(["الملخص", "المعتمدون", "غير المدفوعين", "الهنادي", "الخرنوبة"]);
    const summary = r.sheets[0].rows;
    expect(summary[1]).toEqual(["الهنادي", "علي قدار", 2, 1, 1, 0, 300000, 200000, 0, 100000, "لا"]);
    expect(summary[2][1]).toBe("المدير");
    expect(summary[3]).toEqual(["المجموع", null, 3, 1, 1, 0, 300000, 200000, 0, 100000, null]);
    expect(r.sheets[1].rows[1]).toEqual(["علي قدار", "الهنادي", 1, 200000, 150000, 0, 50000, "راتب شهري", 500000, 0, 500000]);
    expect(r.sheets[2].rows.slice(1).map((x) => x[1])).toEqual(["سامر"]);
    const hnadi = r.sheets[3].rows;
    expect(hnadi[1].slice(5)).toEqual([200000, 200000, 0, 0, "مدفوع", "عند المعتمد"]);
    expect(hnadi[1][1]).toBe("علي أحمد"); // three-part display name
    expect(r.sheets[3].rows[0][1]).toBe("الاسم الثلاثي");
    expect(hnadi[2].slice(9)).toEqual(["غير مدفوع", ""]); // reversed Sham Cash is not listed
    expect(r.sheets[4].rows[1].slice(5, 10)).toEqual([null, null, null, null, "بدون سعر"]);
    // writes and reads back
    expect(readXlsx(writeXlsx(r.sheets)).map((s) => s.name)).toEqual(r.sheets.map((s) => s.name));
  });
});
