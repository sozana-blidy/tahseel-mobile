import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../lib/auth";
import type { AppError } from "../lib/errors";
import { Button, Card, Field, T } from "../ui/kit";
import { colors, space } from "../ui/theme";

export default function Login() {
  const { signIn, signInAsGuest } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!username.trim() || !password) {
      setError("أدخل اسم الدخول وكلمة المرور");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
    } catch (e) {
      setError((e as AppError).message ?? "تعذر تسجيل الدخول");
    } finally {
      setBusy(false);
    }
  }

  async function guest() {
    setBusy(true);
    setError(null);
    try {
      await signInAsGuest(); // routing moves to /guest, where the guest code is asked
    } catch (e) {
      setError((e as Error).message ?? "تعذر دخول الضيف");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: space(5), gap: space(6) }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: "center", gap: space(1) }}>
            <T w="bold" size={34} color={colors.primary}>تحصيل</T>
            <T color={colors.muted}>متابعة فواتير الإنترنت</T>
          </View>
          <Card style={{ gap: space(4) }}>
            <Field
              label="اسم الدخول"
              hint="المدير: البريد الإلكتروني"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              ltr
            />
            <Field
              label="كلمة المرور"
              value={password}
              onChangeText={setPassword}
              secureTextEntry autoCapitalize="none" autoCorrect={false}
              textContentType="password"
              onSubmitEditing={submit}
              returnKeyType="go"
              error={error}
              ltr
            />
            <Button title="دخول" onPress={submit} loading={busy} big />
          </Card>
          <Button title="معتمد جديد؟ أدخل رمز الدعوة" variant="ghost" onPress={() => router.push("/join")} />
          <Button title="دخول كضيف (عرض فقط)" variant="secondary" onPress={guest} disabled={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
