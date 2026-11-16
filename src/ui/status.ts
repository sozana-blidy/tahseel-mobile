import type { DisplayStatus } from "../lib/agentList";
import { colors } from "./theme";

export const STATUS: Record<DisplayStatus, { label: string; fg: string; bg: string }> = {
  paid: { label: "مدفوع", fg: colors.paid, bg: colors.paidSoft },
  sending: { label: "قيد الإرسال", fg: colors.sending, bg: colors.sendingSoft },
  unpaid: { label: "غير مدفوع", fg: colors.open, bg: colors.openSoft },
  exempt: { label: "معفى", fg: colors.muted, bg: colors.neutralSoft },
  no_invoice: { label: "لا فاتورة", fg: colors.muted, bg: colors.neutralSoft },
  no_price: { label: "بدون سعر", fg: colors.danger, bg: colors.dangerSoft },
  disconnected: { label: "مفصول", fg: colors.muted, bg: colors.neutralSoft },
};
