import { router } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../lib/auth";
import { emitDataChanged } from "../../../lib/bus";
import type { AppError } from "../../../lib/errors";
import { useManager } from "../../../lib/managerContext";
import { formatK } from "../../../lib/money";
import { currentMonth, monthLabel } from "../../../lib/months";
import { loadOverview } from "../../../lib/managerData";
import { rpc } from "../../../lib/rpc";
import { useLoad } from "../../../lib/useLoad";
import { Banner, Button, Card, Num, Sheet, T } from "../../../ui/kit";
import { Empty, MonthBar, Progress, Stat } from "../../../ui/parts";
import { colors, space } from "../../../ui/theme";

export default function Overview() {
  const { profile } = useAuth();
  const m = useManager();
  const { data, error, loading, refresh } = useLoad(() => loadOverview(m.month), [m.month]);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = currentMonth();

  const total = (data ?? []).reduce(
    (a, r) => ({ expected: a.expected + r.expected, paid: a.paid + r.paid, remaining: a.remaining + r.remaining, exempt: a.exempt + r.exempt, done: a.done + r.paid_count, subs: a.subs + r.subscribers }),
    { expected: 0, paid: 0, remaining: 0, exempt: 0, done: 0, subs: 0 },
  );

  async function openMonth() {
    setBusy(true);
    try {
      const r = await rpc<{ issued: number; total: number; no_price: number }>("open_month", { p_month: now });
      await m.reloadMonths();
      m.setMonth(now);
      setOpening(false);
      emitDataChanged();
      Alert.alert(
        "تم إصدار الفواتير",
        `${r.issued} فاتورة بقيمة ${formatK(r.total)} ألف ل.س${r.no_price ? `\n${r.no_price} مشترك بدون سعر — حدّد سرعتهم` : ""}`,
      );
    } catch (e) {
      Alert.alert("تعذر الإصدار", (e as AppError).message);
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <View style={{ gap: space(3), paddingBottom: space(2) }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <T w="bold" size={22}>أهلاً {profile?.full_name}</T>
          <T color={colors.muted}>كل المناطق</T>
        </View>
      </View>

      {m.currentMonthMissing && (data?.length ?? 0) > 0 && (
        <Banner
          tone="warn"
          text={`لم تصدر فواتير ${monthLabel(now)} بعد`}
          action={<Button title="إصدار" onPress={() => setOpening(true)} style={{ minHeight: 38 }} />}
        />
      )}

      <MonthBar months={m.months} month={m.month} onPick={m.setMonth} />

      <Card style={{ gap: space(3) }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
          <T w="bold" size={17}>{monthLabel(m.month)}</T>
          <T size={12} color={colors.muted}>المبالغ بالألف ل.س</T>
        </View>
        <View style={{ flexDirection: "row", gap: space(2) }}>
          <Stat label="المطلوب" amount={total.expected} />
          <Stat label="المدفوع" amount={total.paid} color={colors.paid} />
          <Stat label="الباقي" amount={total.remaining} color={colors.open} />
        </View>
        <Progress value={total.paid + total.exempt} total={total.expected} />
        <T size={13} color={colors.muted}>
          دفع {total.done} من {total.subs} مشترك{total.exempt ? ` · إعفاءات ${formatK(total.exempt)}` : ""}
        </T>
      </Card>
      {error && <Banner tone="error" text={error} />}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.area_id}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: space(4), gap: space(2.5) }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.primary]} />}
        ListEmptyComponent={
          data ? (
            m.months.length ? (
              <Empty text="لا توجد فواتير لهذا الشهر" />
            ) : (
              <View style={{ gap: space(3), marginTop: space(4) }}>
                <Empty text="لا توجد بيانات بعد — ابدأ باستيراد ملف المشتركين ثم أصدر الفواتير" />
                <Button title="استيراد من Excel" onPress={() => router.push("/manager/import")} />
              </View>
            )
          ) : undefined
        }
        renderItem={({ item: a }) => {
          const done = a.remaining === 0 && a.expected > 0;
          return (
            <Pressable onPress={() => router.push({ pathname: "/manager/area/[id]", params: { id: a.area_id, name: a.area_name } })} accessibilityRole="button">
              <Card style={{ gap: space(2) }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
                  <View style={{ flex: 1 }}>
                    <T w="bold" size={18}>{a.area_name}</T>
                    <T size={14} color={colors.muted}>{a.agent_name ? `المعتمد: ${a.agent_name}` : "يجمعها المدير"}</T>
                  </View>
                  {done ? (
                    <T w="bold" color={colors.paid}>مكتملة ✓</T>
                  ) : (
                    <View style={{ alignItems: "flex-end" }}>
                      <T size={12} color={colors.muted}>باقي</T>
                      <Num w="bold" size={17} color={colors.open}>{formatK(a.remaining)}</Num>
                    </View>
                  )}
                </View>
                <Progress value={a.paid + a.exempt} total={a.expected} />
                <T size={13} color={colors.muted}>
                  دفع {a.paid_count} من {a.subscribers} · مدفوع {formatK(a.paid)} من {formatK(a.expected)}
                  {a.partial_count ? ` · جزئي ${a.partial_count}` : ""}
                </T>
              </Card>
            </Pressable>
          );
        }}
      />

      <Sheet visible={opening} onClose={() => !busy && setOpening(false)}>
        <T w="bold" size={20}>إصدار فواتير {monthLabel(now)}</T>
        <T color={colors.muted}>
          تصدر فاتورة لكل مشترك فعّال حسب سرعته (كل 1M = 50 ألف). المفصولون لا تصدر لهم فواتير، والمعفيون دائماً تصدر لهم بصفر.
        </T>
        <Button title="إصدار الآن" onPress={openMonth} loading={busy} big />
        <Button title="إلغاء" variant="secondary" onPress={() => setOpening(false)} disabled={busy} />
      </Sheet>
    </SafeAreaView>
  );
}
