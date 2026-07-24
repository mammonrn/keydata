import { AdsData, SheetRow } from "../types";
import { SHEET_HEADERS } from "../config";
import { getDriveClient, getSheetsClient, throttle, withRetry } from "./auth";
import { findMonthFolder, sanitizeName } from "./drive";
import { logSheetCreated } from "../services/logger";

const SHEET_TAB_NAME = "Data";
const DATA_START_ROW = 2; // row 1 = header

export function buildSheetFileName(website: string, month: string, year: string): string {
  return sanitizeName(`${website}_${month}_${year}`);
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

async function createSpreadsheet(monthFolderId: string, fileName: string): Promise<string> {
  const sheets = getSheetsClient();
  const drive = getDriveClient();

  const created = await withRetry(() =>
    sheets.spreadsheets.create({
      requestBody: {
        properties: { title: fileName },
        sheets: [{ properties: { title: SHEET_TAB_NAME } }],
      },
    })
  );
  await throttle();

  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) throw new Error(`Failed to create spreadsheet: ${fileName}`);

  const file = await withRetry(() => drive.files.get({ fileId: spreadsheetId, fields: "parents" }));
  const previousParents = (file.data.parents ?? []).join(",");
  await withRetry(() =>
    drive.files.update({
      fileId: spreadsheetId,
      addParents: monthFolderId,
      removeParents: previousParents,
      fields: "id, parents",
    })
  );
  await throttle();

  await formatHeaderAndWriteRow(spreadsheetId);
  return spreadsheetId;
}

async function formatHeaderAndWriteRow(spreadsheetId: string): Promise<void> {
  const sheets = getSheetsClient();

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TAB_NAME}!A1`,
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
              range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
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
              properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
          {
            autoResizeDimensions: {
              dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: SHEET_HEADERS.length },
            },
          },
        ],
      },
    })
  );
  await throttle();
}

/**
 * Sheets created before the "Total Click" column was added have a 14-column
 * header (Row..Recorded At, no Total Click). Rather than blindly overwriting
 * the header text — which would silently misalign every pre-existing row's
 * CPR/Total Spent/etc. values under the wrong header — this inserts an
 * actual blank column at the point where the old and current headers first
 * diverge, then writes the current header row. Existing data cells are never
 * edited, only shifted as a unit by the column insert, so old rows stay
 * correctly aligned under their original headers.
 */
async function migrateHeaderIfNeeded(spreadsheetId: string): Promise<void> {
  const sheets = getSheetsClient();
  const res = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TAB_NAME}!A1:1` }));
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
                range: { sheetId: 0, dimension: "COLUMNS", startIndex: insertIndex, endIndex: insertIndex + columnsToInsert },
                inheritFromBefore: false,
              },
            },
          ],
        },
      })
    );
    await throttle();
  }

  await formatHeaderAndWriteRow(spreadsheetId);
}

export async function ensureSpreadsheet(
  monthFolderId: string,
  website: string,
  month: string,
  year: string,
  actor?: { userId: number; username?: string }
): Promise<string> {
  const fileName = buildSheetFileName(website, month, year);
  const existing = await findSpreadsheet(monthFolderId, fileName);
  if (existing) {
    await migrateHeaderIfNeeded(existing);
    return existing;
  }

  const spreadsheetId = await createSpreadsheet(monthFolderId, fileName);
  if (actor) logSheetCreated(actor.userId, actor.username, website, `Created sheet: ${fileName}`, spreadsheetId);
  return spreadsheetId;
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
    String(data.impressions),
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

export async function appendRow(spreadsheetId: string, data: AdsData): Promise<number> {
  const sheets = getSheetsClient();
  const existingRows = await getAllRows(spreadsheetId);
  const rowNumber = existingRows.length + 1;

  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_TAB_NAME}!A:O`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [adsDataToRow(rowNumber, data)] },
    })
  );
  await throttle();

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            autoResizeDimensions: {
              dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: SHEET_HEADERS.length },
            },
          },
        ],
      },
    })
  );
  await throttle();

  return rowNumber;
}

export async function getAllRows(spreadsheetId: string): Promise<SheetRow[]> {
  const sheets = getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_TAB_NAME}!A${DATA_START_ROW}:O`,
    })
  );
  await throttle();
  const values = res.data.values ?? [];
  return values.map((row, idx) => ({ rowNumber: idx + 1, values: row.map((v) => String(v ?? "")) }));
}

export async function getRow(spreadsheetId: string, rowNumber: number): Promise<string[] | null> {
  const rows = await getAllRows(spreadsheetId);
  const row = rows.find((r) => r.rowNumber === rowNumber);
  return row ? row.values : null;
}

export async function updateRowValues(spreadsheetId: string, rowNumber: number, values: string[]): Promise<void> {
  const sheets = getSheetsClient();
  const sheetRowIndex = rowNumber + 1; // account for header row
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TAB_NAME}!A${sheetRowIndex}:O${sheetRowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    })
  );
  await throttle();
}

export async function deleteRow(spreadsheetId: string, rowNumber: number): Promise<void> {
  const sheets = getSheetsClient();
  const sheetRowIndex = rowNumber + 1; // account for header row (1-indexed)

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: { sheetId: 0, dimension: "ROWS", startIndex: sheetRowIndex - 1, endIndex: sheetRowIndex },
            },
          },
        ],
      },
    })
  );
  await throttle();

  const remainingRows = await getAllRows(spreadsheetId);
  if (remainingRows.length === 0) return;

  const renumbered = remainingRows.map((r, idx) => {
    const values = [...r.values];
    values[0] = String(idx + 1);
    return values;
  });

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TAB_NAME}!A${DATA_START_ROW}:O${DATA_START_ROW + renumbered.length - 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: renumbered },
    })
  );
  await throttle();
}
