import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} }));

import { credentialsFileName, credentialsSheet } from "./accounts";

describe("agent credentials file", () => {
  it("lists only created accounts with the four columns", () => {
    const s = credentialsSheet([
      { ok: true, full_name: "علي قدار", username: "ali.kadar", areas: "الهنادي، فديو", password: "ahpwDLT29g" },
      { ok: false, full_name: "سامر", username: "samer", error: "اسم الدخول samer مستخدم مسبقاً" },
    ]);
    expect(s.rows).toEqual([["الاسم", "المناطق", "اسم الدخول", "كلمة المرور"], ["علي قدار", "الهنادي، فديو", "ali.kadar", "ahpwDLT29g"]]);
    expect(credentialsFileName(new Date(2026, 10, 16, 9, 5))).toBe("حسابات-المعتمدين-2026-11-16-0905.xlsx");
  });
});
