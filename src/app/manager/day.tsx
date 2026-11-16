import { router, useLocalSearchParams } from "expo-router";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { dayTitle } from "../../lib/dailyText";
import { loadDayPayments } from "../../lib/managerData";
import { formatFull } from "../../lib/money";
import { monthLabel } from "../../lib/months";
import { displayName } from "../../lib/names";
import { useLoad } from "../../lib/useLoad";
import { useManager } from "../../lib/managerContext";
import { Banner, Card, Num, T } from "../../ui/kit";
import { Empty, Header, localTime } from "../../ui/parts";
import { colors, space } from "../../ui/theme";

/** Who paid the agent of one area on one day (tap target of a daily-summary line). */
export default function DayScreen() {
  const { area, day, name } = useLocalSearchParams<{ area: string; day: string; name?: string }>();
  const m = useManager();
  const { data, error, loading, refresh } = useLoad(() => loadDayPayments(area, day), [area, day]);
  const total = (data ?? []).reduce((a, p) => a + p.amount, 0);
  const agent = data?.[0]?.agent_name;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header title={`${name ?? ""} — ${dayTitle(day)}`} subtitle={agent ? `المعتمد: ${agent}` : undefined} />
      <FlatList
        data={data ?? []}
        keyExtractor={(p) => p.payment_id}
        contentContainerStyle={{ padding: space(4), paddingTop: 0, gap: space(2) }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.primary]} />}
        ListHeaderComponent={
          <View style={{ gap: space(2), marginBottom: space(2) }}>
            {error && <Banner tone="error" text={error} />}
            <Card style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
              <T color={colors.muted}>{data?.length ?? 0} فاتورة</T>
              <T>
                <Num w="bold" size={20} color={colors.paid}>{formatFull(total)}</Num> ل.س
              </T>
            </Card>
          </View>
        }
        ListEmptyComponent={data ? <Empty text="لا دفعات" /> : undefined}
        renderItem={({ item: p }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              m.setMonth(p.month);
              router.push({ pathname: "/manager/subscriber/[id]", params: { id: p.subscriber_id } });
            }}
          >
            <Card style={{ padding: space(3.5), flexDirection: "row", alignItems: "center", gap: space(3) }}>
              <View style={{ flex: 1, gap: 2 }}>
                <T w="bold" size={16}>{displayName(p.full_name, p.father_name)}</T>
                <T size={13} color={colors.muted}>
                  {[p.package_label, `فاتورة ${monthLabel(p.month)}`, localTime(p.created_at)].filter(Boolean).join(" · ")}
                </T>
              </View>
              <Num w="bold">{formatFull(p.amount)}</Num>
            </Card>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}
