import { SHEET_HEADERS } from "../config";

export interface EditableField {
  label: string;
  index: number;
  key: string;
  numeric: boolean;
}

export const EDITABLE_FIELDS: EditableField[] = [
  { label: "Date", index: 1, key: "date", numeric: false },
  { label: "Platform", index: 2, key: "platform", numeric: false },
  { label: "Total Message", index: 3, key: "totalMessage", numeric: true },
  { label: "CPR", index: 4, key: "cpr", numeric: true },
  { label: "Total Spent", index: 5, key: "totalSpent", numeric: true },
  { label: "Impressions", index: 6, key: "impressions", numeric: true },
  { label: "Reach", index: 7, key: "reach", numeric: true },
  { label: "Target Audience", index: 8, key: "targetAudience", numeric: false },
  { label: "Ads Name", index: 9, key: "adsName", numeric: false },
  { label: "Location", index: 10, key: "location", numeric: false },
];

export function formatRowDisplay(row: string[]): string {
  return SHEET_HEADERS.map((header, idx) => `${header}: ${row[idx] ?? "-"}`).join("\n");
}
