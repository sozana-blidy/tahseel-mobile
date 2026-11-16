import { router } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../lib/auth";
import { guestUnlock, guestUnlocked, loadGuestAreas } from "../../lib/guest";
import { monthLabel } from "../../lib/months";
import { useLoad } from "../../lib/useLoad";
import { Banner, Button, Card, Field, T } from "../../ui/kit";
import { Empty } from "../../ui/parts";
import { colors, space } from "../../ui/theme";

/** Guest home: enter the guest code once, then the areas with paid / unpaid counts. Read only. */
export default function GuestHome() {
  const { signOut } = useAuth();
  const status = useLoad(guestUnlocked, []);
  const unlocked = status.data === true;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <View style={{ flexDirection: "row", alignItems: "center", padding: space(4), paddingBottom: space(2) }}>
        <View style={{ flex: 1 }}>
          <T w="bold" size={22}>عرض الضيف</T>
          <T size={13} color={colors.muted}>للاطلاع فقط</T>
        </View>
        <Button title="خروج" variant="secondary" onPress={signOut} style={{ minHeight: 40 }} />
      </View>
      {status.error && !status.data ? <View style={{ paddingHorizontal: space(4) }}><Banner tone="error" text={status.error} /></View> : null}
      {status.data === false && <CodeForm onUnlocked={status.refresh} />}
      {unlocked && <Areas />}
    </SafeAreaView>
  );
}

function CodeForm({ onUnlocked }: { onUnlocked: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!code.trim()) return setError("أدخل رمز الضيف");
    setBusy(true);
    setError(null);
    try {
      await guestUnlock(code);
      onUnlocked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ padding: space(4), gap: space(3) }}>
      <Card style={{ gap: space(3) }}>
        <T color={colors.muted}>اطلب رمز الضيف من المدير.</T>
        <Field label="رمز الضيف" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} onSubmitEditing={submit} error={error} ltr />
        <Button title="متابعة" onPress={submit} loading={busy} big />
      </Card>
    </View>
  );
}

function Areas() {
  const { data, error, loading, refresh } = useLoad(loadGuestAreas, []);
  const month = data?.[0]?.month;
  return (
    <FlatList
      data={data ?? []}
      keyExtractor={(a) => a.area_id}
      contentContainerStyle={{ padding: space(4), paddingTop: space(1), gap: space(2), paddingBottom: space(10) }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.primary]} />}
      ListHeaderComponent={
        <View style={{ gap: space(2), marginBottom: space(1) }}>
          {month ? <T w="medium" color={colors.muted}>{monthLabel(month)}</T> : null}
          {error ? <Banner tone="error" text={error} /> : null}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push({ pathname: "/guest/area", params: { id: item.area_id, name: item.area_name, month: item.month } })}
        >
          <Card style={{ padding: space(3.5), gap: 2 }}>
            <T w="bold" size={17}>{item.area_name}</T>
            <T size={14} color={colors.muted}>دفع {item.paid_count} · لم يدفع {item.unpaid_count}</T>
          </Card>
        </Pressable>
      )}
      ListEmptyComponent={data ? <Empty text="لا توجد مناطق بعد" /> : undefined}
    />
  );
}
