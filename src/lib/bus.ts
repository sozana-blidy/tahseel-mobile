/** Tiny "data changed" signal so open screens refetch after a write or a realtime event. */
type Fn = () => void;
const subs = new Set<Fn>();
export function onDataChanged(fn: Fn): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function emitDataChanged() {
  for (const fn of subs) fn();
}
