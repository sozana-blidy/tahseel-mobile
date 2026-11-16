import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../lib/auth";
import { classifyError } from "../lib/errors";
import { loginEmail } from "../lib/env";
import { supabase } from "../lib/supabase";
import { Button, Card, Field, Num, T } from "../ui/kit";
import { colors, space } from "../ui/theme";

type Invite = { full_name: string; username: string };

/**
 * Agent onboarding: the manager gives a one-time code → the agent sees his name,
 * picks a password → account is created and bound to his areas (claim_agent_invite).
 */
export default function Join() {
  const { session, reloadProfile, signOut } = useAuth();
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");

  async function checkCode() {
    if (cleanCode.length !== 8) return setError("الرمز من 8 أحرف");
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc("invite_info", { p_code: cleanCode });
    setBusy(false);
    if (e) return setError(classifyError(e).message);
    if (!data) return setError("الرمز غير صالح أو منتهي — اطلب رمزاً جديداً من المدير");
    setInvite(data as Invite);
  }

  async function createAccount() {
    if (!invite) return;
    if (password.length < 8) return setError("كلمة المرور 8 أحرف على الأقل");
    if (password !== confirm) return setError("كلمتا المرور غير متطابقتين");
    setBusy(true);
    setError(null);
    try {
      const email = loginEmail(invite.username);
      // A retry after a dropped connection may find the account already created.
      if (!session || session.user.email !== email) {
        const up = await supabase.auth.signUp({ email, password });
        if (up.error) {
          const err = classifyError(up.error);
          if (err.message !== "هذا الحساب موجود مسبقاً") throw err;
          const inn = await supabase.auth.signInWithPassword({ email, password });
          if (inn.error) throw { message: "هذا الحساب موجود مسبقاً — سجّل الدخول بكلمة المرور التي اخترتها", retry: false };
        } else if (!up.data.session) {
          throw { message: "الخادم يطلب تأكيد البريد — أخبر المدير بإيقاف «Confirm email» في Supabase", retry: false };
        }
      }
      const claim = await supabase.rpc("claim_agent_invite", { p_code: cleanCode });
      if (claim.error) {
        const err = classifyError(claim.error);
        if (!/مفعّل مسبقاً/.test(err.message)) throw err;
      }
      await reloadProfile();
      router.replace("/");
    } catch (e) {
      setError((e as { message?: string }).message ?? "تعذر إنشاء الحساب");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: space(5), gap: space(5) }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: space(1) }}>
            <T w="bold" size={26}>تفعيل حساب معتمد</T>
            <T color={colors.muted}>{invite ? "اختر كلمة مرور لحسابك" : "أدخل الرمز الذي أعطاك إياه المدير"}</T>
          </View>

          {!invite ? (
            <Card style={{ gap: space(4) }}>
              <Field
                label="رمز الدعوة"
                value={code}
                onChangeText={(v) => setCode(v.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={12}
                placeholder="ABCD2345"
                error={error}
                onSubmitEditing={checkCode}
                style={{ fontSize: 24, letterSpacing: 4 }}
                ltr
              />
              <Button title="التالي" onPress={checkCode} loading={busy} big />
            </Card>
          ) : (
            <Card style={{ gap: space(4) }}>
              <View style={{ backgroundColor: colors.primarySoft, borderRadius: 12, padding: space(3), gap: space(1) }}>
                <T w="bold" size={20}>{invite.full_name}</T>
                <T color={colors.muted}>
                  اسم الدخول: <Num w="bold" color={colors.text}>{invite.username}</Num>
                </T>
                <T size={13} color={colors.muted}>احفظ اسم الدخول — ستحتاجه في كل مرة تسجّل فيها الدخول</T>
              </View>
              <Field label="كلمة المرور" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} hint="8 أحرف على الأقل" ltr />
              <Field label="تأكيد كلمة المرور" value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none" autoCorrect={false} error={error} ltr onSubmitEditing={createAccount} />
              <Button title="إنشاء الحساب" onPress={createAccount} loading={busy} big />
              <Button title="رمز آخر" variant="ghost" onPress={() => { setInvite(null); setError(null); }} />
            </Card>
          )}

          <Button
            title="رجوع"
            variant="ghost"
            onPress={async () => {
              if (session) await signOut();
              router.canGoBack() ? router.back() : router.replace("/");
            }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
