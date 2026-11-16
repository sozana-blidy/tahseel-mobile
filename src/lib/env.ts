/** Public config baked into the app at build time (EXPO_PUBLIC_* only — never secrets). */
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
/** Agents log in with a username; it becomes <username>@<this domain> for Supabase Auth. */
export const AGENT_EMAIL_DOMAIN = process.env.EXPO_PUBLIC_AGENT_EMAIL_DOMAIN || "agents.tahseel.app";
export const isConfigured = SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.length > 20;

/** "ali.kadar" → "ali.kadar@agents.tahseel.app"; a full email (manager) is used as-is. */
export function loginEmail(input: string): string {
  const v = input.trim().toLowerCase();
  return v.includes("@") ? v : `${v}@${AGENT_EMAIL_DOMAIN}`;
}
