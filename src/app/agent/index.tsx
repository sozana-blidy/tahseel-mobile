import { randomUUID } from "expo-crypto";
import { useCallback, useMemo, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams } from "expo-router";
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { filterRows, toDisplayRows, totals, type DisplayRow, type ListFilter } from "../../lib/agentList";
import { useAuth } from "../../lib/auth";
import { formatK } from "../../lib/money";
import { monthLabel } from "../../lib/months";
import { outboxFor, useOutbox } from "../../lib/outbox";
import { useAgentData } from "../../lib/useAgentData";
import { unpaidSheet } from "../../lib/agentExport";
import type { AppError } from "../../lib/errors";
import { shareXlsx } from "../../lib/share";
import { Badge, Banner, Button, Card, Chip, Num, Sheet, T, s as kit } from "../../ui/kit";
import { STATUS } from "../../ui/status";
import { colors, font, space } from "../../ui/theme";

const k = (v: number) => `${formatK(v)} ألف`;

export default function AgentHome() {
  const { profile, session, signOut } = useAuth();
  const uid = session?.user.id;
  const data = useAgentData(uid);
  const outbox = useOutbox(uid, data.refresh);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ListFilter>("unpaid");
  const [areaId, setAreaId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<DisplayRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const params = useLocalSearchParams<{ export?: string }>();
  const fromReminder = params.export === "1";

  async function exportUnpaid() {
    if (!data.rows || !data.month) return;
    setExporting(true);
    try {
      const x = unpaidSheet(data.rows, profile?.full_name ?? "المعتمد", data.month);
      await shareXlsx(x.sheets, x.fileName, x.message);
    } catch (e) {
      Alert.alert("تعذر التصدير", (e as AppError).message ?? "");
    } finally {
      setExporting(false);
    }
  }

  const rows = useMemo(() => (data.rows && data.month ? toDisplayRows(data.rows, outbox, data.month) : []), [data.rows, outbox, data.month]);
  const areas = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.area_id, r.area_name);
    return [...m.entries()];
  }, [rows]);
  const scoped = areaId ? rows.filter((r) => r.area_id === areaId) : rows;
  const t = useMemo(() => totals(scoped), [scoped]);
  const visible = useMemo(() => filterRows(rows, query, filter, areaId), [rows, query, filter, areaId]);
  const pending = outbox.filter((p) => p.state === "pending");
  const failed = outbox.filter((p) => p.state === "failed");

  const confirmPaid = useCallback(async () => {
    if (!confirmRow || !uid || !data.month) return;
    setSaving(true);
    const q = outboxFor(uid);
    await q.add({
      clientKey: randomUUID(),
      subscriberId: confirmRow.id,
      month: data.month,
      name: confirmRow.display_name,
      areaName: confirmRow.area_name,
      amount: confirmRow.due,
    });
    setSaving(false);
    setConfirmRow(null);
    setQuery("");
    const refresh = data.refresh;
    q.flush().then((n) => {
      if (n > 0) refresh();
    });
  }, [confirmRow, uid, data.month, data.refresh]);

  function askSignOut() {
    const msg = pending.length
      ? `لديك ${pending.length} دفعة لم تُرسل بعد. ستبقى محفوظة على هذا الهاتف وتُرسل عند دخولك مرة أخرى.`
      : "هل تريد تسجيل الخروج؟";
    Alert.alert("تسجيل الخروج", msg, [
      { text: "إلغاء", style: "cancel" },
      { text: "خروج", style: "destructive", onPress: signOut },
    ]);
  }

  const header = (
    <View style={{ gap: space(3), paddingBottom: space(2) }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flex: 1 }}>
          <T w="bold" size={22}>{profile?.full_name}</T>
          <T color={colors.muted} numberOfLines={1}>{areas.map((a) => a[1]).join("، ") || "—"}</T>
        </View>
        <Pressable onPress={exportUnpaid} hitSlop={10} accessibilityRole="button" accessibilityLabel="تصدير غير المدفوعين" style={{ padding: space(2) }} disabled={exporting || !data.rows}>
          <Ionicons name={exporting ? "hourglass-outline" : "share-outline"} size={24} color={colors.primary} />
        </Pressable>
        <Pressable onPress={askSignOut} hitSlop={12} accessibilityRole="button" style={{ padding: space(2) }}>
          <T w="medium" color={colors.primary}>خروج</T>
        </Pressable>
      </View>

      {fromReminder && (
        <Banner
          text={`تذكير يوم 4: أرسل قائمة غير المدفوعين (${t.openCount}) للمدير`}
          action={<Button title="تصدير" onPress={exportUnpaid} loading={exporting} style={{ minHeight: 38 }} />}
        />
      )}

      {data.months.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(2) }}>
          {data.months.slice(0, 6).map((m) => (
            <Chip key={m} label={monthLabel(m)} active={m === data.month} onPress={() => data.selectMonth(m)} />
          ))}
        </ScrollView>
      )}

      <Card style={{ gap: space(3) }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
          <T w="bold" size={17}>{data.month ? monthLabel(data.month) : "لا يوجد شهر مفتوح"}</T>
          <T size={12} color={colors.muted}>المبالغ بالألف ل.س</T>
        </View>
        <View style={{ flexDirection: "row", gap: space(3) }}>
          <Stat label="دفعوا" count={t.collectedCount} amount={t.collected} color={colors.paid} />
          <Stat label="باقي" count={t.openCount} amount={t.open} color={colors.open} />
          <Stat label="معك" amount={data.cash.holding} color={colors.primary} />
        </View>
      </Card>

      {data.offline && (
        <Banner tone="warn" text={`بدون اتصال — القائمة من آخر تحديث${data.updatedAt ? ` (${timeAgo(data.updatedAt)})` : ""}. يمكنك متابعة التحصيل وستُرسل الدفعات تلقائياً.`} />
      )}
      {!data.offline && data.error && <Banner tone="error" text={data.error} />}
      {pending.length > 0 && <Banner text={`${pending.length} دفعة بانتظار الإرسال — تُرسل تلقائياً عند توفر الشبكة`} />}
      {failed.map((f) => (
        <Banner
          key={f.clientKey}
          tone="error"
          text={`${f.name}: ${f.error ?? "لم تُقبل"}`}
          action={
            <Pressable onPress={() => outboxFor(uid!).dismiss(f.clientKey)} hitSlop={10}>
              <T w="bold" color={colors.danger}>حسناً</T>
            </Pressable>
          }
        />
      ))}

      <View style={[kit.input, { flexDirection: "row", alignItems: "center", paddingHorizontal: space(3) }]}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="ابحث بالاسم أو اسم المستخدم أو الهاتف"
          placeholderTextColor={colors.muted}
          style={{ flex: 1, fontFamily: font.regular, fontSize: 17, color: colors.text, paddingVertical: space(2) }}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="بحث"
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} hitSlop={12} accessibilityLabel="مسح البحث">
            <T size={20} color={colors.muted}>✕</T>
          </Pressable>
        ) : null}
      </View>

      {!query && (
        <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
          <Chip label={`غير مدفوع (${t.openCount})`} active={filter === "unpaid"} onPress={() => setFilter("unpaid")} />
          <Chip label={`مدفوع (${t.collectedCount})`} active={filter === "paid"} onPress={() => setFilter("paid")} />
          <Chip label="الكل" active={filter === "all"} onPress={() => setFilter("all")} />
        </View>
      )}
      {areas.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(2) }}>
          <Chip label="كل المناطق" active={!areaId} onPress={() => setAreaId(null)} />
          {areas.map(([id, name]) => (
            <Chip key={id} label={name} active={areaId === id} onPress={() => setAreaId(id)} />
          ))}
        </ScrollView>
      )}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <FlatList
        data={visible}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: space(4), paddingBottom: space(10), gap: space(2) }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={data.refresh} colors={[colors.primary]} />}
        renderItem={({ item }) => <Row row={item} showArea={areas.length > 1 && !areaId} onPay={() => setConfirmRow(item)} />}
        ListEmptyComponent={
          data.rows === null ? (
            <T color={colors.muted} style={{ textAlign: "center", marginTop: space(8) }}>جارٍ التحميل…</T>
          ) : (
            <T color={colors.muted} style={{ textAlign: "center", marginTop: space(8) }}>
              {query ? "لا يوجد مشترك بهذا الاسم في منطقتك" : filter === "unpaid" ? "الكل دفع 🎉" : "لا يوجد"}
            </T>
          )
        }
        initialNumToRender={20}
        windowSize={10}
      />

      <Sheet visible={!!confirmRow} onClose={() => !saving && setConfirmRow(null)}>
        {confirmRow && (
          <>
            <T w="bold" size={20}>تأكيد استلام الدفعة</T>
            <View style={{ backgroundColor: colors.primarySoft, borderRadius: 14, padding: space(4), gap: space(1) }}>
              <T w="bold" size={20}>{confirmRow.display_name}</T>
              <T color={colors.muted}>{confirmRow.area_name}{confirmRow.package_label ? ` · ${confirmRow.package_label}` : ""}</T>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: space(2), marginTop: space(2) }}>
                <Num w="bold" size={32} color={colors.primary}>{formatK(confirmRow.due)}</Num>
                <T color={colors.muted}>ألف ل.س</T>
              </View>
            </View>
            <T size={14} color={colors.danger}>بعد التأكيد لا يمكنك التعديل أو التراجع. أي تصحيح يتم عن طريق المدير فقط.</T>
            <Button title="تأكيد — تم الدفع" onPress={confirmPaid} loading={saving} big />
            <Button title="إلغاء" variant="secondary" onPress={() => setConfirmRow(null)} disabled={saving} />
          </>
        )}
      </Sheet>
    </SafeAreaView>
  );
}

function Stat({ label, count, amount, color }: { label: string; count?: number; amount: number; color: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T size={13} color={colors.muted}>{label}{count !== undefined ? ` (${count})` : ""}</T>
      <Num w="bold" size={18} color={color}>{formatK(amount)}</Num>
    </View>
  );
}

function Row({ row, showArea, onPay }: { row: DisplayRow; showArea: boolean; onPay: () => void }) {
  const st = STATUS[row.display];
  // Arabic first so the whole line aligns right; the Latin username rides along at the end.
  const sub = [row.package_label, showArea ? row.area_name : null, row.username].filter(Boolean).join(" \u200F· "); // RLM keeps Latin parts in Arabic order
  return (
    <Card style={{ padding: space(3.5), gap: space(2.5) }}>
      <View style={{ flexDirection: "row", gap: space(3), alignItems: "flex-start" }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T w="bold" size={17}>{row.display_name}</T>
          {sub ? <T size={14} color={colors.muted}>{sub}</T> : null}
        </View>
        <View style={{ alignItems: "flex-end", gap: space(1) }}>
          <Badge label={st.label} fg={st.fg} bg={st.bg} />
          {row.amount !== null && row.amount > 0 && <Num w="medium" size={15}>{formatK(row.display === "unpaid" ? row.remaining : row.amount)}</Num>}
        </View>
      </View>
      {row.canMark && <Button title={`تم الدفع · ${k(row.due)}`} onPress={onPay} />}
    </Card>
  );
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `قبل ${mins} دقيقة`;
  const h = Math.round(mins / 60);
  if (h < 24) return `قبل ${h} ساعة`;
  return `قبل ${Math.round(h / 24)} يوم`;
}
