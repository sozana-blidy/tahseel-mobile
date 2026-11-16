import type { Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { readCache, writeCache } from "./cache";
import { classifyError } from "./errors";
import { loginEmail } from "./env";
import { supabase } from "./supabase";
import type { Profile } from "./types";

interface AuthState {
  /** true until the stored session (and its profile) has been read. */
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  /** Profile could not be loaded because of the network (vs. "no profile"). */
  profileError: string | null;
  /** Anonymous read-only guest (no profile; data only through the guest_* functions). */
  isGuest: boolean;
  signIn(username: string, password: string): Promise<void>;
  signInAsGuest(): Promise<void>;
  signOut(): Promise<void>;
  reloadProfile(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  const seq = useRef(0);
  const loadProfile = useCallback(async (s: Session | null) => {
    // Only the latest call may set state: a slow load that started before an invite
    // was claimed must not overwrite the fresh profile.
    const my = ++seq.current;
    if (!s || s.user.is_anonymous) {
      setProfile(null);
      setProfileError(null);
      return;
    }
    const cacheKey = `profile:${s.user.id}`;
    const { data, error } = await supabase.from("profiles").select("*").eq("id", s.user.id).maybeSingle();
    if (my !== seq.current) return;
    if (error) {
      setProfileError(classifyError(error).message);
      // Offline at app start: use the last known profile so the agent can keep working.
      const cached = await readCache<Profile>(cacheKey);
      setProfile((prev) => prev ?? cached?.data ?? null);
      return;
    }
    setProfileError(null);
    setProfile((data as Profile | null) ?? null);
    if (data) await writeCache(cacheKey, data);
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      await loadProfile(data.session);
      if (alive) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Defer: supabase-js warns against awaiting other calls inside this callback.
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") setTimeout(() => loadProfile(s), 0);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      profile,
      profileError,
      async signIn(username, password) {
        const { data, error } = await supabase.auth.signInWithPassword({ email: loginEmail(username), password });
        if (error) throw classifyError(error);
        await loadProfile(data.session);
      },
      isGuest: !!session?.user.is_anonymous,
      async signInAsGuest() {
        const { error } = await supabase.auth.signInAnonymously();
        if (error) {
          if (/anonymous.*disabled|not enabled/i.test(error.message)) throw new Error("دخول الضيوف غير مفعّل");
          throw classifyError(error);
        }
      },
      async signOut() {
        await supabase.auth.signOut({ scope: "local" });
        setProfile(null);
      },
      // Read the session fresh: right after sign-up the rendered `session` is still stale.
      reloadProfile: async () => loadProfile((await supabase.auth.getSession()).data.session),
    }),
    [loading, session, profile, profileError, loadProfile],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
