import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { emitDataChanged } from "../lib/bus";
import type { AppError } from "../lib/errors";
import { useManager } from "../lib/managerContext";
import { formatK } from "../lib/money";
import { monthLabel } from "../lib/months";
import { rpc } from "../lib/rpc";
import { displayName } from "../lib/names";
import { Button, Field, Sheet, T } from "./kit";
import { ToggleRow } from "./parts";
import { colors, space } from "./theme";

const RATE = 50_000;

export function parseSpeedInput(v: string): number | null {
  const n = Number(v.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
}

export function AddSubscriberSheet({ visible, areaId, areaName, onClose }: { visible: boolean; areaId: string; areaName: string; onClose: () => void }) {
  const m = useManager();
  const [name, setName] = useState("");
  const [father, setFather] = useState("");
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [speed, setSpeed] = useState("");
  const [spf, setSpf] = useState(false);
  const [billNow, setBillNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setName(""); setFather(""); setPhone(""); setUsername(""); setSpeed(""); setSpf(false); setBillNow(true); setError(null);
    }
  }, [visible]);

  const mbps = parseSpeedInput(speed);
  const monthOpen = m.months.includes(m.month);

  async function save() {
    if (!name.trim()) return setError("الاسم مطلوب");
    if (!spf && speed.trim() && mbps === null) return setError("السرعة غير صحيحة");
    setBusy(true);
    setError(null);
    try {
      await rpc("add_subscriber", {
        p_area_id: areaId, p_full_name: name, p_father_name: father, p_phone: phone, p_username: username,
        p_speed_mbps: spf ? null : mbps, p_standing_exempt: spf,
      });
      // open_month only issues invoices that are missing, so this bills just the new subscriber.
      if (billNow && monthOpen) await rpc("open_month", { p_month: m.month });
      emitDataChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={() => !busy && onClose()}>
      <ScrollView contentContainerStyle={{ gap: space(3) }} keyboardShouldPersistTaps="handled" style={{ maxHeight: 560 }}>
        <T w="bold" size={20}>مشترك جديد — {areaName}</T>
        <Field label="الاسم والكنية" value={name} onChangeText={setName} hint="مثال: علي عروس" />
        <Field label="اسم الأب" value={father} onChangeText={setFather} hint={name.trim() ? `يظهر هكذا: ${displayName(name, father)}` : undefined} />
        <Field label="اسم المستخدم" value={username} onChangeText={setUsername} autoCapitalize="none" ltr />
        <Field label="الهاتف" value={phone} onChangeText={setPhone} keyboardType="phone-pad" ltr />
        <ToggleRow label="معفى دائماً (SPF)" value={spf} onChange={setSpf} />
        {!spf && (
          <Field
            label="السرعة (ميغا)"
            value={speed}
            onChangeText={setSpeed}
            keyboardType="decimal-pad"
            hint={mbps ? `الفاتورة الشهرية: ${formatK(mbps * RATE)} ألف` : "مثال: 4"}
            ltr
          />
        )}
        {monthOpen && <ToggleRow label={`إصدار فاتورة ${monthLabel(m.month)}`} hint="أطفئه إذا بدأ الاشتراك من الشهر القادم" value={billNow} onChange={setBillNow} />}
        {error ? <T color={colors.danger}>{error}</T> : null}
        <Button title="إضافة" onPress={save} loading={busy} big />
        <Button title="إلغاء" variant="secondary" onPress={onClose} disabled={busy} />
      </ScrollView>
    </Sheet>
  );
}
