/**
 * Static guard for RouterOS scripts that must be READ-ONLY (batch 3, dry-run).
 * "set / add / remove" here means RouterOS MENU commands; script-local :set / :local / :global / :put / :log are fine.
 */

/** Substrings that must never appear anywhere in the file (comments included). Checked case-insensitively,
 *  also after turning "/" into " " so the v7 path form (/ppp/secret/set) is caught too. */
export const FORBIDDEN_SUBSTRINGS = [
  "secret set",
  "secret add",
  "secret remove",
  "active remove",
  "disabled=",
  "/file",
  // dynamic code would let a forbidden command hide inside a string
  ":parse",
  ":execute",
  "/import",
  "script run",
  // fetch must never skip the certificate check or write a file
  "check-certificate=no",
  "dst-path",
  "output=file",
];

/** The only menu commands allowed (path normalised to spaces, no leading slash). */
export const ALLOWED_MENU_PREFIXES = ["ppp secret find", "ppp secret get", "ppp secret print", "tool fetch", "system identity get", "log"];

export interface Violation {
  line: number;
  rule: string;
  text: string;
}

export function scanReadOnlyRsc(source: string): Violation[] {
  const out: Violation[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    const spaced = lower.replace(/\//g, " ").replace(/\s+/g, " ");

    for (const bad of FORBIDDEN_SUBSTRINGS) {
      const needle = bad.toLowerCase();
      const spacedNeedle = needle.replace(/\//g, " ").replace(/\s+/g, " ").trim();
      if (lower.includes(needle) || (needle.includes(" ") && spaced.includes(spacedNeedle))) {
        out.push({ line, rule: `forbidden: ${bad}`, text: trimmed });
      }
    }
    if (/^(set|add|remove)(\s|$)/.test(lower)) out.push({ line, rule: "line starts with a menu set/add/remove", text: trimmed });
    if (lower.startsWith("#") || lower === "") return;

    // Every menu command ("/x ..." at the start, or after whitespace, [ ( { ;) must be on the allow-list.
    for (const m of lower.matchAll(/(?:^|[\s[({;])\/([a-z][a-z0-9/ -]*)/g)) {
      const cmd = m[1].replace(/\//g, " ").replace(/\s+/g, " ").trim();
      if (!ALLOWED_MENU_PREFIXES.some((p) => cmd === p || cmd.startsWith(p + " "))) {
        out.push({ line, rule: `menu command not allowed: /${cmd.split(" ").slice(0, 3).join(" ")}`, text: trimmed });
      }
    }
  });
  return out;
}

/** True when only the PASTE_ placeholders are present (no real key, token or project ref committed). */
export function hasOnlyPlaceholders(source: string): boolean {
  return (
    !/eyJ[A-Za-z0-9_-]{10,}/.test(source) && // JWT (legacy anon / service keys)
    !/sb_(publishable|secret)_[A-Za-z0-9_-]{6,}/.test(source) &&
    !/tsk_[0-9a-f]{16,}/.test(source) && // router token
    !/https:\/\/[a-z0-9]{20}\.supabase\.co/.test(source) // a real project ref
  );
}
