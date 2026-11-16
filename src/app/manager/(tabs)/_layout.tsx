import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router/js-tabs";
import { colors, font } from "../../../ui/theme";

export default function ManagerTabs() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontFamily: font.medium, fontSize: 12 },
        tabBarStyle: { minHeight: 60 },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "المناطق", tabBarIcon: ({ color, size }) => <Ionicons name="map-outline" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="agents" options={{ title: "المعتمدون", tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="notifications" options={{ title: "الملخص اليومي", tabBarIcon: ({ color, size }) => <Ionicons name="today-outline" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="more" options={{ title: "المزيد", tabBarIcon: ({ color, size }) => <Ionicons name="ellipsis-horizontal-circle-outline" color={String(color)} size={size} /> }} />
    </Tabs>
  );
}
