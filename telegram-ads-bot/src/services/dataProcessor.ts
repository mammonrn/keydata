import { AdsData, PendingEdit } from "../types";
import { MONTH_NAMES_EN, config, normalizeWebsiteName } from "../config";
import { clearDriveCaches, ensureFolderStructure, listChildFolders, moveFileToFolder, uploadPhoto } from "../google/drive";
import {
  appendRawRow,
  appendRow,
  buildSheetFileName,
  clearSheetCaches,
  deleteRow,
  ensureSpreadsheet,
  findSpreadsheetIdForWebsiteMonth,
  findTab,
  getAllRowsNormalized,
  getRow,
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

const PHOTO_UPLOAD_CONCURRENCY = 3;

export async function saveAdsData(
  data: Omit<AdsData, "photoLink" | "recordedBy" | "recordedAt">,
  photos: PhotoInput[],
  actor: Actor
): Promise<SaveResult> {
  const startedAt = Date.now();
  try {
    // Defensive re-normalization: every intake path normalizes already, but
    // this is the single choke point before folders/files get created.
    data = { ...data, website: normalizeWebsiteName(data.website) };
    const dateObj = parseThaiDate(data.date);
    const year = String(dateObj.getFullYear());
    const month = MONTH_NAMES_EN[dateObj.getMonth()];

    const refs = await ensureFolderStructure(data.website, dateObj, data.platform, actor);
    const sheet = await ensureSpreadsheet(refs.monthFolderId, data.website, month, year, data.platform, actor);

    let photoLink: string | undefined;
    if (photos.length > 0) {
      // Uploads are independent of one another — run them in parallel,
      // capped so a large album doesn't burst-hit the Drive rate limit.
      const links: string[] = [];
      for (let i = 0; i < photos.length; i += PHOTO_UPLOAD_CONCURRENCY) {
        const chunk = photos.slice(i, i + PHOTO_UPLOAD_CONCURRENCY);
        const chunkLinks = await Promise.all(
          chunk.map((photo) => uploadPhoto(refs.photosFolderId, photo.filename, photo.mimeType, photo.buffer))
        );
        links.push(...chunkLinks);
        for (const photo of chunk) {
          logPhotoUploaded(actor.userId, actor.username, data.website, `Uploaded photo: ${photo.filename} (${data.platform})`);
        }
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
    const elapsedMs = Date.now() - startedAt;
    logRecorded(
      actor.userId,
      actor.username,
      data.website,
      `Recorded row #${rowNumber} in ${data.website}_${month}_${year} [${sheet.tabName}] (${elapsedMs}ms)`,
      sheet.spreadsheetId,
      rowNumber
    );

    return { spreadsheetId: sheet.spreadsheetId, rowNumber, photoLink, website: data.website, month, year };
  } catch (err) {
    // A failure may mean a cached folder/file/tab id no longer exists
    // (deleted or moved externally). Drop the caches so the next attempt
    // re-resolves everything from the API instead of failing the same way.
    clearDriveCaches();
    clearSheetCaches();
    throw err;
  }
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

const PHOTO_LINK_COLUMN = 12;

function extractDriveFileIds(photoLinkCell: string): string[] {
  const ids: string[] = [];
  for (const link of photoLinkCell.split(",")) {
    const match = link.trim().match(/\/d\/([-\w]+)/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

export interface MoveRowResult {
  oldWebsite: string;
  newWebsite: string;
  newRowNumber: number;
  destFileName: string;
  photosMoved: number;
}

/**
 * "Editing" the website of a saved row really means relocating it: each
 * website has its own spreadsheet per month, so the row is appended to the
 * destination website's file (created on demand) and then deleted from the
 * source. Append-before-delete on purpose — if anything fails mid-way the
 * worst case is a duplicate row, never a lost one. Attached photos are
 * re-parented into the destination's Photos/{Platform}/ folder; their Drive
 * ids (and thus the Photo Link cell) survive the move unchanged.
 */
export async function moveRowToWebsite(edit: PendingEdit, newWebsiteRaw: string, actor: Actor): Promise<MoveRowResult | null> {
  const newWebsite = normalizeWebsiteName(newWebsiteRaw);
  const oldWebsite = edit.website;
  if (!newWebsite) return null;

  const row = await getRow(edit.spreadsheetId, edit.tabName, edit.rowNumber);
  if (!row) return null;

  const rowPlatform = row[2] || edit.tabName;
  const monthIndex = MONTH_NAMES_EN.findIndex((m) => m.toLowerCase() === edit.month.toLowerCase());
  const monthDate = new Date(Number(edit.year), monthIndex >= 0 ? monthIndex : 0, 1);

  const destRefs = await ensureFolderStructure(newWebsite, monthDate, rowPlatform, actor);
  const destSheet = await ensureSpreadsheet(destRefs.monthFolderId, newWebsite, edit.month, edit.year, rowPlatform, actor);

  const newRowNumber = await appendRawRow(destSheet, row);
  await deleteRow(edit.spreadsheetId, edit.tabName, edit.sheetId, edit.rowNumber);

  let photosMoved = 0;
  const photoIds = extractDriveFileIds(row[PHOTO_LINK_COLUMN] ?? "");
  for (const fileId of photoIds) {
    await moveFileToFolder(fileId, destRefs.photosFolderId);
    photosMoved++;
  }

  const destFileName = buildSheetFileName(newWebsite, edit.month, edit.year);
  logEdited(
    actor.userId,
    actor.username,
    newWebsite,
    `Moved row: website "${oldWebsite}" -> "${newWebsite}" (${edit.sheetName} row #${edit.rowNumber} -> ${destFileName} [${destSheet.tabName}] row #${newRowNumber}, ${photosMoved} photo(s) moved)`,
    destSheet.spreadsheetId,
    newRowNumber
  );

  return { oldWebsite, newWebsite, newRowNumber, destFileName, photosMoved };
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

    // Sum across every tab in the file, including the legacy "Data" tab —
    // reads must reflect everything actually stored, whichever code version
    // wrote it. (Writes still never touch the legacy tab.) Normalized reads
    // keep column positions correct even if a tab still has the old
    // pre-Total-Click header.
    const tabs = await listSheetTabs(spreadsheetId);

    let recordCount = 0;
    let totalMessageSum = 0;
    let cprSum = 0;
    let totalSpentSum = 0;
    let impressionsSum = 0;
    let reachSum = 0;

    for (const tab of tabs) {
      const rows = await getAllRowsNormalized(spreadsheetId, tab.title);
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
 * matching platform tab(s); without one, merges rows from every tab in the
 * file — including the legacy "Data" tab, so listings reflect everything
 * actually stored. Each row carries its Platform column, so a combined
 * listing stays unambiguous.
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

  const allTabs = await listSheetTabs(spreadsheetId);
  const filter = platformFilter?.toLowerCase();

  const values: string[][] = [];
  for (const tab of allTabs) {
    const tabMatches = !filter || tab.title.toLowerCase().includes(filter);
    // The legacy "Data" tab mixes platforms in one table, so a platform
    // filter is applied to its rows' Platform column instead of the tab name.
    const isMixedLegacyTab = tab.title === "Data";
    if (!tabMatches && !isMixedLegacyTab) continue;

    const rows = await getAllRowsNormalized(spreadsheetId, tab.title);
    for (const r of rows) {
      if (tabMatches || (r.values[2] ?? "").toLowerCase().includes(filter!)) {
        values.push(r.values);
      }
    }
  }
  return { spreadsheetId, rows: values };
}
