import { AdsData, PendingEdit } from "../types";
import {
  ALL_DATA_FIELDS,
  DataField,
  MONTH_NAMES_EN,
  columnIndexOfField,
  columnIndexOfSystem,
  config,
  dataFieldsPresent,
  headerToFields,
  isCanonicalPlatform,
  isSuperAdmin,
  normalizePlatformName,
  normalizeWebsiteName,
  numericCell,
  registerPlatformIfNew,
} from "../config";
import { clearDriveCaches, ensureFolderStructure, isKnownWebsite, listChildFolders, moveFileToFolder, uploadPhoto } from "../google/drive";
import {
  appendRawRow,
  appendRow,
  buildSheetFileName,
  clearSheetCaches,
  deleteRow,
  ensureColumnForField,
  ensureSpreadsheet,
  findSpreadsheetIdForWebsiteMonth,
  findTab,
  getRow,
  getTabContents,
  getTabHeader,
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

    // Safety net: only Super Admin can create new website folders.
    if (!isSuperAdmin(actor.userId) && !(await isKnownWebsite(data.website))) {
      throw new Error(`ไม่อนุญาตให้สร้างเว็บไซต์ใหม่ '${data.website}' — เฉพาะ Admin เท่านั้น`);
    }

    data = { ...data, platform: normalizePlatformName(data.platform) };

    if (!isSuperAdmin(actor.userId) && !isCanonicalPlatform(data.platform)) {
      throw new Error(`ไม่อนุญาตให้สร้าง Platform ใหม่ '${data.platform}' — เฉพาะ Admin เท่านั้น`);
    }

    const dateObj = parseThaiDate(data.date);
    const year = String(dateObj.getFullYear());
    const month = MONTH_NAMES_EN[dateObj.getMonth()];

    const refs = await ensureFolderStructure(data.website, dateObj, data.platform, actor);
    // The tab is widened to fit whatever this record actually carries, so a
    // field outside the platform's default schema gains a real column
    // instead of being silently dropped.
    const sheet = await ensureSpreadsheet(
      refs.monthFolderId,
      data.website,
      month,
      year,
      data.platform,
      actor,
      dataFieldsPresent(data as unknown as Record<string, unknown>)
    );

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

    registerPlatformIfNew(data.platform);

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
  header: string[];
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
  const header = await getTabHeader(spreadsheetId, tab.title);
  return { spreadsheetId, sheetId: tab.sheetId, tabName: tab.title, header, month, year };
}

export interface EditRowResult {
  before: string;
  after: string;
  header: string[];
  beforeRow: string[];
  afterRow: string[];
}

/**
 * Writes a single field of a stored row. The column is resolved from the
 * tab's own header rather than a fixed index, since each platform tab has
 * its own layout; if the tab has no column for the field yet (editing a
 * field outside that platform's default schema) the tab is widened first.
 */
export async function editRowField(
  spreadsheetId: string,
  sheetId: number,
  tabName: string,
  platform: string,
  rowNumber: number,
  field: DataField,
  newValue: string,
  actor: Actor,
  website: string
): Promise<EditRowResult | null> {
  let header = await getTabHeader(spreadsheetId, tabName);
  let columnIndex = columnIndexOfField(header, field);
  if (columnIndex < 0) {
    header = await ensureColumnForField(spreadsheetId, sheetId, tabName, platform, field);
    columnIndex = columnIndexOfField(header, field);
    if (columnIndex < 0) {
      throw new Error(`ไม่สามารถเพิ่มคอลัมน์สำหรับ '${field}' ใน tab ${tabName} ได้`);
    }
  }

  const row = await getRow(spreadsheetId, tabName, rowNumber);
  if (!row) return null;

  const beforeRow = [...row];
  const afterRow = [...row];
  while (afterRow.length < header.length) afterRow.push("");
  const before = beforeRow[columnIndex] ?? "";
  afterRow[columnIndex] = newValue;

  await updateRowValues(spreadsheetId, tabName, rowNumber, afterRow, header.length);
  logEdited(
    actor.userId,
    actor.username,
    website,
    `Edited row #${rowNumber} [${tabName}] ${field}: "${before}" -> "${newValue}"`,
    spreadsheetId,
    rowNumber
  );
  return { before, after: newValue, header, beforeRow, afterRow };
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

  // Safety net: only Super Admin can move rows to a new (non-existent) website.
  if (!isSuperAdmin(actor.userId) && !(await isKnownWebsite(newWebsite))) {
    throw new Error(`ไม่อนุญาตให้สร้างเว็บไซต์ใหม่ '${newWebsite}' — เฉพาะ Admin เท่านั้น`);
  }

  const srcHeader = await getTabHeader(edit.spreadsheetId, edit.tabName);
  const row = await getRow(edit.spreadsheetId, edit.tabName, edit.rowNumber);
  if (!row) return null;

  const platformIndex = columnIndexOfSystem(srcHeader, "Platform");
  const rowPlatform = (platformIndex >= 0 ? row[platformIndex] : "") || edit.tabName;
  const monthIndex = MONTH_NAMES_EN.findIndex((m) => m.toLowerCase() === edit.month.toLowerCase());
  const monthDate = new Date(Number(edit.year), monthIndex >= 0 ? monthIndex : 0, 1);

  const destRefs = await ensureFolderStructure(newWebsite, monthDate, rowPlatform, actor);
  // The destination tab must be wide enough for every field the source row
  // actually holds, or the move would quietly drop columns the destination
  // platform's schema doesn't include.
  const carriedFields = headerToFields(srcHeader).filter(
    (f) => (row[columnIndexOfField(srcHeader, f)] ?? "").trim().length > 0
  );
  const destSheet = await ensureSpreadsheet(
    destRefs.monthFolderId,
    newWebsite,
    edit.month,
    edit.year,
    rowPlatform,
    actor,
    carriedFields
  );

  const newRowNumber = await appendRawRow(destSheet, srcHeader, row);
  await deleteRow(edit.spreadsheetId, edit.tabName, edit.sheetId, edit.rowNumber);

  let photosMoved = 0;
  const photoLinkIndex = columnIndexOfSystem(srcHeader, "Photo Link");
  const photoIds = extractDriveFileIds(photoLinkIndex >= 0 ? row[photoLinkIndex] ?? "" : "");
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

export type FieldTotals = Partial<Record<DataField, number>>;

export interface MonthlyStatusEntry {
  website: string;
  recordCount: number;
  /** Sum of each field, over the rows that actually carry that field. */
  sums: FieldTotals;
  /** How many rows contributed to each sum — the correct divisor for averages. */
  counts: FieldTotals;
}

function accumulate(target: FieldTotals, counts: FieldTotals, field: DataField, value: number): void {
  target[field] = (target[field] ?? 0) + value;
  counts[field] = (counts[field] ?? 0) + 1;
}

/**
 * Monthly totals per website, aggregated across every platform tab.
 *
 * Platforms report different metrics, so a blank cell means "this platform
 * doesn't report this", not "zero". Each field therefore carries its own
 * contributing-row count: sums skip blanks entirely, and an average like CPR
 * divides by the number of rows that actually had a CPR rather than by the
 * total record count (which used to drag the average toward zero as soon as
 * any non-Facebook data existed).
 */
export async function getMonthlyStatus(): Promise<MonthlyStatusEntry[]> {
  const now = new Date();
  const month = MONTH_NAMES_EN[now.getMonth()];
  const year = String(now.getFullYear());

  const websiteFolders = await listChildFolders(config.googleDriveRootFolderId);
  const results: MonthlyStatusEntry[] = [];

  for (const folder of websiteFolders) {
    const spreadsheetId = await findSpreadsheetIdForWebsiteMonth(folder.name, month, year, now);
    if (!spreadsheetId) continue;

    // Read every tab in the file, including the legacy "Data" tab — reads
    // must reflect everything actually stored, whichever code version wrote
    // it. (Writes still never touch the legacy tab.) Each tab is interpreted
    // against its own header, so differing layouts mix safely.
    const tabs = await listSheetTabs(spreadsheetId);

    let recordCount = 0;
    const sums: FieldTotals = {};
    const counts: FieldTotals = {};

    for (const tab of tabs) {
      const { header, rows } = await getTabContents(spreadsheetId, tab.title);
      if (header.length === 0) continue;
      recordCount += rows.length;

      const indices = ALL_DATA_FIELDS.map((field) => [field, columnIndexOfField(header, field)] as const).filter(
        ([, index]) => index >= 0
      );

      for (const row of rows) {
        for (const [field, index] of indices) {
          const num = numericCell(row.values[index] ?? "");
          if (num !== null) accumulate(sums, counts, field, num);
        }
      }
    }

    if (recordCount === 0 && tabs.length === 0) continue;

    results.push({ website: folder.name, recordCount, sums, counts });
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
export interface ListedRow {
  header: string[];
  values: string[];
}

export async function listRows(
  website: string,
  month: string,
  year: string,
  platformFilter?: string
): Promise<{ spreadsheetId: string; rows: ListedRow[] } | null> {
  const monthIndex = MONTH_NAMES_EN.findIndex((m) => m.toLowerCase() === month.toLowerCase());
  const dateForLookup = monthIndex >= 0 ? new Date(Number(year), monthIndex, 1) : new Date();
  const spreadsheetId = await findSpreadsheetIdForWebsiteMonth(website, month, year, dateForLookup);
  if (!spreadsheetId) return null;

  const allTabs = await listSheetTabs(spreadsheetId);
  const filter = platformFilter?.toLowerCase();

  // Rows travel with the header of the tab they came from: a combined
  // listing can span platforms whose tabs have different column layouts, so
  // there is no shared index the caller could read cells by.
  const listed: ListedRow[] = [];
  for (const tab of allTabs) {
    const tabMatches = !filter || tab.title.toLowerCase().includes(filter);
    // The legacy "Data" tab mixes platforms in one table, so a platform
    // filter is applied to its rows' Platform column instead of the tab name.
    const isMixedLegacyTab = tab.title.trim().toLowerCase() === "data";
    if (!tabMatches && !isMixedLegacyTab) continue;

    const { header, rows } = await getTabContents(spreadsheetId, tab.title);
    if (header.length === 0) continue;
    const platformIndex = columnIndexOfSystem(header, "Platform");

    for (const r of rows) {
      const rowPlatform = platformIndex >= 0 ? (r.values[platformIndex] ?? "").toLowerCase() : "";
      if (tabMatches || rowPlatform.includes(filter!)) {
        listed.push({ header, values: r.values });
      }
    }
  }
  return { spreadsheetId, rows: listed };
}
