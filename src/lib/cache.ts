import AsyncStorage from "@react-native-async-storage/async-storage";

/** Last good server answer, so an agent can still search the list with no signal. */
export async function readCache<T>(key: string): Promise<{ at: string; data: T } | null> {
  try {
    const raw = await AsyncStorage.getItem(`tahseel.cache.v1:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    await AsyncStorage.setItem(`tahseel.cache.v1:${key}`, JSON.stringify({ at: new Date().toISOString(), data }));
  } catch {
    /* storage full — not fatal */
  }
}
