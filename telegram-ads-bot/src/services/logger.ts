import fs from "fs";
import path from "path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { config } from "../config";
import { LogEntry } from "../types";

const LOGS_DIR = path.join(__dirname, "..", "..", "logs");
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const rotateTransport = new DailyRotateFile({
  dirname: LOGS_DIR,
  filename: "bot_%DATE%.log",
  datePattern: "YYYY-MM-DD",
  zippedArchive: false,
  maxFiles: "90d",
});

const winstonLogger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.json(),
  transports: [
    rotateTransport,
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

function bangkokTimestamp(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+07:00`;
}

export function nowBangkok(): string {
  return bangkokTimestamp();
}

function writeLog(entry: Omit<LogEntry, "timestamp">): void {
  const full: LogEntry = { timestamp: bangkokTimestamp(), ...entry };
  winstonLogger.info(full);
}

export function logRecorded(userId: number, username: string | undefined, website: string, details: string, sheetId?: string, rowNumber?: number): void {
  writeLog({ action: "DATA_RECORDED", user_id: userId, username, website, details, sheet_id: sheetId, row_number: rowNumber });
}

export function logEdited(userId: number, username: string | undefined, website: string, details: string, sheetId?: string, rowNumber?: number): void {
  writeLog({ action: "DATA_EDITED", user_id: userId, username, website, details, sheet_id: sheetId, row_number: rowNumber });
}

export function logDeleted(userId: number, username: string | undefined, website: string, details: string, sheetId?: string, rowNumber?: number): void {
  writeLog({ action: "DATA_DELETED", user_id: userId, username, website, details, sheet_id: sheetId, row_number: rowNumber });
}

/**
 * Records both halves of the duplicate flow — the detection and what the user
 * decided about it — under one action, so `grep DATA_DUPLICATE` answers "how
 * often does this fire, and how often do people save anyway?" in one pass.
 */
export function logDuplicate(userId: number, username: string | undefined, website: string, details: string, sheetId?: string, rowNumber?: number): void {
  writeLog({ action: "DATA_DUPLICATE", user_id: userId, username, website, details, sheet_id: sheetId, row_number: rowNumber });
}

export function logPhotoUploaded(userId: number, username: string | undefined, website: string, details: string): void {
  writeLog({ action: "PHOTO_UPLOADED", user_id: userId, username, website, details });
}

export function logFolderCreated(userId: number, username: string | undefined, website: string, details: string): void {
  writeLog({ action: "FOLDER_CREATED", user_id: userId, username, website, details });
}

export function logSheetCreated(userId: number, username: string | undefined, website: string, details: string, sheetId?: string): void {
  writeLog({ action: "SHEET_CREATED", user_id: userId, username, website, details, sheet_id: sheetId });
}

export function logError(userId: number, username: string | undefined, details: string, website?: string): void {
  writeLog({ action: "ERROR", user_id: userId, username, website, details });
}

export function logCommand(userId: number, username: string | undefined, details: string): void {
  writeLog({ action: "USER_COMMAND", user_id: userId, username, details });
}

export function logUnauthorized(userId: number, username: string | undefined, details: string): void {
  writeLog({ action: "UNAUTHORIZED_ACCESS", user_id: userId, username, details });
}

export function getRecentLogs(limit: number, filterUserId?: number): LogEntry[] {
  const files = fs
    .readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith("bot_") && f.endsWith(".log"))
    .sort()
    .reverse();

  const entries: LogEntry[] = [];
  for (const file of files) {
    if (entries.length >= limit * 5) break;
    const content = fs.readFileSync(path.join(LOGS_DIR, file), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.timestamp && parsed.action) {
          entries.push(parsed as LogEntry);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  const filtered = filterUserId !== undefined ? entries.filter((e) => e.user_id === filterUserId) : entries;
  filtered.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return filtered.slice(0, limit);
}
