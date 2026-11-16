/**
 * Local scheduled reminders (on the phone itself — free, no push server, works on
 * Syrian networks). Rescheduled at every sign-in, cancelled at sign-out.
 *   manager: every day 22:00 → daily summary
 *   agent:   every month on the 4th, 10:00 → export the unpaid list for the manager
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Role } from "./types";

const CHANNEL = "reminders";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export const REMINDERS = {
  manager: {
    title: "ملخص تحصيل اليوم",
    body: "اضغط لعرض المبالغ التي وصلت لكل معتمد اليوم",
    route: "/manager/notifications",
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: 22, minute: 0 } as const,
  },
  agent: {
    title: "اليوم 4 من الشهر",
    body: "صدّر قائمة من لم يدفع وأرسلها للمدير عبر واتساب",
    route: "/agent?export=1",
    trigger: { type: Notifications.SchedulableTriggerInputTypes.MONTHLY, day: 4, hour: 10, minute: 0 } as const,
  },
};

/** Returns false when the user refused notifications (the app keeps working without them). */
export async function setupReminders(role: Role | null): Promise<boolean> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    if (!role) return true;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: "تذكيرات تحصيل",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return false;
    const r = REMINDERS[role];
    await Notifications.scheduleNotificationAsync({
      content: { title: r.title, body: r.body, data: { route: r.route } },
      trigger: { ...r.trigger, channelId: CHANNEL },
    });
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
