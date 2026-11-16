import Ionicons from "@expo/vector-icons/Ionicons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { buildSearchable, scoreMatch } from "../../../lib/arabic";
import { useManager } from "../../../lib/managerContext";
import { loadAreaRows, loadAreas } from "../../../lib/managerData";
import { formatK } from "../../../lib/money";
import { monthLabel } from "../../../lib/months";
import { buildMonthReport } from "../../../lib/report";
import { shareXlsx } from "../../../lib/share";
import type { AppError } from "../../../lib/errors";
import type { RowStatus, SubscriberRow } from "../../../lib/types";
import { useLoad } from "../../../lib/useLoad";
import { AddSubscriberSheet } from "../../../ui/AddSubscriberSheet";
import { Badge, Banner, Card, Chip, Num, T, s as kit } from "../../../ui/kit";
import { PaySheet, type PayTarget } from "../../../ui/PaySheet";
import { Empty, Header, Progress } from "../../../ui/parts";
import { STATUS } from "../../../ui/status";
import { colors, font, space } from "../../../ui/theme";

type Filter = "open" | "paid" | "exempt" | "other" | "all";
const IN: Record<Filter, RowStatus[] | null> = {
  open: ["unpaid"],
  paid: ["paid"],
  exempt: ["exempt"],
  other: ["no_invoice", "no_price", "disconnected"],
  all: null,
};

export default function AreaScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const m = useManager();
  const { data, error, loading, refresh } = useLoad(async () => {
    const [rows, areas] = await Promise.all([loadAreaRows(m.month, id), loadAreas()]);
    return { rows, area: areas.find((a) => a.id === id) ?? null };
  }, [m.month, id]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("open");
  const [pay, setPay] = useState<PayTarget | null>(null);
  const [adding, setAdding] = useState(false);

  const [exporting, setExporting] = useState(false);
  async function exportArea() {
    setExporting(true);
    try {
      const r = await buildMonthReport(m.month, id);
      await shareXlsx(r.sheets, r.fileName, `${data?.area?.name ?? ""} — ${monthLabel(m.month)}`);
    } catch (e) {
      Alert.alert("تعذر التصدير", (e as AppError).message ?? "");
    } finally {
      setExporting(false);
    }
  }

  const rows = data?.rows ?? [];
  const agent = data?.area?.agent_id ? { full_name: data.area.agent_name ?? "" } : null;
  const indexed = useMemo(
    () => rows.map((r) => ({ r, s: buildSearchable({ fullName: r.display_name, fatherName: r.father_name ?? "", username: r.username ?? "", code: r.code, phone: r.phone ?? "" }) })),
    [rows],
  );
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { open: 0, paid: 0, exempt: 0, other: 0, all: rows.length };
    for (const r of rows) for (const f of ["open", "paid", "exempt", "other"] as Filter[]) if (IN[f]!.includes(r.status)) c[f]++;
    return c;
  }, [rows]);
  const visible = useMemo(() => {
    if (query.trim())
      return indexed
        .map((x) => ({ r: x.r, sc: scoreMatch(query, x.s) }))
        .filter((x) => x.sc > 0)
        .sort((a, b) => b.sc - a.sc)
        .map((x) => x.r);
    const allowed = IN[filter];
    return allowed ? rows.filter((r) => allowed.includes(r.status)) : rows;
  }, [indexed, rows, query, filter]);
  const t = rows.reduce((a, r) => ({ exp: a.exp + (r.amount ?? 0), paid: a.paid + r.paid, ex: a.ex + r.exempt, rem: a.rem + r.remaining }), { exp: 0, paid: 0, ex: 0, rem: 0 });
  const areaName = data?.area?.name ?? name ?? "";

  const header = (
    <View style={{ gap: space(3), paddingBottom: space(2) }}>
      <Card style={{ gap: space(2) }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <T color={colors.muted}>مدفوع {formatK(t.paid)} من {formatK(t.exp)}</T>
          <T w="bold" color={colors.open}>باقي {formatK(t.rem)}</T>
        </View>
        <Progress value={t.paid + t.ex} total={t.exp} />
        <T size={13} color={colors.muted}>{agent ? `المعتمد: ${agent.full_name}` : "بدون معتمد — يجمعها المدير"} · المبالغ بالألف</T>
      </Card>
      {error && <Banner tone="error" text={error} />}
      <View style={[kit.input, { flexDirection: "row", alignItems: "center", paddingHorizontal: space(3) }]}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="ابحث بالاسم أو اسم المستخدم أو الهاتف"
          placeholderTextColor={colors.muted}
          style={{ flex: 1, fontFamily: font.regular, fontSize: 17, color: colors.text, paddingVertical: space(2) }}
          autoCorrect={false}
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} hitSlop={12} accessibilityLabel="مسح البحث">
            <T size={20} color={colors.muted}>✕</T>
          </Pressable>
        ) : undefined}
      </View>
      {!query && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
          <Chip label={`غير مدفوع (${counts.open})`} active={filter === "open"} onPress={() => setFilter("open")} />
          <Chip label={`مدفوع (${counts.paid})`} active={filter === "paid"} onPress={() => setFilter("paid")} />
          <Chip label={`معفى (${counts.exempt})`} active={filter === "exempt"} onPress={() => setFilter("exempt")} />
          {counts.other > 0 && <Chip label={`أخرى (${counts.other})`} active={filter === "other"} onPress={() => setFilter("other")} />}
          <Chip label={`الكل (${counts.all})`} active={filter === "all"} onPress={() => setFilter("all")} />
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header
        title={areaName}
        subtitle={monthLabel(m.month)}
        right={
          <View style={{ flexDirection: "row", gap: space(3) }}>
            <Pressable onPress={exportArea} hitSlop={10} accessibilityLabel="تصدير Excel" style={{ padding: space(1) }} disabled={exporting}>
              <Ionicons name={exporting ? "hourglass-outline" : "share-outline"} size={24} color={colors.primary} />
            </Pressable>
            <Pressable onPress={() => setAdding(true)} hitSlop={10} accessibilityLabel="إضافة مشترك" style={{ padding: space(1) }}>
              <Ionicons name="person-add-outline" size={24} color={colors.primary} />
            </Pressable>
          </View>
        }
      />
      <FlatList
        data={visible}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: space(4), paddingTop: 0, gap: space(2) }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.primary]} />}
        ListEmptyComponent={data ? <Empty text={query ? "لا نتائج" : "لا يوجد"} /> : undefined}
        initialNumToRender={20}
        renderItem={({ item }) => (
          <SubRow
            row={item}
            onOpen={() => router.push({ pathname: "/manager/subscriber/[id]", params: { id: item.id } })}
            onPay={() => setPay({ subscriberId: item.id, name: item.display_name, month: m.month, remaining: item.remaining, agentName: agent?.full_name ?? null })}
          />
        )}
      />
      <PaySheet target={pay} onClose={() => setPay(null)} />
      <AddSubscriberSheet visible={adding} areaId={id} areaName={areaName} onClose={() => setAdding(false)} />
    </SafeAreaView>
  );
}

const VIA: Record<string, string> = { agent_cash: "عبر المعتمد", shamcash: "عبر شام كاش", manager_cash: "نقداً للمدير" };
const viaLabel = (v: string | null) => (v ? v.split(",").map((m) => VIA[m] ?? m).join(" + ") : null);

function SubRow({ row, onOpen, onPay }: { row: SubscriberRow; onOpen: () => void; onPay: () => void }) {
  const st = STATUS[row.status];
  const info = [row.package_label, row.username].filter(Boolean).join(" \u200F· ");
  const canPay = row.status === "unpaid" && row.remaining > 0;
  return (
    <Pressable onPress={onOpen} accessibilityRole="button">
      <Card style={{ padding: space(3.5), flexDirection: "row", alignItems: "center", gap: space(3) }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T w="bold" size={17}>{row.display_name}</T>
          {info ? <T size={14} color={colors.muted}>{info}</T> : undefined}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), marginTop: 2 }}>
            <Badge label={st.label} fg={st.fg} bg={st.bg} />
            {row.status === "paid" && viaLabel(row.paid_via) ? (
              <T size={12} color={row.paid_via === "shamcash" ? colors.sending : colors.muted}>{viaLabel(row.paid_via)}</T>
            ) : undefined}
          </View>
        </View>
        <View style={{ alignItems: "flex-end", gap: space(1.5) }}>
          {row.amount !== null && <Num w="medium">{formatK(row.status === "unpaid" ? row.remaining : row.amount)}</Num>}
          {canPay && (
            <Pressable onPress={onPay} hitSlop={6} style={{ backgroundColor: colors.primarySoft, borderRadius: 10, paddingHorizontal: space(3), paddingVertical: space(1.5) }}>
              <T w="bold" size={14} color={colors.primary}>دفع</T>
            </Pressable>
          )}
        </View>
      </Card>
    </Pressable>
  );
}
