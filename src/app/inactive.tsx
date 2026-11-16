import { router } from "expo-router";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../lib/auth";
import { Button, Card, T } from "../ui/kit";
import { colors, space } from "../ui/theme";

/** Signed in, but no active profile: never claimed an invite, disabled, or offline on first launch. */
export default function Inactive() {
  const { profileError, reloadProfile, signOut } = useAuth();
  return (
    <SafeAreaView style={{ flex: 1, justifyContent: "center", padding: space(5) }}>
      <Card style={{ gap: space(4) }}>
        <T w="bold" size={20}>{profileError ? "تعذر الاتصال بالخادم" : "الحساب غير مفعّل"}</T>
        <T color={colors.muted}>
          {profileError
            ? profileError
            : "هذا الحساب غير مرتبط بأي منطقة بعد، أو أوقفه المدير. إذا كان معك رمز دعوة أدخله الآن."}
        </T>
        <View style={{ gap: space(2) }}>
          {profileError ? (
            <Button title="إعادة المحاولة" onPress={reloadProfile} big />
          ) : (
            <Button title="أدخل رمز الدعوة" onPress={() => router.push("/join")} big />
          )}
          <Button title="تسجيل الخروج" variant="secondary" onPress={signOut} />
        </View>
      </Card>
    </SafeAreaView>
  );
}
