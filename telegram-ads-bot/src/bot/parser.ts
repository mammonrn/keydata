import { AdsData, REQUIRED_FIELDS, RequiredField } from "../types";

type NumericField = "totalMessage" | "cpr" | "totalSpent" | "impressions" | "reach";
type TextField = "date" | "targetAudience" | "adsName" | "location" | "website" | "platform";

const NUMERIC_FIELDS: NumericField[] = ["totalMessage", "cpr", "totalSpent", "impressions", "reach"];

const FIELD_ALIASES: Record<string, TextField | NumericField> = {
  date: "date",
  totalmessage: "totalMessage",
  total: "totalMessage",
  messages: "totalMessage",
  message: "totalMessage",
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

function normalizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function cleanNumber(raw: string): number | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/bath|baht|฿|บาท/g, "")
    .replace(/,/g, "")
    .trim();
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isNaN(num) ? null : num;
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

export function parseSingleFieldValue(field: RequiredField | string, raw: string): string | number {
  if (NUMERIC_FIELDS.includes(field as NumericField)) {
    const num = cleanNumber(raw);
    return num ?? 0;
  }
  return raw.trim();
}

export function formatParsedSummary(data: Partial<AdsData>): string {
  const lines: string[] = [];
  if (data.date) lines.push(`📅 วันที่: ${data.date}`);
  if (data.website) lines.push(`🌐 เว็บ: ${data.website}`);
  if (data.platform) lines.push(`📱 Platform: ${data.platform}`);
  if (data.totalMessage !== undefined) lines.push(`💬 Total Message: ${data.totalMessage}`);
  if (data.cpr !== undefined) lines.push(`💰 CPR: ${data.cpr} บาท`);
  if (data.totalSpent !== undefined) lines.push(`💵 Total Spent: ${data.totalSpent} บาท`);
  if (data.impressions !== undefined) lines.push(`👁 Impressions: ${data.impressions}`);
  if (data.reach !== undefined) lines.push(`📊 Reach: ${data.reach}`);
  if (data.targetAudience) lines.push(`🎯 Target Audience: ${data.targetAudience}`);
  if (data.adsName) lines.push(`📢 Ads Name: ${data.adsName}`);
  if (data.location) lines.push(`📍 Location: ${data.location}`);
  return lines.join("\n");
}
