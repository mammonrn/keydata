import { Readable } from "stream";
import { config, isCanonicalWebsite, MONTH_NAMES_EN } from "../config";
import { DriveFolderRefs } from "../types";
import { getDriveClient, throttle, withRetry } from "./auth";
import { logFolderCreated } from "../services/logger";

export function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").trim();
}

/**
 * Locates a child folder by name, case-insensitively.
 *
 * Drive's `name = '...'` query is case-sensitive, and — unlike Sheets tabs —
 * Drive happily allows two folders with names differing only in case. So a
 * case-sensitive lookup does not fail loudly here; it quietly creates a
 * second "TikTok" beside an existing "Tiktok" and splits that platform's
 * photos across both. The exact-match query stays as the one-call fast path;
 * only when it misses do we list the parent's folders (a small set — years,
 * months, platforms) and re-check ignoring case.
 */
async function findFolder(parentId: string, name: string): Promise<string | null> {
  const drive = getDriveClient();
  const safeName = name.replace(/'/g, "\\'");
  const res = await withRetry(() =>
    drive.files.list({
      q: `'${parentId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
    })
  );
  await throttle();
  const files = res.data.files ?? [];
  if (files.length > 0 && files[0].id) return files[0].id;

  const siblings = await listChildFolders(parentId);
  const wanted = name.trim().toLowerCase();
  return siblings.find((f) => f.name.trim().toLowerCase() === wanted)?.id ?? null;
}

async function createFolder(parentId: string, name: string): Promise<string> {
  const drive = getDriveClient();
  const res = await withRetry(() =>
    drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
    })
  );
  await throttle();
  if (!res.data.id) throw new Error(`Failed to create folder: ${name}`);
  return res.data.id;
}

async function findOrCreateFolder(
  parentId: string,
  name: string,
  onCreated?: (folderId: string) => void
): Promise<string> {
  const existing = await findFolder(parentId, name);
  if (existing) return existing;
  const created = await createFolder(parentId, name);
  onCreated?.(created);
  return created;
}

// Folder ids are stable, so resolving Website/Year/Month/Photos/Platform
// via the API on every single save (5 requests + throttles) is wasted
// latency. Cache per path; cleared on save errors so a manually deleted
// folder is re-resolved on the next attempt.
const folderIdCache = new Map<string, string>();

export function clearDriveCaches(): void {
  folderIdCache.clear();
}

async function findOrCreateFolderCached(
  cacheKey: string,
  parentId: string,
  name: string,
  onCreated?: (folderId: string) => void
): Promise<string> {
  // Lower-cased so two spellings of the same folder ("TikTok"/"Tiktok"),
  // which findFolder now resolves to one folder, share one cache entry.
  const key = cacheKey.toLowerCase();
  const hit = folderIdCache.get(key);
  if (hit) return hit;
  const id = await findOrCreateFolder(parentId, name, onCreated);
  folderIdCache.set(key, id);
  return id;
}

export async function listChildFolders(parentId: string): Promise<{ id: string; name: string }[]> {
  const drive = getDriveClient();
  const res = await withRetry(() =>
    drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
    })
  );
  await throttle();
  return (res.data.files ?? [])
    .filter((f) => f.id && f.name)
    .map((f) => ({ id: f.id as string, name: f.name as string }));
}

// Websites are exactly the top-level folders under the Drive root. Cached
// briefly so the website-picker keyboard doesn't cost an API call per ask.
let websiteListCache: { names: string[]; at: number } | null = null;
const WEBSITE_LIST_TTL_MS = 10 * 60 * 1000;

export async function listKnownWebsites(): Promise<string[]> {
  if (websiteListCache && Date.now() - websiteListCache.at < WEBSITE_LIST_TTL_MS) {
    return websiteListCache.names;
  }
  const folders = await listChildFolders(config.googleDriveRootFolderId);
  const names = folders.map((f) => f.name).filter((n) => n.length > 0);
  websiteListCache = { names, at: Date.now() };
  return names;
}

export async function isKnownWebsite(normalizedName: string): Promise<boolean> {
  if (isCanonicalWebsite(normalizedName)) return true;
  try {
    const folders = await listKnownWebsites();
    return folders.some((f) => f.toLowerCase() === normalizedName.toLowerCase());
  } catch {
    return false;
  }
}

export async function findMonthFolder(website: string, date: Date): Promise<string | null> {
  const safeWebsite = sanitizeName(website);
  const year = String(date.getFullYear());
  const month = MONTH_NAMES_EN[date.getMonth()];

  const websiteFolderId = await findFolder(config.googleDriveRootFolderId, safeWebsite);
  if (!websiteFolderId) return null;
  const yearFolderId = await findFolder(websiteFolderId, year);
  if (!yearFolderId) return null;
  return findFolder(yearFolderId, month);
}

export async function ensureFolderStructure(
  website: string,
  date: Date,
  platform: string,
  actor?: { userId: number; username?: string }
): Promise<DriveFolderRefs> {
  const safeWebsite = sanitizeName(website);
  const safePlatform = sanitizeName(platform) || "Unknown";
  const year = String(date.getFullYear());
  const month = MONTH_NAMES_EN[date.getMonth()];

  const websiteFolderId = await findOrCreateFolderCached(safeWebsite, config.googleDriveRootFolderId, safeWebsite, () => {
    if (actor) logFolderCreated(actor.userId, actor.username, safeWebsite, `Created website folder: ${safeWebsite}`);
  });

  const yearFolderId = await findOrCreateFolderCached(`${safeWebsite}/${year}`, websiteFolderId, year, () => {
    if (actor) logFolderCreated(actor.userId, actor.username, safeWebsite, `Created year folder: ${safeWebsite}/${year}`);
  });

  const monthFolderId = await findOrCreateFolderCached(`${safeWebsite}/${year}/${month}`, yearFolderId, month, () => {
    if (actor) logFolderCreated(actor.userId, actor.username, safeWebsite, `Created month folder: ${safeWebsite}/${year}/${month}`);
  });

  const photosFolderId = await findOrCreateFolderCached(`${safeWebsite}/${year}/${month}/Photos`, monthFolderId, "Photos", () => {
    if (actor) logFolderCreated(actor.userId, actor.username, safeWebsite, `Created Photos folder: ${safeWebsite}/${year}/${month}/Photos`);
  });

  // Photos are grouped per platform: Photos/{Platform}/. The returned
  // photosFolderId points at the platform subfolder, which is where all
  // uploads for this record belong.
  const platformPhotosFolderId = await findOrCreateFolderCached(
    `${safeWebsite}/${year}/${month}/Photos/${safePlatform}`,
    photosFolderId,
    safePlatform,
    () => {
      if (actor)
        logFolderCreated(actor.userId, actor.username, safeWebsite, `Created platform photos folder: ${safeWebsite}/${year}/${month}/Photos/${safePlatform}`);
    }
  );

  return { websiteFolderId, yearFolderId, monthFolderId, photosFolderId: platformPhotosFolderId };
}

/**
 * Re-parents a Drive file into a new folder. The file id (and therefore its
 * webViewLink) is unchanged by a move, so sheet Photo Link cells stay valid.
 */
export async function moveFileToFolder(fileId: string, newParentId: string): Promise<void> {
  const drive = getDriveClient();
  const file = await withRetry(() => drive.files.get({ fileId, fields: "parents" }));
  await throttle();
  const previousParents = (file.data.parents ?? []).join(",");
  await withRetry(() =>
    drive.files.update({
      fileId,
      addParents: newParentId,
      removeParents: previousParents,
      fields: "id, parents",
    })
  );
  await throttle();
}

export async function uploadPhoto(photosFolderId: string, filename: string, mimeType: string, buffer: Buffer): Promise<string> {
  const drive = getDriveClient();
  const stream = Readable.from(buffer);
  const res = await withRetry(() =>
    drive.files.create({
      requestBody: {
        name: sanitizeName(filename),
        parents: [photosFolderId],
      },
      media: {
        mimeType,
        body: stream,
      },
      fields: "id, webViewLink",
    })
  );
  await throttle();

  const fileId = res.data.id;
  if (!fileId) throw new Error("Failed to upload photo to Google Drive");

  await withRetry(() =>
    drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    })
  );
  await throttle();

  // The create call already returned webViewLink — no need for a third
  // request just to read it back.
  return res.data.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`;
}
