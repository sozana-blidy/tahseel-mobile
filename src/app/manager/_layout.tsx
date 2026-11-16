import { Stack } from "expo-router";
import { ManagerProvider } from "../../lib/managerContext";
import { colors } from "../../ui/theme";

export default function ManagerLayout() {
  return (
    <ManagerProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
    </ManagerProvider>
  );
}
