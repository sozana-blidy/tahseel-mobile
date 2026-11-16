import { formatK } from "../lib/money";
import { monthLabel } from "../lib/months";
import { rpc } from "../lib/rpc";
import type { SubscriberRow } from "../lib/types";
import { ConfirmSheet } from "./sheets";

/** «تأجيل»: this month's unpaid invoice moves to next month and is paid together with it. */
export function DeferSheet({ row, month, clientKey, onClose }: { row: SubscriberRow; month: string; clientKey: string; onClose: () => void }) {
  return (
    <ConfirmSheet
      title={`تأجيل فاتورة ${monthLabel(month)}`}
      body={`تُؤجَّل فاتورة ${row.display_name} (${formatK(row.remaining)} ألف) إلى الشهر القادم وتُدفع مع فاتورته دفعة واحدة. شهر واحد فقط — ولا يُفصل المشترك خلال التأجيل.`}
      action="تأجيل"
      onClose={onClose}
      run={() => rpc("defer_invoice", { p_subscriber_id: row.id, p_month: month, p_client_key: clientKey })}
    />
  );
}
