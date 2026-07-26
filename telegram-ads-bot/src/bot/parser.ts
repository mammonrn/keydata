import { AdsData, REQUIRED_FIELDS, RequiredField } from "../types";

type NumericField =
  | "totalMessage"
  | "totalClick"
  | "cpr"
  | "totalSpent"
  | "impressions"
  | "reach"
  | "views"
  | "mainBudget"
  | "joined";
type TextField =
  | "date"
  | "targetAudience"
  | "adsName"
  | "location"
  | "runningCampaign"
  | "website"
  | "platform";

const NUMERIC_FIELDS: NumericField[] = [
  "totalMessage",
  "totalClick",
  "cpr",
  "totalSpent",
  "impressions",
  "reach",
  "views",
  "mainBudget",
  "joined",
];

const FIELD_ALIASES: Record<string, TextField | NumericField> = {
  date: "date",
  totalmessage: "totalMessage",
  total: "totalMessage",
  messages: "totalMessage",
  message: "totalMessage",
  // TikTok/Telegram report a bare "Click"/"Clicks"; that is the same quantity
  // Facebook records as "Total Click", so it maps to the existing field
  // rather than adding a second clicks column that means the same thing.
  totalclick: "totalClick",
  click: "totalClick",
  clicks: "totalClick",
  "จำนวนคลิก": "totalClick",
  "คลิก": "totalClick",
  "ยอดคลิก": "totalClick",
  cpr: "cpr",
  costperresult: "cpr",
  // "Spent budget" (TikTok/Telegram) is the same money-actually-spent value
  // Facebook calls "Total Spent" — one shared field, several spellings.
  totalspent: "totalSpent",
  spentbudget: "totalSpent",
  spent: "totalSpent",
  spend: "totalSpent",
  budget: "totalSpent",
  "ยอดใช้จ่าย": "totalSpent",
  "งบที่ใช้": "totalSpent",
  impressions: "impressions",
  impression: "impressions",
  reach: "reach",
  // Views counts people who actually watched; Impressions counts times the
  // ad was served. Deliberately separate fields.
  views: "views",
  view: "views",
  "วิว": "views",
  "ยอดวิว": "views",
  "จำนวนวิว": "views",
  // Main Budget is the allocated budget; it coexists with Spent Budget in a
  // Telegram report, so it cannot be folded into totalSpent.
  mainbudget: "mainBudget",
  "งบหลัก": "mainBudget",
  "งบทั้งหมด": "mainBudget",
  runningcampaign: "runningCampaign",
  "แคมเปญ": "runningCampaign",
  "แคมเปญที่รัน": "runningCampaign",
  joined: "joined",
  "เข้าร่วม": "joined",
  "ยอดเข้าร่วม": "joined",
  targetaudience: "targetAudience",
  audience: "targetAudience",
  target: "targetAudience",
  adsname: "adsName",
  adname: "adsName",
  campaignname: "adsName",
  name: "adsName",
  location: "location",
  area: "location",
  website: "website",
  brand: "website",
  web: "website",
  site: "website",
  platform: "platform",
  channel: "platform",
};

// Keeps Thai characters (U+0E00-U+0E7F) alongside ASCII letters/digits so
// Thai-language aliases (e.g. "จำนวนคลิก") can match FIELD_ALIASES above —
// a plain [^a-z0-9] strip would previously erase Thai text entirely.
function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9฀-๿]/g, "");
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

function fuzzyMatchField(normalizedKey: string): (TextField | NumericField) | undefined {
  if (normalizedKey.length < 3) return undefined;
  const maxDist = normalizedKey.length <= 4 ? 1 : 2;
  let bestField: (TextField | NumericField) | undefined;
  let bestDist = maxDist + 1;
  let ambiguous = false;

  for (const [alias, field] of Object.entries(FIELD_ALIASES)) {
    if (Math.abs(normalizedKey.length - alias.length) > maxDist) continue;
    const dist = levenshteinDistance(normalizedKey, alias);
    if (dist < bestDist) {
      bestDist = dist;
      bestField = field;
      ambiguous = false;
    } else if (dist === bestDist && field !== bestField) {
      ambiguous = true;
    }
  }

  return ambiguous ? undefined : bestField;
}

function cleanNumber(raw: string): number | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/bath|baht|฿|บาท/g, "")
    .replace(/,/g, "")
    .trim();
  // "39.64k" means 39,640 here, matching parseStrictNumericAnswer — the two
  // parsers must agree on units or the same value would record differently
  // depending on whether it arrived in a full message or a Q&A answer.
  const kMatch = cleaned.match(/^(-?\d+(\.\d+)?)\s*k$/);
  if (kMatch) {
    return Number(kMatch[1]) * 1000;
  }
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isNaN(num) ? null : num;
}

/**
 * Strict numeric parser for single-field Q&A answers (as opposed to
 * cleanNumber, which is intentionally loose for full-message line parsing).
 * Only accepts text that, once units/commas are stripped, is *purely* a
 * number — so a stray full-message line like "Date : 23/7/2026" typed by
 * mistake in reply to "Total Message?" is rejected instead of silently
 * extracting "23".
 */
export function parseStrictNumericAnswer(raw: string): number | null {
  let cleaned = raw.trim().toLowerCase();
  cleaned = cleaned.replace(/bath|baht|฿|บาท/g, "");
  cleaned = cleaned.replace(/,/g, "");
  cleaned = cleaned.trim();

  const kMatch = cleaned.match(/^(-?\d+(\.\d+)?)\s*k$/);
  if (kMatch) {
    return Number(kMatch[1]) * 1000;
  }

  if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return Number(cleaned);
  }

  return null;
}

const DATE_DMY = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/;
const DATE_YMD = /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/;

/**
 * Accepts a date written with /, . or - separators (23/7/2026, 23.7.2026,
 * 23-7-2026, 2026-7-23) and normalizes it to DD/MM/YYYY. Returns null for
 * anything that is not a recognizable date, which doubles as validation for
 * date answers in the Q&A flow.
 */
export function normalizeDateString(raw: string): string | null {
  const trimmed = raw.trim();
  let day: number;
  let month: number;
  let year: number;

  const dmy = trimmed.match(DATE_DMY);
  if (dmy) {
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = Number(dmy[3]);
  } else {
    const ymd = trimmed.match(DATE_YMD);
    if (!ymd) return null;
    year = Number(ymd[1]);
    month = Number(ymd[2]);
    day = Number(ymd[3]);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

const SKIP_KEYWORDS = ["ไม่มี", "ไม่ต้องใส่", "ไม่ใส่", "none", "n/a", "na", "-"];

export function isSkipAnswer(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return SKIP_KEYWORDS.some((kw) => normalized === kw.toLowerCase());
}

export interface ParseResult {
  data: Partial<AdsData>;
  missingRequired: RequiredField[];
  leftoverLines: string[];
}

export function parseAdsMessage(rawText: string): ParseResult {
  const data: Partial<AdsData> = {};
  const lines = rawText.split(/\r?\n/);
  const matchedLineIndices = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s*([^:：]+)[:：](.+)$/)
               ?? line.match(/^\s*(.+?)\s+-\s+(.+)$/);
    if (!match) continue;
    const keyRaw = match[1];
    const valueRaw = match[2].trim();
    if (!valueRaw) continue;

    const normalizedKey = normalizeKey(keyRaw);
    const field = FIELD_ALIASES[normalizedKey] ?? fuzzyMatchField(normalizedKey);
    if (!field) continue;

    matchedLineIndices.add(i);

    if (NUMERIC_FIELDS.includes(field as NumericField)) {
      const num = cleanNumber(valueRaw);
      if (num !== null) {
        (data as any)[field] = num;
      }
    } else if (field === "date") {
      data.date = normalizeDateString(valueRaw) ?? valueRaw;
    } else {
      (data as any)[field] = valueRaw;
    }
  }

  if (!data.date) {
    for (let i = 0; i < lines.length; i++) {
      if (matchedLineIndices.has(i)) continue;
      const line = lines[i].trim();
      if (!line) continue;
      const dateMatch = line.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/)
                     ?? line.match(/(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
      if (dateMatch) {
        const normalized = normalizeDateString(dateMatch[0]);
        if (normalized) {
          data.date = normalized;
          matchedLineIndices.add(i);
          break;
        }
      }
    }
  }

  const leftoverLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (matchedLineIndices.has(i)) continue;
    const trimmed = lines[i].trim();
    if (trimmed) leftoverLines.push(trimmed);
  }

  const missingRequired = REQUIRED_FIELDS.filter((f) => {
    const value = (data as any)[f];
    return value === undefined || value === null || value === "";
  });

  return { data, missingRequired, leftoverLines };
}

export type CountAnswerResult =
  | { kind: "skip" }
  | { kind: "invalid"; reason: string }
  | { kind: "value"; field: "totalMessage" | "totalClick"; value: number };

// Labels a user may legitimately prefix their answer with when replying to
// the combined "Total Message หรือ Total Click" prompt. Anything else in
// front of the number (e.g. "Date :") must cause a rejection, not a guess.
const COUNT_LABEL_PATTERN = /^(total\s*click|total\s*message|clicks?|messages?|จำนวนคลิก|จำนวนข้อความ|คลิก)\s*[:：]?\s*/i;

/**
 * Parses the answer to the combined Total Message / Total Click prompt.
 * An optional *recognized* label picks which field the number goes to;
 * after stripping that label, the remainder must satisfy the same
 * whole-string numeric rule as parseStrictNumericAnswer. A reply like
 * "Date : 25/7/2026" has an unrecognized label and a non-numeric remainder,
 * so it is rejected outright instead of having "25" plucked out of it.
 */
export function parseTotalMessageOrClickAnswer(raw: string): CountAnswerResult {
  const trimmed = raw.trim();
  if (isSkipAnswer(trimmed)) {
    return { kind: "skip" };
  }

  let field: "totalMessage" | "totalClick" = "totalMessage";
  let rest = trimmed;
  const labelMatch = trimmed.match(COUNT_LABEL_PATTERN);
  if (labelMatch) {
    field = /click|คลิก/i.test(labelMatch[1]) ? "totalClick" : "totalMessage";
    rest = trimmed.slice(labelMatch[0].length);
  }

  const num = parseStrictNumericAnswer(rest);
  if (num === null) {
    return { kind: "invalid", reason: "กรุณาระบุเป็นตัวเลขเท่านั้น" };
  }
  return { kind: "value", field, value: num };
}

export type FieldAnswerResult =
  | { kind: "skip" }
  | { kind: "invalid"; reason: string }
  | { kind: "value"; value: string | number };

/**
 * Parses the answer to a single missing-field question. This is the fix for
 * the "answering a missing-field prompt corrupts previously-parsed data"
 * bug: unlike parseAdsMessage, this NEVER re-parses the answer as a full
 * multi-field ads message — it only ever produces a value for the one field
 * that was asked about.
 */
export function parseFieldAnswer(field: string, raw: string, opts?: { numeric?: boolean }): FieldAnswerResult {
  const trimmed = raw.trim();
  if (isSkipAnswer(trimmed)) {
    return { kind: "skip" };
  }

  if (field === "date") {
    const normalized = normalizeDateString(trimmed);
    if (normalized === null) {
      return { kind: "invalid", reason: "กรุณาระบุวันที่ในรูปแบบ วัน/เดือน/ปี เช่น 23/7/2026 (ใช้ / . หรือ - คั่นได้)" };
    }
    return { kind: "value", value: normalized };
  }

  const numeric = opts?.numeric ?? NUMERIC_FIELDS.includes(field as NumericField);
  if (numeric) {
    const num = parseStrictNumericAnswer(trimmed);
    if (num === null) {
      return { kind: "invalid", reason: "กรุณาระบุเป็นตัวเลขเท่านั้น" };
    }
    return { kind: "value", value: num };
  }

  return { kind: "value", value: trimmed };
}

export function formatParsedSummary(data: Partial<AdsData>): string {
  const lines: string[] = [];
  if (data.date) lines.push(`📅 วันที่: ${data.date}`);
  if (data.website) lines.push(`🌐 เว็บ: ${data.website}`);
  if (data.platform) lines.push(`📱 Platform: ${data.platform}`);
  if (data.totalMessage !== undefined) lines.push(`💬 Total Message: ${data.totalMessage}`);
  if (data.totalClick !== undefined) lines.push(`🖱 Total Click: ${data.totalClick}`);
  if (data.cpr !== undefined) lines.push(`💰 CPR: ${data.cpr} บาท`);
  if (data.mainBudget !== undefined) lines.push(`🏦 Main Budget: ${data.mainBudget} บาท`);
  if (data.totalSpent !== undefined) lines.push(`💵 Total Spent: ${data.totalSpent} บาท`);
  if (data.impressions !== undefined) lines.push(`👁 Impressions: ${data.impressions}`);
  if (data.reach !== undefined) lines.push(`📊 Reach: ${data.reach}`);
  if (data.views !== undefined) lines.push(`▶️ Views: ${data.views}`);
  if (data.joined !== undefined) lines.push(`🙋 Joined: ${data.joined}`);
  if (data.runningCampaign) lines.push(`🚀 Running Campaign: ${data.runningCampaign}`);
  if (data.targetAudience) lines.push(`🎯 Target Audience: ${data.targetAudience}`);
  if (data.adsName) lines.push(`📢 Ads Name: ${data.adsName}`);
  if (data.location) lines.push(`📍 Location: ${data.location}`);
  return lines.join("\n");
}
