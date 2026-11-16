import * as DocumentPicker from "expo-document-picker";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { emitDataChanged } from "../../lib/bus";
import { buildImportPlan, type ImportPlan } from "../../lib/importPlan";
import { useManager } from "../../lib/managerContext";
import { formatK } from "../../lib/money";
import { parseWorkbook } from "../../lib/parseWorkbook";
import { q, rpc } from "../../lib/rpc";
import { supabase } from "../../lib/supabase";
import { useLoad } from "../../lib/useLoad";
import { readXlsx } from "../../lib/xlsx";
import { readFileBytes } from "../../lib/files";
import { Banner, Button, Card, Num, T } from "../../ui/kit";
import { Header, Line } from "../../ui/parts";
import { ConfirmSheet } from "../../ui/sheets";
import { colors, space } from "../../ui/theme";

/**
 * Import the company workbook on the phone: read → parse → preview totals per
 * area → replace all subscribers. Allowed only before the first invoices.
 */
export default function ImportScreen() {
  const m = useManager();
  const guard = useLoad(async () => (await q<{ id: string }[]>(supabase.from("invoices").select("id").limit(1))).length > 0, []);
  const [fileName, setFileName] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<{ imported: number; areas: number } | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

  async function pick() {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"],
      // Read the original content:// uri: in Expo Go the picker's cache copy lives outside
      // the app's sandbox and is unreadable ("isn't readable").
      copyToCacheDirectory: false,
      multiple: false,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    setBusy(true);
    setPlan(null);
    setFileName(asset.name);
    // let the spinner render before the (synchronous) parse
    setTimeout(async () => {
      try {
        if (!/\.xlsx$/i.test(asset.name)) throw new Error("اختر ملف Excel بصيغة ‎.xlsx");
        const bytes = await readFileBytes(asset.uri);
        const p = buildImportPlan(parseWorkbook(readXlsx(bytes)));
        if (!p.rows.length) throw new Error("لم يتم العثور على مشتركين في الملف — تأكد أن الأعمدة تحوي «إسم المشترك»");
        setPlan(p);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    }, 50);
  }

  async function runImport() {
    if (!plan) return;
    const r = await rpc<{ imported: number; areas: number }>("import_subscribers", { p_rows: plan.rows });
    setDone(r);
    emitDataChanged();
  }

  if (done) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Header title="تم الاستيراد" />
        <View style={{ padding: space(4), gap: space(4) }}>
          <Card style={{ alignItems: "center", gap: space(2), paddingVertical: space(6) }}>
            <Num w="bold" size={40} color={colors.paid}>{done.imported}</Num>
            <T color={colors.muted}>مشترك في {done.areas} منطقة</T>
          </Card>
          <Banner text="الخطوة التالية: أصدر فواتير الشهر من صفحة «المناطق»، ثم أرسل رموز الدعوة للمعتمدين." />
          <Button title="إلى المناطق" onPress={() => router.replace("/manager")} big />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header title="استيراد المشتركين" subtitle="من ملف Excel الخاص بالشركة" />
      <ScrollView contentContainerStyle={{ padding: space(4), paddingTop: 0, gap: space(3), paddingBottom: space(10) }}>
        {guard.data === true && (
          <Banner tone="error" text="تم إصدار فواتير مسبقاً — الاستيراد متاح فقط قبل أول إصدار حتى لا يضيع سجل الدفعات. لإضافة مشترك استخدم «+» في صفحة المنطقة." />
        )}
        {guard.data === false && !plan && (
          <Banner tone="warn" text="الاستيراد يستبدل كل المشتركين الحاليين بمحتوى الملف. المناطق تُنشأ تلقائياً من أسماء الأوراق." />
        )}

        <Button title={plan ? "اختيار ملف آخر" : "اختيار ملف Excel"} variant={plan ? "secondary" : "primary"} onPress={pick} disabled={busy || guard.data !== false} big={!plan} />
        {busy && (
          <View style={{ alignItems: "center", gap: space(2), padding: space(6) }}>
            <ActivityIndicator color={colors.primary} size="large" />
            <T color={colors.muted}>جارٍ قراءة {fileName}…</T>
          </View>
        )}
        {error && <Banner tone="error" text={error} />}

        {plan && (
          <>
            <Card style={{ gap: space(1) }}>
              <T color={colors.muted}>{fileName}</T>
              <Line label="المشتركون" value={<Num w="bold">{plan.total.count}</Num>} />
              <Line label="المناطق" value={<Num w="bold">{plan.areas.length}</Num>} />
              <Line label="المطلوب شهرياً (بالألف)" value={<Num w="bold" color={colors.primary}>{formatK(plan.total.expected)}</Num>} />
              <Line label="معفى (SPF)" value={<Num>{plan.total.exempt}</Num>} />
              {plan.total.noPrice > 0 && <Line label="بدون سعر" value={<Num color={colors.danger}>{plan.total.noPrice}</Num>} />}
            </Card>

            <Card style={{ gap: space(2) }}>
              <T w="bold">حسب المنطقة</T>
              {plan.areas.map((a) => {
                const match = a.sheetTotal === null ? null : a.sheetTotal === a.expected;
                return (
                  <View key={a.area} style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingVertical: space(1), borderBottomWidth: 1, borderBottomColor: colors.line }}>
                    <View style={{ flex: 1 }}>
                      <T w="medium">{a.area}</T>
                      <T size={13} color={colors.muted}>
                        {a.count} مشترك{a.exempt ? ` · ${a.exempt} معفى` : ""}{a.noPrice ? ` · ${a.noPrice} بدون سعر` : ""}
                      </T>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Num w="bold">{formatK(a.expected)}</Num>
                      {match !== null && (
                        <T size={12} color={match ? colors.paid : colors.open}>
                          {match ? "يطابق ورقة «الكل» ✓" : `الكل: ${formatK(a.sheetTotal!)}`}
                        </T>
                      )}
                    </View>
                  </View>
                );
              })}
            </Card>

            {plan.warnings.length > 0 && (
              <Card style={{ gap: space(2) }}>
                <T w="bold">تنبيهات</T>
                {plan.warnings.map((w) => (
                  <T key={w.label} size={14}>
                    <Num w="bold" color={colors.open}>{w.count}</Num> — {w.label}
                  </T>
                ))}
              </Card>
            )}

            {plan.excluded.length > 0 && (
              <Card style={{ gap: space(2) }}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <T w="bold" style={{ flex: 1 }}>مستبعد من الاستيراد ({plan.excluded.length})</T>
                  <Button title={showExcluded ? "إخفاء" : "عرض"} variant="ghost" onPress={() => setShowExcluded((v) => !v)} style={{ minHeight: 32 }} />
                </View>
                {showExcluded &&
                  plan.excluded.map((x) => (
                    <T key={x.record.key} size={13} color={colors.muted}>
                      {x.record.fullName} — {x.record.sheet} · {x.reason}
                    </T>
                  ))}
              </Card>
            )}

            <Button title={`استيراد ${plan.total.count} مشترك`} onPress={() => setConfirm(true)} big disabled={guard.data !== false} />
          </>
        )}
      </ScrollView>

      {confirm && plan && (
        <ConfirmSheet
          title="تأكيد الاستيراد"
          body={`سيتم حذف المشتركين الحاليين واستيراد ${plan.total.count} مشترك في ${plan.areas.length} منطقة من الملف. ${m.months.length ? "" : "بعدها أصدر فواتير الشهر."}`}
          action="استيراد"
          onClose={() => setConfirm(false)}
          run={runImport}
        />
      )}
    </SafeAreaView>
  );
}
