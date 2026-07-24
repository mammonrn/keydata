import "dotenv/config";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const USERS_FILE = path.join(DATA_DIR, "authorized-users.json");
const GROUPS_FILE = path.join(DATA_DIR, "allowed-groups.json");
const ALIASES_FILE = path.join(DATA_DIR, "website-aliases.json");

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

function loadAliases(): AliasMap {
  ensureDataDir();
  if (!fs.existsSync(ALIASES_FILE)) {
    fs.writeFileSync(ALIASES_FILE, JSON.stringify(DEFAULT_ALIASES, null, 2), "utf-8");
    return { ...DEFAULT_ALIASES };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ALIASES_FILE, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const map: AliasMap = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) map[key] = value.map((v) => String(v));
      }
      return map;
    }
    return { ...DEFAULT_ALIASES };
  } catch {
    return { ...DEFAULT_ALIASES };
  }
}

function saveAliases(map: AliasMap): void {
  ensureDataDir();
  fs.writeFileSync(ALIASES_FILE, JSON.stringify(map, null, 2), "utf-8");
}

let websiteAliases = loadAliases();

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
  saveAliases(websiteAliases);
  return { canonical, alias, added: true };
}

export function getWebsiteAliases(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(websiteAliases).map(([k, v]) => [k, [...v]]));
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

export const SHEET_HEADERS = [
  "Row",
  "Date",
  "Platform",
  "Total Message",
  "Total Click",
  "CPR (฿)",
  "Total Spent (฿)",
  "Impressions",
  "Reach",
  "Target Audience",
  "Ads Name",
  "Location",
  "Photo Link",
  "Recorded By",
  "Recorded At",
];

export const DATA_DIR_PATH = DATA_DIR;
