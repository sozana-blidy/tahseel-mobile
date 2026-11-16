import { router } from "expo-router";
import Constants from "expo-constants";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../lib/auth";
import type { AppError } from "../../../lib/errors";
import { useManager } from "../../../lib/managerContext";
import { monthLabel } from "../../../lib/months";
import { buildMonthReport, reportTitle } from "../../../lib/report";
import { shareXlsx } from "../../../lib/share";
import { Banner, Button, Card, T } from "../../../ui/kit";
import { MonthBar } from "../../../ui/parts";
import { colors, space } from "../../../ui/theme";

export default function More() {
  const { profile, signOut } = useAuth();
  const m = useManager();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportMonth() {
    setBusy(true);
    setError(null);
    try {
      const r = await buildMonthReport(m.month);
      await shareXlsx(r.sheets, r.fileName, reportTitle(m.month));
    } catch (e) {
      setError((e as AppError).message ?? "تعذر إنشاء التقرير");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(3), paddingBottom: space(10) }}>
        <T w="bold" size={22}>المزيد</T>

        <Card style={{ gap: space(3) }}>
          <T w="bold" size={17}>تقرير Excel</T>
          <T color={colors.muted}>ملخص المناطق، المعتمدون وأموالهم، غير المدفوعين، وورقة لكل منطقة. المبالغ كاملة بالليرة.</T>
          <MonthBar months={m.months} month={m.month} onPick={m.setMonth} />
          {error && <Banner tone="error" text={error} />}
          <Button title={`تقرير ${monthLabel(m.month)} — مشاركة`} onPress={exportMonth} loading={busy} disabled={!m.months.includes(m.month)} />
        </Card>

        <Card style={{ gap: space(3) }}>
          <T w="bold" size={17}>استيراد المشتركين</T>
          <T color={colors.muted}>من ملف Excel الخاص بالشركة — مرة واحدة قبل إصدار أول فواتير.</T>
          <Button title="استيراد من Excel" variant="secondary" onPress={() => router.push("/manager/import")} />
        </Card>

        <Card style={{ gap: space(2) }}>
          <T w="bold" size={17}>الحساب</T>
          <T color={colors.muted}>{profile?.full_name} · المدير</T>
          <Button
            title="تسجيل الخروج"
            variant="secondary"
            onPress={() => Alert.alert("تسجيل الخروج", "هل تريد تسجيل الخروج؟", [{ text: "إلغاء", style: "cancel" }, { text: "خروج", style: "destructive", onPress: signOut }])}
          />
        </Card>
        <View style={{ alignItems: "center" }}>
          <T size={12} color={colors.muted}>تحصيل · الإصدار {Constants.expoConfig?.version ?? "—"}</T>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
