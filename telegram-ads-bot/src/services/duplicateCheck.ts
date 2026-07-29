/**
 * Duplicate detection for records about to be saved.
 *
 * A record counts as a duplicate when its date matches an existing row *and*
 * every data field the user actually filled in matches that row too. The
 * comparison is deliberately scoped to one tab — the website's spreadsheet
 * for the record's own month, the tab for its platform — because that is the
 * only place a row for this record could already live. There is no
 * cross-month lookback: re-typing last month's report into this month is a
 * different (and much rarer) mistake than double-sending today's, and
 * chasing it would mean reading every file in the website's folder on every
 * single save.
 *
 * Everything here is pure: it takes a tab's header and rows and returns the
 * matches. The Sheets round-trip lives in dataProcessor.findDuplicateRecords.
 */
import {
  ALL_DATA_FIELDS,
  DataField,
  columnIndexOfField,
  columnIndexOfSystem,
  isNumericDataField,
  normalizePlatformName,
  numericCell,
} from "../config";
import { normalizeDateString } from "../bot/parser";
import { AdsData, SheetRow } from "../types";

export interface DuplicateMatch {
  /** Row number as the tab numbers its own rows (column A), 1-based. */
  rowNumber: number;
  values: string[];
}

/**
 * Text comparison rule shared by every non-numeric field: trim, fold case,
 * and collapse internal runs of whitespace. Mirrors how website/platform
 * aliases are matched elsewhere, so "  Bangkok " and "bangkok" are the same
 * campaign location rather than two different ones.
 */
function normalizeText(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Numbers are compared as numbers, so "1,780.63" (how Sheets hands back a
 * formatted cell) and "1780.63" (what the parser produced) match. Anything
 * that isn't numeric on both sides falls back to the text rule.
 */
function sameNumeric(a: string, b: string): boolean {
  const na = numericCell(a);
  const nb = numericCell(b);
  if (na !== null && nb !== null) return na === nb;
  return normalizeText(a) === normalizeText(b);
}

/**
 * Dates are compared in normalized DD/MM/YYYY form, which makes "1/12/2026"
 * and "01/12/2026" the same day.
 *
 * Rows written before the text-cell fix (see asTextCell) may come back in
 * whatever format the spreadsheet's locale chose to render its real date
 * cells in. A US-locale file renders 1 December as "12/1/2026", which
 * normalizes to 12 January and so won't match — an old row like that is
 * reported as "not a duplicate" and simply saves, which is the safe way to
 * be wrong. Rows written from here on are text and unambiguous.
 */
function sameDate(a: string, b: string): boolean {
  const na = normalizeDateString(a) ?? normalizeText(a);
  const nb = normalizeDateString(b) ?? normalizeText(b);
  return na === nb;
}

function sameFieldValue(field: DataField, pending: string, stored: string): boolean {
  if (field === "date") return sameDate(pending, stored);
  if (isNumericDataField(field)) return sameNumeric(pending, stored);
  return normalizeText(pending) === normalizeText(stored);
}

/** The data fields a pending record actually carries a value for. */
function filledFields(data: Partial<AdsData>): DataField[] {
  const record = data as unknown as Record<string, unknown>;
  return ALL_DATA_FIELDS.filter((field) => {
    const value = record[field];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
}

/**
 * Finds rows in one tab that the pending record duplicates.
 *
 * Returns every match rather than the first, so a tab that has already
 * accumulated the same row twice reports both instead of hiding the extent
 * of it.
 *
 * Two cases deliberately report nothing:
 * - the record (or the tab) has no date, since date equality is half the
 *   definition of a duplicate and there is nothing to anchor a match on;
 * - the record carries a field the tab has no column for, which means no
 *   stored row can possibly hold that value — the record is new by
 *   definition, and comparing only the remaining fields would flag unrelated
 *   rows.
 */
export function findDuplicateRows(
  header: string[],
  rows: SheetRow[],
  data: Partial<AdsData>
): DuplicateMatch[] {
  if (!data.date || header.length === 0) return [];

  const fields = filledFields(data);
  if (!fields.includes("date")) return [];

  const indices: Array<[DataField, number]> = [];
  for (const field of fields) {
    const index = columnIndexOfField(header, field);
    if (index < 0) return [];
    indices.push([field, index]);
  }

  // The tab is already per-platform, so this is a belt-and-braces check for
  // a tab whose rows carry a Platform column that disagrees with its title
  // (hand-edited files, or rows written before a platform alias existed).
  const platformIndex = columnIndexOfSystem(header, "Platform");
  const pendingPlatform =
    data.platform !== undefined ? normalizePlatformName(data.platform).toLowerCase() : undefined;

  const record = data as unknown as Record<string, unknown>;
  const matches: DuplicateMatch[] = [];

  for (const row of rows) {
    if (platformIndex >= 0 && pendingPlatform !== undefined) {
      const storedPlatform = normalizePlatformName(row.values[platformIndex] ?? "").toLowerCase();
      if (storedPlatform && storedPlatform !== pendingPlatform) continue;
    }

    const allMatch = indices.every(([field, index]) =>
      sameFieldValue(field, String(record[field] ?? ""), row.values[index] ?? "")
    );
    if (allMatch) matches.push({ rowNumber: row.rowNumber, values: row.values });
  }

  return matches;
}
