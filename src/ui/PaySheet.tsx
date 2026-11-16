import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { emitDataChanged } from "../lib/bus";
import type { AppError } from "../lib/errors";
import { formatK, parseK } from "../lib/money";
import { monthLabel, today } from "../lib/months";
import { newKey, rpc } from "../lib/rpc";
import { Button, Field, Num, Sheet, T } from "./kit";
import { MoneyField, Options } from "./parts";
import { colors, space } from "./theme";

export type Method = "manager_cash" | "agent_cash" | "shamcash";

export interface PayTarget {
  subscriberId: string;
  name: string;
  month: string;
  remaining: number;
  /** Active agent of the subscriber's area, if any. */
  agentName: string | null;
}

/**
 * Manager records a payment: full (default) or partial, cash to manager, cash
 * held by the area's agent, or Sham Cash with a transfer number.
 */
export function PaySheet({ target, onClose }: { target: PayTarget | null; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("manager_cash");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  useEffect(() => {
    if (target) {
      setAmount(formatK(target.remaining));
      setMethod("manager_cash");
      setReference("");
      setError(null);
      key.current = newKey();
    }
  }, [target]);

  async function save() {
    if (!target) return;
    const v = parseK(amount);
    if (v === null || v <= 0) return setError("مبلغ غير صحيح");
    if (v > target.remaining) return setError(`أكبر من الباقي (${formatK(target.remaining)})`);
    if (method === "shamcash" && !reference.trim()) return setError("رقم عملية شام كاش مطلوب");
    setBusy(true);
    setError(null);
    try {
      await rpc("manager_record_payment", {
        p_subscriber_id: target.subscriberId,
        p_month: target.month,
        p_amount: v,
        p_method: method,
        p_client_key: key.current,
        p_reference: method === "shamcash" ? reference.trim() : null,
        p_paid_on: today(),
        p_notes: null,
      });
      emitDataChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  }

  const methods: [Method, string][] = [["manager_cash", "نقداً للمدير"], ["shamcash", "شام كاش"]];
  if (target?.agentName) methods.splice(1, 0, ["agent_cash", `عند المعتمد ${target.agentName}`]);

  return (
    <Sheet visible={!!target} onClose={() => !busy && onClose()}>
      {target && (
        <>
          <View style={{ gap: 2 }}>
            <T w="bold" size={20}>تسجيل دفعة</T>
            <T color={colors.muted}>{target.name} · {monthLabel(target.month)}</T>
            <T size={14} color={colors.muted}>
              الباقي: <Num w="bold" color={colors.open}>{formatK(target.remaining)}</Num> ألف
            </T>
          </View>
          <MoneyField label="المبلغ" value={amount} onChange={setAmount} hint="اتركه كما هو لدفع الفاتورة كاملة" />
          <Options value={method} options={methods} onChange={setMethod} />
          {method === "shamcash" && <Field label="رقم العملية" value={reference} onChangeText={setReference} autoCapitalize="none" ltr />}
          {error ? <T color={colors.danger}>{error}</T> : null}
          <Button title="حفظ الدفعة" onPress={save} loading={busy} big />
          <Button title="إلغاء" variant="secondary" onPress={onClose} disabled={busy} />
        </>
      )}
    </Sheet>
  );
}
