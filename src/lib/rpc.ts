import { randomUUID } from "expo-crypto";
import { classifyError } from "./errors";
import { supabase } from "./supabase";

/** Call a database function; throws AppError (Arabic message) on failure. */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw classifyError(error);
  return data as T;
}

/** Await a supabase query builder; throws AppError on failure. */
export async function q<T>(builder: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await builder;
  if (error) throw classifyError(error);
  return data as T;
}

/** Idempotency key for one user action (retries of the same action reuse it). */
export const newKey = () => randomUUID();
