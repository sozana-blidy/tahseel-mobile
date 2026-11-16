import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, Share, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { emitDataChanged } from "../../lib/bus";
import type { AppError } from "../../lib/errors";
import { inviteMessage, loadAreas } from "../../lib/managerData";
import { parseK } from "../../lib/money";
import { rpc } from "../../lib/rpc";
import { useLoad } from "../../lib/useLoad";
import { Banner, Button, Card, Chip, Field, Num, T } from "../../ui/kit";
import { Header, MoneyField, Options } from "../../ui/parts";
import { colors, space } from "../../ui/theme";

type Comp = "none" | "monthly_salary" | "per_invoice";

/** Manager creates a one-time code that binds a new agent to his areas. */
export default function InviteScreen() {
  const areas = useLoad(loadAreas, []);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [comp, setComp] = useState<Comp>("none");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ code: string; username: string; full_name: string } | null>(null);
  const sent = useRef(false);

  const free = (areas.data ?? []).filter((a) => !a.agent_id);
  const uname = username.trim().toLowerCase();

  async function create() {
    if (!name.trim()) return setError("اسم المعتمد مطلوب");
    if (!/^[a-z0-9_.]{3,30}$/.test(uname)) return setError("اسم الدخول: أحرف إنجليزية صغيرة أو أرقام أو . _ (3 أحرف على الأقل)");
    if (!picked.length) return setError("اختر منطقة واحدة على الأقل");
    const amt = comp === "none" ? 0 : parseK(amount);
    if (amt === null || (comp !== "none" && amt <= 0)) return setError("مبلغ التعويض غير صحيح");
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await rpc<{ code: string; username: string }>("create_agent_invite", {
        p_full_name: name.trim(), p_username: uname, p_area_ids: picked, p_phone: phone.trim() || null, p_comp_type: comp, p_comp_amount: amt,
      });
      setResult({ code: r.code, username: r.username, full_name: name.trim() });
      emitDataChanged();
    } catch (e) {
      sent.current = false;
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Header title="رمز الدعوة جاهز" />
        <View style={{ padding: space(4), gap: space(4) }}>
          <Card style={{ alignItems: "center", gap: space(2), paddingVertical: space(6) }}>
            <T color={colors.muted}>أعطِ هذا الرمز لـ {result.full_name}</T>
            <Num w="bold" size={40} color={colors.primary} style={{ letterSpacing: 6 }}>{result.code}</Num>
            <T color={colors.muted}>اسم الدخول: <Num w="bold" color={colors.text}>{result.username}</Num></T>
            <T size={13} color={colors.muted}>صالح لمرة واحدة خلال 7 أيام</T>
          </Card>
          <Banner text="يفتح المعتمد التطبيق ← «معتمد جديد؟ أدخل رمز الدعوة» ← يختار كلمة مرور. بعدها يرى مناطقه فقط ولا يستطيع تغييرها." />
          <Button title="مشاركة (واتساب…)" onPress={() => Share.share({ message: inviteMessage(result) })} big />
          <Button title="نسخ الرمز" variant="secondary" onPress={() => Clipboard.setStringAsync(result.code)} />
          <Button title="تم" variant="ghost" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header title="دعوة معتمد جديد" />
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4), paddingBottom: space(10) }} keyboardShouldPersistTaps="handled">
        <Field label="اسم المعتمد" value={name} onChangeText={setName} />
        <Field label="اسم الدخول (إنجليزي)" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} hint="مثال: ali.kadar" ltr />
        <Field label="الهاتف (اختياري)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" ltr />
        <View style={{ gap: space(2) }}>
          <T w="medium">المناطق</T>
          {free.length === 0 ? (
            <T color={colors.muted}>{areas.data ? "كل المناطق مرتبطة بمعتمدين" : "جارٍ التحميل…"}</T>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
              {free.map((a) => (
                <Chip key={a.id} label={a.name} active={picked.includes(a.id)} onPress={() => setPicked((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id]))} />
              ))}
            </View>
          )}
        </View>
        <View style={{ gap: space(2) }}>
          <T w="medium">التعويض</T>
          <Options<Comp> value={comp} onChange={setComp} options={[["none", "بدون"], ["monthly_salary", "راتب شهري"], ["per_invoice", "عن كل فاتورة"]]} />
          {comp !== "none" && <MoneyField label={comp === "monthly_salary" ? "الراتب الشهري" : "المبلغ عن كل فاتورة"} value={amount} onChange={setAmount} />}
        </View>
        {error ? <T color={colors.danger}>{error}</T> : null}
        <Button title="إنشاء رمز الدعوة" onPress={create} loading={busy} big />
      </ScrollView>
    </SafeAreaView>
  );
}
