/**
 * Local scheduled notifications (on the phone itself — free, no push server, works on
 * Syrian networks). Rescheduled at every sign-in, cancelled at sign-out.
 *   manager: every night 22:00 Damascus → today's real per-area counts (agent cash), see nightly.ts.
 *            One one-off notification per night (id manager-summary-YYYY-MM-DD). The next 7 nights
 *            are pre-scheduled with a generic text so a night is never missed; tonight's is replaced
 *            with the latest counts whenever manager data refreshes and from a background task.
 *   agent:   every month on the 4th, 10:00 → export the unpaid list for the manager.
 * Android channel settings are immutable once created, hence a new channel id (v2) with sound.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { damascusInstant, damascusNow, SUMMARY_HOUR } from "./damascus";
import { loadDailyCollections } from "./managerData";
import { NIGHT_GENERIC_BODY, NIGHT_PREFIX, NIGHT_TITLE, nightId, nightlyBody, upcomingNights } from "./nightly";
import type { Role } from "./types";

const CHANNEL = "tahseel-alerts-v2";
const OLD_CHANNELS = ["reminders"];
const ROLE_KEY = "tahseel.reminders.role";
const MANAGER_ROUTE = "/manager/notifications";
export const NIGHTLY_TASK = "tahseel-nightly-summary";
const supported = Platform.OS !== "web";

if (supported) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

const AGENT = {
  title: "اليوم 4 من الشهر",
  body: "صدّر قائمة من لم يدفع وأرسلها للمدير عبر واتساب",
  route: "/agent?export=1",
};

async function ensureChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: "تنبيهات تحصيل",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
    enableVibrate: true,
    vibrationPattern: [0, 300, 200, 300],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  for (const id of OLD_CHANNELS) await Notifications.deleteNotificationChannelAsync(id).catch(() => {});
}

async function scheduleNight(day: string, body: string) {
  const at = damascusInstant(day, SUMMARY_HOUR);
  if (at.getTime() <= Date.now()) return;
  const identifier = nightId(day);
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: { title: NIGHT_TITLE, body, sound: "default", data: { route: MANAGER_ROUTE } },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL },
  });
}

/** Generic text for every upcoming night that has nothing scheduled yet (rolling 7-night window). */
async function fillGenericNights() {
  const scheduled = new Set((await Notifications.getAllScheduledNotificationsAsync()).map((n) => n.identifier));
  for (const day of upcomingNights(damascusNow())) {
    if (!scheduled.has(nightId(day))) await scheduleNight(day, NIGHT_GENERIC_BODY);
  }
  // drop leftovers outside the window (e.g. after the phone's clock was changed)
  const keep = new Set(upcomingNights(damascusNow()).map(nightId));
  for (const id of scheduled) if (id.startsWith(NIGHT_PREFIX) && !keep.has(id)) await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
}

let chain: Promise<unknown> = Promise.resolve();
/** Runs one refresh at a time (data refreshes and the background task can overlap). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/**
 * Manager only: re-schedule tonight's 22:00 notification with the latest per-area counts.
 * Falls back to the generic text when the data can't be fetched. Never throws.
 */
export function refreshTonight(): Promise<void> {
  if (!supported) return Promise.resolve();
  return serial(async () => {
    try {
      if ((await AsyncStorage.getItem(ROLE_KEY)) !== "manager") return;
      await fillGenericNights();
      const clock = damascusNow();
      if (clock.hour >= SUMMARY_HOUR) return; // tonight's has already been shown
      let body = NIGHT_GENERIC_BODY;
      try {
        body = nightlyBody(await loadDailyCollections(1), clock);
      } catch {
        /* offline / session expired → keep the generic text */
      }
      await scheduleNight(clock.day, body);
    } catch {
      /* notifications are a convenience — never break the app */
    }
  });
}

async function registerNightlyTask(on: boolean) {
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(NIGHTLY_TASK);
    if (on && !registered) await BackgroundTask.registerTaskAsync(NIGHTLY_TASK, { minimumInterval: 15 }); // Android minimum
    if (!on && registered) await BackgroundTask.unregisterTaskAsync(NIGHTLY_TASK);
  } catch {
    /* background tasks unavailable (e.g. Expo Go) — the in-app refreshes still work */
  }
}

/** Returns false when the user refused notifications (the app keeps working without them). */
export async function setupReminders(role: Role | null): Promise<boolean> {
  if (!supported) return true;
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    if (role) await AsyncStorage.setItem(ROLE_KEY, role);
    else await AsyncStorage.removeItem(ROLE_KEY);
    await registerNightlyTask(role === "manager");
    if (!role) return true;
    await ensureChannel();
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return false;
    if (role === "manager") {
      await refreshTonight();
    } else {
      await Notifications.scheduleNotificationAsync({
        content: { title: AGENT.title, body: AGENT.body, sound: "default", data: { route: AGENT.route } },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.MONTHLY, day: 4, hour: 10, minute: 0, channelId: CHANNEL },
      });
    }
    return true;
  } catch {
    return false; // e.g. unsupported environment — reminders are a convenience, never block the app
  }
}

export function routeOf(response: Notifications.NotificationResponse | null | undefined): string | null {
  const route = response?.notification.request.content.data?.route;
  return typeof route === "string" ? route : null;
}

/** Last tapped reminder (null where the native module is missing, e.g. web previews). */
export const useLastReminderTap: () => Notifications.NotificationResponse | null | undefined =
  Platform.OS === "web" ? () => null : Notifications.useLastNotificationResponse;
