import { Readable } from "stream";
import { config, isCanonicalWebsite, MONTH_NAMES_EN } from "../config";
import { DriveFolderRefs } from "../types";
import { getDriveClient, throttle, withRetry } from "./auth";
import { logError, logFolderCreated } from "../services/logger";

export function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").trim();
}

function httpStatusOf(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const candidate of [e?.code, e?.status, e?.response?.status]) {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

/**
 * Whether an id still points at a file that is neither trashed nor deleted.
 *
 * One call covers a whole ancestor chain: Drive's `trashed` field is true for
 * a file that was trashed *or* whose parent folder was trashed, so a live
 * leaf folder proves every folder above it is live too.
 *
 * A 404 is a definitive answer (the file is gone for good), so it returns
 * false immediately rather than burning the retry backoff on it. Any other
 * error is treated as transient and retried — and if it still fails, it
 * propagates. Guessing "probably fine" on an unclear error is what produced
 * this bug class in the first place; a failed save the user is told about is
 * strictly better than a successful-looking save into the Trash.
 */
export async function isLive(fileId: string): Promise<boolean> {
  const drive = getDriveClient();
  const fetchTrashed = () => drive.files.get({ fileId, fields: "trashed" });
  let res;
  try {
    res = await fetchTrashed();
  } catch (err) {
    if (httpStatusOf(err) === 404) return false;
    res = await withRetry(fetchTrashed);
  }
  await throttle();
  return res.data.trashed !== true;
}

/**
 * Backstop for the exact failure this bug was made of: Drive accepts a
 * create call whose parent is in the Trash, returns success, and marks the
 * new file trashed on the way in — so the bot reported "saved" while nothing
 * was visible in Drive.
 *
 * Cache revalidation should stop us ever getting here. If we do, restoring
 * only works when the parent is live (otherwise the file re-inherits trashed
 * and the update reflects that), so a restore that reports `trashed: false`
 * is a real recovery. When it can't be recovered we throw: surfacing the
 * error to the user is the whole point, since silently continuing is what
 * made the data loss invisible.
 */
async function assertNotBornTrashed(fileId: string, trashed: boolean | null | undefined, what: string): Promise<void> {
  if (trashed !== true) return;

  logError(0, undefined, `Newly created ${what} (${fileId}) came back trashed — its parent folder is in the Trash. Attempting to restore.`);
  try {
    const res = await withRetry(() =>
      getDriveClient().files.update({ fileId, requestBody: { trashed: false }, fields: "trashed" })
    );
    await throttle();
    if (res.data.trashed !== true) {
      logError(0, undefined, `Restored ${what} (${fileId}) out of the Trash successfully.`);
      return;
    }
  } catch (err) {
    logError(0, undefined, `Failed to restore ${what} (${fileId}) from the Trash: ${String(err)}`);
  }

  throw new Error(
    `สร้าง ${what} แล้วถูกย้ายเข้า Trash อัตโนมัติ (โฟลเดอร์แม่อยู่ใน Trash) — ` +
      `ยกเลิกการบันทึกเพื่อไม่ให้ข้อมูลหายไปเงียบๆ กรุณาตรวจสอบ/กู้คืน Google Drive Trash แล้วลองใหม่`
  );
}

export { assertNotBornTrashed };

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
      fields: "id, trashed",
    })
  );
  await throttle();
  if (!res.data.id) throw new Error(`Failed to create folder: ${name}`);
  await assertNotBornTrashed(res.data.id, res.data.trashed, `โฟลเดอร์ "${name}"`);
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
  websiteListCache = null;
}

/** Forgets a folder and everything cached beneath it. */
function dropCachedSubtree(pathPrefix: string): void {
  const prefix = pathPrefix.toLowerCase();
  for (const key of [...folderIdCache.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}/`)) folderIdCache.delete(key);
  }
}

/**
 * Makes sure the cached folder chain still exists before anything is created
 * inside it.
 *
 * A cached id is not self-invalidating: trashing a website folder in the
 * Drive UI leaves the cache happily pointing at it, and because Drive accepts
 * creates under a trashed parent (silently trashing the new child), every
 * later save reported success while writing into the Trash. Re-resolving is
 * not enough on its own either — a `trashed = false` lookup under a trashed
 * parent finds nothing and then *creates* a replacement that is itself born
 * trashed. So the whole subtree has to be dropped and rebuilt from the root,
 * which is never trashed.
 *
 * Cost is one `files.get` per save: only the deepest cached folder is
 * checked, because `trashed` propagates down from an ancestor, so that single
 * answer clears the entire chain. A cold cache needs no check at all — every
 * lookup is already a fresh `trashed = false` query.
 */
async function revalidateCachedChain(chainKeys: string[], website: string, actorId: number): Promise<void> {
  let deepest: { key: string; id: string } | undefined;
  for (const key of chainKeys) {
    const id = folderIdCache.get(key.toLowerCase());
    if (id) deepest = { key, id };
  }
  if (!deepest) return;
  if (await isLive(deepest.id)) return;

  logError(
    actorId,
    undefined,
    `Cached Drive folder "${deepest.key}" (${deepest.id}) is trashed or missing — dropping cached ids under "${website}" and rebuilding the folder chain`,
    website
  );
  dropCachedSubtree(website);
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

  // Shallow -> deep, so revalidation can pick the deepest cached entry.
  await revalidateCachedChain(
    [
      safeWebsite,
      `${safeWebsite}/${year}`,
      `${safeWebsite}/${year}/${month}`,
      `${safeWebsite}/${year}/${month}/Photos`,
      `${safeWebsite}/${year}/${month}/Photos/${safePlatform}`,
    ],
    safeWebsite,
    actor?.userId ?? 0
  );

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
      fields: "id, webViewLink, trashed",
    })
  );
  await throttle();

  const fileId = res.data.id;
  if (!fileId) throw new Error("Failed to upload photo to Google Drive");
  await assertNotBornTrashed(fileId, res.data.trashed, `รูป "${filename}"`);

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
