import { AdsData, REQUIRED_FIELDS, RequiredField } from "../types";

type NumericField = "totalMessage" | "totalClick" | "cpr" | "totalSpent" | "impressions" | "reach";
type TextField = "date" | "targetAudience" | "adsName" | "location" | "website" | "platform";

const NUMERIC_FIELDS: NumericField[] = ["totalMessage", "totalClick", "cpr", "totalSpent", "impressions", "reach"];

const FIELD_ALIASES: Record<string, TextField | NumericField> = {
  date: "date",
  totalmessage: "totalMessage",
  total: "totalMessage",
  messages: "totalMessage",
  message: "totalMessage",
  totalclick: "totalClick",
  click: "totalClick",
  clicks: "totalClick",
  "จำนวนคลิก": "totalClick",
  "คลิก": "totalClick",
  cpr: "cpr",
  costperresult: "cpr",
  totalspent: "totalSpent",
  spent: "totalSpent",
  spend: "totalSpent",
  budget: "totalSpent",
  impressions: "impressions",
  impression: "impressions",
  reach: "reach",
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

const SKIP_KEYWORDS = ["ไม่มี", "ไม่ต้องใส่", "ไม่ใส่", "none", "n/a", "na", "-"];

export function isSkipAnswer(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return SKIP_KEYWORDS.some((kw) => normalized === kw.toLowerCase());
}

export interface ParseResult {
  data: Partial<AdsData>;
  missingRequired: RequiredField[];
}

export function parseAdsMessage(rawText: string): ParseResult {
  const data: Partial<AdsData> = {};
  const lines = rawText.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\s*([^:：]+)[:：](.+)$/);
    if (!match) continue;
    const keyRaw = match[1];
    const valueRaw = match[2].trim();
    if (!valueRaw) continue;

    const normalizedKey = normalizeKey(keyRaw);
    const field = FIELD_ALIASES[normalizedKey];
    if (!field) continue;

    if (NUMERIC_FIELDS.includes(field as NumericField)) {
      const num = cleanNumber(valueRaw);
      if (num !== null) {
        (data as any)[field] = num;
      }
    } else {
      (data as any)[field] = valueRaw;
    }
  }

  const missingRequired = REQUIRED_FIELDS.filter((f) => {
    const value = (data as any)[f];
    return value === undefined || value === null || value === "";
  });

  return { data, missingRequired };
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
  if (data.totalSpent !== undefined) lines.push(`💵 Total Spent: ${data.totalSpent} บาท`);
  if (data.impressions !== undefined) lines.push(`👁 Impressions: ${data.impressions}`);
  if (data.reach !== undefined) lines.push(`📊 Reach: ${data.reach}`);
  if (data.targetAudience) lines.push(`🎯 Target Audience: ${data.targetAudience}`);
  if (data.adsName) lines.push(`📢 Ads Name: ${data.adsName}`);
  if (data.location) lines.push(`📍 Location: ${data.location}`);
  return lines.join("\n");
}
