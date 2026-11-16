/**
 * Manager alerts: each 'late_payment' row (database trigger) and each 'automation_hold' row
 * (automatic disconnect held: abnormal count / daily limit) becomes ONE phone notification with sound. Checked live (Realtime while the
 * app is open), at start / foreground, and from the background task. The last handled id is kept
 * on the phone, so a row is never shown twice — and the first run does not replay old rows.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { CUTOFF_ROUTE, URGENT_COLOR } from "./automation";
import { planLateAlerts, type LateRow } from "./lateAlertPlan";
import { ALERT_CHANNEL, ensureAlertChannel, storedReminderRole } from "./reminders";
import { supabase } from "./supabase";

const LAST_KEY = "tahseel.lateAlerts.lastId:"; // + user id: another manager on this phone starts fresh
const ROUTE = "/manager/notifications";
const KINDS = ["late_payment", "automation_hold"];

let chain: Promise<unknown> = Promise.resolve();

async function fetchNewest(): Promise<number | null> {
  const { data, error } = await supabase.from("notifications").select("id").in("kind", KINDS).order("id", { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0]?.id ?? null;
}

async function fetchAfter(lastId: number): Promise<LateRow[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, kind, title, body")
    .in("kind", KINDS)
    .gt("id", lastId)
    .order("id", { ascending: true })
    .limit(30);
  if (error) throw error;
  return (data ?? []) as LateRow[];
}

/** Manager phones only. Never throws. */
export function checkLateAlerts(): Promise<void> {
  if (Platform.OS === "web") return Promise.resolve();
  const run = async () => {
    try {
      if ((await storedReminderRole()) !== "manager") return;
      const uid = (await supabase.auth.getSession()).data.session?.user.id;
      if (!uid) return;
      const key = LAST_KEY + uid;
      const raw = await AsyncStorage.getItem(key);
      const lastId = raw === null ? null : Number(raw);
      const plan = planLateAlerts(lastId, lastId === null ? await fetchNewest() : null, lastId === null ? [] : await fetchAfter(lastId));
      if (plan.show.length) await ensureAlertChannel();
      for (const r of plan.show) {
        const hold = r.kind === "automation_hold";
        await Notifications.scheduleNotificationAsync({
          identifier: `${hold ? "hold" : "late"}-${r.id}`,
          content: hold
            ? { title: r.title, body: r.body, sound: "default", color: URGENT_COLOR, priority: Notifications.AndroidNotificationPriority.MAX, data: { route: CUTOFF_ROUTE } }
            : { title: r.title, body: r.body, sound: "default", data: { route: ROUTE } },
          trigger: { channelId: ALERT_CHANNEL }, // now
        });
        await AsyncStorage.setItem(key, String(r.id)); // after each one: a crash never repeats a shown alert
      }
      if (plan.nextLastId !== null && plan.nextLastId !== lastId) await AsyncStorage.setItem(key, String(plan.nextLastId));
    } catch {
      /* offline / signed out — the next check catches up */
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}
