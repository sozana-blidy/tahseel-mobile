/** Which late-payment rows to show as phone notifications — pure (unit-tested). */

export interface LateRow {
  id: number;
  title: string;
  body: string;
}

/**
 * lastId = highest notification id already handled on this phone (null = first run).
 * First run shows nothing and starts from the newest row (no replay of old alerts).
 * Each id is shown once; ids are handled in increasing order.
 */
export function planLateAlerts(lastId: number | null, newestId: number | null, rows: LateRow[]): { show: LateRow[]; nextLastId: number | null } {
  if (lastId === null) return { show: [], nextLastId: newestId ?? 0 };
  const show = rows.filter((r) => r.id > lastId).sort((a, b) => a.id - b.id);
  return { show, nextLastId: show.length ? show[show.length - 1].id : lastId };
}
