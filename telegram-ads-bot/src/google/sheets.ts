import { AdsData, SheetRow } from "../types";
import { SHEET_HEADERS } from "../config";
import { getDriveClient, getSheetsClient, throttle, withRetry } from "./auth";
import { findMonthFolder, sanitizeName } from "./drive";
import { logSheetCreated } from "../services/logger";

const DATA_START_ROW = 2; // row 1 = header

// Write-path lookup caches: spreadsheet ids, tab sheetIds, and header
// verification are stable per file+tab, so re-resolving them on every save
// costs several API round-trips (plus throttles) for nothing. Cleared on
// save errors so externally deleted files/tabs get re-resolved.
const spreadsheetIdCache = new Map<string, string>();
const tabIdCache = new Map<string, number>();
const headerVerified = new Set<string>();

export function clearSheetCaches(): void {
  spreadsheetIdCache.clear();
  tabIdCache.clear();
  headerVerified.clear();
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

export async function findTab(spreadsheetId: string, tabName: string): Promise<SheetTab | null> {
  const tabs = await listSheetTabs(spreadsheetId);
  return tabs.find((t) => t.title === tabName) ?? null;
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

async function writeHeaderAndFormat(spreadsheetId: string, sheetId: number, tabName: string): Promise<void> {
  const sheets = getSheetsClient();

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: tabRange(tabName, "A1"),
      valueInputOption: "RAW",
      requestBody: { values: [SHEET_HEADERS] },
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
              dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: SHEET_HEADERS.length },
            },
          },
        ],
      },
    })
  );
  await throttle();
}

/**
 * Platform tabs created before a future column addition would have a
 * narrower header than the current SHEET_HEADERS. Same strategy as the
 * earlier Total Click migration: insert real blank column(s) at the first
 * divergence so existing rows shift as a unit and stay aligned under their
 * original headers, then rewrite the header row.
 */
async function migrateTabHeaderIfNeeded(spreadsheetId: string, sheetId: number, tabName: string): Promise<void> {
  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId, range: tabRange(tabName, "A1:1") })
  );
  await throttle();
  const existingHeader = (res.data.values?.[0] ?? []).map((v) => String(v ?? ""));

  const upToDate =
    existingHeader.length === SHEET_HEADERS.length && existingHeader.every((h, i) => h === SHEET_HEADERS[i]);
  if (upToDate) return;

  if (existingHeader.length < SHEET_HEADERS.length) {
    let insertIndex = existingHeader.findIndex((h, i) => h !== SHEET_HEADERS[i]);
    if (insertIndex === -1) insertIndex = existingHeader.length;
    const columnsToInsert = SHEET_HEADERS.length - existingHeader.length;

    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: { sheetId, dimension: "COLUMNS", startIndex: insertIndex, endIndex: insertIndex + columnsToInsert },
                inheritFromBefore: false,
              },
            },
          ],
        },
      })
    );
    await throttle();
  }

  await writeHeaderAndFormat(spreadsheetId, sheetId, tabName);
}

/**
 * Finds the platform's tab in the spreadsheet, creating and formatting it if
 * absent. Returns the tab with its real sheetId — callers must use that id
 * (never a hardcoded 0) for all id-addressed operations.
 */
export async function ensureSheetTab(spreadsheetId: string, tabName: string): Promise<SheetTab> {
  const cacheKey = `${spreadsheetId}|${tabName}`;
  const cachedSheetId = tabIdCache.get(cacheKey);
  if (cachedSheetId !== undefined && headerVerified.has(cacheKey)) {
    return { sheetId: cachedSheetId, title: tabName };
  }

  const existing = await findTab(spreadsheetId, tabName);
  if (existing) {
    await migrateTabHeaderIfNeeded(spreadsheetId, existing.sheetId, existing.title);
    tabIdCache.set(cacheKey, existing.sheetId);
    headerVerified.add(cacheKey);
    return existing;
  }

  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    })
  );
  await throttle();

  const sheetId = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) {
    throw new Error(`Failed to create tab "${tabName}" in spreadsheet ${spreadsheetId}`);
  }

  await writeHeaderAndFormat(spreadsheetId, sheetId, tabName);
  tabIdCache.set(cacheKey, sheetId);
  headerVerified.add(cacheKey);
  return { sheetId, title: tabName };
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
      fields: "id",
    })
  );
  await throttle();

  const spreadsheetId = created.data.id;
  if (!spreadsheetId) throw new Error(`Failed to create spreadsheet: ${fileName}`);

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

  await writeHeaderAndFormat(spreadsheetId, firstTab.sheetId, tabName);
  return spreadsheetId;
}

export interface EnsuredSheet {
  spreadsheetId: string;
  sheetId: number;
  tabName: string;
}

export async function ensureSpreadsheet(
  monthFolderId: string,
  website: string,
  month: string,
  year: string,
  platform: string,
  actor?: { userId: number; username?: string }
): Promise<EnsuredSheet> {
  const fileName = buildSheetFileName(website, month, year);
  const tabName = sanitizeTabName(platform);
  const fileCacheKey = `${monthFolderId}|${fileName}`;

  const existing = spreadsheetIdCache.get(fileCacheKey) ?? (await findSpreadsheet(monthFolderId, fileName));
  if (existing) {
    spreadsheetIdCache.set(fileCacheKey, existing);
    const tab = await ensureSheetTab(existing, tabName);
    return { spreadsheetId: existing, sheetId: tab.sheetId, tabName: tab.title };
  }

  const spreadsheetId = await createSpreadsheet(monthFolderId, fileName, tabName);
  if (actor) logSheetCreated(actor.userId, actor.username, website, `Created sheet: ${fileName} (tab: ${tabName})`, spreadsheetId);
  const tab = await findTab(spreadsheetId, tabName);
  if (!tab) throw new Error(`Tab "${tabName}" missing right after creation in ${fileName}`);
  spreadsheetIdCache.set(fileCacheKey, spreadsheetId);
  tabIdCache.set(`${spreadsheetId}|${tabName}`, tab.sheetId);
  headerVerified.add(`${spreadsheetId}|${tabName}`);
  return { spreadsheetId, sheetId: tab.sheetId, tabName: tab.title };
}

function adsDataToRow(rowNumber: number, data: AdsData): string[] {
  return [
    String(rowNumber),
    data.date,
    data.platform,
    data.totalMessage !== undefined && data.totalMessage !== null ? String(data.totalMessage) : "",
    data.totalClick !== undefined && data.totalClick !== null ? String(data.totalClick) : "",
    String(data.cpr),
    String(data.totalSpent),
    data.impressions !== undefined && data.impressions !== null ? String(data.impressions) : "",
    String(data.reach),
    data.targetAudience ?? "",
    data.adsName ?? "",
    data.location ?? "",
    data.photoLink ?? "",
    data.recordedBy,
    data.recordedAt,
  ];
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

  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: sheet.spreadsheetId,
      range: tabRange(sheet.tabName, "A:O"),
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [adsDataToRow(rowNumber, data)] },
    })
  );
  await throttle();

  // Columns are auto-resized once at tab creation; re-resizing after every
  // append was a whole extra API call per save for a purely cosmetic tweak.
  return rowNumber;
}

export async function getAllRows(spreadsheetId: string, tabName: string): Promise<SheetRow[]> {
  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: tabRange(tabName, `A${DATA_START_ROW}:O`),
    })
  );
  await throttle();
  const values = res.data.values ?? [];
  return values.map((row, idx) => ({ rowNumber: idx + 1, values: row.map((v) => String(v ?? "")) }));
}

/**
 * Read-path variant that tolerates tabs still on the pre-Total-Click
 * 14-column layout (notably the legacy "Data" tab, which the write path
 * never touches or migrates). Reads the tab's own header row and, when the
 * "Total Click" column is absent, splices a blank into each row at that
 * position so callers can always address columns by the current layout's
 * indices.
 */
export async function getAllRowsNormalized(spreadsheetId: string, tabName: string): Promise<SheetRow[]> {
  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: tabRange(tabName, "A1:O"),
    })
  );
  await throttle();
  const all = res.data.values ?? [];
  if (all.length === 0) return [];

  const header = (all[0] ?? []).map((v) => String(v ?? ""));
  const totalClickIndex = SHEET_HEADERS.indexOf("Total Click");
  const isLegacyLayout = !header.includes("Total Click");

  return all.slice(1).map((row, idx) => {
    let values = row.map((v) => String(v ?? ""));
    if (isLegacyLayout) {
      values = [...values.slice(0, totalClickIndex), "", ...values.slice(totalClickIndex)];
    }
    return { rowNumber: idx + 1, values };
  });
}

export async function getRow(spreadsheetId: string, tabName: string, rowNumber: number): Promise<string[] | null> {
  const rows = await getAllRows(spreadsheetId, tabName);
  const row = rows.find((r) => r.rowNumber === rowNumber);
  return row ? row.values : null;
}

export async function updateRowValues(spreadsheetId: string, tabName: string, rowNumber: number, values: string[]): Promise<void> {
  const sheets = getSheetsClient();
  const sheetRowIndex = rowNumber + 1; // account for header row
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: tabRange(tabName, `A${sheetRowIndex}:O${sheetRowIndex}`),
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

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: tabRange(tabName, `A${DATA_START_ROW}:O${DATA_START_ROW + renumbered.length - 1}`),
      valueInputOption: "USER_ENTERED",
      requestBody: { values: renumbered },
    })
  );
  await throttle();
}
