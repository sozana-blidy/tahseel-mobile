/**
 * Background task: refresh tonight's 22:00 manager notification with the latest counts, refresh N in
 * the 20:00 eve-of-cutoff warning, and show new late-payment / automatic-disconnect-hold alerts.
 * Must be defined when the JS bundle loads — a headless background run renders no screen,
 * so this file is imported from the app entry (index.js), not from a route.
 * Android runs it at most every ~15 minutes and only when the OS allows (battery optimization!).
 */
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { refreshEveWarning } from "./eveWarning";
import { checkLateAlerts } from "./lateAlerts";
import { NIGHTLY_TASK, refreshTonight } from "./reminders";

if (Platform.OS !== "web" && !TaskManager.isTaskDefined(NIGHTLY_TASK)) {
  TaskManager.defineTask(NIGHTLY_TASK, async () => {
    try {
      await refreshTonight();
      await refreshEveWarning();
      await checkLateAlerts(); // late payers + disconnect holds since the last check, each shown once
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}
