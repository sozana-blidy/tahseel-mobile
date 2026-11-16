import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { credentialsFileName, credentialsSheet, PASSWORD_WARNING, resetAgentPassword } from "../../../lib/accounts";
import { emitDataChanged } from "../../../lib/bus";
import type { AppError } from "../../../lib/errors";
import { useManager } from "../../../lib/managerContext";
import { loadAgents, loadAgentTx, loadAreas, loadCompensation, type AgentTx } from "../../../lib/managerData";
import { formatK, parseK } from "../../../lib/money";
import { monthLabel, today } from "../../../lib/months";
import { newKey, rpc } from "../../../lib/rpc";
import { shareXlsx } from "../../../lib/share";
import { useLoad } from "../../../lib/useLoad";
import { Banner, Button, Card, Chip, Field, Num, T } from "../../../ui/kit";
import { Header, Line, localTime, MoneyField, MonthBar, Options, Stat } from "../../../ui/parts";
import { ConfirmSheet, ReasonSheet, SheetFrame } from "../../../ui/sheets";
import { colors, space } from "../../../ui/theme";

type TxType = AgentTx["type"];
const TX_LABEL: Record<TxType, string> = { delivery: "تسليم نقدي", deduction: "اقتطاع تعويض من النقد", salary_paid: "تعويض مدفوع منفصلاً" };
const COMP_LABEL = { none: "بدون تعويض", monthly_salary: "راتب شهري", per_invoice: "عن كل فاتورة" } as const;
type Comp = keyof typeof COMP_LABEL;

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const m = useManager();
  const { data, error, loading, refresh } = useLoad(async () => {
    const [agents, comp, tx, areas] = await Promise.all([loadAgents(m.month), loadCompensation(id, m.month), loadAgentTx(id, m.month), loadAreas()]);
    return { agent: agents.find((a) => a.profile.id === id) ?? null, comp, tx, areas };
  }, [id, m.month]);
  const [sheet, setSheet] = useState<null | { tx: TxType; amount: number } | { reverse: AgentTx } | "areas" | "comp" | "toggle" | "password">(null);

  const a = data?.agent;
  if (!a) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Header title="المعتمد" />
        {error ? <Banner tone="error" text={error} /> : <T color={colors.muted} style={{ textAlign: "center", marginTop: space(8) }}>جارٍ التحميل…</T>}
      </SafeAreaView>
    );
  }
  const c = data!.comp;
  const p = a.profile;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header title={p.full_name} subtitle={`${p.username}${p.active ? "" : " · موقوف"}`} />
      <ScrollView
        contentContainerStyle={{ padding: space(4), paddingTop: 0, gap: space(3), paddingBottom: space(10) }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.primary]} />}
      >
        <MonthBar months={m.months} month={m.month} onPick={m.setMonth} />
        {error && <Banner tone="error" text={error} />}

        <Card style={{ gap: space(3) }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <T w="bold" size={17}>النقد — {monthLabel(m.month)}</T>
            <T size={12} color={colors.muted}>بالألف</T>
          </View>
          <View style={{ flexDirection: "row", gap: space(2) }}>
            <Stat label="حصّل" count={a.totals.count} amount={a.totals.collected} color={colors.paid} />
            <Stat label="سلّم" amount={a.totals.delivered} />
            <Stat label="معه" amount={a.totals.holding} color={colors.primary} />
          </View>
          {a.cash.length > 1 &&
            a.cash.map((x) => (
              <Line key={x.area_id} label={x.area_name} value={<T size={14}>حصّل {formatK(x.collected)} · معه <Num w="bold">{formatK(x.holding)}</Num></T>} />
            ))}
          {a.totals.deductions > 0 && <T size={13} color={colors.muted}>اقتُطع من النقد كتعويض: {formatK(a.totals.deductions)}</T>}
          <Button title="تسجيل تسليم نقدي" onPress={() => setSheet({ tx: "delivery", amount: Math.max(0, a.totals.holding) })} disabled={!a.cash.length} />
        </Card>

        <Card style={{ gap: space(1.5) }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <T w="bold" size={17}>التعويض</T>
            <Button title="تعديل" variant="ghost" onPress={() => setSheet("comp")} style={{ minHeight: 34 }} />
          </View>
          <T color={colors.muted}>
            {COMP_LABEL[c.type]}
            {c.type === "monthly_salary" ? ` · ${formatK(c.rate)} ألف` : c.type === "per_invoice" ? ` · ${formatK(c.rate)} ألف × ${c.invoices} فاتورة` : ""}
          </T>
          {c.type !== "none" && (
            <>
              <Line label="المستحق هذا الشهر" value={<Num w="medium">{formatK(c.due)}</Num>} />
              {c.deducted > 0 && <Line label="اقتُطع من النقد" value={<Num>{formatK(c.deducted)}</Num>} />}
              {c.paid_separately > 0 && <Line label="دُفع منفصلاً" value={<Num>{formatK(c.paid_separately)}</Num>} />}
              <Line label="الباقي له" value={<Num w="bold" color={colors.open}>{formatK(c.remaining)}</Num>} />
              {c.remaining > 0 && (
                <View style={{ flexDirection: "row", gap: space(2), marginTop: space(1) }}>
                  <Button title="اقتطاع من النقد" variant="secondary" onPress={() => setSheet({ tx: "deduction", amount: c.remaining })} style={{ flex: 1 }} disabled={!a.cash.length} />
                  <Button title="دفع منفصل" variant="secondary" onPress={() => setSheet({ tx: "salary_paid", amount: c.remaining })} style={{ flex: 1 }} />
                </View>
              )}
            </>
          )}
        </Card>

        {data!.tx.length > 0 && (
          <Card style={{ gap: space(3) }}>
            <T w="bold">الحركات</T>
            {data!.tx.map((t) => {
              const reversed = !!t.reversed_by;
              const areaName = data!.areas.find((x) => x.id === t.area_id)?.name;
              return (
                <View key={t.id} style={{ flexDirection: "row", gap: space(3), alignItems: "center", opacity: reversed ? 0.5 : 1 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T w="medium" style={reversed ? { textDecorationLine: "line-through" } : null}>{t.reversal_of ? "تصحيح" : TX_LABEL[t.type]}</T>
                    <T size={13} color={colors.muted}>{[areaName, localTime(t.created_at), t.notes].filter(Boolean).join(" · ")}</T>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Num w="bold" color={t.amount < 0 ? colors.danger : colors.text}>{formatK(t.amount)}</Num>
                    {!t.reversal_of && !reversed && <Button title="تصحيح" variant="ghost" onPress={() => setSheet({ reverse: t })} style={{ minHeight: 32, paddingHorizontal: space(2) }} />}
                    {reversed && <T size={12} color={colors.danger}>مُلغاة</T>}
                  </View>
                </View>
              );
            })}
          </Card>
        )}

        <Card style={{ gap: space(2) }}>
          <T w="bold">الحساب</T>
          <Line label="المناطق" value={a.areas.map((x) => x.name).join("، ") || "—"} />
          {p.phone ? <Line label="الهاتف" value={<Num>{p.phone}</Num>} /> : null}
          <Button title="تعديل المناطق" variant="secondary" onPress={() => setSheet("areas")} />
          {p.active && <Button title="إعادة تعيين كلمة المرور" variant="secondary" onPress={() => setSheet("password")} />}
          <Button title={p.active ? "إيقاف الحساب" : "إعادة تفعيل الحساب"} variant="ghost" onPress={() => setSheet("toggle")} />
        </Card>
      </ScrollView>

      {sheet && typeof sheet === "object" && "tx" in sheet && (
        <TxSheet agentId={id} type={sheet.tx} defaultAmount={sheet.amount} month={m.month} areas={a.cash.map((x) => ({ id: x.area_id, name: x.area_name, holding: x.holding }))} onClose={() => setSheet(null)} />
      )}
      {sheet && typeof sheet === "object" && "reverse" in sheet && (
        <ReasonSheet
          title="تصحيح حركة"
          note={`سيُسجَّل قيد عكسي بقيمة ${formatK(sheet.reverse.amount)} ألف.`}
          action="تصحيح"
          danger
          onClose={() => setSheet(null)}
          run={(reason, key) => rpc("manager_reverse", { p_kind: "agent_tx", p_id: sheet.reverse.id, p_reason: reason, p_client_key: key })}
        />
      )}
      {sheet === "areas" && <AreasSheet agentId={id} current={a.areas.map((x) => x.id)} all={data!.areas} onClose={() => setSheet(null)} />}
      {sheet === "comp" && <CompSheet agentId={id} type={p.comp_type} amount={p.comp_amount} onClose={() => setSheet(null)} />}
      {sheet === "password" && (
        <ConfirmSheet
          title="إعادة تعيين كلمة المرور"
          body={`تُنشأ كلمة مرور جديدة لـ ${p.full_name} وتتوقف القديمة فوراً. تصلك في ملف Excel — ${PASSWORD_WARNING}.`}
          action="إعادة التعيين"
          onClose={() => setSheet(null)}
          run={async () => {
            const results = await resetAgentPassword(id);
            try {
              await shareXlsx([credentialsSheet(results)], credentialsFileName(), `كلمة مرور ${p.full_name}`);
            } catch {
              // the old password is already gone; retrying simply issues another new one
              throw new Error("تغيّرت كلمة المرور لكن تعذر حفظ الملف — اضغط مرة أخرى لإنشاء كلمة جديدة");
            }
          }}
        />
      )}
      {sheet === "toggle" && (
        <ConfirmSheet
          title={p.active ? "إيقاف الحساب" : "إعادة التفعيل"}
          body={
            p.active
              ? "لن يستطيع الدخول أو تسجيل دفعات، وتُفصل مناطقه عنه (تصبح للمدير). سجل دفعاته يبقى كما هو."
              : "يستطيع الدخول مجدداً. بعد التفعيل اربطه بمناطقه من «تعديل المناطق»."
          }
          action={p.active ? "إيقاف" : "تفعيل"}
          onClose={() => setSheet(null)}
          run={() => rpc("set_agent_active", { p_agent_id: id, p_active: !p.active })}
        />
      )}
    </SafeAreaView>
  );
}

function TxSheet({ agentId, type, defaultAmount, month, areas, onClose }: { agentId: string; type: TxType; defaultAmount: number; month: string; areas: { id: string; name: string; holding: number }[]; onClose: () => void }) {
  const byHolding = [...areas].sort((x, y) => y.holding - x.holding);
  const [amount, setAmount] = useState(defaultAmount > 0 ? formatK(defaultAmount) : "");
  const [areaId, setAreaId] = useState<string | null>(type === "salary_paid" ? null : byHolding[0]?.id ?? null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  useEffect(() => setError(null), [amount, areaId]);

  async function save() {
    const v = parseK(amount);
    if (v === null || v <= 0) return setError("مبلغ غير صحيح");
    if (type !== "salary_paid" && !areaId) return setError("اختر المنطقة");
    setBusy(true);
    try {
      await rpc("record_agent_tx", { p_agent_id: agentId, p_area_id: areaId, p_month: month, p_type: type, p_amount: v, p_client_key: key.current, p_paid_on: today(), p_notes: notes.trim() || null });
      emitDataChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetFrame onClose={onClose} busy={busy}>
      <T w="bold" size={20}>{TX_LABEL[type]}</T>
      <T color={colors.muted}>
        {type === "delivery" ? "المبلغ الذي استلمته من المعتمد نقداً." : type === "deduction" ? "يُخصم التعويض من النقد الذي معه بموافقتك." : "تعويض دفعته له من خارج النقد الذي معه — لا يغيّر ما معه."}
      </T>
      <MoneyField label="المبلغ" value={amount} onChange={setAmount} />
      {type !== "salary_paid" && areas.length > 1 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
          {areas.map((x) => (
            <Chip key={x.id} label={`${x.name} (${formatK(x.holding)})`} active={areaId === x.id} onPress={() => setAreaId(x.id)} />
          ))}
        </View>
      )}
      <Field label="ملاحظة (اختياري)" value={notes} onChangeText={setNotes} />
      {error ? <T color={colors.danger}>{error}</T> : null}
      <Button title="حفظ" onPress={save} loading={busy} big />
      <Button title="إلغاء" variant="secondary" onPress={onClose} disabled={busy} />
    </SheetFrame>
  );
}

function AreasSheet({ agentId, current, all, onClose }: { agentId: string; current: string[]; all: { id: string; name: string; agent_id: string | null; agent_name: string | null }[]; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    try {
      await rpc("set_agent_areas", { p_agent_id: agentId, p_area_ids: picked });
      emitDataChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SheetFrame onClose={onClose} busy={busy}>
      <T w="bold" size={20}>مناطق المعتمد</T>
      <T color={colors.muted}>المعتمد يرى هذه المناطق فقط. المنطقة المرتبطة بمعتمد آخر غير متاحة.</T>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
        {all
          .filter((x) => !x.agent_id || x.agent_id === agentId)
          .map((x) => (
            <Chip key={x.id} label={x.name} active={picked.includes(x.id)} onPress={() => setPicked((p) => (p.includes(x.id) ? p.filter((y) => y !== x.id) : [...p, x.id]))} />
          ))}
      </View>
      {error ? <T color={colors.danger}>{error}</T> : null}
      <Button title="حفظ" onPress={save} loading={busy} big />
      <Button title="إلغاء" variant="secondary" onPress={onClose} disabled={busy} />
    </SheetFrame>
  );
}

function CompSheet({ agentId, type, amount, onClose }: { agentId: string; type: Comp; amount: number; onClose: () => void }) {
  const [t, setT] = useState<Comp>(type);
  const [v, setV] = useState(amount ? formatK(amount) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const amt = t === "none" ? 0 : parseK(v);
    if (amt === null || (t !== "none" && amt <= 0)) return setError("مبلغ غير صحيح");
    setBusy(true);
    try {
      await rpc("set_agent_compensation", { p_agent_id: agentId, p_type: t, p_amount: amt });
      emitDataChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SheetFrame onClose={onClose} busy={busy}>
      <T w="bold" size={20}>تعويض المعتمد</T>
      <Options<Comp> value={t} onChange={setT} options={[["none", "بدون"], ["monthly_salary", "راتب شهري"], ["per_invoice", "عن كل فاتورة"]]} />
      {t !== "none" && <MoneyField label={t === "monthly_salary" ? "الراتب الشهري" : "عن كل فاتورة"} value={v} onChange={setV} />}
      <T size={13} color={colors.muted}>«عن كل فاتورة»: تُحسب الفاتورة مرة واحدة في الشهر الذي اكتمل دفعها فيه عن طريقه. شام كاش للشركة لا يُحسب.</T>
      {error ? <T color={colors.danger}>{error}</T> : null}
      <Button title="حفظ" onPress={save} loading={busy} big />
      <Button title="إلغاء" variant="secondary" onPress={onClose} disabled={busy} />
    </SheetFrame>
  );
}
