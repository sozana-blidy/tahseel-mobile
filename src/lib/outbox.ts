import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { classifyError } from "./errors";
import { PaymentQueue, type PendingPayment } from "./paymentQueue";
import { supabase } from "./supabase";

const queues = new Map<string, PaymentQueue>();

/** One outbox per signed-in user, stored on the phone. */
export function outboxFor(userId: string): PaymentQueue {
  let q = queues.get(userId);
  if (!q) {
    q = new PaymentQueue(AsyncStorage, `tahseel.outbox.v1:${userId}`, async (p) => {
      const { error } = await supabase.rpc("agent_mark_paid", {
        p_subscriber_id: p.subscriberId,
        p_month: p.month,
        p_client_key: p.clientKey,
      });
      if (!error) return { ok: true };
      const e = classifyError(error);
      return { ok: false, retry: e.retry, message: e.message };
    });
    queues.set(userId, q);
  }
  return q;
}

/** Live outbox items + automatic resend on reconnect, on foreground and every 30 s. */
export function useOutbox(userId: string | undefined, onSent?: () => void) {
  const [items, setItems] = useState<PendingPayment[]>([]);
  // Keep the latest callback without re-running the effect: callers pass a new function
  // every render, and re-subscribing on each render caused an infinite update loop.
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;
  useEffect(() => {
    if (!userId) return;
    const q = outboxFor(userId);
    const unsub = q.subscribe((list) => setItems([...list]));
    const kick = () => {
      if (q.pendingCount() === 0) return;
      q.flush().then((n) => {
        if (n > 0) onSentRef.current?.();
      });
    };
    q.load().then(kick);
    const net = NetInfo.addEventListener((s) => s.isConnected && kick());
    const app = AppState.addEventListener("change", (s) => s === "active" && kick());
    const timer = setInterval(kick, 30_000);
    return () => {
      unsub();
      net();
      app.remove();
      clearInterval(timer);
    };
  }, [userId]);
  return items;
}
