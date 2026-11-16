import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createAgentAccounts, credentialsFileName, credentialsSheet, PASSWORD_WARNING, type AccountResult } from "../../lib/accounts";
import { emitDataChanged } from "../../lib/bus";
import { loadAreas } from "../../lib/managerData";
import { parseK } from "../../lib/money";
import { shareXlsx } from "../../lib/share";
import { useLoad } from "../../lib/useLoad";
import { Banner, Button, Card, Chip, Field, T } from "../../ui/kit";
import { Header, MoneyField, Options } from "../../ui/parts";
import { colors, space } from "../../ui/theme";

type Comp = "none" | "monthly_salary" | "per_invoice";
interface Draft {
  key: number;
  name: string;
  username: string;
  phone: string;
  areas: string[];
  comp: Comp;
  amount: string;
  error?: string;
}
const blank = (key: number): Draft => ({ key, name: "", username: "", phone: "", areas: [], comp: "none", amount: "" });

/** Manager creates agent logins (username + generated password) and gets them as an Excel file. */
export default function AccountsScreen() {
  const areas = useLoad(loadAreas, []);
  const next = useRef(1);
  const [rows, setRows] = useState<Draft[]>([blank(0)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<AccountResult[]>([]);
  const [shareError, setShareError] = useState<string | null>(null);

  const free = (areas.data ?? []).filter((a) => !a.agent_id);
  const set = (key: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, error: undefined } : r)));

  async function share(results: AccountResult[]) {
    setShareError(null);
    try {
      await shareXlsx([credentialsSheet(results)], credentialsFileName(), "حسابات المعتمدين");
    } catch (e) {
      setShareError((e as Error).message || "تعذرت المشاركة");
    }
  }

  async function submit() {
    setError(null);
    const checked = rows.map((r) => {
      const uname = r.username.trim().toLowerCase();
      const amt = r.comp === "none" ? 0 : parseK(r.amount);
      const err = !r.name.trim() ? "الاسم مطلوب"
        : !/^[a-z0-9_.]{3,30}$/.test(uname) ? "اسم الدخول: أحرف إنجليزية صغيرة أو أرقام أو . _ (3 أحرف على الأقل)"
        : !r.areas.length ? "اختر منطقة واحدة على الأقل"
        : amt === null || (r.comp !== "none" && amt <= 0) ? "مبلغ التعويض غير صحيح"
        : undefined;
      return { r, uname, amt: amt ?? 0, err };
    });
    const names = checked.map((c) => c.uname);
    if (new Set(names).size !== names.length) return setError("اسم دخول مكرر في القائمة");
    if (checked.some((c) => c.err)) {
      setRows(checked.map((c) => ({ ...c.r, error: c.err })));
      return;
    }
    setBusy(true);
    try {
      const results = await createAgentAccounts(
        checked.map((c) => ({ full_name: c.r.name.trim(), username: c.uname, area_ids: c.r.areas, comp_type: c.r.comp, comp_amount: c.amt, phone: c.r.phone.trim() || null })),
      );
      const okNames = new Set(results.filter((x) => x.ok).map((x) => x.username));
      const failed = new Map(results.filter((x) => !x.ok).map((x) => [x.username ?? x.full_name, x.ok ? "" : x.error]));
      const left = checked.filter((c) => !okNames.has(c.uname)).map((c) => ({ ...c.r, error: failed.get(c.uname) ?? failed.get(c.r.name.trim()) ?? "لم يُنشأ" }));
      setRows(left.length ? left : [blank(next.current++)]);
      const created = results.filter((x) => x.ok);
      if (created.length) {
        const all = [...done, ...created];
        setDone(all);
        emitDataChanged();
        await share(all);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header title="إنشاء حسابات المعتمدين" />
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4), paddingBottom: space(10) }} keyboardShouldPersistTaps="handled">
        {done.length > 0 && (
          <Card style={{ gap: space(2) }}>
            <Banner tone="warn" text={PASSWORD_WARNING} />
            <T>تم إنشاء {done.length} حساب: {done.map((d) => d.full_name).join("، ")}</T>
            {shareError ? <T color={colors.danger}>{shareError}</T> : null}
            <Button title="مشاركة / حفظ الملف مرة أخرى" variant="secondary" onPress={() => share(done)} />
          </Card>
        )}
        <T color={colors.muted}>يُنشأ لكل معتمد اسم دخول وكلمة مرور. تصلك في ملف Excel للمشاركة — لا تُحفظ كلمات المرور في النظام.</T>

        {rows.map((r, i) => {
          const takenByOthers = new Set(rows.filter((o) => o.key !== r.key).flatMap((o) => o.areas));
          const choices = free.filter((a) => !takenByOthers.has(a.id));
          return (
            <Card key={r.key} style={{ gap: space(3) }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <T w="bold" style={{ flex: 1 }}>معتمد {i + 1}</T>
                {rows.length > 1 && <Button title="حذف" variant="ghost" onPress={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} style={{ minHeight: 32 }} />}
              </View>
              <Field label="اسم المعتمد" value={r.name} onChangeText={(v) => set(r.key, { name: v })} />
              <Field label="اسم الدخول (إنجليزي)" value={r.username} onChangeText={(v) => set(r.key, { username: v })} autoCapitalize="none" autoCorrect={false} hint="مثال: ali.kadar" ltr />
              <Field label="الهاتف (اختياري)" value={r.phone} onChangeText={(v) => set(r.key, { phone: v })} keyboardType="phone-pad" ltr />
              <View style={{ gap: space(2) }}>
                <T w="medium">المناطق</T>
                {choices.length === 0 ? (
                  <T color={colors.muted}>{areas.data ? "لا توجد مناطق بدون معتمد" : "جارٍ التحميل…"}</T>
                ) : (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
                    {choices.map((a) => (
                      <Chip key={a.id} label={a.name} active={r.areas.includes(a.id)} onPress={() => set(r.key, { areas: r.areas.includes(a.id) ? r.areas.filter((x) => x !== a.id) : [...r.areas, a.id] })} />
                    ))}
                  </View>
                )}
              </View>
              <Options<Comp> value={r.comp} onChange={(v) => set(r.key, { comp: v })} options={[["none", "بدون تعويض"], ["monthly_salary", "راتب شهري"], ["per_invoice", "عن كل فاتورة"]]} />
              {r.comp !== "none" && <MoneyField label={r.comp === "monthly_salary" ? "الراتب الشهري" : "المبلغ عن كل فاتورة"} value={r.amount} onChange={(v) => set(r.key, { amount: v })} />}
              {r.error ? <T color={colors.danger}>{r.error}</T> : null}
            </Card>
          );
        })}

        <Button title="+ معتمد آخر" variant="secondary" onPress={() => setRows((rs) => [...rs, blank(next.current++)])} disabled={busy || rows.length >= 20} />
        {error ? <T color={colors.danger}>{error}</T> : null}
        <Button title={rows.length > 1 ? `إنشاء ${rows.length} حسابات` : "إنشاء الحساب"} onPress={submit} loading={busy} big />
      </ScrollView>
    </SafeAreaView>
  );
}
