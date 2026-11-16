import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { colors, font, radius, space } from "./theme";

type Weight = "regular" | "medium" | "bold";

export function T({ w = "regular", size = 16, color = colors.text, style, ...rest }: TextProps & { w?: Weight; size?: number; color?: string }) {
  return <Text {...rest} style={[{ fontFamily: font[w], fontSize: size, color, lineHeight: Math.round(size * 1.5) }, style]} />;
}

/** Numbers and Latin ids keep left-to-right order inside Arabic lines. */
export function Num({ children, style, ...rest }: TextProps & { w?: Weight; size?: number; color?: string; children: ReactNode }) {
  return (
    <T {...rest} style={[{ writingDirection: "ltr" }, style as StyleProp<TextStyle>]}>
      {children}
    </T>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

type Variant = "primary" | "secondary" | "danger" | "ghost";

export function Button({
  title,
  onPress,
  variant = "primary",
  loading,
  disabled,
  style,
  big,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  big?: boolean;
}) {
  const v = VARIANTS[variant];
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [s.btn, big && s.btnBig, { backgroundColor: v.bg, borderColor: v.border, opacity: off ? 0.55 : pressed ? 0.8 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={v.fg} /> : <T w="bold" size={big ? 18 : 16} color={v.fg}>{title}</T>}
    </Pressable>
  );
}

const VARIANTS: Record<Variant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.primary, fg: colors.primaryText, border: colors.primary },
  secondary: { bg: colors.card, fg: colors.primary, border: colors.primary },
  danger: { bg: colors.danger, fg: "#fff", border: colors.danger },
  ghost: { bg: "transparent", fg: colors.primary, border: "transparent" },
};

export function Field({ label, hint, error, style, ltr, ...rest }: TextInputProps & { label: string; hint?: string; error?: string | null; ltr?: boolean }) {
  return (
    <View style={{ gap: space(1.5) }}>
      <T w="medium" size={15}>{label}</T>
      <TextInput
        placeholderTextColor={colors.muted}
        {...rest}
        style={[s.input, ltr && { writingDirection: "ltr" }, error ? { borderColor: colors.danger } : null, style]}
      />
      {error ? <T size={14} color={colors.danger}>{error}</T> : hint ? <T size={13} color={colors.muted}>{hint}</T> : null}
    </View>
  );
}

export function Badge({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <T w="bold" size={13} color={fg}>{label}</T>
    </View>
  );
}

export function Banner({ text, tone = "info", action }: { text: string; tone?: "info" | "warn" | "error"; action?: ReactNode }) {
  const c = tone === "error" ? [colors.danger, colors.dangerSoft] : tone === "warn" ? [colors.open, colors.openSoft] : [colors.sending, colors.sendingSoft];
  return (
    <View style={[s.banner, { backgroundColor: c[1] }]}>
      <T size={14} color={c[0]} style={{ flex: 1 }}>{text}</T>
      {action}
    </View>
  );
}

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[s.chip, active ? { backgroundColor: colors.primary, borderColor: colors.primary } : null]}
    >
      <T w={active ? "bold" : "medium"} size={14} color={active ? "#fff" : colors.text}>{label}</T>
    </Pressable>
  );
}

/** Bottom sheet used for every irreversible confirmation. */
export function Sheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="إغلاق" />
      <View style={s.sheet}>{children}</View>
    </Modal>
  );
}

export const s = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius, padding: space(4), borderWidth: 1, borderColor: colors.line },
  btn: { minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: space(4), borderWidth: 1.5 },
  btnBig: { minHeight: 56 },
  input: {
    minHeight: 52,
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: space(3.5),
    fontFamily: font.regular,
    fontSize: 17,
    color: colors.text,
    backgroundColor: colors.card,
  },
  badge: { paddingHorizontal: space(2.5), paddingVertical: space(0.5), borderRadius: 999, alignSelf: "flex-start" },
  banner: { flexDirection: "row", alignItems: "center", gap: space(2), padding: space(3), borderRadius: 12 },
  chip: { paddingHorizontal: space(3.5), minHeight: 38, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: space(5), paddingBottom: space(8), gap: space(4) },
});
