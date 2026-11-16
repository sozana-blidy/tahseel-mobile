import { describe, expect, it } from "vitest";
import { damascusStamp, eveBody, eveWanted, groupTargets, nextEves, parseCutoffDay, summarize, type TargetRow } from "./automation";

const at = (iso: string) => new Date(iso);

describe("eve-of-cutoff warning", () => {
  it("is 20:00 Damascus on the day before the cutoff day", () => {
    const [e] = nextEves(25, at("2026-11-16T10:00:00+03:00"));
    expect(e).toMatchObject({ month: "2026-11", cutoffDay: "2026-11-25", eveDay: "2026-11-24", id: "automation-eve-2026-11" });
    expect(e.at.toISOString()).toBe("2026-11-24T17:00:00.000Z");
  });

  it("moves to next month once this month's eve has passed; crosses the year", () => {
    expect(nextEves(25, at("2026-11-24T20:00:00+03:00"))[0].month).toBe("2026-12");
    expect(nextEves(25, at("2026-11-24T19:59:00+03:00"))[0].month).toBe("2026-11");
    expect(nextEves(25, at("2026-12-30T12:00:00+03:00")).map((e) => e.month)).toEqual(["2027-01", "2027-02"]);
  });

  it("cutoff day 1 → the eve is the last day of the previous month", () => {
    const [e] = nextEves(1, at("2026-11-16T10:00:00+03:00"));
    expect(e).toMatchObject({ month: "2026-12", eveDay: "2026-11-30" });
  });

  it("clamps the day to 1–28 like the server", () => {
    expect(nextEves(31, at("2026-11-01T00:00:00+03:00"))[0].cutoffDay).toBe("2026-11-28");
    expect(nextEves(0, at("2026-11-01T00:00:00+03:00"))[0].cutoffDay).toBe("2026-12-01"); // Nov's eve (Oct 31) has passed
  });

  it("text with and without N; dry-run suffix", () => {
    expect(eveBody(12, "live")).toBe("سيتم فصل 12 حساب الساعة 12 ليلاً لعدم دفع الفاتورة — للإلغاء أو التعديل راجع القائمة");
    expect(eveBody(null, "live")).toBe("سيتم فصل حسابات الساعة 12 ليلاً لعدم دفع الفاتورة — للإلغاء أو التعديل راجع القائمة");
    expect(eveBody(3, "dry_run")).toMatch(/ — وضع تجريبي$/);
  });

  it("not scheduled when off, paused or nobody to disconnect; unknown N still warns", () => {
    expect(eveWanted("off", false, 5)).toBe(false);
    expect(eveWanted("dry_run", true, 5)).toBe(false);
    expect(eveWanted("dry_run", false, 0)).toBe(false);
    expect(eveWanted("dry_run", false, null)).toBe(true);
    expect(eveWanted("live", false, 4)).toBe(true);
  });
});

describe("log summary", () => {
  it("counts per server, general alerts last", () => {
    const s = summarize([
      { router_id: "-", action: "alert", n: 1 },
      { router_id: "2116", action: "would_disable", n: 4 },
      { router_id: "1100", action: "would_disable", n: 5 },
      { router_id: "1100", action: "skipped", n: 2 },
    ]);
    expect(s).toEqual([
      { server: "1100", counts: { would_disable: 5, skipped: 2 }, total: 7 },
      { server: "2116", counts: { would_disable: 4 }, total: 4 },
      { server: "-", counts: { alert: 1 }, total: 1 },
    ]);
  });
});

describe("disconnect list", () => {
  const row = (o: Partial<TargetRow>): TargetRow => ({
    subscriber_id: "s", code: "C1", username: "user1", display_name: "علي أحمد عروس", area_id: "a1", area_name: "فديو",
    reason: "unpaid", reason_text: "لم يدفع", oldest_month: "2026-11", due: 100000, excluded: false, ...o,
  });
  const rows = [
    row({ subscriber_id: "1", area_id: "a1", area_name: "فديو" }),
    row({ subscriber_id: "2", area_id: "a2", area_name: "الهنادي", display_name: "محمود خالد", username: "mk", code: "C2" }),
    row({ subscriber_id: "3", area_id: "a1", area_name: "فديو", display_name: "فراس", username: "fr", code: "C3", excluded: true }),
  ];

  it("groups by area in name order and counts excluded separately", () => {
    const g = groupTargets(rows);
    expect(g.map((s) => [s.area_name, s.count, s.excluded, s.data.map((r) => r.subscriber_id)])).toEqual([
      ["الهنادي", 1, 0, ["2"]],
      ["فديو", 1, 1, ["1", "3"]],
    ]);
  });

  it("searches by name, username or code", () => {
    expect(groupTargets(rows, "محمود").flatMap((s) => s.data.map((r) => r.subscriber_id))).toEqual(["2"]);
    expect(groupTargets(rows, "fr").flatMap((s) => s.data.map((r) => r.subscriber_id))).toEqual(["3"]);
    expect(groupTargets(rows, "C2").flatMap((s) => s.data.map((r) => r.subscriber_id))).toEqual(["2"]);
    expect(groupTargets(rows, "غير موجود")).toEqual([]);
  });
});

describe("cutoff day input", () => {
  it("1–28, Arabic digits accepted", () => {
    expect(parseCutoffDay("25")).toBe(25);
    expect(parseCutoffDay("٢٥")).toBe(25);
    expect(parseCutoffDay("0")).toBeNull();
    expect(parseCutoffDay("29")).toBeNull();
    expect(parseCutoffDay("2.5")).toBeNull();
  });
});

describe("damascusStamp", () => {
  it("shows Damascus wall time", () => {
    expect(damascusStamp("2026-11-24T21:05:00.000Z")).toBe("2026-11-25 00:05");
    expect(damascusStamp(null)).toBe("—");
  });
});
