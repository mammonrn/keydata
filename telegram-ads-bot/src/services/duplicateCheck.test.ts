/**
 * Run with: npm test
 *
 * Covers the pure half of both features — duplicate matching and date
 * text-pinning. The Sheets round-trip around them (findDuplicateRecords) is
 * exercised by the manual scenarios in README.md.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AdsData, SheetRow } from "../types";
import { asTextCell, buildRowValues, forceDateAsText, remapRow } from "../config";
import { findDuplicateRows } from "./duplicateCheck";

// A Telegram tab's layout, matching what schemaForPlatform("telegram") builds.
const HEADER = [
  "Row",
  "Date",
  "Platform",
  "Main Budget (฿)",
  "Running Campaign",
  "Total Spent (฿)",
  "Views",
  "Total Click",
  "Joined",
  "Target Audience",
  "Ads Name",
  "Location",
  "Photo Link",
  "Recorded By",
  "Recorded At",
];

function row(rowNumber: number, cells: Partial<Record<string, string>>): SheetRow {
  return {
    rowNumber,
    values: HEADER.map((h) => cells[h] ?? ""),
  };
}

const STORED = row(1, {
  Row: "1",
  Date: "01/12/2026",
  Platform: "Telegram Ads",
  "Total Spent (฿)": "1780.63",
  Views: "13543",
  "Ads Name": "Winter Promo",
});

const PENDING: Partial<AdsData> = {
  date: "01/12/2026",
  platform: "Telegram Ads",
  website: "SH666",
  totalSpent: 1780.63,
  views: 13543,
  adsName: "Winter Promo",
};

test("identical record matches the stored row", () => {
  const matches = findDuplicateRows(HEADER, [STORED], PENDING);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].rowNumber, 1);
});

test("a different date is not a duplicate", () => {
  const matches = findDuplicateRows(HEADER, [STORED], { ...PENDING, date: "02/12/2026" });
  assert.deepEqual(matches, []);
});

test("dates match regardless of zero padding", () => {
  const stored = row(1, { ...Object.fromEntries(HEADER.map((h, i) => [h, STORED.values[i]])), Date: "1/12/2026" });
  const matches = findDuplicateRows(HEADER, [stored], PENDING);
  assert.equal(matches.length, 1);
});

test("text fields compare case-insensitively and ignore surrounding whitespace", () => {
  const matches = findDuplicateRows(HEADER, [STORED], { ...PENDING, adsName: "  winter   promo " });
  assert.equal(matches.length, 1);
});

test("numbers match across sheet formatting", () => {
  const stored = row(1, {
    Date: "01/12/2026",
    Platform: "Telegram Ads",
    "Total Spent (฿)": "1,780.63",
    Views: "13,543",
    "Ads Name": "Winter Promo",
  });
  const matches = findDuplicateRows(HEADER, [stored], PENDING);
  assert.equal(matches.length, 1);
});

test("a different metric value is not a duplicate", () => {
  const matches = findDuplicateRows(HEADER, [STORED], { ...PENDING, views: 13544 });
  assert.deepEqual(matches, []);
});

test("a field the tab has no column for means the record is new", () => {
  // The Telegram tab has no CPR column, so no stored row can hold this value.
  const matches = findDuplicateRows(HEADER, [STORED], { ...PENDING, cpr: 12.5 });
  assert.deepEqual(matches, []);
});

test("a record with no date is never reported as a duplicate", () => {
  const matches = findDuplicateRows(HEADER, [STORED], { ...PENDING, date: undefined });
  assert.deepEqual(matches, []);
});

test("every matching row is reported, not just the first", () => {
  const second = { ...STORED, rowNumber: 4 };
  const matches = findDuplicateRows(HEADER, [STORED, row(2, { Date: "05/12/2026" }), second], PENDING);
  assert.deepEqual(
    matches.map((m) => m.rowNumber),
    [1, 4]
  );
});

test("a row whose Platform column disagrees with the tab is skipped", () => {
  const stored = row(1, {
    Date: "01/12/2026",
    Platform: "Facebook",
    "Total Spent (฿)": "1780.63",
    Views: "13543",
    "Ads Name": "Winter Promo",
  });
  assert.deepEqual(findDuplicateRows(HEADER, [stored], PENDING), []);
});

test("an empty tab has nothing to match against", () => {
  assert.deepEqual(findDuplicateRows([], [], PENDING), []);
  assert.deepEqual(findDuplicateRows(HEADER, [], PENDING), []);
});

// ===== Date written as text (feature 2) =====

test("buildRowValues pins the date cell to text and leaves other cells alone", () => {
  const values = buildRowValues(HEADER, 7, {
    ...PENDING,
    platform: "Telegram Ads",
    recordedBy: "@someone",
  } as never);
  assert.equal(values[HEADER.indexOf("Date")], "'01/12/2026");
  assert.equal(values[HEADER.indexOf("Total Spent (฿)")], "1780.63");
  assert.equal(values[HEADER.indexOf("Platform")], "Telegram Ads");
  assert.equal(values[0], "7");
});

test("asTextCell is idempotent and leaves blanks blank", () => {
  assert.equal(asTextCell("01/12/2026"), "'01/12/2026");
  assert.equal(asTextCell("'01/12/2026"), "'01/12/2026");
  assert.equal(asTextCell(""), "");
});

test("forceDateAsText re-pins a date read back from a sheet", () => {
  const values = [...STORED.values];
  const forced = forceDateAsText(HEADER, values);
  assert.equal(forced[HEADER.indexOf("Date")], "'01/12/2026");
  // Original array untouched, and no other cell changed.
  assert.equal(values[HEADER.indexOf("Date")], "01/12/2026");
  assert.equal(forced[HEADER.indexOf("Views")], "13543");
});

test("forceDateAsText is a no-op on a header with no date column", () => {
  const header = ["Row", "Platform", "Views"];
  assert.deepEqual(forceDateAsText(header, ["1", "Telegram Ads", "10"]), ["1", "Telegram Ads", "10"]);
});

test("moving a row to another tab keeps its date pinned to text", () => {
  const dstHeader = ["Row", "Date", "Platform", "Views", "Photo Link", "Recorded By", "Recorded At"];
  const moved = remapRow(HEADER, STORED.values, dstHeader);
  assert.equal(moved[dstHeader.indexOf("Date")], "'01/12/2026");
  assert.equal(moved[dstHeader.indexOf("Views")], "13543");
});
