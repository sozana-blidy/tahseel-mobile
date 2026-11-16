import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { onDataChanged } from "./bus";
import type { AppError } from "./errors";

/** Load data; reload when the screen regains focus or any write/realtime event fires. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const v = await fnRef.current();
      if (my === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError((e as AppError).message ?? "خطأ غير متوقع");
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void refresh(), deps);
  useFocusEffect(useCallback(() => void refresh(), [refresh]));
  useEffect(() => onDataChanged(() => void refresh()), [refresh]);

  return { data, error, loading, refresh };
}
