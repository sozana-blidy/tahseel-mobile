import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { emitDataChanged } from "../../../lib/bus";
import type { AppError } from "../../../lib/errors";
import { useManager } from "../../../lib/managerContext";
import { loadSubscriber, loadSubscriberHistory, type HistoryMonth, type Ledger, type SubscriberDetail } from "../../../lib/managerData";
import { formatK } from "../../../lib/money";
import { monthLabel, shiftMonth } from "../../../lib/months";
import { newKey, rpc } from "../../../lib/rpc";
import { amountDue } from "../../../lib/types";
import { useLoad } from "../../../lib/useLoad";
import { displayName } from "../../../lib/names";
import { parseSpeedInput } from "../../../ui/AddSubscriberSheet";
import { Badge, Banner, Button, Card, Field, Num, T } from "../../../ui/kit";
import { ConfirmSheet, ReasonSheet, SheetFrame } from "../../../ui/sheets";
import { PaySheet, type PayTarget } from "../../../ui/PaySheet";
import { DueBreakdown, Header, Line, localTime, ltr, ToggleRow, TwoBillsBadge } from "../../../ui/parts";
import { DeferSheet } from "../../../ui/DeferSheet";
import { STATUS } from "../../../ui/status";
import { colors, space } from "../../../ui/theme";

const METHOD: Record<string, string> = { agent_cash: "نقداً عند المعتمد", manager_cash: "نقداً للمدير", shamcash: "شام كاش" };

export default function SubscriberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const m = useManager();
  const { data, error, loading, refresh } = useLoad(() => loadSubscriber(id, m.month), [id, m.month]);
  // Manager only (this route is under /manager and the function refuses agents). Loaded separately
  // so a failure here never hides the rest of the screen.
  const history = useLoad(() => loadSubscriberHistory(id), [id]);
  const [pay, setPay] = useState<PayTarget | null>(null);
  const [sheet, setSheet] = useState<null | "exempt" | "edit" | "disconnect" | "reconnect" | "cancelDefer" | { defer: string } | { reverse: Ledger; kind: "payment" | "exemption" }>(null);

  if (!data) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Header title="المشترك" />
        {error ? <Banner tone="error" text={error} /> : <T color={colors.muted} style={{ textAlign: "center", marginTop: space(8) }}>جارٍ التحميل…</T>}
      </SafeAreaView>
    );
  }
  const { sub, row } = data;
  const st = row ? STATUS[row.status] : null;
  const due = row ? amountDue(row) : 0;
  const open = !!row && due > 0 && (row.status === "unpaid" || row.carried_amount > 0);
  const canDefer = !!row && row.status === "unpaid" && row.remaining > 0 && !row.deferred_to && row.carried_amount === 0;
  const movements = [
    ...data.payments.map((p) => ({ kind: "payment" as const, l: p })),
    ...data.exemptions.map((e) => ({ kind: "exemption" as const, l: e })),
  ].sort((a, b) => a.l.created_at.localeCompare(b.l.created_at));

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header title={displayName(sub.full_name, sub.father_name)} subtitle={`${data.areaName} · ${sub.code}`} />
      <ScrollView
        contentContainerStyle={{ padding: space(4), paddingTop: 0, gap: space(3), paddingBottom: space(10) }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { refresh(); history.refresh(); }} colors={[colors.primary]} />}
      >
        {error && <Banner tone="error" text={error} />}

        <Card style={{ gap: space(2) }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <T w="bold" size={17}>{monthLabel(m.month)}</T>
            <View style={{ flexDirection: "row", gap: space(2) }}>
              {row && row.carried_amount > 0 ? <TwoBillsBadge /> : null}
              {st && <Badge label={st.label} fg={st.fg} bg={st.bg} />}
            </View>
          </View>
          {row?.deferred_to ? (
            <Banner tone="warn" text={`فاتورة هذا الشهر مؤجّلة إلى ${monthLabel(row.deferred_to)} وتُدفع مع فاتورته. لا يُفصل المشترك خلال التأجيل.`} />
          ) : null}
          {row && row.amount !== null ? (
            <>
              <Line label="الفاتورة" value={<Num w="medium">{formatK(row.amount)}</Num>} />
              <Line label="مدفوع" value={<Num w="medium" color={colors.paid}>{formatK(row.paid)}</Num>} />
              {row.exempt ? <Line label="معفى" value={<Num w="medium">{formatK(row.exempt)}</Num>} /> : null}
              <Line label="الباقي" value={<Num w="bold" color={colors.open}>{formatK(row.remaining)}</Num>} />
            </>
          ) : (
            <T color={colors.muted}>
              {sub.monthly_amount === null ? "لا يوجد سعر — حدّد السرعة من «تعديل»." : sub.status === "disconnected" ? "مفصول — لا فاتورة." : "لا توجد فاتورة لهذا الشهر."}
            </T>
          )}
          {row ? <DueBreakdown month={m.month} remaining={row.remaining} carriedMonth={row.carried_month} carriedAmount={row.carried_amount} /> : null}
          {open && (
            <View style={{ gap: space(2), marginTop: space(1) }}>
              <Button
                title={`تسجيل دفعة · ${formatK(due)} ألف`}
                onPress={() => setPay({ subscriberId: sub.id, name: displayName(sub.full_name, sub.father_name), month: m.month, remaining: row.remaining, carriedMonth: row.carried_month, carriedAmount: row.carried_amount, agentName: data.areaAgent?.full_name ?? null })}
              />
              {canDefer && <Button title="تأجيل إلى الشهر القادم" variant="secondary" onPress={() => setSheet({ defer: newKey() })} />}
              {row.status === "unpaid" && row.remaining > 0 && <Button title="إعفاء هذا الشهر" variant="secondary" onPress={() => setSheet("exempt")} />}
            </View>
          )}
          {row?.deferred_to ? <Button title="إلغاء التأجيل" variant="ghost" onPress={() => setSheet("cancelDefer")} /> : null}
        </Card>

        {movements.length > 0 && (
          <Card style={{ gap: space(3) }}>
            <T w="bold">الحركات</T>
            {movements.map(({ kind, l }) => (
              <Movement key={l.id} kind={kind} l={l} data={data} onReverse={() => setSheet({ reverse: l, kind })} />
            ))}
          </Card>
        )}

        <Card style={{ gap: space(3) }}>
          <T w="bold">سجل آخر 3 أشهر</T>
          {history.error ? <T color={colors.danger}>{history.error}</T> : null}
          {!history.data && !history.error ? <T color={colors.muted}>جارٍ التحميل…</T> : null}
          {history.data?.length === 0 ? <T color={colors.muted}>لا توجد أشهر مفتوحة بعد.</T> : null}
          {history.data?.map((h) => <HistoryRow key={h.month} h={h} />)}
        </Card>

        <Card style={{ gap: space(1) }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: space(1) }}>
            <T w="bold">بيانات المشترك</T>
            <Button title="تعديل" variant="ghost" onPress={() => setSheet("edit")} style={{ minHeight: 36 }} />
          </View>
          {sub.username ? <Line label="اسم المستخدم" value={<Num>{sub.username}</Num>} /> : null}
          {sub.phone ? <Line label="الهاتف" value={<Num>{sub.phone}</Num>} /> : null}
          <Line label="الباقة" value={sub.standing_exempt ? "SPF (معفى)" : sub.package_label ?? "—"} />
          <Line label="الفاتورة الشهرية" value={sub.monthly_amount === null ? "—" : `${formatK(sub.monthly_amount)} ألف`} />
          <Line label="الحالة" value={sub.status === "active" ? "فعّال" : `مفصول من ${monthLabel(sub.disconnected_from ?? "")}`} />
          <Line label="المعتمد" value={data.areaAgent?.full_name ?? "المدير"} />
          {sub.notes ? <Line label="ملاحظات" value={sub.notes} /> : null}
        </Card>

        {sub.status === "active" ? (
          <Button title="فك الاشتراك" variant="secondary" onPress={() => setSheet("disconnect")} />
        ) : (
          <Button title="إعادة تفعيل الاشتراك" variant="secondary" onPress={() => setSheet("reconnect")} />
        )}
      </ScrollView>

      <PaySheet target={pay} onClose={() => setPay(null)} />
      {sheet && typeof sheet === "object" && "defer" in sheet && row && (
        <DeferSheet row={row} month={m.month} clientKey={sheet.defer} onClose={() => setSheet(null)} />
      )}
      {sheet === "cancelDefer" && row && (
        <ConfirmSheet
          title="إلغاء التأجيل"
          body={`تعود فاتورة ${monthLabel(m.month)} مستحقة في شهرها. يمكن التأجيل مرة أخرى لاحقاً.`}
          action="إلغاء التأجيل"
          onClose={() => setSheet(null)}
          run={() => rpc("cancel_deferral", { p_subscriber_id: sub.id, p_month: m.month })}
        />
      )}
      {sheet === "exempt" && row && (
        <ReasonSheet
          title={`إعفاء ${monthLabel(m.month)}`}
          note={`يُعفى المبلغ الباقي (${formatK(row.remaining)} ألف) لهذا الشهر فقط.`}
          action="إعفاء"
          onClose={() => setSheet(null)}
          run={(reason, key) => rpc("set_month_exempt", { p_subscriber_id: sub.id, p_month: m.month, p_reason: reason, p_client_key: key })}
        />
      )}
      {sheet && typeof sheet === "object" && "reverse" in sheet && (
        <ReasonSheet
          title="تصحيح حركة"
          note={`سيُسجَّل قيد عكسي بقيمة ${formatK(sheet.reverse.amount)} ألف. لا يُحذف شيء من السجل.`}
          action="تصحيح"
          danger
          onClose={() => setSheet(null)}
          run={(reason, key) => rpc("manager_reverse", { p_kind: sheet.kind, p_id: sheet.reverse.id, p_reason: reason, p_client_key: key })}
        />
      )}
      {sheet === "edit" && <EditSheet data={data} month={m.month} onClose={() => setSheet(null)} />}
      {sheet === "disconnect" && (
        <ConfirmSheet
          title="فك الاشتراك"
          body={`لن تصدر فواتير لـ ${displayName(sub.full_name, sub.father_name)} اعتباراً من ${monthLabel(shiftMonth(m.month, 1))}. فاتورة ${monthLabel(m.month)} تبقى كما هي (يمكنك إعفاؤها).`}
          action="فك"
          onClose={() => setSheet(null)}
          run={() => rpc("disconnect_subscriber", { p_id: sub.id, p_from_month: shiftMonth(m.month, 1) })}
        />
      )}
      {sheet === "reconnect" && (
        <ConfirmSheet
          title="إعادة التفعيل"
          body="تعود الفواتير من الشهر الذي يصدر بعد الآن. إذا كان الشهر الحالي مفتوحاً تصدر فاتورته فوراً."
          action="إعادة التفعيل"
          onClose={() => setSheet(null)}
          run={async () => {
            await rpc("reconnect_subscriber", { p_id: sub.id });
            if (m.months.includes(m.month)) await rpc("open_month", { p_month: m.month });
          }}
        />
      )}
    </SafeAreaView>
  );
}

function HistoryRow({ h }: { h: HistoryMonth }) {
  const st = STATUS[h.status];
  const via = h.method ? h.method.split(",").map((x) => METHOD[x] ?? x).join(" + ") : null;
  const paidLine = h.paid_at ? [ltr(h.paid_at), via, h.recorded_by].filter(Boolean).join(" · ") : null;
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <T w="medium">{monthLabel(h.month)}</T>
        <Badge label={st.label} fg={st.fg} bg={st.bg} />
      </View>
      {h.invoice_amount !== null ? (
        <T size={13} color={colors.muted}>
          الفاتورة <Num size={13}>{formatK(h.invoice_amount)}</Num> · المدفوع <Num size={13} color={h.paid_amount ? colors.paid : colors.muted}>{formatK(h.paid_amount ?? 0)}</Num>
        </T>
      ) : null}
      {paidLine ? <T size={13} color={colors.muted}>{paidLine}</T> : null}
    </View>
  );
}

function Movement({ kind, l, data, onReverse }: { kind: "payment" | "exemption"; l: Ledger; data: SubscriberDetail; onReverse: () => void }) {
  const isReversal = !!l.reversal_of;
  const reversed = !!l.reversed_by;
  const title = isReversal ? "تصحيح" : kind === "exemption" ? "إعفاء" : METHOD[l.method ?? ""] ?? "دفعة";
  const who = data.names[l.recorded_by] ?? "";
  const detail = [kind === "exemption" ? l.reason : l.notes, l.reference ? `رقم ${l.reference}` : null].filter(Boolean).join(" · ");
  return (
    <View style={{ flexDirection: "row", gap: space(3), alignItems: "center", opacity: reversed ? 0.5 : 1 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <T w="medium" style={reversed ? { textDecorationLine: "line-through" } : null}>{title}</T>
        <T size={13} color={colors.muted}>{who} · {localTime(l.created_at)}</T>
        {detail ? <T size={13} color={colors.muted}>{detail}</T> : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: space(1) }}>
        <Num w="bold" color={l.amount < 0 ? colors.danger : colors.text}>{formatK(l.amount)}</Num>
        {!isReversal && !reversed && (
          <Button title="تصحيح" variant="ghost" onPress={onReverse} style={{ minHeight: 32, paddingHorizontal: space(2) }} />
        )}
        {reversed && <T size={12} color={colors.danger}>مُلغاة</T>}
      </View>
    </View>
  );
}

function EditSheet({ data, month, onClose }: { data: SubscriberDetail; month: string; onClose: () => void }) {
  const s = data.sub;
  const [name, setName] = useState(s.full_name);
  const [father, setFather] = useState(s.father_name ?? "");
  const [phone, setPhone] = useState(s.phone ?? "");
  const [speed, setSpeed] = useState(s.speed_mbps ? String(s.speed_mbps) : "");
  const [spf, setSpf] = useState(s.standing_exempt);
  const [notes, setNotes] = useState(s.notes ?? "");
  const [applyNow, setApplyNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [speed, spf]);
  const mbps = parseSpeedInput(speed);
  const newPrice = spf ? 0 : mbps ? Math.round(mbps * data.pricePerMbps) : s.monthly_amount;
  const touched = !!data.row && (data.row.paid !== 0 || data.row.exempt !== 0);

  async function save() {
    if (!name.trim()) return setError("الاسم مطلوب");
    if (!spf && speed.trim() && mbps === null) return setError("السرعة غير صحيحة");
    setBusy(true);
    try {
      const r = await rpc<{ repriced: boolean }>("update_subscriber", {
        p_id: s.id, p_full_name: name, p_father_name: father, p_phone: phone,
        p_speed_mbps: spf ? null : mbps, p_standing_exempt: spf, p_notes: notes,
        p_apply_month: applyNow ? month : null,
      });
      emitDataChanged();
      onClose();
      if (applyNow && !r.repriced && newPrice !== s.monthly_amount && data.row) {
        // the server refuses to reprice an invoice that already has money on it
        Alert.alert("تم الحفظ", `فاتورة ${monthLabel(month)} لم تتغير لأن عليها دفعات أو إعفاء. السعر الجديد يبدأ من الشهر القادم.`);
      }
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetFrame onClose={onClose} busy={busy}>
      <ScrollView contentContainerStyle={{ gap: space(3) }} keyboardShouldPersistTaps="handled" style={{ maxHeight: 580 }}>
        <T w="bold" size={20}>تعديل المشترك</T>
        <Field label="الاسم والكنية" value={name} onChangeText={setName} hint="مثال: علي عروس" />
        <Field label="اسم الأب" value={father} onChangeText={setFather} hint={name.trim() ? `يظهر هكذا: ${displayName(name, father)}` : undefined} />
        <Field label="الهاتف" value={phone} onChangeText={setPhone} keyboardType="phone-pad" ltr />
        <ToggleRow label="معفى دائماً (SPF)" value={spf} onChange={setSpf} />
        {!spf && (
          <Field
            label="السرعة (ميغا)"
            value={speed}
            onChangeText={setSpeed}
            keyboardType="decimal-pad"
            hint={newPrice !== null ? `الفاتورة الشهرية: ${formatK(newPrice)} ألف` : undefined}
            ltr
          />
        )}
        {data.row && (
          <ToggleRow
            label={`طبّق السعر الجديد على ${monthLabel(month)}`}
            hint={touched ? "على هذا الشهر دفعات/إعفاء — التغيير يبدأ من الشهر القادم" : "وإلا يبدأ من الشهر القادم"}
            value={applyNow && !touched}
            onChange={setApplyNow}
          />
        )}
        <Field label="ملاحظات" value={notes} onChangeText={setNotes} multiline />
        {error ? <T color={colors.danger}>{error}</T> : null}
        <Button title="حفظ" onPress={save} loading={busy} big />
        <Button title="إلغاء" variant="secondary" onPress={onClose} disabled={busy} />
      </ScrollView>
    </SheetFrame>
  );
}
