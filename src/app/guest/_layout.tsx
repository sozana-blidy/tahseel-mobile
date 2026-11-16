import { Stack } from "expo-router";
import { colors } from "../../ui/theme";

/** Guest (read-only) screens. Reached only by an anonymous session (see app/_layout.tsx). */
export default function GuestLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
