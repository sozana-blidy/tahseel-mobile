import * as Sharing from "expo-sharing";
import { writeCacheFile } from "./files";
import { writeXlsx, type XSheet } from "./xlsx";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Write the workbook to the app cache and open the Android share sheet (WhatsApp, Drive…). */
export async function shareXlsx(sheets: XSheet[], fileName: string, dialogTitle: string): Promise<void> {
  const uri = await writeCacheFile(fileName, writeXlsx(sheets));
  if (!(await Sharing.isAvailableAsync())) throw new Error("المشاركة غير متاحة على هذا الجهاز");
  await Sharing.shareAsync(uri, { mimeType: XLSX_MIME, dialogTitle, UTI: "org.openxmlformats.spreadsheetml.sheet" });
}
