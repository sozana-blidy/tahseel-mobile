import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Switch, View } from "react-native";
import { formatK } from "../lib/money";
import { monthLabel } from "../lib/months";
import { Badge, Chip, Field, Num, T } from "./kit";
import { colors, space } from "./theme";

/** Header with a back button (points right — RTL). */
export function Header({ title, subtitle, right, back = true }: { title: string; subtitle?: string; right?: ReactNode; back?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(4), paddingVertical: space(2) }}>
      {back && (
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/manager"))}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="رجوع"
          style={{ padding: space(1) }}
        >
          <Ionicons name="chevron-forward" size={26} color={colors.text} />
        </Pressable>
      )}
      <View style={{ flex: 1 }}>
        <T w="bold" size={20} numberOfLines={1}>{title}</T>
        {subtitle ? <T size={14} color={colors.muted} numberOfLines={1}>{subtitle}</T> : null}
      </View>
      {right}
    </View>
  );
}

export function MonthBar({ months, month, onPick }: { months: string[]; month: string; onPick: (m: string) => void }) {
  if (months.length <= 1) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(2) }}>
      {months.slice(0, 12).map((m) => (
        <Chip key={m} label={monthLabel(m)} active={m === month} onPress={() => onPick(m)} />
      ))}
    </ScrollView>
  );
}

export function Progress({ value, total, color = colors.paid }: { value: number; total: number; color?: string }) {
  const pct = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.neutralSoft, overflow: "hidden" }}>
      <View style={{ width: `${pct * 100}%`, height: 8, backgroundColor: color }} />
    </View>
  );
}

/** Label + amount (in thousands) stacked; used in summary cards. */
export function Stat({ label, amount, color = colors.text, count }: { label: string; amount: number; color?: string; count?: number }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T size={13} color={colors.muted}>{label}{count !== undefined ? ` (${count})` : ""}</T>
      <Num w="bold" size={17} color={color}>{formatK(amount)}</Num>
    </View>
  );
}

export function Options<V extends string>({ value, options, onChange }: { value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
      {options.map(([v, label]) => (
        <Chip key={v} label={label} active={v === value} onPress={() => onChange(v)} />
      ))}
    </View>
  );
}

export function MoneyField({ label, value, onChange, hint, error }: { label: string; value: string; onChange: (v: string) => void; hint?: string; error?: string | null }) {
  return <Field label={`${label} (بالألف)`} value={value} onChangeText={onChange} keyboardType="decimal-pad" hint={hint} error={error} ltr />;
}

export function ToggleRow({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space(3) }}>
      <View style={{ flex: 1 }}>
        <T w="medium">{label}</T>
        {hint ? <T size={13} color={colors.muted}>{hint}</T> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.primary }} />
    </View>
  );
}

export function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space(3), paddingVertical: space(1) }}>
      <T color={colors.muted}>{label}</T>
      {typeof value === "string" || typeof value === "number" ? <T w="medium">{value}</T> : value}
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <T color={colors.muted} style={{ textAlign: "center", marginVertical: space(8) }}>{text}</T>;
}

/** Keep a Latin/number run (dates, codes) in left-to-right order inside an Arabic line. */
export const ltr = (s: string) => `\u2066${s}\u2069`;

export function localTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return ltr(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`);
}

/** «فاتورتين»: this month's invoice also carries a deferred one. */
export function TwoBillsBadge() {
  return <Badge label="فاتورتين" fg={colors.danger} bg={colors.dangerSoft} />;
}

/** The two invoices of one payment, each on its own line, then the total (amounts in thousands). */
export function DueBreakdown({ month, remaining, carriedMonth, carriedAmount }: { month: string; remaining: number; carriedMonth: string | null; carriedAmount: number }) {
  if (!carriedMonth || carriedAmount <= 0) return null;
  return (
    <View style={{ gap: space(1) }}>
      <Line label={`فاتورة ${monthLabel(carriedMonth)} (مؤجلة)`} value={<Num w="medium">{formatK(carriedAmount)}</Num>} />
      {remaining > 0 ? <Line label={`فاتورة ${monthLabel(month)}`} value={<Num w="medium">{formatK(remaining)}</Num>} /> : null}
      <Line label="المجموع" value={<Num w="bold" color={colors.primary}>{formatK(carriedAmount + remaining)}</Num>} />
    </View>
  );
}
