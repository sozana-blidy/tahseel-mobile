/**
 * Eve-of-cutoff warning (manager phone): 20:00 Damascus on the day before the cutoff day,
 * «سيتم فصل N حساب الساعة 12 ليلاً …». Scheduled locally so it fires on time even offline;
 * N is refreshed whenever this runs (app start / foreground / data changes / background task).
 * If N can't be fetched, the text goes without it. Tap → «قائمة الفصل».
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { CUTOFF_ROUTE, EVE_PREFIX, EVE_TITLE, eveBody, eveWanted, nextEves, URGENT_COLOR, type AutomationMode } from "./automation";
import { loadAutomationStatus, loadCycleInfo, type CycleInfo } from "./automationData";
import { ALERT_CHANNEL, storedReminderRole } from "./reminders";

const CACHE_KEY = "tahseel.automation.settings"; // { mode, cutoff_day } — the last values seen online

let chain: Promise<unknown> = Promise.resolve();

/** Manager phones only. Never throws. */
export function refreshEveWarning(): Promise<void> {
  if (Platform.OS === "web") return Promise.resolve();
  const run = async () => {
    try {
      if ((await storedReminderRole()) !== "manager") return;

      let mode: AutomationMode;
      let cutoffDay: number;
      let current: CycleInfo | null = null;
      try {
        const st = await loadAutomationStatus();
        mode = st.mode;
        cutoffDay = st.cutoff_day;
        current = st.cycle;
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ mode, cutoff_day: cutoffDay }));
      } catch {
        const raw = await AsyncStorage.getItem(CACHE_KEY);
        if (!raw) return; // never seen the settings online — nothing safe to schedule
        ({ mode, cutoff_day: cutoffDay } = JSON.parse(raw) as { mode: AutomationMode; cutoff_day: number });
      }

      const eves = nextEves(cutoffDay);
      const keep = new Set<string>();
      for (const eve of eves) {
        let info: CycleInfo | null = current?.month === eve.month ? current : null;
        if (!info) {
          try {
            info = await loadCycleInfo(eve.month);
          } catch {
            info = null; // offline → text without N
          }
        }
        const n = info ? info.count_now : null;
        await Notifications.cancelScheduledNotificationAsync(eve.id).catch(() => {});
        if (!eveWanted(mode, info?.paused ?? false, n)) continue;
        keep.add(eve.id);
        await Notifications.scheduleNotificationAsync({
          identifier: eve.id,
          content: {
            title: EVE_TITLE,
            body: eveBody(n, mode),
            sound: "default",
            color: URGENT_COLOR,
            priority: Notifications.AndroidNotificationPriority.MAX,
            data: { route: CUTOFF_ROUTE },
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: eve.at, channelId: ALERT_CHANNEL },
        });
      }
      // drop eves for months no longer in the window (e.g. the cutoff day was changed)
      for (const s of await Notifications.getAllScheduledNotificationsAsync()) {
        if (s.identifier.startsWith(EVE_PREFIX) && !keep.has(s.identifier)) {
          await Notifications.cancelScheduledNotificationAsync(s.identifier).catch(() => {});
        }
      }
    } catch {
      /* notifications are a convenience — never break the app */
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}
