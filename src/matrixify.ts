/**
 * Build a Matrixify "Orders" tracking-import workbook from classified orders.
 *
 * Only orders already SHIPPED in Everstox (tracking code present) are included
 * — these are the ones whose tracking needs pushing into Shopify. One sheet per
 * store, named "Orders US" / "Orders EU" / "Orders UK" so Matrixify recognizes
 * each as an Orders import. Columns match Matrixify's fulfillment update.
 *
 * NOTE: US / EU / UK are three separate Shopify stores, so each sheet is
 * imported into its own store's Matrixify. When importing into one store,
 * select only that store's sheet in the Matrixify preview.
 */

import { FlaggedOrder } from "./report.js";
import { writeXlsx, Sheet } from "./xlsxwriter.js";

const MATRIXIFY_HEADERS = [
  "Name",
  "Fulfillment: Status",
  "Fulfillment: Tracking Number",
  "Fulfillment: Tracking Company",
  "Fulfillment: Tracking URL",
  "Fulfillment: Send Notification",
];

// The report re-routes some US orders into the EU tab; group the export by the
// ORIGINATING store (f.store), because tracking is imported into the Shopify
// store the order actually lives in, not the tab it was displayed under.
const STORE_ORDER: { key: string; label: string }[] = [
  { key: "us", label: "Orders US" },
  { key: "eu", label: "Orders EU" },
  { key: "uk", label: "Orders UK" },
];

export interface MatrixifyBuild {
  buffer: Buffer;
  counts: Record<string, number>;
  total: number;
}

export function buildMatrixifyWorkbook(
  flagged: FlaggedOrder[],
  opts?: { notify?: boolean },
): MatrixifyBuild {
  const notify = opts?.notify ? "TRUE" : "FALSE";
  const counts: Record<string, number> = {};
  const sheets: Sheet[] = [];

  for (const { key, label } of STORE_ORDER) {
    const rows = flagged
      .filter((f) => f.store === key && f.shipped && f.trackingCodes.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    counts[key] = rows.length;

    const sheetRows: string[][] = [MATRIXIFY_HEADERS.slice()];
    for (const f of rows) {
      sheetRows.push([
        f.name,
        "success",
        f.trackingCodes[0] ?? "",
        f.carrier ?? "",
        f.trackingUrl ?? "",
        notify,
      ]);
    }
    sheets.push({ name: label, rows: sheetRows });
  }

  const total = Object.values(counts).reduce((n, v) => n + v, 0);
  return { buffer: writeXlsx(sheets), counts, total };
}

export function matrixifyFilename(generatedAtIso: string): string {
  const day = (generatedAtIso || "").slice(0, 10) || "report";
  return `matrixify-tracking_${day}.xlsx`;
}
