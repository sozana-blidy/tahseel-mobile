import { useRef, useState, type ReactNode } from "react";
import { emitDataChanged } from "../lib/bus";
import type { AppError } from "../lib/errors";
import { newKey } from "../lib/rpc";
import { Button, Field, Sheet, T } from "./kit";
import { colors } from "./theme";

export function SheetFrame({ children, onClose, busy }: { children: ReactNode; onClose: () => void; busy: boolean }) {
  return (
    <Sheet visible onClose={() => !busy && onClose()}>
      {children}
    </Sheet>
  );
}

export function ReasonSheet({ title, note, action, danger, onClose, run }: { title: string; note: string; action: string; danger?: boolean; onClose: () => void; run: (reason: string, key: string) => Promise<unknown> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  async function go() {
    if (!reason.trim()) return setError("السبب مطلوب");
    setBusy(true);
    setError(null);
    try {
      await run(reason.trim(), key.current);
      emitDataChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SheetFrame onClose={onClose} busy={busy}>
      <T w="bold" size={20}>{title}</T>
      <T color={colors.muted}>{note}</T>
      <Field label="السبب" value={reason} onChangeText={setReason} error={error} />
      <Button title={action} variant={danger ? "danger" : "primary"} onPress={go} loading={busy} big />
      <Button title="إلغاء" variant="secondary" onPress={onClose} disabled={busy} />
    </SheetFrame>
  );
}

export function ConfirmSheet({ title, body, action, onClose, run }: { title: string; body: string; action: string; onClose: () => void; run: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await run();
      emitDataChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SheetFrame onClose={onClose} busy={busy}>
      <T w="bold" size={20}>{title}</T>
      <T color={colors.muted}>{body}</T>
      {error ? <T color={colors.danger}>{error}</T> : null}
      <Button title={action} onPress={go} loading={busy} big />
      <Button title="إلغاء" variant="secondary" onPress={onClose} disabled={busy} />
    </SheetFrame>
  );
}

