/**
 * Agent "تم الدفع" outbox. Village networks drop often, so a confirmed tap is
 * saved on the phone first and sent until the server answers. Safe to resend:
 * the server de-duplicates by clientKey (agent_mark_paid is idempotent).
 *
 * Pure logic (no React Native imports) so it is unit-tested with a fake store.
 */
export interface PendingPayment {
  clientKey: string;
  subscriberId: string;
  month: string;
  name: string;
  areaName: string;
  amount: number;
  createdAt: string;
  state: "pending" | "failed";
  /** Final server answer when state = failed (e.g. «مدفوع مسبقاً»). */
  error?: string;
  attempts: number;
}

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export type SendResult = { ok: true } | { ok: false; retry: boolean; message: string };
export type Sender = (p: PendingPayment) => Promise<SendResult>;

export class PaymentQueue {
  private items: PendingPayment[] = [];
  private loaded = false;
  private flushing: Promise<number> | null = null;
  private listeners = new Set<(items: PendingPayment[]) => void>();

  constructor(private store: KeyValueStore, private storageKey: string, private send: Sender) {}

  async load(): Promise<PendingPayment[]> {
    if (!this.loaded) {
      try {
        const raw = await this.store.getItem(this.storageKey);
        const parsed = raw ? JSON.parse(raw) : [];
        this.items = Array.isArray(parsed) ? parsed : [];
      } catch {
        this.items = [];
      }
      this.loaded = true;
      this.emit();
    }
    return this.items;
  }

  list(): PendingPayment[] {
    return this.items;
  }

  subscribe(fn: (items: PendingPayment[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.items);
    return () => this.listeners.delete(fn);
  }

  /** Save first, then try to send. Refuses a second live entry for the same invoice. */
  async add(p: Omit<PendingPayment, "state" | "attempts" | "createdAt">): Promise<PendingPayment> {
    await this.load();
    const dup = this.items.find((x) => x.subscriberId === p.subscriberId && x.month === p.month && x.state === "pending");
    if (dup) return dup;
    const item: PendingPayment = { ...p, state: "pending", attempts: 0, createdAt: new Date().toISOString() };
    this.items = [...this.items, item];
    await this.persist();
    return item;
  }

  /** Send every pending item in order. Returns how many were accepted by the server. Concurrent calls share one run. */
  flush(): Promise<number> {
    if (!this.flushing) {
      this.flushing = this.runFlush().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async runFlush(): Promise<number> {
    await this.load();
    let sent = 0;
    for (const item of this.items.filter((x) => x.state === "pending")) {
      let res: SendResult;
      try {
        res = await this.send(item);
      } catch (e) {
        res = { ok: false, retry: true, message: String(e) };
      }
      if (res.ok) {
        this.items = this.items.filter((x) => x.clientKey !== item.clientKey);
        sent++;
      } else if (res.retry) {
        this.items = this.items.map((x) => (x.clientKey === item.clientKey ? { ...x, attempts: x.attempts + 1 } : x));
        await this.persist();
        break; // network is down — stop and keep the order for next time
      } else {
        this.items = this.items.map((x) =>
          x.clientKey === item.clientKey ? { ...x, state: "failed", error: res.message, attempts: x.attempts + 1 } : x,
        );
      }
      await this.persist();
    }
    return sent;
  }

  /** Agent acknowledged a failed item (only failed items can be removed). */
  async dismiss(clientKey: string): Promise<void> {
    await this.load();
    this.items = this.items.filter((x) => !(x.clientKey === clientKey && x.state === "failed"));
    await this.persist();
  }

  pendingCount(): number {
    return this.items.filter((x) => x.state === "pending").length;
  }

  private async persist() {
    await this.store.setItem(this.storageKey, JSON.stringify(this.items));
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l(this.items);
  }
}
