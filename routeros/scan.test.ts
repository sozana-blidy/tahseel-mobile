import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasOnlyPlaceholders, scanReadOnlyRsc } from "./scan";

const script = readFileSync(path.join(__dirname, "tahseel-sync-dryrun.rsc"), "utf8");

describe("RouterOS dry-run script is read-only", () => {
  it("has no forbidden or unlisted menu command", () => {
    expect(scanReadOnlyRsc(script)).toEqual([]);
  });

  it("verifies the certificate and only reads fetch output into a variable", () => {
    const fetches = script.split(/\r?\n/).filter((l) => !l.trim().startsWith("#") && l.includes("/tool fetch"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain("check-certificate=yes");
    expect(fetches[0]).toContain("output=user");
  });

  it("always tells the server it is a dry script", () => {
    expect(script.match(/"dry"=true/g)).toHaveLength(2);
    expect(script).not.toMatch(/"dry"=false/);
  });

  it("contains placeholders only — no key, token or project ref", () => {
    for (const p of ["PASTE_PROJECT_REF", "PASTE_ANON_KEY", "PASTE_ROUTER_ID", "PASTE_ROUTER_TOKEN"]) expect(script).toContain(p);
    expect(hasOnlyPlaceholders(script)).toBe(true);
  });
});

describe("the scanner itself catches violations", () => {
  const bad: [string, string][] = [
    ["/ppp secret set [find name=x] disabled=yes", "forbidden: secret set"],
    ["/ppp/secret/set numbers=0 comment=x", "forbidden: secret set"],
    ["/ppp secret add name=x", "forbidden: secret add"],
    ["/ppp secret remove 0", "forbidden: secret remove"],
    ["/ppp active remove [find name=x]", "forbidden: active remove"],
    [":local a {disabled=yes}", "forbidden: disabled="],
    ["/file print", "forbidden: /file"],
    ["set 0 disabled=no", "line starts with a menu set/add/remove"],
    ["add name=x", "line starts with a menu set/add/remove"],
    ["remove 0", "line starts with a menu set/add/remove"],
    ["# comment mentioning secret remove", "forbidden: secret remove"],
    [":local c [:parse \"/ppp secret print\"]", "forbidden: :parse"],
    [":execute \"x\"", "forbidden: :execute"],
    ["/tool fetch url=$u check-certificate=no output=user", "forbidden: check-certificate=no"],
    ["/tool fetch url=$u output=file", "forbidden: output=file"],
    ["/system reboot", "menu command not allowed: /system reboot"],
    ["/ppp profile print", "menu command not allowed: /ppp profile print"],
    ["/interface disable 0", "menu command not allowed: /interface disable 0"],
  ];
  it.each(bad)("%s", (line, rule) => {
    expect(scanReadOnlyRsc(line).map((v) => v.rule)).toContain(rule);
  });

  it("allows script-local commands and the read-only menu commands", () => {
    const ok = [
      ":local x 1",
      ":set x 2",
      ":set ($a->0) {\"u\"=$u}",
      ":global g",
      ":put $x",
      ":log info \"x\"",
      ":local ids [/ppp secret find where name=$u]",
      ":local off [/ppp secret get ($ids->0) disabled]",
      "/ppp secret print count-only",
      ":local id [/system identity get name]",
      ":local r [/tool fetch url=\"https://example.supabase.co/rest/v1/rpc/x\" check-certificate=yes output=user as-value]",
    ].join("\n");
    expect(scanReadOnlyRsc(ok)).toEqual([]);
  });

  it("detects committed secrets", () => {
    expect(hasOnlyPlaceholders(":local k \"eyJhbGciOiJIUzI1NiIsInR5cCI6\"")).toBe(false);
    expect(hasOnlyPlaceholders(":local t \"tsk_0123456789abcdef0123\"")).toBe(false);
    expect(hasOnlyPlaceholders(":local u \"https://abcdefghijklmnopqrst.supabase.co\"")).toBe(false);
  });
});
