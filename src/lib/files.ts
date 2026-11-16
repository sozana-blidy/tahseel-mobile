/**
 * File I/O with a fallback: the new expo-file-system API can refuse files the
 * document picker copied ("Missing 'READ' permission", seen in Expo Go), so we
 * fall back to the legacy API, which reads/writes base64.
 */
import { File, Paths } from "expo-file-system";
import * as Legacy from "expo-file-system/legacy";
import { base64ToBytes, bytesToBase64 } from "./base64";

/** Reads file:// or content:// (Android document picker) URIs. */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
  // content:// is read through Android's content resolver by the legacy API — most reliable.
  if (uri.startsWith("content://")) {
    try {
      return base64ToBytes(await Legacy.readAsStringAsync(uri, { encoding: Legacy.EncodingType.Base64 }));
    } catch {
      return await new File(uri).bytes();
    }
  }
  try {
    return await new File(uri).bytes();
  } catch {
    return base64ToBytes(await Legacy.readAsStringAsync(uri, { encoding: Legacy.EncodingType.Base64 }));
  }
}

/** Write to the app cache; returns a file:// uri for sharing. */
export async function writeCacheFile(name: string, bytes: Uint8Array): Promise<string> {
  const safe = name.replace(/[\\/:*?"<>|]/g, "-");
  try {
    const file = new File(Paths.cache, safe);
    if (file.exists) file.delete();
    file.create();
    await file.write(bytes);
    return file.uri;
  } catch {
    if (!Legacy.cacheDirectory) throw new Error("لا يمكن حفظ الملف على هذا الجهاز");
    const uri = `${Legacy.cacheDirectory}${encodeURIComponent(safe)}`;
    await Legacy.writeAsStringAsync(uri, bytesToBase64(bytes), { encoding: Legacy.EncodingType.Base64 });
    return uri;
  }
}
