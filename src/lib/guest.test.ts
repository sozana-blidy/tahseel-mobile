import { describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({ rpc: vi.fn() }));

import { searchGuestRows, type GuestRow } from "./guest";

describe("guest list search", () => {
  const rows: GuestRow[] = [
    { area_name: "الهنادي", display_name: "علي أحمد عروس", status: "paid" },
    { area_name: "الهنادي", display_name: "محمود خالد", status: "unpaid" },
    { area_name: "الهنادي", display_name: "نقطة خدمة", status: "exempt" },
  ];
  it("empty query lists everyone; a name finds across hamza variants; only the three fields exist", () => {
    expect(searchGuestRows(rows, "  ")).toHaveLength(3);
    expect(searchGuestRows(rows, "احمد").map((r) => r.display_name)).toEqual(["علي أحمد عروس"]);
    expect(searchGuestRows(rows, "zzz")).toEqual([]);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["area_name", "display_name", "status"]);
  });
});
