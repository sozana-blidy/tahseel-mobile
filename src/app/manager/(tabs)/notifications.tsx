import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { damascusNow } from "../../../lib/damascus";
import { dailyLine, dayTitle, SUMMARY_PENDING_TEXT, visibleSummary } from "../../../lib/dailyText";
import { loadDailyCollections, type DailyLine } from "../../../lib/managerData";
import { formatFull } from "../../../lib/money";
import { refreshTonight } from "../../../lib/reminders";
import { useLoad } from "../../../lib/useLoad";
import { Banner, Card, Num, T } from "../../../ui/kit";
import { Empty } from "../../../ui/parts";
import { colors, space } from "../../../ui/theme";

/**
 * Daily summary: one line per area per day — what reached each agent. Tap → that day's payments.
 * An evening thing: today's section appears only from 22:00 Damascus time; earlier days always show.
 */
export default function DailySummary() {
  const { data, error, loading, refresh } = useLoad(() => loadDailyCollections(14), []);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000); // flips to the evening view at 22:00 while open
    return () => clearInterval(t);
  }, []);
  const { sections, todayHidden } = useMemo(() => {
    const v = visibleSummary(data ?? [], damascusNow(now));
    const byDay = new Map<string, DailyLine[]>();
    for (const l of v.lines) byDay.set(l.day, [...(byDay.get(l.day) ?? []), l]);
    const list = [...byDay.entries()].map(([day, ls]) => ({ day, total: ls.reduce((a, l) => a + l.amount, 0), data: ls }));
    return { sections: list, todayHidden: v.todayHidden };
  }, [data, now]);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <SectionList
        sections={sections}
        keyExtractor={(l) => `${l.day}:${l.area_id}`}
        contentContainerStyle={{ padding: space(4), paddingBottom: space(10), gap: space(2) }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { setNow(new Date()); refresh(); void refreshTonight(); }} colors={[colors.primary]} />}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={{ gap: space(2), marginBottom: space(2) }}>
            <T w="bold" size={22}>الملخص اليومي</T>
            <T color={colors.muted}>ما وصل لكل معتمد في كل يوم. يصلك تذكير كل يوم الساعة 10 مساءً.</T>
            {error && <Banner tone="error" text={error} />}
            {todayHidden && (
              <Card style={{ padding: space(3.5), backgroundColor: colors.primarySoft }}>
                <T w="medium" color={colors.primary}>{SUMMARY_PENDING_TEXT}</T>
              </Card>
            )}
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
