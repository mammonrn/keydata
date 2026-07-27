import { AdsData, SheetRow } from "../types";
import {
  DataField,
  buildHeader,
  buildRowValues,
  colLetter,
  columnIndexOfField,
  headerToFields,
  planHeaderInsertions,
  remapRow,
  resolveTargetHeader,
  schemaForPlatform,
} from "../config";
import { getDriveClient, getSheetsClient, throttle, withRetry } from "./auth";
import { assertNotBornTrashed, findMonthFolder, isLive, sanitizeName } from "./drive";
import { logError, logSheetCreated } from "../services/logger";

const DATA_START_ROW = 2; // row 1 = header

// Widest range we ever read. Comfortably past the union layout's width, so a
// single constant works for every per-platform header without re-deriving a
// range for reads.
const MAX_COLUMN = "AZ";

// Write-path lookup caches: spreadsheet ids, tab sheetIds, and resolved
// headers are stable per file+tab, so re-resolving them on every save costs
// several API round-trips (plus throttles) for nothing. Cleared on save
// errors so externally deleted files/tabs get re-resolved.
const spreadsheetIdCache = new Map<string, string>();
const tabCache = new Map<string, EnsuredTab>();

// Google Sheets treats tab titles case-insensitively (it rejects addSheet
// "TikTok" when "Tiktok" exists), so every lookup here must too — and the
// cache must be keyed that way as well, or "TikTok" and "Tiktok" would get
// two entries pointing at the same physical tab.
function tabCacheKey(spreadsheetId: string, tabName: string): string {
  return `${spreadsheetId}|${tabName.trim().toLowerCase()}`;
}

export function clearSheetCaches(): void {
  spreadsheetIdCache.clear();
  tabCache.clear();
}

/** Drops every cached tab belonging to one spreadsheet (used when it turns
 * out to be trashed, so its sheetIds must not be reused). */
function dropTabCacheForSpreadsheet(spreadsheetId: string): void {
  for (const key of [...tabCache.keys()]) {
    if (key.startsWith(`${spreadsheetId}|`)) tabCache.delete(key);
  }
}

export function buildSheetFileName(website: string, month: string, year: string): string {
  return sanitizeName(`${website}_${month}_${year}`);
}

// Google Sheets tab titles cannot contain [ ] * / \ ? : and are capped at
// 100 chars. Falls back to "Unknown" so a fully-stripped name can't produce
// an invalid empty title.
export function sanitizeTabName(platform: string): string {
  const cleaned = platform.replace(/[\[\]*\/\\?:]/g, "").trim().slice(0, 90);
  return cleaned.length > 0 ? cleaned : "Unknown";
}

// A1-notation range on a specific tab. Tab names go in single quotes with
// internal quotes doubled, so names with spaces ("Facebook Ads") or
// apostrophes stay valid.
function tabRange(tabName: string, ref: string): string {
  return `'${tabName.replace(/'/g, "''")}'!${ref}`;
}

export interface SheetTab {
  sheetId: number;
  title: string;
}

export async function listSheetTabs(spreadsheetId: string): Promise<SheetTab[]> {
  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" })
  );
  await throttle();
  return (res.data.sheets ?? [])
    .map((s) => ({ sheetId: s.properties?.sheetId ?? -1, title: s.properties?.title ?? "" }))
    .filter((s) => s.sheetId >= 0 && s.title.length > 0);
}

/**
 * Locates a tab by name, comparing case-insensitively because that is how
 * the Sheets API itself compares titles: asking for "TikTok" when the file
 * holds a "Tiktok" tab must resolve to that tab, not report "not found" and
 * send the caller off to addSheet — which the API then rejects as a
 * duplicate.
 *
 * The returned tab carries its *literal* title. Callers must use that for
 * A1 ranges; a range built from the requested spelling would address a tab
 * that does not exist.
 */
export async function findTab(spreadsheetId: string, tabName: string): Promise<SheetTab | null> {
  const tabs = await listSheetTabs(spreadsheetId);
  const wanted = tabName.trim().toLowerCase();
  return tabs.find((t) => t.title.trim().toLowerCase() === wanted) ?? null;
}

async function findSpreadsheet(monthFolderId: string, fileName: string): Promise<string | null> {
  const drive = getDriveClient();
  const safeName = fileName.replace(/'/g, "\\'");
  const res = await withRetry(() =>
    drive.files.list({
      q: `'${monthFolderId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: "files(id, name)",
    })
  );
  await throttle();
  const files = res.data.files ?? [];
  return files.length > 0 ? files[0].id ?? null : null;
}

/** Reads a tab's header row. Empty array when the tab has no header yet. */
export async function getTabHeader(spreadsheetId: string, tabName: string): Promise<string[]> {
  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId, range: tabRange(tabName, `A1:${MAX_COLUMN}1`) })
  );
  await throttle();
  return (res.data.values?.[0] ?? []).map((v) => String(v ?? "")).filter((v) => v.length > 0);
}

async function writeHeaderAndFormat(
  spreadsheetId: string,
  sheetId: number,
  tabName: string,
  header: string[]
): Promise<void> {
  const sheets = getSheetsClient();

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: tabRange(tabName, "A1"),
      valueInputOption: "RAW",
      requestBody: { values: [header] },
    })
  );
  await throttle();

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.85, green: 0.9, blue: 0.98 },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: header.length },
            },
          },
        ],
      },
    })
  );
  await throttle();
}

/**
 * Widens an existing tab to the header its platform schema (plus whatever
 * it already has, plus whatever is about to be written) calls for.
 *
 * Only ever inserts columns: real blank columns go in at each divergence
 * point so existing rows shift as a unit and stay aligned under their
 * original headers. Insertions are applied right-to-left so earlier indices
 * remain valid as the grid grows. If the existing header can't be expressed
 * as a subsequence of the target — a hand-edited tab, or the legacy mixed
 * "Data" tab — the tab is left exactly as it is and its own header becomes
 * the layout used for writes.
 */
async function migrateTabHeaderIfNeeded(
  spreadsheetId: string,
  sheetId: number,
  tabName: string,
  platform: string,
  neededFields: Iterable<DataField>
): Promise<string[]> {
  const existingHeader = await getTabHeader(spreadsheetId, tabName);
  if (existingHeader.length === 0) {
    const header = buildHeader(new Set([...schemaForPlatform(platform), ...neededFields]));
    await writeHeaderAndFormat(spreadsheetId, sheetId, tabName, header);
    return header;
  }

  const target = resolveTargetHeader(existingHeader, platform, neededFields);
  const upToDate =
    existingHeader.length === target.length && existingHeader.every((h, i) => h.trim() === target[i].trim());
  if (upToDate) return existingHeader;

  const insertions = planHeaderInsertions(existingHeader, target);
  if (!insertions) {
    // Unrecognizable layout — never rewrite it, just use it as-is.
    return existingHeader;
  }

  const requests = [...insertions]
    .reverse()
    .map(({ index, count }) => ({
      insertDimension: {
        range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + count },
        inheritFromBefore: false,
      },
    }));

  if (requests.length > 0) {
    const sheets = getSheetsClient();
    await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }));
    await throttle();
  }

  await writeHeaderAndFormat(spreadsheetId, sheetId, tabName, target);
  return target;
}

export interface EnsuredTab extends SheetTab {
  header: string[];
}

/**
 * Finds the platform's tab in the spreadsheet, creating and formatting it if
 * absent, and widening its header when the schema (or the record about to be
 * written) needs columns it doesn't have yet. Returns the tab with its real
 * sheetId — callers must use that id (never a hardcoded 0) for all
 * id-addressed operations — plus the header its rows must be laid out
 * against.
 */
export async function ensureSheetTab(
  spreadsheetId: string,
  tabName: string,
  platform: string,
  neededFields: Iterable<DataField> = []
): Promise<EnsuredTab> {
  const cacheKey = tabCacheKey(spreadsheetId, tabName);
  const cached = tabCache.get(cacheKey);
  // A cached header is only reusable when it already covers every field this
  // write needs; otherwise the tab has to be widened first.
  if (cached) {
    const covered = [...neededFields].every((f) => columnIndexOfField(cached.header, f) >= 0);
    if (covered) return cached;
  }

  // Case-insensitive, matching the API: an existing "Tiktok" tab is reused
  // for a canonical "TikTok" platform instead of triggering a duplicate
  // addSheet. Its literal title is what every subsequent range is built
  // from — the tab is deliberately NOT renamed to the canonical spelling,
  // since renaming would break any formula, chart, or external link that
  // references the old title.
  const existing = await findTab(spreadsheetId, tabName);
  if (existing) {
    const header = await migrateTabHeaderIfNeeded(spreadsheetId, existing.sheetId, existing.title, platform, neededFields);
    const resolved = { ...existing, header };
    tabCache.set(cacheKey, resolved);
    return resolved;
  }

  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    })
  );
  await throttle();

  const created = res.data.replies?.[0]?.addSheet?.properties;
  const sheetId = created?.sheetId;
  if (sheetId === undefined || sheetId === null) {
    throw new Error(`Failed to create tab "${tabName}" in spreadsheet ${spreadsheetId}`);
  }
  // Use the title the API actually assigned, not the one requested.
  const title = created?.title ?? tabName;

  const header = buildHeader(new Set([...schemaForPlatform(platform), ...neededFields]));
  await writeHeaderAndFormat(spreadsheetId, sheetId, title, header);
  const resolved = { sheetId, title, header };
  tabCache.set(cacheKey, resolved);
  return resolved;
}

async function createSpreadsheet(monthFolderId: string, fileName: string, tabName: string): Promise<string> {
  const drive = getDriveClient();
  const sheets = getSheetsClient();

  // Create directly inside the target folder via the Drive API.
  // (Creating with sheets.spreadsheets.create() first lands the file in the
  // creating account's own Drive space and needs a move; creating with
  // `parents` set places it — and its storage accounting — in the shared
  // folder from the start.)
  const created = await withRetry(() =>
    drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [monthFolderId],
      },
      fields: "id, trashed",
    })
  );
  await throttle();

  const spreadsheetId = created.data.id;
  if (!spreadsheetId) throw new Error(`Failed to create spreadsheet: ${fileName}`);
  await assertNotBornTrashed(spreadsheetId, created.data.trashed, `ไฟล์ชีท "${fileName}"`);

  // Rename the default first tab to the platform's tab name, addressing it
  // by its real sheetId rather than assuming 0.
  const tabs = await listSheetTabs(spreadsheetId);
  const firstTab = tabs[0];
  if (!firstTab) throw new Error(`New spreadsheet ${fileName} has no default tab`);

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: firstTab.sheetId, title: tabName },
              fields: "title",
            },
          },
        ],
      },
    })
  );
  await throttle();

  return spreadsheetId;
}

export interface EnsuredSheet {
  spreadsheetId: string;
  sheetId: number;
  tabName: string;
  header: string[];
}

export async function ensureSpreadsheet(
  monthFolderId: string,
  website: string,
  month: string,
  year: string,
  platform: string,
  actor?: { userId: number; username?: string },
  neededFields: Iterable<DataField> = []
): Promise<EnsuredSheet> {
  const fileName = buildSheetFileName(website, month, year);
  const tabName = sanitizeTabName(platform);
  const fileCacheKey = `${monthFolderId}|${fileName}`;

  // The month folder was revalidated by ensureFolderStructure, but the sheet
  // inside it can be trashed on its own — and rows appended to a trashed
  // spreadsheet are written successfully and are invisible to the user. A
  // cached id therefore has to be proven live before it is written to; the
  // uncached branch below is already safe, since findSpreadsheet filters on
  // `trashed = false`.
  const cachedId = spreadsheetIdCache.get(fileCacheKey);
  if (cachedId !== undefined && !(await isLive(cachedId))) {
    logError(
      actor?.userId ?? 0,
      actor?.username,
      `Cached spreadsheet "${fileName}" (${cachedId}) is trashed or missing — dropping it and creating a fresh sheet`,
      website
    );
    spreadsheetIdCache.delete(fileCacheKey);
    dropTabCacheForSpreadsheet(cachedId);
  }

  const existing = spreadsheetIdCache.get(fileCacheKey) ?? (await findSpreadsheet(monthFolderId, fileName));
  if (existing) {
    spreadsheetIdCache.set(fileCacheKey, existing);
    const tab = await ensureSheetTab(existing, tabName, platform, neededFields);
    return { spreadsheetId: existing, sheetId: tab.sheetId, tabName: tab.title, header: tab.header };
  }

  const spreadsheetId = await createSpreadsheet(monthFolderId, fileName, tabName);
  if (actor) logSheetCreated(actor.userId, actor.username, website, `Created sheet: ${fileName} (tab: ${tabName})`, spreadsheetId);
  spreadsheetIdCache.set(fileCacheKey, spreadsheetId);
  const tab = await ensureSheetTab(spreadsheetId, tabName, platform, neededFields);
  return { spreadsheetId, sheetId: tab.sheetId, tabName: tab.title, header: tab.header };
}

export async function findSpreadsheetIdForWebsiteMonth(website: string, month: string, year: string, date: Date): Promise<string | null> {
  const monthFolderId = await findMonthFolder(website, date);
  if (!monthFolderId) return null;
  const fileName = buildSheetFileName(website, month, year);
  return findSpreadsheet(monthFolderId, fileName);
}

export async function appendRow(sheet: EnsuredSheet, data: AdsData): Promise<number> {
  const sheets = getSheetsClient();
  const existingRows = await getAllRows(sheet.spreadsheetId, sheet.tabName);
  const rowNumber = existingRows.length + 1; // per-tab numbering, restarts at 1 for each platform
  const values = buildRowValues(sheet.header, rowNumber, data);

  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: sheet.spreadsheetId,
      range: tabRange(sheet.tabName, `A:${colLetter(sheet.header.length)}`),
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] },
    })
  );
  await throttle();

  // Columns are auto-resized once at tab creation; re-resizing after every
  // append was a whole extra API call per save for a purely cosmetic tweak.
  return rowNumber;
}

/**
 * Appends an already-materialized row to a tab, re-laying its cells against
 * the destination tab's header and assigning that tab's next row number in
 * column A. Used when moving a row between spreadsheets: source and
 * destination tabs can have different layouts, so cells are matched by what
 * their column *means*, never by position.
 */
export async function appendRawRow(
  sheet: EnsuredSheet,
  srcHeader: string[],
  srcValues: string[]
): Promise<number> {
  const sheets = getSheetsClient();
  const existingRows = await getAllRows(sheet.spreadsheetId, sheet.tabName);
  const rowNumber = existingRows.length + 1;

  const values = remapRow(srcHeader, srcValues, sheet.header);
  values[0] = String(rowNumber);

  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: sheet.spreadsheetId,
      range: tabRange(sheet.tabName, `A:${colLetter(sheet.header.length)}`),
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] },
    })
  );
  await throttle();

  return rowNumber;
}

export async function getAllRows(spreadsheetId: string, tabName: string): Promise<SheetRow[]> {
  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: tabRange(tabName, `A${DATA_START_ROW}:${MAX_COLUMN}`),
    })
  );
  await throttle();
  const values = res.data.values ?? [];
  return values.map((row, idx) => ({ rowNumber: idx + 1, values: row.map((v) => String(v ?? "")) }));
}

export interface TabContents {
  header: string[];
  rows: SheetRow[];
}

/**
 * Reads a tab together with its own header row. Every read path goes through
 * this: with per-platform layouts there is no universal column order to
 * normalize to, so callers address cells by field name against the header
 * they get back (see cellOf/columnIndexOfField).
 */
export async function getTabContents(spreadsheetId: string, tabName: string): Promise<TabContents> {
  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: tabRange(tabName, `A1:${MAX_COLUMN}`),
    })
  );
  await throttle();
  const all = res.data.values ?? [];
  if (all.length === 0) return { header: [], rows: [] };

  const header = (all[0] ?? []).map((v) => String(v ?? ""));
  const rows = all.slice(1).map((row, idx) => ({
    rowNumber: idx + 1,
    values: row.map((v) => String(v ?? "")),
  }));
  return { header, rows };
}

export async function getRow(spreadsheetId: string, tabName: string, rowNumber: number): Promise<string[] | null> {
  const rows = await getAllRows(spreadsheetId, tabName);
  const row = rows.find((r) => r.rowNumber === rowNumber);
  return row ? row.values : null;
}

export async function updateRowValues(
  spreadsheetId: string,
  tabName: string,
  rowNumber: number,
  values: string[],
  width: number
): Promise<void> {
  const sheets = getSheetsClient();
  const sheetRowIndex = rowNumber + 1; // account for header row
  const lastCol = colLetter(Math.max(width, values.length));
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: tabRange(tabName, `A${sheetRowIndex}:${lastCol}${sheetRowIndex}`),
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    })
  );
  await throttle();
}

export async function deleteRow(spreadsheetId: string, tabName: string, sheetId: number, rowNumber: number): Promise<void> {
  const sheets = getSheetsClient();
  const sheetRowIndex = rowNumber + 1; // account for header row (1-indexed)

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: { sheetId, dimension: "ROWS", startIndex: sheetRowIndex - 1, endIndex: sheetRowIndex },
            },
          },
        ],
      },
    })
  );
  await throttle();

  const remainingRows = await getAllRows(spreadsheetId, tabName);
  if (remainingRows.length === 0) return;

  const renumbered = remainingRows.map((r, idx) => {
    const values = [...r.values];
    values[0] = String(idx + 1);
    return values;
  });
  const width = Math.max(...renumbered.map((r) => r.length), 1);

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: tabRange(tabName, `A${DATA_START_ROW}:${colLetter(width)}${DATA_START_ROW + renumbered.length - 1}`),
      valueInputOption: "USER_ENTERED",
      requestBody: { values: renumbered },
    })
  );
  await throttle();
}

/**
 * Makes sure a tab has a column for `field`, widening it if not. Returns the
 * tab's header afterwards. Used by the edit path, where a user may set a
 * field the tab's platform schema doesn't include yet.
 */
export async function ensureColumnForField(
  spreadsheetId: string,
  sheetId: number,
  tabName: string,
  platform: string,
  field: DataField
): Promise<string[]> {
  const header = await migrateTabHeaderIfNeeded(spreadsheetId, sheetId, tabName, platform, [field]);
  // tabName here is already the literal title (callers get it from findTab /
  // ensureSheetTab), so the cache entry stays consistent with that spelling.
  tabCache.set(tabCacheKey(spreadsheetId, tabName), { sheetId, title: tabName, header });
  return header;
}

export { headerToFields };
