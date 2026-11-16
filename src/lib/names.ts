/**
 * Display a subscriber as a three-part Arabic name: first + father + family.
 * The workbook stores "first family" and the father separately:
 *   ("علي عروس", "أحمد") → "علي أحمد عروس"
 *   ("عبد الله غضبان", "سمير") → "عبد الله سمير غضبان"   (compound first name kept together)
 *   ("زياد سامي عروس", "سامي") → unchanged (father already inside)
 */
const COMPOUND_FIRST = new Set(["عبد", "أبو", "ابو", "أم", "ام"]);

const norm = (s: string) => s.replace(/[إأآا]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").trim();

export function displayName(fullName: string, fatherName?: string | null): string {
  const full = fullName.trim().replace(/\s+/g, " ");
  const father = (fatherName ?? "").trim().replace(/\s+/g, " ");
  if (!father) return full;
  const tokens = full.split(" ");
  if (tokens.length < 2) return `${full} ${father}`;
  // father already part of the name (as a whole word sequence) → keep as written
  if (` ${norm(full)} `.includes(` ${norm(father)} `)) return full;
  // a two-word compound alone ("أبو عبدو", "عبد مسعود"): never split it — add the father after
  if (tokens.length === 2 && COMPOUND_FIRST.has(tokens[0])) return `${full} ${father}`;
  // compound first names: عبد الله، أبو أسد، نور الدين، ذو الفقار، زين العابدين
  const firstLen = tokens.length >= 3 && (COMPOUND_FIRST.has(tokens[0]) || /^ال/.test(tokens[1])) ? 2 : 1;
  return [...tokens.slice(0, firstLen), father, ...tokens.slice(firstLen)].join(" ");
}
