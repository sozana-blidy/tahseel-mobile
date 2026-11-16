import { describe, expect, it } from "vitest";
import { ALLOWED_EMAIL_DOMAINS, PASSWORD_ALPHABET, checkDomain, generatePassword, parseAgent, parseRequest } from "./logic";

const AREA = "0b7f1a52-6a1e-4c33-9a3c-5f3f6b2a9d10";

describe("admin-users: passwords", () => {
  it("10 chars, no look-alikes, letter + digit, varied", () => {
    for (const ch of "0O1lI") expect(PASSWORD_ALPHABET).not.toContain(ch);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(10);
      expect(p).toMatch(/^[a-km-zA-HJ-NP-Z2-9]+$/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[a-zA-Z]/);
      seen.add(p);
    }
    expect(seen.size).toBe(300);
  });
  it("skips bytes that would bias the result (rejection sampling)", () => {
    expect(PASSWORD_ALPHABET).toHaveLength(57); // limit = 256 - 256 % 57 = 228
    let calls = 0;
    const p = generatePassword(10, (n) => {
      calls++;
      return calls === 1 ? new Uint8Array(n).fill(255) : Uint8Array.from({ length: n }, (_, i) => (i * 7) % 57);
    });
    expect(calls).toBe(2);
    expect(p).toBe("ahpwDLT29g");
  });
});

describe("admin-users: input", () => {
  it("only the allow-listed domain", () => {
    expect(checkDomain("Agents.Tahseel.App")).toEqual({ ok: true, value: ALLOWED_EMAIL_DOMAINS[0] });
    expect(checkDomain("evil.example").ok).toBe(false);
    expect(parseRequest({ action: "create", email_domain: "evil.example", agents: [{}] }).ok).toBe(false);
  });
  it("validates an agent like create_agent_invite", () => {
    const ok = parseAgent({ full_name: " علي قدار ", username: "Ali.Kadar", area_ids: [AREA, AREA], comp_type: "monthly_salary", comp_amount: 500000 });
    expect(ok).toEqual({ ok: true, value: { full_name: "علي قدار", username: "ali.kadar", area_ids: [AREA], comp_type: "monthly_salary", comp_amount: 500000, phone: null } });
    expect(parseAgent({ full_name: "x", username: "a b", area_ids: [AREA] }).ok).toBe(false);
    expect(parseAgent({ full_name: "x", username: "abc", area_ids: [] }).ok).toBe(false);
    expect(parseAgent({ full_name: "x", username: "abc", area_ids: ["nope"] }).ok).toBe(false);
    expect(parseAgent({ full_name: "x", username: "abc", area_ids: [AREA], comp_amount: -1 }).ok).toBe(false);
    expect(parseAgent({ full_name: "", username: "abc", area_ids: [AREA] }).ok).toBe(false);
  });
  it("requests: duplicates, size limit, reset id", () => {
    const a = { full_name: "x", username: "abc", area_ids: [AREA] };
    expect(parseRequest({ action: "create", email_domain: "agents.tahseel.app", agents: [a, { ...a, username: "ABC" }] }).ok).toBe(false);
    expect(parseRequest({ action: "create", email_domain: "agents.tahseel.app", agents: Array(21).fill(a) }).ok).toBe(false);
    expect(parseRequest({ action: "reset", agent_id: AREA })).toEqual({ ok: true, value: { action: "reset", agent_id: AREA } });
    expect(parseRequest({ action: "reset", agent_id: "1" }).ok).toBe(false);
    expect(parseRequest({ action: "drop" }).ok).toBe(false);
  });
});
