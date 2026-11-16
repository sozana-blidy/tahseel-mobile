import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable } from "react-native";
import { MODE_LABEL, type AutomationMode } from "../lib/automation";
import { Badge } from "./kit";
import { colors, space } from "./theme";

export function IconBtn({ name, label, onPress }: { name: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label} style={{ padding: space(1.5) }}>
      <Ionicons name={name} size={24} color={colors.primary} />
    </Pressable>
  );
}

export function ModeBadge({ mode }: { mode: AutomationMode }) {
  const [fg, bg] = mode === "live" ? [colors.danger, colors.dangerSoft] : mode === "dry_run" ? [colors.sending, colors.sendingSoft] : [colors.muted, colors.neutralSoft];
  return <Badge label={`الوضع: ${MODE_LABEL[mode] ?? mode}`} fg={fg} bg={bg} />;
}
