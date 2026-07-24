import { AdsData } from "../types";
import { MONTH_NAMES_EN, config } from "../config";
import { ensureFolderStructure, listChildFolders, uploadPhoto } from "../google/drive";
import { appendRow, deleteRow, ensureSpreadsheet, findSpreadsheetIdForWebsiteMonth, getAllRows, getRow, updateRowValues } from "../google/sheets";
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
  photo: PhotoInput | undefined,
  actor: Actor
): Promise<SaveResult> {
  const dateObj = parseThaiDate(data.date);
  const year = String(dateObj.getFullYear());
  const month = MONTH_NAMES_EN[dateObj.getMonth()];

  const refs = await ensureFolderStructure(data.website, dateObj, actor);
  const spreadsheetId = await ensureSpreadsheet(refs.monthFolderId, data.website, month, year, actor);

  let photoLink: string | undefined;
  if (photo) {
    photoLink = await uploadPhoto(refs.photosFolderId, photo.filename, photo.mimeType, photo.buffer);
    logPhotoUploaded(actor.userId, actor.username, data.website, `Uploaded photo: ${photo.filename}`);
  }

  const recordedBy = actor.username ? `@${actor.username}` : String(actor.userId);
  const finalData: AdsData = {
    ...data,
    photoLink,
    recordedBy,
    recordedAt: nowBangkok(),
  };

  const rowNumber = await appendRow(spreadsheetId, finalData);
  logRecorded(actor.userId, actor.username, data.website, `Recorded row #${rowNumber} in ${data.website}_${month}_${year}`, spreadsheetId, rowNumber);

  return { spreadsheetId, rowNumber, photoLink, website: data.website, month, year };
}

export async function findSheetForCurrentMonth(website: string): Promise<{ spreadsheetId: string; month: string; year: string } | null> {
  const now = new Date();
  const month = MONTH_NAMES_EN[now.getMonth()];
  const year = String(now.getFullYear());
  const spreadsheetId = await findSpreadsheetIdForWebsiteMonth(website, month, year, now);
  if (!spreadsheetId) return null;
  return { spreadsheetId, month, year };
}

export async function editRowField(
  spreadsheetId: string,
  rowNumber: number,
  fieldIndex: number,
  newValue: string,
  actor: Actor,
  website: string
): Promise<{ before: string[]; after: string[] } | null> {
  const row = await getRow(spreadsheetId, rowNumber);
  if (!row) return null;
  const before = [...row];
  const after = [...row];
  after[fieldIndex] = newValue;
  await updateRowValues(spreadsheetId, rowNumber, after);
  logEdited(
    actor.userId,
    actor.username,
    website,
    `Edited row #${rowNumber}: "${before[fieldIndex]}" -> "${newValue}"`,
    spreadsheetId,
    rowNumber
  );
  return { before, after };
}

export async function deleteRowWithLog(spreadsheetId: string, rowNumber: number, actor: Actor, website: string): Promise<string[] | null> {
  const snapshot = await getRow(spreadsheetId, rowNumber);
  if (!snapshot) return null;
  await deleteRow(spreadsheetId, rowNumber);
  logDeleted(actor.userId, actor.username, website, `Deleted row #${rowNumber}: ${JSON.stringify(snapshot)}`, spreadsheetId, rowNumber);
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
    const rows = await getAllRows(spreadsheetId);
    const recordCount = rows.length;

    let totalMessageSum = 0;
    let cprSum = 0;
    let totalSpentSum = 0;
    let impressionsSum = 0;
    let reachSum = 0;

    for (const row of rows) {
      // row.values indices: [1]=Date [2]=Platform [3]=TotalMessage [4]=CPR [5]=TotalSpent [6]=Impressions [7]=Reach
      totalMessageSum += toNumber(row.values[3]);
      cprSum += toNumber(row.values[4]);
      totalSpentSum += toNumber(row.values[5]);
      impressionsSum += toNumber(row.values[6]);
      reachSum += toNumber(row.values[7]);
    }

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

  const rows = await getAllRows(spreadsheetId);
  let values = rows.map((r) => r.values);
  if (platformFilter) {
    values = values.filter((v) => (v[2] ?? "").toLowerCase().includes(platformFilter.toLowerCase()));
  }
  return { spreadsheetId, rows: values };
}
