import { AdsData } from "../types";
import { MONTH_NAMES_EN, config } from "../config";
import { ensureFolderStructure, listChildFolders, uploadPhoto } from "../google/drive";
import {
  appendRow,
  deleteRow,
  ensureSpreadsheet,
  findSpreadsheetIdForWebsiteMonth,
  findTab,
  getAllRows,
  getRow,
  isLegacyTab,
  listSheetTabs,
  sanitizeTabName,
  updateRowValues,
} from "../google/sheets";
import { logDeleted, logEdited, logPhotoUploaded, logRecorded, nowBangkok } from "./logger";

export interface Actor {
  userId: number;
  username?: string;
}

export interface PhotoInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export function parseThaiDate(raw: string): Date {
  const trimmed = raw.trim();

  const dmy = trimmed.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    return new Date(year, month - 1, day);
  }

  const ymd = trimmed.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    return new Date(year, month - 1, day);
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  return new Date();
}

export interface SaveResult {
  spreadsheetId: string;
  rowNumber: number;
  photoLink?: string;
  website: string;
  month: string;
  year: string;
}

export async function saveAdsData(
  data: Omit<AdsData, "photoLink" | "recordedBy" | "recordedAt">,
  photos: PhotoInput[],
  actor: Actor
): Promise<SaveResult> {
  const dateObj = parseThaiDate(data.date);
  const year = String(dateObj.getFullYear());
  const month = MONTH_NAMES_EN[dateObj.getMonth()];

  const refs = await ensureFolderStructure(data.website, dateObj, data.platform, actor);
  const sheet = await ensureSpreadsheet(refs.monthFolderId, data.website, month, year, data.platform, actor);

  let photoLink: string | undefined;
  if (photos.length > 0) {
    const links: string[] = [];
    for (const photo of photos) {
      const link = await uploadPhoto(refs.photosFolderId, photo.filename, photo.mimeType, photo.buffer);
      links.push(link);
      logPhotoUploaded(actor.userId, actor.username, data.website, `Uploaded photo: ${photo.filename} (${data.platform})`);
    }
    // Comma-joined so each link in the cell stays individually clickable
    // (Google Sheets auto-links every recognized URL substring in a cell).
    photoLink = links.join(", ");
  }

  const recordedBy = actor.username ? `@${actor.username}` : String(actor.userId);
  const finalData: AdsData = {
    ...data,
    photoLink,
    recordedBy,
    recordedAt: nowBangkok(),
  };

  const rowNumber = await appendRow(sheet, finalData);
  logRecorded(
    actor.userId,
    actor.username,
    data.website,
    `Recorded row #${rowNumber} in ${data.website}_${month}_${year} [${sheet.tabName}]`,
    sheet.spreadsheetId,
    rowNumber
  );

  return { spreadsheetId: sheet.spreadsheetId, rowNumber, photoLink, website: data.website, month, year };
}

export interface CurrentMonthSheet {
  spreadsheetId: string;
  sheetId: number;
  tabName: string;
  month: string;
  year: string;
}

/**
 * Finds this month's spreadsheet for the website AND the tab for the given
 * platform. Returns null if either the file or the platform's tab doesn't
 * exist yet — find-only, nothing is created for read/edit/delete paths.
 */
export async function findSheetForCurrentMonth(website: string, platform: string): Promise<CurrentMonthSheet | null> {
  const now = new Date();
  const month = MONTH_NAMES_EN[now.getMonth()];
  const year = String(now.getFullYear());
  const spreadsheetId = await findSpreadsheetIdForWebsiteMonth(website, month, year, now);
  if (!spreadsheetId) return null;
  const tab = await findTab(spreadsheetId, sanitizeTabName(platform));
  if (!tab) return null;
  return { spreadsheetId, sheetId: tab.sheetId, tabName: tab.title, month, year };
}

export async function editRowField(
  spreadsheetId: string,
  tabName: string,
  rowNumber: number,
  fieldIndex: number,
  newValue: string,
  actor: Actor,
  website: string
): Promise<{ before: string[]; after: string[] } | null> {
  const row = await getRow(spreadsheetId, tabName, rowNumber);
  if (!row) return null;
  const before = [...row];
  const after = [...row];
  after[fieldIndex] = newValue;
  await updateRowValues(spreadsheetId, tabName, rowNumber, after);
  logEdited(
    actor.userId,
    actor.username,
    website,
    `Edited row #${rowNumber} [${tabName}]: "${before[fieldIndex]}" -> "${newValue}"`,
    spreadsheetId,
    rowNumber
  );
  return { before, after };
}

export async function deleteRowWithLog(
  spreadsheetId: string,
  tabName: string,
  sheetId: number,
  rowNumber: number,
  actor: Actor,
  website: string
): Promise<string[] | null> {
  const snapshot = await getRow(spreadsheetId, tabName, rowNumber);
  if (!snapshot) return null;
  await deleteRow(spreadsheetId, tabName, sheetId, rowNumber);
  logDeleted(actor.userId, actor.username, website, `Deleted row #${rowNumber} [${tabName}]: ${JSON.stringify(snapshot)}`, spreadsheetId, rowNumber);
  return snapshot;
}

export interface MonthlyStatusEntry {
  website: string;
  recordCount: number;
  totalMessageSum: number;
  cprAvg: number;
  totalSpentSum: number;
  impressionsSum: number;
  reachSum: number;
}

function toNumber(raw: string | undefined): number {
  const num = Number(raw);
  return Number.isNaN(num) ? 0 : num;
}

export async function getMonthlyStatus(): Promise<MonthlyStatusEntry[]> {
  const now = new Date();
  const month = MONTH_NAMES_EN[now.getMonth()];
  const year = String(now.getFullYear());

  const websiteFolders = await listChildFolders(config.googleDriveRootFolderId);
  const results: MonthlyStatusEntry[] = [];

  for (const folder of websiteFolders) {
    const spreadsheetId = await findSpreadsheetIdForWebsiteMonth(folder.name, month, year, now);
    if (!spreadsheetId) continue;

    // Sum across every platform tab in the file. The legacy "Data" tab
    // (pre-platform-split test data) is intentionally excluded.
    const tabs = (await listSheetTabs(spreadsheetId)).filter((t) => !isLegacyTab(t.title));

    let recordCount = 0;
    let totalMessageSum = 0;
    let cprSum = 0;
    let totalSpentSum = 0;
    let impressionsSum = 0;
    let reachSum = 0;

    for (const tab of tabs) {
      const rows = await getAllRows(spreadsheetId, tab.title);
      recordCount += rows.length;
      for (const row of rows) {
        // row.values indices: [1]=Date [2]=Platform [3]=TotalMessage [4]=TotalClick [5]=CPR [6]=TotalSpent [7]=Impressions [8]=Reach
        totalMessageSum += toNumber(row.values[3]);
        cprSum += toNumber(row.values[5]);
        totalSpentSum += toNumber(row.values[6]);
        impressionsSum += toNumber(row.values[7]);
        reachSum += toNumber(row.values[8]);
      }
    }

    if (recordCount === 0 && tabs.length === 0) continue;

    results.push({
      website: folder.name,
      recordCount,
      totalMessageSum,
      cprAvg: recordCount > 0 ? cprSum / recordCount : 0,
      totalSpentSum,
      impressionsSum,
      reachSum,
    });
  }

  return results;
}

/**
 * Lists rows for a website+month. With a platform filter, reads only the
 * matching platform tab(s); without one, merges rows from every platform
 * tab — each row still carries its Platform column, so a combined listing
 * stays unambiguous. The legacy "Data" tab is never read.
 */
export async function listRows(
  website: string,
  month: string,
  year: string,
  platformFilter?: string
): Promise<{ spreadsheetId: string; rows: string[][] } | null> {
  const monthIndex = MONTH_NAMES_EN.findIndex((m) => m.toLowerCase() === month.toLowerCase());
  const dateForLookup = monthIndex >= 0 ? new Date(Number(year), monthIndex, 1) : new Date();
  const spreadsheetId = await findSpreadsheetIdForWebsiteMonth(website, month, year, dateForLookup);
  if (!spreadsheetId) return null;

  let tabs = (await listSheetTabs(spreadsheetId)).filter((t) => !isLegacyTab(t.title));
  if (platformFilter) {
    tabs = tabs.filter((t) => t.title.toLowerCase().includes(platformFilter.toLowerCase()));
  }

  const values: string[][] = [];
  for (const tab of tabs) {
    const rows = await getAllRows(spreadsheetId, tab.title);
    values.push(...rows.map((r) => r.values));
  }
  return { spreadsheetId, rows: values };
}
