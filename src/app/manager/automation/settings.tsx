import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { damascusStamp, parseCutoffDay } from "../../../lib/automation";
import { loadAutomationStatus, setCutoffDay } from "../../../lib/automationData";
import { useLoad } from "../../../lib/useLoad";
import { ModeBadge } from "../../../ui/automationParts";
import { Banner, Button, Card, Field, T } from "../../../ui/kit";
import { Header, Line } from "../../../ui/parts";
import { ConfirmSheet } from "../../../ui/sheets";
import { colors, space } from "../../../ui/theme";

/** Read-only, except the cutoff day while the mode is dry-run (1–28, audited on the server). */
export default function AutomationSettings() {
  const { data: st, error, loading, refresh } = useLoad(loadAutomationStatus, []);
  const [dayText, setDayText] = useState("");
  const [dayError, setDayError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);

  function askSave() {
    const d = parseCutoffDay(dayText);
    if (d === null) return setDayError("يوم من 1 إلى 28");
    if (st && d === st.cutoff_day) return setDayError("هذا هو اليوم الحالي");
    setDayError(null);
    setConfirm(d);
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header title="إعدادات الفصل التلقائي" />
      <ScrollView
        contentContainerStyle={{ padding: space(4), paddingTop: 0, gap: space(3), paddingBottom: space(10) }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.primary]} />}
      >
        {error ? <Banner tone="error" text={error} /> : null}
        {st ? (
          <>
            <Card style={{ gap: space(2) }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <T w="bold" size={17}>الوضع</T>
                <ModeBadge mode={st.mode} />
              </View>
              <T color={colors.muted}>
                {st.mode === "dry_run"
                  ? "تجريبي: السيرفران يقرآن فقط ولا يتغير شيء عليهما. السجل يبين ما كان سيحدث."
                  : st.mode === "live"
                    ? "حقيقي: يُفصل غير الدافعين ويعاد تفعيلهم بعد الدفع."
                    : "متوقف: لا يفعل الفصل التلقائي شيئاً."}
              </T>
            </Card>

            <Card style={{ gap: space(2.5) }}>
              <T w="bold" size={17}>يوم القطع: {st.cutoff_day}</T>
              <T color={colors.muted}>الفصل الساعة 12 ليلاً من هذا اليوم، والتنبيه الساعة 8 مساءً في اليوم السابق.</T>
              {st.mode === "dry_run" ? (
                <>
                  <Field label="يوم جديد (1–28)" value={dayText} onChangeText={setDayText} keyboardType="number-pad" error={dayError} ltr />
                  <Button title="تغيير يوم القطع" variant="secondary" onPress={askSave} />
                </>
              ) : (
                <T size={13} color={colors.muted}>يمكن تغييره في الوضع التجريبي فقط.</T>
              )}
            </Card>

            <Card style={{ gap: space(1) }}>
              <T w="bold" size={17} style={{ marginBottom: space(1) }}>الحدود</T>
              <Line label="أقصى فصل في كل دورة (لكل سيرفر)" value={String(st.max_disconnects_per_run)} />
              <Line label="أقصى فصل جديد في اليوم بعد يوم القطع" value={String(st.daily_new_disconnect_limit)} />
              <T size={13} color={colors.muted}>إيقاف تلقائي إذا تجاوز العدد نصف المشتركين أو ضعف الشهر الماضي.</T>
            </Card>

            <Card style={{ gap: space(1.5) }}>
              <T w="bold" size={17}>المناطق المشمولة ({st.areas.length})</T>
              <T color={colors.muted}>{st.areas.map((a) => a.name).join("، ") || "—"}</T>
            </Card>

            <Card style={{ gap: space(2) }}>
              <T w="bold" size={17}>السيرفرات</T>
              {st.routers.map((r) => (
                <View key={r.id} style={{ gap: 2 }}>
                  <T w="medium">{r.id} · {r.name}{r.enabled ? "" : " (معطّل)"}</T>
                  <T size={13} color={r.silent ? colors.danger : colors.muted}>
                    {!r.has_token ? "لا يوجد رمز — أصدره من محرر SQL" : r.last_seen_at ? `آخر اتصال ${damascusStamp(r.last_seen_at)}${r.silent ? " — لم يتصل منذ أكثر من 15 دقيقة" : ""}` : "لم يتصل بعد"}
                  </T>
                </View>
              ))}
            </Card>
          </>
        ) : null}
      </ScrollView>

      {confirm !== null && st ? (
        <ConfirmSheet
          title={`يوم القطع: ${st.cutoff_day} ← ${confirm}`}
          body="يبدأ اختبار هذا الشهر من جديد (القائمة والإيقاف والفصل التجريبي). الاستثناءات والإيقاف اليدوي تبقى. يتغير أيضاً موعد تنبيهات الدفع المتأخر. يُسجَّل التغيير."
          action="تغيير"
          onClose={() => setConfirm(null)}
          run={async () => {
            await setCutoffDay(confirm);
            setDayText("");
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}
