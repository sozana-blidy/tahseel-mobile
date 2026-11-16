import { Tajawal_400Regular, Tajawal_500Medium, Tajawal_700Bold, useFonts } from "@expo-google-fonts/tajawal";
import { router, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { I18nManager, Platform, View } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth";
import { isConfigured } from "../lib/env";
import { refreshEveWarning } from "../lib/eveWarning";
import { routeOf, setupReminders, useLastReminderTap } from "../lib/reminders";
import { Card, T } from "../ui/kit";
import { colors, space } from "../ui/theme";

// Release builds are forced RTL by the expo-localization plugin (app.json).
// This covers Expo Go during development: takes effect after one app restart.
if (Platform.OS !== "web" && !I18nManager.isRTL) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ Tajawal_400Regular, Tajawal_500Medium, Tajawal_700Bold });
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <Gate fontsReady={fontsLoaded || !!fontError} />
    </AuthProvider>
  );
}

function Gate({ fontsReady }: { fontsReady: boolean }) {
  const { loading, session, profile, isGuest } = useAuth();
  const ready = fontsReady && !loading;
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Daily (manager) / monthly (agent) reminders follow whoever is signed in on this phone.
  const role = session && profile?.active ? profile.role : null;
  useEffect(() => {
    // setupReminders clears every scheduled notification first, so the eve warning comes after it
    if (ready) void setupReminders(role).then(() => (role === "manager" ? refreshEveWarning() : undefined));
  }, [ready, role]);

  // Tapping a reminder opens its screen (once per notification).
  const lastResponse = useLastReminderTap();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const route = routeOf(lastResponse);
    const id = lastResponse?.notification.request.identifier + ":" + lastResponse?.notification.date;
    if (!route || !role || handled.current === id) return;
    if ((role === "manager") !== route.startsWith("/manager")) return;
    handled.current = id;
    setTimeout(() => router.push(route as never), 300);
  }, [lastResponse, role]);
  if (!ready) return null;
  if (!isConfigured) return <ConfigMissing />;

  const signedIn = !!session;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "fade" }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      {/* join stays reachable after sign-up until the invite is claimed */}
      <Stack.Protected guard={!isGuest && (!signedIn || !profile)}>
        <Stack.Screen name="join" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !isGuest && !profile}>
        <Stack.Screen name="inactive" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && isGuest}>
        <Stack.Screen name="guest" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && profile?.role === "agent"}>
        <Stack.Screen name="agent/index" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && profile?.role === "manager"}>
        <Stack.Screen name="manager" />
      </Stack.Protected>
    </Stack>
  );
}

function ConfigMissing() {
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: space(6), backgroundColor: colors.bg }}>
      <Card style={{ gap: space(2) }}>
        <T w="bold" size={18}>إعداد ناقص</T>
        <T color={colors.muted}>
          لم يتم ضبط عنوان الخادم. أضف EXPO_PUBLIC_SUPABASE_URL و EXPO_PUBLIC_SUPABASE_ANON_KEY في ملف .env ثم أعد تشغيل التطبيق.
        </T>
      </Card>
    </View>
  );
}
