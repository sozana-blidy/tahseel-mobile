import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { damascusStamp, groupTargets, type TargetRow } from "../../../lib/automation";
import { continueCutoff, loadAutomationStatus, loadDisconnectList, setExclusion, setPause, type CycleInfo } from "../../../lib/automationData";
import { emitDataChanged } from "../../../lib/bus";
import type { AppError } from "../../../lib/errors";
import { formatK } from "../../../lib/money";
import { monthLabel } from "../../../lib/months";
import { useLoad } from "../../../lib/useLoad";
import { IconBtn, ModeBadge } from "../../../ui/automationParts";
import { Banner, Button, Card, Field, Num, T } from "../../../ui/kit";
import { Empty, Header } from "../../../ui/parts";
import { ConfirmSheet } from "../../../ui/sheets";
import { colors, space } from "../../../ui/theme";

/** «قائمة الفصل»: who will be disconnected at 00:00 on the cutoff day, by area; per-subscriber exclusion; pause / continue. */
export default function CutoffList() {
  const status = useLoad(loadAutomationStatus, []);
  const month = status.data?.cycle.month ?? null;
  const list = useLoad(() => (month ? loadDisconnectList(month) : Promise.resolve([] as TargetRow[])), [month]);
  const [query, setQuery] = useState("");
  const sections = useMemo(() => groupTargets(list.data ?? [], query), [list.data, query]);
  const [sheet, setSheet] = useState<null | "pause" | "continue">(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const st = status.data;
  const c = st?.cycle;

  async function toggle(r: TargetRow) {
    if (!month) return;
    setBusyId(r.subscriber_id);
    setRowError(null);
    try {
      await setExclusion(r.subscriber_id, month, !r.excluded);
      emitDataChanged();
    } catch (e) {
      setRowError((e as AppError).message);
    } finally {
      setBusyId(null);
    }
  }

  const header = (
    <View style={{ gap: space(3), paddingBottom: space(2) }}>
      {status.error || list.error ? <Banner tone="error" text={(status.error ?? list.error) as string} /> : null}
      {st && c ? <CycleCard mode={st.mode} c={c} cutoffDay={st.cutoff_day} onPause={() => setSheet("pause")} onContinue={() => setSheet("continue")} /> : null}
      {rowError ? <Banner tone="error" text={rowError} /> : null}
      {list.data && list.data.length > 0 ? (
        <Field label="بحث" value={query} onChangeText={setQuery} placeholder="الاسم أو اسم المستخدم أو الرمز" autoCorrect={false} />
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header
        title="قائمة الفصل"
        subtitle={month ? monthLabel(month) : undefined}
        right={<IconBtn name="receipt-outline" label="السجل" onPress={() => router.push("/manager/automation/log")} />}
      />
      <SectionList
        sections={sections}
        keyExtractor={(r) => r.subscriber_id}
        ListHeaderComponent={header}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ padding: space(4), paddingTop: 0, gap: space(2), paddingBottom: space(10) }}
        refreshControl={
          <RefreshControl
            refreshing={status.loading || list.loading}
            onRefresh={() => {
              status.refresh();
              list.refresh();
            }}
            colors={[colors.primary]}
          />
        }
        renderSectionHeader={({ section }) => (
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: space(3), marginBottom: space(1) }}>
            <T w="bold" size={17}>{section.area_name}</T>
            <T size={13} color={colors.muted}>
              {section.count} حساب{section.excluded ? ` · مستثنى ${section.excluded}` : ""}
            </T>
          </View>
        )}
        renderItem={({ item }) => <TargetItem r={item} busy={busyId === item.subscriber_id} onToggle={() => toggle(item)} />}
        ListEmptyComponent={list.data ? <Empty text={query ? "لا نتائج" : "لا أحد في قائمة الفصل لهذا الشهر"} /> : undefined}
      />

      {sheet === "pause" && month ? (
        <ConfirmSheet
          title="إيقاف الفصل لهذا الشهر"
          body={`لن يُفصل أحد في ${monthLabel(month)} حتى تضغط «متابعة الفصل». إعادة التفعيل بعد الدفع تستمر كالمعتاد.`}
          action="إيقاف الفصل"
          onClose={() => setSheet(null)}
          run={() => setPause(month, true)}
        />
      ) : null}
      {sheet === "continue" && month && c ? (
        <ConfirmSheet
          title="متابعة الفصل"
          body={
            c.hold_reason
              ? `سيتابع الفصل التلقائي لشهر ${monthLabel(month)} (${c.hold_count ?? c.count_now} حساب) على دفعات في الدورات القادمة.`
              : `يعود الفصل التلقائي لشهر ${monthLabel(month)} للعمل.`
          }
          action="متابعة الفصل"
          onClose={() => setSheet(null)}
          run={async () => {
            if (c.paused) await setPause(month, false);
            if (c.hold_reason) await continueCutoff(month);
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

function CycleCard({ mode, c, cutoffDay, onPause, onContinue }: { mode: "off" | "dry_run" | "live"; c: CycleInfo; cutoffDay: number; onPause: () => void; onContinue: () => void }) {
  const stopped = c.paused || !!c.hold_reason;
  return (
    <Card style={{ gap: space(2.5) }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <T w="bold" size={17}>يوم القطع {cutoffDay} — الساعة 12 ليلاً</T>
        <ModeBadge mode={mode} />
      </View>
      <T color={colors.muted}>
        {c.started ? `بدأ القطع منذ ${damascusStamp(c.cutoff_at)}` : `يبدأ ${damascusStamp(c.cutoff_at)} · تنبيه ${damascusStamp(c.eve_at)}`}
      </T>
      <T size={18} w="bold" color={c.count_now ? colors.danger : colors.text}>
        {c.started ? "غير المدفوعين الآن" : "سيُفصل"}: <Num w="bold" size={18} color={c.count_now ? colors.danger : colors.text}>{c.count_now}</Num> حساب
        {c.excluded_count ? <T color={colors.muted}> · مستثنى {c.excluded_count}</T> : null}
      </T>
      {mode === "dry_run" ? <Banner tone="info" text="وضع تجريبي: لا يُفصل أحد فعلاً — السجل يبين ما كان سيحدث." /> : null}
      {c.hold_reason === "sanity" ? (
        <Banner tone="error" text={`تم إيقاف الفصل التلقائي — عدد غير طبيعي (${c.hold_count ?? c.count_now}) من أصل ${c.in_scope_count ?? "؟"}${c.prev_count ? ` · الشهر الماضي ${c.prev_count}` : ""}`} />
      ) : null}
      {c.hold_reason === "daily_limit" ? (
        <Banner tone="error" text={`تم إيقاف الفصل التلقائي — عدد كبير من الحسابات الجديدة اليوم (${c.hold_count ?? "؟"})`} />
      ) : null}
      {c.paused ? <Banner tone="warn" text="الفصل موقوف لهذا الشهر." /> : null}
      {mode !== "off" ? (
        stopped ? (
          <Button title="متابعة الفصل" onPress={onContinue} />
        ) : (
          <Button title="إيقاف الفصل لهذا الشهر" variant="secondary" onPress={onPause} />
        )
      ) : null}
    </Card>
  );
}

function TargetItem({ r, busy, onToggle }: { r: TargetRow; busy: boolean; onToggle: () => void }) {
  return (
    <Card style={{ padding: space(3.5), gap: space(1.5), opacity: r.excluded ? 0.6 : 1 }}>
      <Pressable onPress={() => router.push({ pathname: "/manager/subscriber/[id]", params: { id: r.subscriber_id } })} accessibilityRole="button">
        <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
          <View style={{ flex: 1 }}>
            <T w="bold" size={16}>{r.display_name}</T>
            <T size={13} color={colors.muted}>
              {r.code} · <Num size={13} color={colors.muted}>{r.username}</Num>
            </T>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Num w="bold" color={colors.open}>{formatK(r.due)}</Num>
            <T size={12} color={colors.muted}>ألف</T>
          </View>
        </View>
        <T size={14} color={r.reason === "two_bills" ? colors.danger : colors.text}>{r.reason_text}</T>
      </Pressable>
      <Button
        title={r.excluded ? "مستثنى — إلغاء الاستثناء" : "استثناء هذا الشهر"}
        variant={r.excluded ? "ghost" : "secondary"}
        onPress={onToggle}
        loading={busy}
        style={{ minHeight: 40 }}
      />
    </Card>
  );
}
