import { describe, expect, it } from "vitest";
import { planLateAlerts } from "./lateAlertPlan";

const r = (id: number) => ({ id, title: "دفعة متأخرة", body: `#${id}` });

describe("late-payment alerts", () => {
  it("first run starts from the newest row and replays nothing", () => {
    expect(planLateAlerts(null, 42, [r(40), r(41), r(42)])).toEqual({ show: [], nextLastId: 42 });
    expect(planLateAlerts(null, null, [])).toEqual({ show: [], nextLastId: 0 });
  });
  it("shows each newer row once, oldest first", () => {
    expect(planLateAlerts(41, null, [r(43), r(42), r(41)])).toEqual({ show: [r(42), r(43)], nextLastId: 43 });
    expect(planLateAlerts(43, null, [r(42), r(43)])).toEqual({ show: [], nextLastId: 43 });
  });
});
