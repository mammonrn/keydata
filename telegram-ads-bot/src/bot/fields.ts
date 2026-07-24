import { SHEET_HEADERS } from "../config";

export interface EditableField {
  label: string;
  index: number;
  key: string;
  numeric: boolean;
}

export const EDITABLE_FIELDS: EditableField[] = [
  // index -1: website is not a sheet column — it identifies which file the
  // row lives in, so editing it moves the whole row (see moveRowToWebsite).
  { label: "เว็บไซต์ (Website)", index: -1, key: "website", numeric: false },
  { label: "Date", index: 1, key: "date", numeric: false },
  { label: "Platform", index: 2, key: "platform", numeric: false },
  { label: "Total Message", index: 3, key: "totalMessage", numeric: true },
  { label: "Total Click", index: 4, key: "totalClick", numeric: true },
  { label: "CPR", index: 5, key: "cpr", numeric: true },
  { label: "Total Spent", index: 6, key: "totalSpent", numeric: true },
  { label: "Impressions", index: 7, key: "impressions", numeric: true },
  { label: "Reach", index: 8, key: "reach", numeric: true },
  { label: "Target Audience", index: 9, key: "targetAudience", numeric: false },
  { label: "Ads Name", index: 10, key: "adsName", numeric: false },
  { label: "Location", index: 11, key: "location", numeric: false },
];

export function formatRowDisplay(row: string[]): string {
  return SHEET_HEADERS.map((header, idx) => `${header}: ${row[idx] ?? "-"}`).join("\n");
}
