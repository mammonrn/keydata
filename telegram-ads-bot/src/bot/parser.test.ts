/**
 * Run with: npm test
 *
 * Date normalization, including the whitespace cases that used to fall
 * through and get stored verbatim ("28 .7 . 2026").
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatParsedSummary, normalizeDateString, parseAdsMessage, parseFieldAnswer } from "./parser";
import { parseThaiDate } from "../services/dataProcessor";

// Every spelling of 28 July 2026 the bug report listed, plus the two
// no-whitespace forms that already worked and must keep working.
const SAME_DAY = [
  "28 .7 . 2026", // spaces on both sides of the dots
  "28. 7 .2026", // uneven spacing
  "28 / 7 / 2026", // same, with / separators
  "28-7 -2026", // same, with - separators
  "28.7.2026", // no spaces at all — no regression
  "28/07/2026", // already canonical — no regression
  "28 . 07 . 2026",
  "  28/7/2026  ", // leading/trailing whitespace
  "2026-7-28", // year-first, unchanged behaviour
  "2026 - 7 - 28", // year-first with spaces
];

for (const input of SAME_DAY) {
  test(`normalizeDateString("${input}") -> 28/07/2026`, () => {
    assert.equal(normalizeDateString(input), "28/07/2026");
  });
}

test("a date answer in the Q&A flow accepts the same spacing", () => {
  assert.deepEqual(parseFieldAnswer("date", "28 .7 . 2026"), { kind: "value", value: "28/07/2026" });
});

test("the confirmation summary shows the normalized date, not the raw text", () => {
  // This is what the bug report saw first: "📅 วันที่: 28 .7 . 2026" appeared
  // in the confirmation message, before any sheet write was involved.
  const parsed = parseAdsMessage("date : 28 .7 . 2026\nViews : 13543");
  assert.equal(parsed.data.date, "28/07/2026");
  assert.match(formatParsedSummary(parsed.data), /📅 วันที่: 28\/07\/2026/);
});

test("a date on an unlabeled line tolerates the same spacing", () => {
  const parsed = parseAdsMessage("28 .7 . 2026\nViews : 13543");
  assert.equal(parsed.data.date, "28/07/2026");
  // The line was consumed as the date, so it isn't offered as an Ads Name.
  assert.deepEqual(parsed.leftoverLines, []);
});

test("parseThaiDate files a spaced date under the right month", () => {
  const date = parseThaiDate("28 .7 . 2026");
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 6); // July, 0-indexed
  assert.equal(date.getDate(), 28);
});

test("single-digit days and months still zero-pad", () => {
  assert.equal(normalizeDateString("1 . 2 . 2026"), "01/02/2026");
});

test("non-dates are still rejected", () => {
  for (const input of ["", "   ", "abc", "28/7", "28/7/26", "32/7/2026", "28/13/2026", "1780.63"]) {
    assert.equal(normalizeDateString(input), null, `expected null for "${input}"`);
  }
});

test("whitespace stripping does not glue separate numbers into a date", () => {
  // "25 50 2026" has no separators at all and must not become a date.
  assert.equal(normalizeDateString("25 50 2026"), null);
});
