export type Month = string;

const AR_MONTHS = [
  "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران",
  "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول",
];

export function currentMonth(d = new Date()): Month {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(m: Month, delta: number): Month {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return currentMonth(d);
}

export function monthLabel(m: Month): string {
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return m;
  return `${AR_MONTHS[mo - 1]} ${y}`;
}

export function isValidMonth(m: string): m is Month {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}
