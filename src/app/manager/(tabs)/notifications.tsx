import { router } from "expo-router";
import { useMemo } from "react";
import { Pressable, RefreshControl, SectionList, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { dailyLine, dayTitle } from "../../../lib/dailyText";
import { loadDailyCollections, type DailyLine } from "../../../lib/managerData";
import { formatFull } from "../../../lib/money";
import { useLoad } from "../../../lib/useLoad";
import { Banner, Card, Num, T } from "../../../ui/kit";
import { Empty } from "../../../ui/parts";
import { colors, space } from "../../../ui/theme";

/** Daily summary: one line per area per day — what reached each agent. Tap → that day's payments. */
export default function DailySummary() {
  const { data, error, loading, refresh } = useLoad(() => loadDailyCollections(14), []);
  const sections = useMemo(() => {
    const byDay = new Map<string, DailyLine[]>();
    for (const l of data ?? []) byDay.set(l.day, [...(byDay.get(l.day) ?? []), l]);
    return [...byDay.entries()].map(([day, lines]) => ({ day, total: lines.reduce((a, l) => a + l.amount, 0), data: lines }));
  }, [data]);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <SectionList
        sections={sections}
        keyExtractor={(l) => `${l.day}:${l.area_id}`}
        contentContainerStyle={{ padding: space(4), paddingBottom: space(10), gap: space(2) }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.primary]} />}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={{ gap: space(2), marginBottom: space(2) }}>
            <T w="bold" size={22}>الملخص اليومي</T>
            <T color={colors.muted}>ما وصل لكل معتمد في كل يوم. يصلك تذكير كل يوم الساعة 10 مساءً.</T>
            {error && <Banner tone="error" text={error} />}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: space(3), marginBottom: space(1) }}>
            <T w="bold" size={17}>{dayTitle(section.day)}</T>
            <T size={13} color={colors.muted}>المجموع <Num w="bold" color={colors.text}>{formatFull(section.total)}</Num></T>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/manager/day", params: { area: item.area_id, day: item.day, name: item.area_name } })}
          >
            <Card style={{ padding: space(3.5), gap: 2 }}>
              <T w="medium" size={16}>{dailyLine(item)}</T>
              <T size={13} color={colors.muted}>{item.invoices} فاتورة · اضغط لعرض من دفع</T>
            </Card>
          </Pressable>
        )}
        ListEmptyComponent={data ? <Empty text="لا دفعات عبر المعتمدين في آخر 14 يوماً" /> : undefined}
      />
    </SafeAreaView>
  );
}
