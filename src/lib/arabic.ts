/**
 * Arabic-aware text normalization and subscriber search ranking.
 */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

export function normalizeArabic(input: string | null | undefined): string {
  if (!input) return "";
  const raw = input.toString();
  // normalize() may be missing on some Hermes builds — skip rather than crash
  return (typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw)
    .toString()
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ة/g, "ه")
    .replace(/ء/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(input: string): string[] {
  const n = normalizeArabic(input);
  return n ? n.split(" ") : [];
}

export interface Searchable {
  /** Name tokens in order (full name then father name). */
  nameTokens: string[];
  /** Exact identifiers: username, code. */
  ids: string[];
  fullNorm: string;
}

export function buildSearchable(fields: {
  fullName: string;
  fatherName?: string;
  username?: string;
  code?: string;
  phone?: string;
}): Searchable {
  const nameTokens = tokenize(fields.fullName);
  const fatherTokens = tokenize(fields.fatherName ?? "");
  const ids = [fields.username, fields.code, fields.phone]
    .filter(Boolean)
    .map((s) => normalizeArabic(s as string).replace(/\s/g, ""));
  return {
    nameTokens: [...nameTokens, ...fatherTokens],
    ids,
    fullNorm: nameTokens.join(" "),
  };
}

/**
 * Score how well a query matches. 0 = no match. Every query token must match
 * some field (AND semantics), so "علي عروس" finds "علي أحمد عروس".
 */
export function scoreMatch(query: string, s: Searchable): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const qJoined = q.join(" ");
  const qCompact = q.join("");

  // Identifier match (username / code / phone)
  for (const id of s.ids) {
    if (!id) continue;
    if (id === qCompact) return 1000;
    if (q.length === 1 && id.startsWith(qCompact)) return 700;
  }

  if (s.fullNorm === qJoined) return 900;

  let score = 0;
  let lastIdx = -1;
  let inOrder = true;
  for (const tok of q) {
    let best = 0;
    let bestIdx = -1;
    s.nameTokens.forEach((nt, i) => {
      let v = 0;
      if (nt === tok) v = 30;
      else if (nt.startsWith(tok)) v = 18;
      else if (tok.length >= 2 && nt.includes(tok)) v = 8;
      // Tolerate "ال" prefix differences: "الشيخ" vs "شيخ"
      else if (nt.startsWith("ال") && nt.slice(2) === tok) v = 24;
      else if (tok.startsWith("ال") && tok.slice(2) === nt) v = 24;
      if (v > best) {
        best = v;
        bestIdx = i;
      }
    });
    if (best === 0) {
      // Fallback: token found inside an identifier
      if (s.ids.some((id) => id.includes(tok))) {
        score += 5;
        continue;
      }
      return 0;
    }
    if (bestIdx < lastIdx) inOrder = false;
    lastIdx = bestIdx;
    // Matches in the subscriber's own name (not father) weigh more
    score += best;
  }
  if (s.fullNorm.startsWith(qJoined)) score += 40;
  else if (s.fullNorm.includes(qJoined)) score += 20;
  if (inOrder) score += 10;
  return score;
}
