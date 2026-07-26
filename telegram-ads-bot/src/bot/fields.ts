import {
  ALL_DATA_FIELDS,
  DataField,
  FIELD_HEADERS,
  columnIndexOfField,
  fieldForHeader,
  isNumericDataField,
  isSystemHeader,
  schemaForPlatform,
} from "../config";

export interface EditableField {
  label: string;
  /** Field key — never a column index: each platform tab has its own layout. */
  key: string;
  numeric: boolean;
}

// index -1 in earlier versions: website is not a sheet column at all — it
// identifies which file the row lives in, so editing it moves the whole row
// (see moveRowToWebsite). Platform is a system column present on every tab.
const WEBSITE_FIELD: EditableField = { label: "เว็บไซต์ (Website)", key: "website", numeric: false };
const PLATFORM_FIELD: EditableField = { label: "Platform", key: "platform", numeric: false };

const DATA_FIELD_LABELS: Record<DataField, string> = {
  date: "Date",
  totalMessage: "Total Message",
  totalClick: "Total Click",
  cpr: "CPR",
  totalSpent: "Total Spent",
  impressions: "Impressions",
  reach: "Reach",
  views: "Views",
  mainBudget: "Main Budget",
  runningCampaign: "Running Campaign",
  joined: "Joined",
  targetAudience: "Target Audience",
  adsName: "Ads Name",
  location: "Location",
};

function editableFor(field: DataField): EditableField {
  return { label: DATA_FIELD_LABELS[field], key: field, numeric: isNumericDataField(field) };
}

/** Every field the system can edit — used to resolve a key from a callback. */
export const EDITABLE_FIELDS: EditableField[] = [
  WEBSITE_FIELD,
  ...ALL_DATA_FIELDS.filter((f) => f === "date").map(editableFor),
  PLATFORM_FIELD,
  ...ALL_DATA_FIELDS.filter((f) => f !== "date").map(editableFor),
];

/**
 * The edit menu for a specific platform: only the columns that platform
 * actually uses, so a TikTok row isn't offered CPR/Impressions/Reach it will
 * never have. Falls back to everything for platforms with no schema.
 */
export function editableFieldsForPlatform(platform: string | undefined): EditableField[] {
  if (!platform) return EDITABLE_FIELDS;
  const schema = schemaForPlatform(platform);
  return [
    WEBSITE_FIELD,
    ...schema.filter((f) => f === "date").map(editableFor),
    PLATFORM_FIELD,
    ...schema.filter((f) => f !== "date").map(editableFor),
  ];
}

export function findEditableField(key: string): EditableField | undefined {
  return EDITABLE_FIELDS.find((f) => f.key === key);
}

/**
 * Renders a stored row against its own tab's header, skipping empty cells so
 * a narrow platform's row isn't padded out with blank lines for columns it
 * doesn't use.
 */
export function formatRowDisplay(header: string[], row: string[]): string {
  const lines: string[] = [];
  header.forEach((cell, index) => {
    const value = (row[index] ?? "").trim();
    if (!value) return;
    if (isSystemHeader(cell) || fieldForHeader(cell)) lines.push(`${cell}: ${value}`);
  });
  return lines.length > 0 ? lines.join("\n") : "(ไม่มีข้อมูล)";
}

export { columnIndexOfField, FIELD_HEADERS };
