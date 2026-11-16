import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ACTION_FILTERS, ACTION_LABEL, damascusStamp, SERVERS, serverLabel, summarize, type LogAction } from "../../../lib/automation";
import { loadLog, loadLogDays, loadLogSummary, type LogRow } from "../../../lib/automationData";
import { useLoad } from "../../../lib/useLoad";
import { IconBtn } from "../../../ui/automationParts";
import { Badge, Banner, Card, Chip, T } from "../../../ui/kit";
import { Empty, Header } from "../../../ui/parts";
import { colors, space } from "../../../ui/theme";

const TONE: Record<LogAction, [string, string]> = {
  would_disable: [colors.danger, colors.dangerSoft],
  disable: [colors.danger, colors.dangerSoft],
  would_enable: [colors.paid, colors.paidSoft],
  enable: [colors.paid, colors.paidSoft],
  skipped: [colors.muted, colors.neutralSoft],
  alert: [colors.open, colors.openSoft],
};

/** «السجل»: what the automation did (dry-run: would do) per Damascus day, filtered by server and action. */
export default function AutomationLog() {
  const days = useLoad(loadLogDays, []);
  const [day, setDay] = useState<string | null>(null);
  const [server, setServer] = useState<string | null>(null);
  const [action, setAction] = useState<LogAction | "all">("all");
  useEffect(() => {
    if (!day && days.data?.length) setDay(days.data[0].day);
  }, [day, days.data]);

  const list = useLoad(() => (day ? loadLog(day, server, action === "all" ? null : action) : Promise.resolve([] as LogRow[])), [day, server, action]);
  const summary = useLoad(() => (day ? loadLogSummary(day) : Promise.resolve([])), [day]);
  const lines = useMemo(() => summarize(summary.data ?? []), [summary.data]);
  const error = days.error ?? list.error ?? summary.error;

  const header = (
    <View style={{ gap: space(3), paddingBottom: space(2) }}>
      {error ? <Banner tone="error" text={error} /> : null}
      {days.data && days.data.length > 0 ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(2) }}>
            {days.data.map((d) => (
              <Chip key={d.day} label={`${d.day}${d.alerts ? " ⚠" : ""}`} active={d.day === day} onPress={() => setDay(d.day)} />
            ))}
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(2) }}>
            <Chip label="كل السيرفرات" active={server === null} onPress={() => setServer(null)} />
            {SERVERS.map((s) => (
              <Chip key={s} label={s} active={server === s} onPress={() => setServer(s)} />
            ))}
            <Chip label="عام" active={server === "-"} onPress={() => setServer("-")} />
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(2) }}>
            {ACTION_FILTERS.map(([v, label]) => (
              <Chip key={v} label={label} active={action === v} onPress={() => setAction(v)} />
            ))}
          </ScrollView>
          <Card style={{ gap: space(1.5) }}>
            <T w="bold">ملخص {day}</T>
            {lines.length === 0 ? <T color={colors.muted}>لا شيء في هذا اليوم.</T> : null}
            {lines.map((l) => (
              <T key={l.server} size={14}>
                <T w="bold" size={14}>{serverLabel(l.server)}: </T>
                {Object.entries(l.counts)
                  .map(([a, n]) => `${ACTION_LABEL[a as LogAction] ?? a} ${n}`)
                  .join(" · ")}
              </T>
            ))}
          </Card>
        </>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header
        title="السجل"
        subtitle="الفصل التلقائي — ما فعله (أو كان سيفعله) كل سيرفر"
        right={
          <View style={{ flexDirection: "row", gap: space(1) }}>
            <IconBtn name="list-outline" label="قائمة الفصل" onPress={() => router.push("/manager/automation/cutoff")} />
            <IconBtn name="settings-outline" label="الإعدادات" onPress={() => router.push("/manager/automation/settings")} />
          </View>
        }
      />
      <FlatList
        data={list.data ?? []}
        keyExtractor={(r) => String(r.id)}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: space(4), paddingTop: 0, gap: space(2), paddingBottom: space(10) }}
        refreshControl={
          <RefreshControl
            refreshing={list.loading}
            onRefresh={() => {
              days.refresh();
              list.refresh();
              summary.refresh();
            }}
            colors={[colors.primary]}
          />
        }
        ListEmptyComponent={
          days.data && days.data.length === 0 ? (
            <Empty text="لا يوجد سجل بعد. يظهر هنا ما يفعله السيرفران كل 5 دقائق بعد تركيب السكربت." />
          ) : list.data ? (
            <Empty text="لا سطور بهذا الفلتر" />
          ) : undefined
        }
        renderItem={({ item }) => <LogItem r={item} />}
      />
    </SafeAreaView>
  );
}

function LogItem({ r }: { r: LogRow }) {
  const [fg, bg] = TONE[r.action] ?? [colors.muted, colors.neutralSoft];
  const open = r.subscriber_id ? () => router.push({ pathname: "/manager/subscriber/[id]", params: { id: r.subscriber_id as string } }) : undefined;
  return (
    <Pressable onPress={open} disabled={!open} accessibilityRole={open ? "button" : undefined}>
      <Card style={{ padding: space(3.5), gap: space(1) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
          <Badge label={ACTION_LABEL[r.action] ?? r.action} fg={fg} bg={bg} />
          <T size={13} color={colors.muted} style={{ flex: 1 }}>
            {serverLabel(r.router_id)}
            {r.batch_no ? ` · الدفعة ${r.batch_no}` : ""}
          </T>
          <T size={13} color={colors.muted}>{damascusStamp(r.at).slice(11)}</T>
        </View>
        <T size={15}>{r.message}</T>
      </Card>
    </Pressable>
  );
}
