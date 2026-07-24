import "dotenv/config";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const USERS_FILE = path.join(DATA_DIR, "authorized-users.json");
const GROUPS_FILE = path.join(DATA_DIR, "allowed-groups.json");

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
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
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
  googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "",
  googlePrivateKey: (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  googleDriveRootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? "",
  superAdminId: Number(process.env.SUPER_ADMIN_ID ?? 0),
  logLevel: process.env.LOG_LEVEL ?? "info",
  timezone: "Asia/Bangkok",
  googleApiRequestDelayMs: 1000,
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
