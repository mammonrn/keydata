import "dotenv/config";
import fs from "fs";
import path from "path";
import { ALL_DATA_FIELDS, buildHeader } from "./schema";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const USERS_FILE = path.join(DATA_DIR, "authorized-users.json");
const GROUPS_FILE = path.join(DATA_DIR, "allowed-groups.json");
const ALIASES_FILE = path.join(DATA_DIR, "website-aliases.json");
const PLATFORM_ALIASES_FILE = path.join(DATA_DIR, "platform-aliases.json");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n));
}

function loadJsonList(filePath: string, seed: number[]): number[] {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(seed, null, 2), "utf-8");
    return [...seed];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((n) => Number(n)).filter((n) => !Number.isNaN(n));
    }
    return [...seed];
  } catch {
    return [...seed];
  }
}

function saveJsonList(filePath: string, list: number[]): void {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
}

export const REQUIRED_ENV_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GOOGLE_DRIVE_ROOT_FOLDER_ID",
  "SUPER_ADMIN_ID",
] as const;

export function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `กรุณาตั้งค่าใน .env (ดูตัวอย่างที่ .env.example)`
    );
  }
}

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
  googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
  googleOauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? "",
  googleDriveRootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? "",
  superAdminId: Number(process.env.SUPER_ADMIN_ID ?? 0),
  logLevel: process.env.LOG_LEVEL ?? "info",
  timezone: "Asia/Bangkok",
  // Google Sheets quota is 60 read + 60 write requests/min/user; a save is a
  // short burst of a handful of calls, so 250ms spacing stays far inside the
  // per-minute window. withRetry's exponential backoff handles any 429.
  googleApiRequestDelayMs: 250,
  googleApiMaxRetries: 3,
};

let authorizedUsers = loadJsonList(USERS_FILE, [
  config.superAdminId,
  ...parseIdList(process.env.AUTHORIZED_USERS),
]);
let allowedGroups = loadJsonList(GROUPS_FILE, parseIdList(process.env.ALLOWED_GROUP_IDS));

export function isSuperAdmin(userId: number): boolean {
  return userId === config.superAdminId;
}

export function isAuthorizedUser(userId: number): boolean {
  return isSuperAdmin(userId) || authorizedUsers.includes(userId);
}

export function isAllowedGroup(chatId: number): boolean {
  return allowedGroups.includes(chatId);
}

export function getAuthorizedUsers(): number[] {
  return [...authorizedUsers];
}

export function getAllowedGroups(): number[] {
  return [...allowedGroups];
}

export function addAuthorizedUser(userId: number): boolean {
  if (authorizedUsers.includes(userId)) return false;
  authorizedUsers.push(userId);
  saveJsonList(USERS_FILE, authorizedUsers);
  return true;
}

export function removeAuthorizedUser(userId: number): boolean {
  if (!authorizedUsers.includes(userId)) return false;
  authorizedUsers = authorizedUsers.filter((id) => id !== userId);
  saveJsonList(USERS_FILE, authorizedUsers);
  return true;
}

export function addAllowedGroup(chatId: number): boolean {
  if (allowedGroups.includes(chatId)) return false;
  allowedGroups.push(chatId);
  saveJsonList(GROUPS_FILE, allowedGroups);
  return true;
}

export function removeAllowedGroup(chatId: number): boolean {
  if (!allowedGroups.includes(chatId)) return false;
  allowedGroups = allowedGroups.filter((id) => id !== chatId);
  saveJsonList(GROUPS_FILE, allowedGroups);
  return true;
}

// ===== Website alias normalization =====
// Staff type the same brand inconsistently (shwe666 vs SH666); without a
// canonical mapping each spelling would get its own Drive folder and sheets.

type AliasMap = Record<string, string[]>;

const DEFAULT_ALIASES: AliasMap = {
  SH666: ["shwe666", "sh666"],
  UB89: ["ubet89", "ub89"],
  "88F": ["88fed", "88f"],
};

const DEFAULT_PLATFORM_ALIASES: AliasMap = {
  Facebook: ["facebook", "fb", "FB", "Facebook Ads", "facebook ads"],
  TikTok: ["tiktok", "Tiktok", "TIKTOK", "tik tok", "TikTok Ads", "tiktok ads"],
  Telegram: ["telegram", "TELEGRAM", "tg", "TG", "Telegram Ads", "telegram ads"],
  Google: ["google", "Google Ads", "google ads"],
  Instagram: ["instagram", "ig", "IG"],
  LINE: ["line", "Line"],
  YouTube: ["youtube", "Youtube", "yt", "YT"],
};

function deduplicateAliasMap(map: AliasMap, defaults: AliasMap): AliasMap {
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(map)) {
    const lc = key.toLowerCase();
    const list = groups.get(lc) ?? [];
    list.push(key);
    groups.set(lc, list);
  }

  const result: AliasMap = {};
  for (const [lc, keys] of groups) {
    const defKey = Object.keys(defaults).find((d) => d.toLowerCase() === lc);
    const canonical = keys.find((k) => k === defKey) ?? defKey ?? keys[0];

    const seen = new Set<string>();
    seen.add(canonical.toLowerCase());
    const aliases: string[] = [];

    for (const key of keys) {
      if (key !== canonical && !seen.has(key.toLowerCase())) {
        aliases.push(key);
        seen.add(key.toLowerCase());
      }
      for (const a of map[key]) {
        if (!seen.has(a.toLowerCase())) {
          aliases.push(a);
          seen.add(a.toLowerCase());
        }
      }
    }
    result[canonical] = aliases;
  }
  return result;
}

function loadAliasMap(filePath: string, defaults: AliasMap): AliasMap {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), "utf-8");
    return { ...defaults };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const map: AliasMap = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) map[key] = value.map((v) => String(v));
      }
      const deduped = deduplicateAliasMap(map, defaults);
      if (JSON.stringify(deduped) !== JSON.stringify(map)) {
        saveAliasMap(filePath, deduped);
      }
      return deduped;
    }
    return { ...defaults };
  } catch {
    return { ...defaults };
  }
}

function saveAliasMap(filePath: string, map: AliasMap): void {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(map, null, 2), "utf-8");
}

let websiteAliases = loadAliasMap(ALIASES_FILE, DEFAULT_ALIASES);
let platformAliases = loadAliasMap(PLATFORM_ALIASES_FILE, DEFAULT_PLATFORM_ALIASES);

// Same forbidden-character strip as drive.ts sanitizeName (duplicated here
// because drive.ts imports this module).
function sanitizeWebsiteInput(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").trim();
}

/**
 * Maps any spelling of a website to its canonical name (case-insensitive
 * against canonical names and their aliases). Unknown names pass through
 * sanitized as-is — they're treated as new websites with no aliases yet.
 */
export function normalizeWebsiteName(input: string): string {
  const sanitized = sanitizeWebsiteInput(input);
  const lc = sanitized.toLowerCase();
  if (!lc) return sanitized;
  for (const [canonical, aliases] of Object.entries(websiteAliases)) {
    if (canonical.toLowerCase() === lc) return canonical;
    if (aliases.some((a) => a.toLowerCase() === lc)) return canonical;
  }
  return sanitized;
}

export function addWebsiteAlias(canonicalRaw: string, aliasRaw: string): { canonical: string; alias: string; added: boolean } {
  const canonicalInput = sanitizeWebsiteInput(canonicalRaw);
  const alias = sanitizeWebsiteInput(aliasRaw);
  const existingKey = Object.keys(websiteAliases).find((k) => k.toLowerCase() === canonicalInput.toLowerCase());
  const canonical = existingKey ?? canonicalInput;

  if (!websiteAliases[canonical]) websiteAliases[canonical] = [];
  if (websiteAliases[canonical].some((a) => a.toLowerCase() === alias.toLowerCase())) {
    return { canonical, alias, added: false };
  }
  websiteAliases[canonical].push(alias);
  saveAliasMap(ALIASES_FILE, websiteAliases);
  return { canonical, alias, added: true };
}

export function isCanonicalWebsite(normalizedName: string): boolean {
  const lc = normalizedName.toLowerCase();
  return Object.keys(websiteAliases).some((k) => k.toLowerCase() === lc);
}

export function getWebsiteAliases(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(websiteAliases).map(([k, v]) => [k, [...v]]));
}

// ===== Platform alias normalization =====

export function normalizePlatformName(input: string): string {
  const sanitized = sanitizeWebsiteInput(input);
  const lc = sanitized.toLowerCase();
  if (!lc) return sanitized;
  for (const [canonical, aliases] of Object.entries(platformAliases)) {
    if (canonical.toLowerCase() === lc) return canonical;
    if (aliases.some((a) => a.toLowerCase() === lc)) return canonical;
  }
  return sanitized;
}

export function isCanonicalPlatform(normalizedName: string): boolean {
  const lc = normalizedName.toLowerCase();
  return Object.keys(platformAliases).some((k) => k.toLowerCase() === lc);
}

export function listCanonicalPlatforms(): string[] {
  return Object.keys(platformAliases);
}

export function registerPlatformIfNew(name: string): void {
  if (isCanonicalPlatform(name)) return;
  platformAliases[name] = [];
  saveAliasMap(PLATFORM_ALIASES_FILE, platformAliases);
}

export function addPlatformAlias(canonicalRaw: string, aliasRaw: string): { canonical: string; alias: string; added: boolean } {
  const canonicalInput = sanitizeWebsiteInput(canonicalRaw);
  const alias = sanitizeWebsiteInput(aliasRaw);
  const existingKey = Object.keys(platformAliases).find((k) => k.toLowerCase() === canonicalInput.toLowerCase());
  const canonical = existingKey ?? canonicalInput;

  if (!platformAliases[canonical]) platformAliases[canonical] = [];
  if (platformAliases[canonical].some((a) => a.toLowerCase() === alias.toLowerCase())) {
    return { canonical, alias, added: false };
  }
  platformAliases[canonical].push(alias);
  saveAliasMap(PLATFORM_ALIASES_FILE, platformAliases);
  return { canonical, alias, added: true };
}

export function getPlatformAliases(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(platformAliases).map(([k, v]) => [k, [...v]]));
}

export const MONTH_NAMES_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export * from "./schema";

// The widest layout the system can produce — every known field. Used as the
// fallback header for platforms with no explicit schema; per-platform layouts
// come from schemaForPlatform()/resolveTargetHeader() instead.
export const SHEET_HEADERS = buildHeader(ALL_DATA_FIELDS);

export const DATA_DIR_PATH = DATA_DIR;
