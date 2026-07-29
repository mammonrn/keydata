/**
 * Per-platform column schemas.
 *
 * Each ad platform reports a different set of numbers (TikTok has Views but
 * no CPR, Telegram adds Main Budget and Joined, Facebook has Impressions and
 * Reach), so one universal header no longer fits. Since every platform
 * already gets its own sheet tab, each tab now carries its own column layout.
 *
 * The invariant that makes this safe: a tab's *own header row* is always the
 * source of truth for its layout. A schema only decides what columns a brand
 * new tab starts with, and which columns an existing tab may gain. Columns
 * are never removed or reordered on an existing tab, so data written by an
 * older version of the code stays aligned under its original headers.
 */

export type DataField =
  | "date"
  | "totalMessage"
  | "totalClick"
  | "cpr"
  | "totalSpent"
  | "impressions"
  | "reach"
  | "views"
  | "mainBudget"
  | "runningCampaign"
  | "joined"
  | "targetAudience"
  | "adsName"
  | "location";

/**
 * Canonical column order. Every header is built by filtering this list, so no
 * two tabs can disagree about the *relative* order of columns they share —
 * which is exactly what lets migration widen an existing tab by pure
 * insertion instead of a reshuffle that would strand existing data.
 *
 * The v14 fields are slotted between "reach" and "targetAudience" so the
 * pre-v14 universal layout remains a subsequence of the union: an existing
 * tab migrates by inserting one contiguous block, no data shifts sideways.
 */
export const ALL_DATA_FIELDS: DataField[] = [
  "date",
  "totalMessage",
  "totalClick",
  "cpr",
  "totalSpent",
  "impressions",
  "reach",
  "views",
  "mainBudget",
  "runningCampaign",
  "joined",
  "targetAudience",
  "adsName",
  "location",
];

export const NUMERIC_DATA_FIELDS: DataField[] = [
  "totalMessage",
  "totalClick",
  "cpr",
  "totalSpent",
  "impressions",
  "reach",
  "views",
  "mainBudget",
  "joined",
];

export function isNumericDataField(field: string): boolean {
  return (NUMERIC_DATA_FIELDS as string[]).includes(field);
}

export const FIELD_HEADERS: Record<DataField, string> = {
  date: "Date",
  totalMessage: "Total Message",
  totalClick: "Total Click",
  cpr: "CPR (฿)",
  totalSpent: "Total Spent (฿)",
  impressions: "Impressions",
  reach: "Reach",
  views: "Views",
  mainBudget: "Main Budget (฿)",
  runningCampaign: "Running Campaign",
  joined: "Joined",
  targetAudience: "Target Audience",
  adsName: "Ads Name",
  location: "Location",
};

// Short labels for compact listings (/list, /status) where the "(฿)" suffix
// is just noise.
export const FIELD_SHORT_LABELS: Record<DataField, string> = {
  date: "Date",
  totalMessage: "Msg",
  totalClick: "Click",
  cpr: "CPR",
  totalSpent: "Spent",
  impressions: "Impr",
  reach: "Reach",
  views: "Views",
  mainBudget: "Budget",
  runningCampaign: "Campaign",
  joined: "Joined",
  targetAudience: "Target",
  adsName: "Ads Name",
  location: "Location",
};

export const ROW_HEADER = "Row";
export const PLATFORM_HEADER = "Platform";
export const SYSTEM_TRAILING_HEADERS = ["Photo Link", "Recorded By", "Recorded At"];

const SYSTEM_HEADER_SET = new Set(
  [ROW_HEADER, PLATFORM_HEADER, ...SYSTEM_TRAILING_HEADERS].map((h) => h.toLowerCase())
);

const HEADER_TO_FIELD = new Map<string, DataField>();
for (const field of ALL_DATA_FIELDS) {
  HEADER_TO_FIELD.set(FIELD_HEADERS[field].toLowerCase(), field);
}
// Header spellings written by earlier versions, or plausible hand edits.
// Without these an existing tab's "CPR (฿)" column would read as unknown and
// the tab would be treated as un-migratable.
HEADER_TO_FIELD.set("cpr", "cpr");
HEADER_TO_FIELD.set("total spent", "totalSpent");
HEADER_TO_FIELD.set("main budget", "mainBudget");
HEADER_TO_FIELD.set("spent budget", "totalSpent");

export function fieldForHeader(header: string): DataField | undefined {
  return HEADER_TO_FIELD.get(header.trim().toLowerCase());
}

export function isSystemHeader(header: string): boolean {
  return SYSTEM_HEADER_SET.has(header.trim().toLowerCase());
}

/**
 * Builds a full header row (system columns included) for a set of data
 * fields. Column order always follows ALL_DATA_FIELDS, with Date first and
 * Platform pinned right after it to match the layout every existing tab
 * already uses.
 */
export function buildHeader(fields: Iterable<DataField>): string[] {
  const wanted = new Set(fields);
  const header: string[] = [ROW_HEADER];
  if (wanted.has("date")) header.push(FIELD_HEADERS.date);
  header.push(PLATFORM_HEADER);
  for (const field of ALL_DATA_FIELDS) {
    if (field === "date") continue;
    if (wanted.has(field)) header.push(FIELD_HEADERS[field]);
  }
  header.push(...SYSTEM_TRAILING_HEADERS);
  return header;
}

/** The data fields an existing header row actually carries columns for. */
export function headerToFields(header: string[]): DataField[] {
  const fields: DataField[] = [];
  for (const cell of header) {
    const field = fieldForHeader(cell);
    if (field && !fields.includes(field)) fields.push(field);
  }
  return fields;
}

export function columnIndexOfField(header: string[], field: DataField): number {
  return header.findIndex((cell) => fieldForHeader(cell) === field);
}

export function columnIndexOfSystem(header: string[], systemHeader: string): number {
  const target = systemHeader.trim().toLowerCase();
  return header.findIndex((cell) => cell.trim().toLowerCase() === target);
}

const PLATFORM_SCHEMAS: Record<string, DataField[]> = {
  // Facebook keeps totalClick even though Facebook reports don't use it:
  // every pre-v14 tab already has that column populated, and dropping it
  // from the schema would make the target header narrower than the existing
  // one — a migration that can only be done by deleting a column with live
  // data in it. Keeping it means existing Facebook tabs migrate by pure
  // insertion, exactly as before.
  facebook: [
    "date",
    "totalMessage",
    "totalClick",
    "cpr",
    "totalSpent",
    "impressions",
    "reach",
    "targetAudience",
    "adsName",
    "location",
  ],
  tiktok: ["date", "totalSpent", "views", "totalClick", "targetAudience", "adsName", "location"],
  telegram: [
    "date",
    "mainBudget",
    "runningCampaign",
    "totalSpent",
    "views",
    "totalClick",
    "joined",
    "targetAudience",
    "adsName",
    "location",
  ],
};

/**
 * The starting column set for a platform. Platforms without an explicit
 * schema (anything a Super Admin adds later) fall back to the union of every
 * field the system knows, so a new platform can record whatever the parser
 * manages to read instead of silently dropping it.
 */
export function schemaForPlatform(platform: string): DataField[] {
  return PLATFORM_SCHEMAS[platform.trim().toLowerCase()] ?? [...ALL_DATA_FIELDS];
}

export function hasPlatformSchema(platform: string): boolean {
  return PLATFORM_SCHEMAS[platform.trim().toLowerCase()] !== undefined;
}

/**
 * The header a tab *should* have: its platform schema, widened by whatever
 * columns the tab already has and whatever fields are about to be written.
 * Union rather than replacement — a field outside the platform's schema
 * (someone reports CPR on TikTok) gains a real column rather than being
 * dropped, and no existing column is ever lost.
 */
export function resolveTargetHeader(
  existingHeader: string[],
  platform: string,
  extraFields: Iterable<DataField> = []
): string[] {
  const fields = new Set<DataField>(schemaForPlatform(platform));
  for (const field of headerToFields(existingHeader)) fields.add(field);
  for (const field of extraFields) fields.add(field);
  return buildHeader(fields);
}

export interface ColumnInsertion {
  /** Index in the *existing* header where blank columns must be inserted. */
  index: number;
  count: number;
}

/**
 * Plans how to widen `existing` into `target` using only insertions.
 * Returns null when `existing` is not a subsequence of `target` — that means
 * the tab has columns we don't recognize or in an order we can't reconcile
 * (a hand-edited tab, or the legacy mixed "Data" tab), and the only safe
 * action is to leave it alone.
 */
export function planHeaderInsertions(existing: string[], target: string[]): ColumnInsertion[] | null {
  const insertions: ColumnInsertion[] = [];
  let cursor = 0;
  for (const cell of target) {
    if (cursor < existing.length && existing[cursor].trim() === cell.trim()) {
      cursor++;
      continue;
    }
    const last = insertions[insertions.length - 1];
    if (last && last.index === cursor) last.count++;
    else insertions.push({ index: cursor, count: 1 });
  }
  if (cursor !== existing.length) return null;
  return insertions;
}

/** Converts a 1-based column count to its A1 column letter (19 -> "S"). */
export function colLetter(n: number): string {
  let out = "";
  let remaining = n;
  while (remaining > 0) {
    const rem = (remaining - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return out || "A";
}

/**
 * Forces a value to be stored as literal text rather than being reinterpreted
 * by Google Sheets.
 *
 * Every write path uses `valueInputOption: "USER_ENTERED"`, which parses each
 * cell exactly as if it had been typed into the UI — and *that* parse follows
 * the spreadsheet's own locale. A date written as "01/12/2026" therefore
 * lands as 12 January on a US-locale file and as 1 December on a Thai one, so
 * the same record reads differently depending on a setting the bot doesn't
 * control. A leading apostrophe is the UI's own escape for "keep this as
 * text": it is not part of the stored value (reads return "01/12/2026"), it
 * is not visible in the cell, and it makes the displayed date identical to
 * what the user typed on every spreadsheet.
 *
 * The trade-off is deliberate: date cells become text, so Sheets-side date
 * arithmetic and chronological sorting no longer work on them. Every date
 * comparison the bot performs happens in code (see duplicateCheck.ts), and
 * DD/MM/YYYY text is what users read, so correctness of the displayed value
 * wins over in-sheet sortability. Switching to real date cells would mean
 * pinning each tab's date column to an explicit dd/mm/yyyy number format via
 * the Sheets API instead.
 */
export function asTextCell(value: string): string {
  if (!value) return value;
  return value.startsWith("'") ? value : `'${value}`;
}

/**
 * Applies asTextCell() to a row's date column, leaving every other cell
 * untouched. Used by the write paths that build a row out of values read back
 * from a sheet (row moves, renumbering after a delete, single-field edits) —
 * a read strips the apostrophe, so without this the very next write would let
 * the locale reinterpret a date the bot had already pinned down.
 */
export function forceDateAsText(header: string[], values: string[]): string[] {
  const index = columnIndexOfField(header, "date");
  if (index < 0) return values;
  const out = [...values];
  out[index] = asTextCell(out[index] ?? "");
  return out;
}

export interface RowSource {
  platform?: string;
  photoLink?: string;
  recordedBy?: string;
  recordedAt?: string;
}

/** Lays a record out against a specific tab's header. */
export function buildRowValues(header: string[], rowNumber: number, data: RowSource): string[] {
  const record = data as unknown as Record<string, unknown>;
  return header.map((cell, index) => {
    if (index === 0 && isSameHeader(cell, ROW_HEADER)) return String(rowNumber);
    if (isSameHeader(cell, PLATFORM_HEADER)) return data.platform ?? "";
    if (isSameHeader(cell, "Photo Link")) return data.photoLink ?? "";
    if (isSameHeader(cell, "Recorded By")) return data.recordedBy ?? "";
    if (isSameHeader(cell, "Recorded At")) return data.recordedAt ?? "";
    const field = fieldForHeader(cell);
    if (!field) return "";
    const value = record[field];
    if (value === undefined || value === null) return "";
    return field === "date" ? asTextCell(String(value)) : String(value);
  });
}

function isSameHeader(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Re-lays a stored row from one tab's layout onto another's, matching cells
 * by what their column *means* rather than by position. Used when moving a
 * row between websites, where source and destination tabs can have different
 * (even different-width) headers.
 */
export function remapRow(srcHeader: string[], srcRow: string[], dstHeader: string[]): string[] {
  const cellFor = (predicate: (cell: string) => boolean): string => {
    const index = srcHeader.findIndex(predicate);
    return index >= 0 ? srcRow[index] ?? "" : "";
  };
  return dstHeader.map((cell, index) => {
    if (index === 0 && isSameHeader(cell, ROW_HEADER)) return "";
    if (isSystemHeader(cell)) return cellFor((h) => isSameHeader(h, cell));
    const field = fieldForHeader(cell);
    if (!field) return "";
    const value = cellFor((h) => fieldForHeader(h) === field);
    return field === "date" ? asTextCell(value) : value;
  });
}

export function cellOf(header: string[], values: string[], field: DataField): string {
  const index = columnIndexOfField(header, field);
  return index >= 0 ? values[index] ?? "" : "";
}

/** Which known data fields a parsed/pending record actually carries. */
export function dataFieldsPresent(data: Record<string, unknown>): DataField[] {
  return ALL_DATA_FIELDS.filter((field) => {
    const value = data[field];
    return value !== undefined && value !== null && value !== "";
  });
}

/**
 * True when a record carries at least one real metric. Date alone is not
 * enough: without this a message the parser found nothing in would still be
 * saveable as an empty row once website/platform were answered.
 */
export function hasAnyMetricField(data: Record<string, unknown>): boolean {
  return dataFieldsPresent(data).some((field) => field !== "date");
}

/** Parses a sheet cell as a number, or null when blank/non-numeric. */
export function numericCell(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const num = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
}
