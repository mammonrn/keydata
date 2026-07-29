import path from "path";
import { Bot, Context, InlineKeyboard } from "grammy";
import {
  DataField,
  config,
  hasAnyMetricField,
  isAllowedGroup,
  isAuthorizedUser,
  isCanonicalPlatform,
  isSuperAdmin,
  listCanonicalPlatforms,
  normalizePlatformName,
  normalizeWebsiteName,
} from "../config";
import { AdsData, FIELD_LABELS_TH, REQUIRED_FIELDS, TOTAL_MESSAGE_OR_CLICK_FIELD, UserSession } from "../types";
import { getSession, resetSessionFlow, updateSession } from "../services/memory";
import { formatParsedSummary, parseAdsMessage, parseFieldAnswer, parseTotalMessageOrClickAnswer } from "./parser";
import { editableFieldsForPlatform, findEditableField, formatRowDisplay } from "./fields";
import {
  deleteRowWithLog,
  editRowField,
  findDuplicateRecords,
  moveRowToWebsite,
  PhotoInput,
  saveAdsData,
} from "../services/dataProcessor";
import { isKnownWebsite, listKnownWebsites } from "../google/drive";
import { logDuplicate, logError, logUnauthorized } from "../services/logger";

// Shortcut buttons offered when asking for the website; used as a fallback
// when the Drive folder listing is unavailable.
const FALLBACK_WEBSITES = ["SH666", "SH999", "UB89", "88F"];

const REQUIRED_FIELD_SET: readonly string[] = REQUIRED_FIELDS;

const NO_DATA_MESSAGE =
  "❌ ไม่พบข้อมูลโฆษณาในข้อความ กรุณาตรวจสอบรูปแบบข้อความอีกครั้ง\n\n" +
  "ตัวอย่าง (ใช้ : หรือ - คั่นก็ได้):\nTotal Spent - 1780.63\nViews - 13543\nClicks - 240";

/**
 * Only the fields that decide *where* a row is filed are still mandatory.
 * Each platform reports a different set of numbers, so demanding CPR /
 * Impressions / Reach / Total Message from every message made the flow
 * unusable for TikTok and Telegram reports. Whether a record carries any
 * actual metric is checked separately by hasAnyMetricField().
 */
function missingFieldsOf(data: Partial<AdsData>): string[] {
  const missing: string[] = [];
  if (!data.date) missing.push("date");
  for (const f of ["website", "platform"] as const) {
    const value = data[f];
    if (value === undefined || value === null || value === "") missing.push(f);
  }
  return missing;
}

function confirmationKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ ยืนยัน", "confirm").text("✏️ แก้ไข", "editrequest").row().text("❌ ยกเลิก", "cancel");
}

// Same two-button shape as the confirmation above, with wording that makes
// the consequence explicit: this one writes a row the sheet already has.
function duplicateKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ บันทึกซ้ำจริง", "dupconfirm").text("❌ ยกเลิก", "dupcancel");
}

function missingFieldLabel(field: string): string {
  if (field === TOTAL_MESSAGE_OR_CLICK_FIELD) {
    return "Total Message หรือ Total Click (ระบุอย่างใดอย่างหนึ่ง)";
  }
  return FIELD_LABELS_TH[field] ?? field;
}

async function websitePickerKeyboard(userId: number): Promise<InlineKeyboard> {
  let names: string[] = [];
  try {
    names = await listKnownWebsites();
  } catch {
    // Drive unavailable — fall back to the static list below.
  }
  if (names.length === 0) names = [...FALLBACK_WEBSITES];

  // The user's /setwebsite favorite goes first as a convenience — it is
  // only ever a button, never an auto-filled value.
  const rawFavorite = getSession(userId).defaultWebsite;
  if (rawFavorite) {
    const favorite = normalizeWebsiteName(rawFavorite);
    names = [favorite, ...names.filter((n) => n.toLowerCase() !== favorite.toLowerCase())];
  }

  const keyboard = new InlineKeyboard();
  names.slice(0, 12).forEach((name, idx) => {
    keyboard.text(name, `websitepick:${name}`);
    if (idx % 2 === 1) keyboard.row();
  });
  if (isSuperAdmin(userId)) {
    keyboard.row().text("➕ อื่นๆ", "websiteother");
  }
  return keyboard;
}

function platformPickerKeyboard(userId: number): InlineKeyboard {
  let names = listCanonicalPlatforms();

  const rawFavorite = getSession(userId).defaultPlatform;
  if (rawFavorite) {
    const favorite = normalizePlatformName(rawFavorite);
    names = [favorite, ...names.filter((n) => n.toLowerCase() !== favorite.toLowerCase())];
  }

  const keyboard = new InlineKeyboard();
  names.slice(0, 12).forEach((name, idx) => {
    keyboard.text(name, `platformpick:${name}`);
    if (idx % 2 === 1) keyboard.row();
  });
  if (isSuperAdmin(userId)) {
    keyboard.row().text("➕ อื่นๆ", "platformother");
  }
  return keyboard;
}

async function askForMissingField(ctx: Context, userId: number, field: string, opts?: { fromEditMenu?: boolean }): Promise<void> {
  updateSession(userId, { step: "awaiting_field_value", currentMissingField: field });
  if (field === "website") {
    const keyboard = await websitePickerKeyboard(userId);
    if (opts?.fromEditMenu) {
      keyboard.row().text("🔙 กลับ", "backtofieldselect");
    }
    await ctx.reply(`❓ กรุณาระบุเว็บไซต์ (กดปุ่มเลือก หรือพิมพ์ชื่อเว็บ):`, {
      reply_markup: keyboard,
    });
    return;
  }
  if (field === "platform") {
    const keyboard = platformPickerKeyboard(userId);
    if (opts?.fromEditMenu) {
      keyboard.row().text("🔙 กลับ", "backtofieldselect");
    }
    await ctx.reply(`❓ กรุณาระบุ Platform (กดปุ่มเลือก หรือพิมพ์ชื่อ Platform):`, {
      reply_markup: keyboard,
    });
    return;
  }
  if (opts?.fromEditMenu) {
    await ctx.reply(`❓ กรุณาระบุ ${missingFieldLabel(field)}:`, {
      reply_markup: new InlineKeyboard().text("🔙 กลับ", "backtofieldselect"),
    });
    return;
  }
  await ctx.reply(`❓ กรุณาระบุ ${missingFieldLabel(field)}:`);
}

async function showConfirmation(ctx: Context, userId: number): Promise<void> {
  const session = getSession(userId);
  const data = session.pendingData ?? {};
  updateSession(userId, {
    step: "awaiting_confirmation",
    defaultWebsite: data.website ?? session.defaultWebsite,
    defaultPlatform: data.platform ?? session.defaultPlatform,
    // Reaching this screen means the record is (re)open for review, so a
    // duplicate acknowledged for an earlier version of it no longer applies.
    duplicateAcknowledged: undefined,
  });
  const summary = formatParsedSummary(data);
  const photoCount = session.pendingPhotoFileIds?.length ?? 0;
  const photoLine = photoCount > 0 ? `\n\n📷 แนบรูปแล้ว ${photoCount} รูป` : "";
  const sent = await ctx.reply(`โปรดตรวจสอบข้อมูล:\n\n${summary}${photoLine}\n\nยืนยันบันทึกหรือไม่?`, {
    reply_markup: confirmationKeyboard(),
  });
  // Remembered so that a "there is already a record waiting" warning can be
  // threaded onto this exact message — in a busy group the confirmation it
  // refers to has usually scrolled out of view by then.
  updateSession(userId, { confirmationMessageId: sent.message_id });
}

async function proceedToLeftoverPicking(ctx: Context, userId: number): Promise<void> {
  const session = getSession(userId);
  const data = session.pendingData ?? {};
  const leftovers = session.leftoverLines ?? [];

  if (!data.adsName && leftovers.length > 0) {
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < leftovers.length; i++) {
      keyboard.text(leftovers[i], `adsnamepick:${i}`).row();
    }
    keyboard.text("➖ ไม่มี/ข้าม", "adsnameskip");
    updateSession(userId, { step: "awaiting_adsname_pick" });
    await ctx.reply("❓ พบข้อความที่ยังไม่ระบุ อันไหนคือ Ads Name?", { reply_markup: keyboard });
    return;
  }

  if (!data.location && leftovers.length > 0) {
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < leftovers.length; i++) {
      keyboard.text(leftovers[i], `locationpick:${i}`).row();
    }
    keyboard.text("➖ ไม่มี/ข้าม", "locationskip");
    updateSession(userId, { step: "awaiting_location_pick" });
    await ctx.reply("❓ พบข้อความที่ยังไม่ระบุ อันไหนคือ Location?", { reply_markup: keyboard });
    return;
  }

  await showConfirmation(ctx, userId);
}

async function proceedAfterFieldsUpdated(ctx: Context, userId: number): Promise<void> {
  const session = getSession(userId);
  const data = session.pendingData ?? {};
  const missing = missingFieldsOf(data);
  if (missing.length > 0) {
    updateSession(userId, { missingFields: missing });
    await askForMissingField(ctx, userId, missing[0]);
    return;
  }
  await proceedToLeftoverPicking(ctx, userId);
}

function extractPhotoFileId(ctx: Context): string | undefined {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return undefined;
  return photos[photos.length - 1].file_id;
}

// A photo held at idle (no data flow running yet) stays attachable for this
// long. Covers the album case where the caption-bearing sibling message
// arrives seconds later, without gluing week-old stray photos onto a new
// record.
const HELD_PHOTO_TTL_MS = 10 * 60 * 1000;

function heldPhotoIds(session: UserSession): string[] {
  const ids = session.pendingPhotoFileIds ?? [];
  if (ids.length === 0) return [];
  if (session.pendingPhotosAt !== undefined && Date.now() - session.pendingPhotosAt > HELD_PHOTO_TTL_MS) return [];
  return ids;
}

async function accumulatePhoto(userId: number, fileId: string, mediaGroupId: string | undefined): Promise<number> {
  const session = getSession(userId);
  const ids = [...(session.pendingPhotoFileIds ?? [])];
  if (!ids.includes(fileId)) ids.push(fileId);
  updateSession(userId, { pendingPhotoFileIds: ids, pendingPhotosAt: Date.now(), pendingMediaGroupId: mediaGroupId ?? session.pendingMediaGroupId });
  return ids.length;
}

async function startAdsFlow(ctx: Context, userId: number, text: string): Promise<void> {
  const session = getSession(userId);
  const parsed = parseAdsMessage(text);
  const fileId = extractPhotoFileId(ctx);
  const mediaGroupId = ctx.message?.media_group_id;

  if (Object.keys(parsed.data).length === 0) {
    // No recognizable ad fields in this message. A bare photo here is most
    // likely an album member whose caption rides on a sibling message that
    // may arrive after this one (Telegram delivers albums as separate
    // messages in no guaranteed order) — hold it silently instead of
    // starting a Q&A interrogation with no data, which would misroute the
    // caption message into the single-field answer path when it lands.
    if (fileId) {
      const ids = [...heldPhotoIds(session)];
      if (!ids.includes(fileId)) ids.push(fileId);
      updateSession(userId, {
        pendingPhotoFileIds: ids,
        pendingPhotosAt: Date.now(),
        pendingMediaGroupId: mediaGroupId ?? session.pendingMediaGroupId,
      });
    }
    return;
  }

  // Something was recognized, but nothing that counts as ad data (e.g. only
  // a stray date). Starting the Q&A here would walk the user all the way to
  // a confirmation screen for an empty row, so say so instead.
  if (!hasAnyMetricField(parsed.data as unknown as Record<string, unknown>)) {
    await ctx.reply(NO_DATA_MESSAGE);
    return;
  }

  const data: Partial<AdsData> = { ...parsed.data };
  if (data.website) {
    data.website = normalizeWebsiteName(data.website);
    if (!isSuperAdmin(userId) && !(await isKnownWebsite(data.website))) {
      await ctx.reply(`❌ ไม่พบเว็บไซต์ '${data.website}' ในระบบ กรุณาเลือกจากรายการที่มีอยู่ หรือติดต่อ Admin เพื่อเพิ่มเว็บใหม่`);
      delete (data as any).website;
    }
  }
  if (data.platform) {
    data.platform = normalizePlatformName(data.platform);
    if (!isSuperAdmin(userId) && !isCanonicalPlatform(data.platform)) {
      await ctx.reply(`❌ ไม่พบ Platform '${data.platform}' ในระบบ กรุณาเลือกจากรายการที่มีอยู่ หรือติดต่อ Admin เพื่อเพิ่ม Platform ใหม่`);
      delete (data as any).platform;
    }
  }
  // Neither website nor platform is ever silently defaulted from the
  // session: groups mix records for several websites and platforms, and a
  // stale session default (e.g. from testing Telegram, then sending an
  // un-labeled Facebook message) was mis-filing data under the wrong
  // platform/tab. When absent from the message, both are asked for
  // explicitly (with shortcut buttons, including the /setplatform favorite
  // as the first button) like any other required field.
  const ids = [...heldPhotoIds(session)];
  if (fileId && !ids.includes(fileId)) ids.push(fileId);

  updateSession(userId, {
    pendingData: data,
    leftoverLines: parsed.leftoverLines.length > 0 ? parsed.leftoverLines : undefined,
    pendingPhotoFileIds: ids,
    pendingPhotosAt: ids.length > 0 ? Date.now() : undefined,
    pendingMediaGroupId: mediaGroupId,
  });

  await proceedAfterFieldsUpdated(ctx, userId);
}

/**
 * Handles the answer to the combined "Total Message หรือ Total Click"
 * prompt. The answer may carry a recognized label to pick the field
 * ("Total Click: 50"), but the number itself is validated with the same
 * whole-string strict rule as every other numeric Q&A answer.
 */
async function handleTotalMessageOrClickAnswer(ctx: Context, userId: number, text: string): Promise<void> {
  const result = parseTotalMessageOrClickAnswer(text);

  if (result.kind === "skip") {
    await ctx.reply("❗ ต้องระบุ Total Message หรือ Total Click อย่างน้อยหนึ่งค่า กรุณาระบุค่า:");
    return;
  }

  if (result.kind === "invalid") {
    await ctx.reply(`❌ ${result.reason} เช่น "174" หรือ "Total Click: 50" กรุณาลองใหม่:`);
    return;
  }

  const session = getSession(userId);
  const data = { ...(session.pendingData ?? {}) } as Partial<AdsData>;
  data[result.field] = result.value;
  updateSession(userId, { pendingData: data });
  await proceedAfterFieldsUpdated(ctx, userId);
}

async function handleAwaitingFieldValue(ctx: Context, userId: number, text: string): Promise<void> {
  const session = getSession(userId);
  const field = session.currentMissingField;
  if (!field) {
    resetSessionFlow(userId);
    return;
  }

  if (field === TOTAL_MESSAGE_OR_CLICK_FIELD) {
    await handleTotalMessageOrClickAnswer(ctx, userId, text);
    return;
  }

  const result = parseFieldAnswer(field, text);

  if (result.kind === "invalid") {
    await ctx.reply(`❌ ${result.reason} กรุณาลองใหม่:`);
    return;
  }

  const data = { ...(session.pendingData ?? {}) } as Partial<AdsData>;

  if (result.kind === "skip") {
    if (REQUIRED_FIELD_SET.includes(field)) {
      await ctx.reply(`❗ ${missingFieldLabel(field)} เป็นข้อมูลที่จำเป็น กรุณาระบุค่า:`);
      return;
    }
    // undefined (not "" or 0) so numeric optionals stay typed correctly and
    // land in the sheet as a blank cell.
    (data as any)[field] = undefined;
  } else if (field === "website") {
    const website = normalizeWebsiteName(String(result.value));
    if (!website || website.length > 50) {
      await ctx.reply("❌ ชื่อเว็บไซต์ไม่ถูกต้อง กรุณาพิมพ์ใหม่ (ไม่เกิน 50 ตัวอักษร ไม่มีอักขระพิเศษ):");
      return;
    }
    if (!isSuperAdmin(userId) && !(await isKnownWebsite(website))) {
      await ctx.reply(`❌ ไม่พบเว็บไซต์ '${website}' ในระบบ กรุณาเลือกจากรายการที่มีอยู่ หรือติดต่อ Admin เพื่อเพิ่มเว็บใหม่`, {
        reply_markup: await websitePickerKeyboard(userId),
      });
      return;
    }
    data.website = website;
  } else if (field === "platform") {
    const platform = normalizePlatformName(String(result.value));
    if (!platform || platform.length > 50) {
      await ctx.reply("❌ ชื่อ Platform ไม่ถูกต้อง กรุณาพิมพ์ใหม่ (ไม่เกิน 50 ตัวอักษร):");
      return;
    }
    if (!isSuperAdmin(userId) && !isCanonicalPlatform(platform)) {
      await ctx.reply(`❌ ไม่พบ Platform '${platform}' ในระบบ กรุณาเลือกจากรายการที่มีอยู่ หรือติดต่อ Admin เพื่อเพิ่ม Platform ใหม่`, {
        reply_markup: platformPickerKeyboard(userId),
      });
      return;
    }
    data.platform = platform;
  } else {
    (data as any)[field] = result.value;
  }

  updateSession(userId, { pendingData: data });
  await proceedAfterFieldsUpdated(ctx, userId);
}

async function handleEditingFieldValue(ctx: Context, userId: number, text: string): Promise<void> {
  const session = getSession(userId);
  const pendingEdit = session.pendingEdit;
  if (!pendingEdit || pendingEdit.field === undefined) {
    resetSessionFlow(userId);
    return;
  }
  const fieldDef = findEditableField(pendingEdit.field);
  if (!fieldDef) {
    resetSessionFlow(userId);
    return;
  }

  // Website is the file the row lives in, not a cell — editing it moves the
  // whole row (and any attached photos) to the destination website's file.
  if (fieldDef.key === "website") {
    const actor = { userId, username: ctx.from?.username };
    try {
      const newWebsite = normalizeWebsiteName(text);
      if (!newWebsite || newWebsite.length > 50) {
        await ctx.reply("❌ ชื่อเว็บไซต์ไม่ถูกต้อง กรุณาพิมพ์ใหม่:");
        return;
      }
      if (!isSuperAdmin(userId) && !(await isKnownWebsite(newWebsite))) {
        await ctx.reply(`❌ ไม่พบเว็บไซต์ '${newWebsite}' ในระบบ กรุณาเลือกจากรายการที่มีอยู่ หรือติดต่อ Admin เพื่อเพิ่มเว็บใหม่`, {
          reply_markup: await websitePickerKeyboard(userId),
        });
        return;
      }
      if (newWebsite.toLowerCase() === pendingEdit.website.toLowerCase()) {
        resetSessionFlow(userId);
        await ctx.reply(`ℹ️ ข้อมูลอยู่ในเว็บ ${pendingEdit.website} อยู่แล้ว ไม่มีการเปลี่ยนแปลง`);
        return;
      }
      const moved = await moveRowToWebsite(pendingEdit, newWebsite, actor);
      resetSessionFlow(userId);
      if (!moved) {
        await ctx.reply(`❌ ไม่พบ row #${pendingEdit.rowNumber} ใน tab ${pendingEdit.tabName}`);
        return;
      }
      const photoNote = moved.photosMoved > 0 ? ` พร้อมย้ายรูป ${moved.photosMoved} รูป` : "";
      await ctx.reply(`✅ ย้ายข้อมูลจาก ${moved.oldWebsite} ไป ${moved.newWebsite} สำเร็จ (Row ใหม่ #${moved.newRowNumber} ใน ${moved.destFileName})${photoNote}`);
    } catch (err) {
      logError(userId, ctx.from?.username, String(err));
      await ctx.reply(`❌ เกิดข้อผิดพลาดในการย้ายข้อมูล: ${(err as Error).message}`);
    }
    return;
  }

  if (fieldDef.key === "platform") {
    const normalized = normalizePlatformName(text);
    if (!isSuperAdmin(userId) && !isCanonicalPlatform(normalized)) {
      await ctx.reply(`❌ ไม่พบ Platform '${normalized}' ในระบบ กรุณาเลือกจากรายการที่มีอยู่ หรือติดต่อ Admin เพื่อเพิ่ม Platform ใหม่`, {
        reply_markup: platformPickerKeyboard(userId),
      });
      return;
    }
    text = normalized;
  }

  const result = parseFieldAnswer(fieldDef.key, text, { numeric: fieldDef.numeric });
  if (result.kind === "invalid") {
    await ctx.reply(`❌ ${result.reason} กรุณาลองใหม่:`);
    return;
  }
  const rawValue = result.kind === "skip" ? "" : String(result.value);

  const actor = { userId, username: ctx.from?.username };
  try {
    const website = pendingEdit.sheetName.split("_")[0];
    const result2 = await editRowField(
      pendingEdit.spreadsheetId,
      pendingEdit.sheetId,
      pendingEdit.tabName,
      pendingEdit.tabName,
      pendingEdit.rowNumber,
      fieldDef.key as DataField,
      rawValue,
      actor,
      website
    );
    resetSessionFlow(userId);
    if (!result2) {
      await ctx.reply(`❌ ไม่พบ row #${pendingEdit.rowNumber}`);
      return;
    }
    await ctx.reply(`✅ แก้ไขสำเร็จ\n\nก่อนหน้า: ${result2.before || "-"}\nปัจจุบัน: ${result2.after || "-"}`);
  } catch (err) {
    logError(userId, ctx.from?.username, String(err));
    await ctx.reply(`❌ เกิดข้อผิดพลาดในการแก้ไข: ${(err as Error).message}`);
  }
}

/** "SH666 / Facebook", degrading gracefully when one half isn't known yet. */
function describeRecord(data: Partial<AdsData>): string {
  const parts = [data.website, data.platform].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" / ") : "ที่ค้างอยู่";
}

/**
 * Guards the merge path against a second, unrelated ad report arriving before
 * the one in flight was confirmed.
 *
 * The signal is a contradiction, not merely presence: an incoming website or
 * platform that differs from the pending one can only mean a different
 * record. A follow-up about the *same* record — the late caption of a photo
 * album, an extra "Location : Bangkok" line — either repeats the same
 * website/platform or omits them entirely, so those keep merging exactly as
 * before. Likewise, when the pending record has no website/platform yet, an
 * incoming one is answering that gap rather than contradicting it.
 *
 * Blocked messages are deliberately not stored: the user is told to settle
 * the pending record first and re-send, which keeps one record in flight at a
 * time and makes the loss visible instead of silent.
 */
async function rejectIfDifferentRecord(
  ctx: Context,
  session: UserSession,
  incoming: Partial<AdsData>
): Promise<boolean> {
  const pending = session.pendingData;
  if (!pending) return false;

  // Normalize before comparing, or an alias ("shwe666" vs "SH666", "Tiktok"
  // vs "TikTok") would read as a conflict and block a legitimate follow-up.
  const website = incoming.website !== undefined ? normalizeWebsiteName(incoming.website) : undefined;
  const platform = incoming.platform !== undefined ? normalizePlatformName(incoming.platform) : undefined;

  const conflicts =
    (website !== undefined &&
      pending.website !== undefined &&
      website.toLowerCase() !== pending.website.toLowerCase()) ||
    (platform !== undefined &&
      pending.platform !== undefined &&
      platform.toLowerCase() !== pending.platform.toLowerCase());

  if (!conflicts) return false;

  const label = describeRecord(pending);
  const instruction =
    session.step === "awaiting_confirmation" || session.step === "awaiting_duplicate_confirmation"
      ? "กรุณากด ✅ ยืนยัน หรือ ❌ ยกเลิก รายการก่อนหน้าก่อน แล้วค่อยส่งข้อมูลใหม่อีกครั้ง"
      : "กรุณากรอกรายการก่อนหน้าให้เสร็จ หรือพิมพ์ /cancel เพื่อยกเลิก แล้วค่อยส่งข้อมูลใหม่อีกครั้ง";

  await ctx.reply(
    `⚠️ มีรายการ ${label} รอการยืนยันอยู่\n\n${instruction}\n\n` +
      `หมายเหตุ: ข้อมูลที่เพิ่งส่งมา (${describeRecord({ website, platform })}) ยังไม่ถูกบันทึก กรุณาส่งใหม่อีกครั้งหลังจัดการรายการก่อนหน้าเสร็จ`,
    session.confirmationMessageId !== undefined
      ? { reply_parameters: { message_id: session.confirmationMessageId, allow_sending_without_reply: true } }
      : undefined
  );
  return true;
}

async function continueFlow(ctx: Context, session: UserSession, text: string, fileId?: string, mediaGroupId?: string): Promise<void> {
  const userId = session.userId;

  if (fileId && (session.step === "awaiting_confirmation" || session.step === "awaiting_duplicate_confirmation" || session.step === "awaiting_field_value" || session.step === "awaiting_adsname_pick" || session.step === "awaiting_location_pick")) {
    const count = await accumulatePhoto(userId, fileId, mediaGroupId);
    if (!text.trim()) {
      await ctx.reply(`📷 เพิ่มรูปแล้ว (รวม ${count} รูป)`);
      return;
    }
    // message also carries meaningful text/caption — fall through and handle it below
  }

  // A message that parses to 2+ ad fields is a full data message, not an
  // answer to whatever single question is pending — e.g. an album's caption
  // message landing after its photo-only sibling already started the Q&A.
  // Swallowing it as the answer to one field would both corrupt that field
  // and discard every other field it carries, so merge it into pendingData
  // instead. (Single-field answers like "Total Click: 50" parse to 1 field
  // and still flow to the strict per-question handlers below.)
  if ((session.step === "awaiting_field_value" || session.step === "awaiting_confirmation" || session.step === "awaiting_duplicate_confirmation" || session.step === "awaiting_adsname_pick" || session.step === "awaiting_location_pick") && text.trim()) {
    const parsedFull = parseAdsMessage(text);
    if (Object.keys(parsedFull.data).length >= 2) {
      const current = getSession(userId);

      // ...unless it is plainly a *different* record. Merging is only ever
      // right for follow-up text about the record already in flight; when the
      // incoming message names a website or platform that contradicts the
      // pending one, it is a second report typed before the first was
      // confirmed, and merging silently destroyed the first record while
      // contaminating the second with the first's fields.
      if (await rejectIfDifferentRecord(ctx, current, parsedFull.data)) return;

      const data: Partial<AdsData> = { ...(current.pendingData ?? {}), ...parsedFull.data };
      if (data.website) {
        data.website = normalizeWebsiteName(data.website);
        if (!isSuperAdmin(userId) && !(await isKnownWebsite(data.website))) {
          await ctx.reply(`❌ ไม่พบเว็บไซต์ '${data.website}' ในระบบ กรุณาเลือกจากรายการที่มีอยู่ หรือติดต่อ Admin เพื่อเพิ่มเว็บใหม่`);
          delete (data as any).website;
        }
      }
      if (data.platform) {
        data.platform = normalizePlatformName(data.platform);
        if (!isSuperAdmin(userId) && !isCanonicalPlatform(data.platform)) {
          await ctx.reply(`❌ ไม่พบ Platform '${data.platform}' ในระบบ กรุณาเลือกจากรายการที่มีอยู่ หรือติดต่อ Admin เพื่อเพิ่ม Platform ใหม่`);
          delete (data as any).platform;
        }
      }
      const existingLeftovers = current.leftoverLines ?? [];
      const newLeftovers = parsedFull.leftoverLines ?? [];
      const mergedLeftovers = [...existingLeftovers];
      for (const l of newLeftovers) {
        if (!mergedLeftovers.includes(l)) mergedLeftovers.push(l);
      }
      updateSession(userId, {
        pendingData: data,
        leftoverLines: mergedLeftovers.length > 0 ? mergedLeftovers : undefined,
        currentMissingField: undefined,
      });
      await proceedAfterFieldsUpdated(ctx, userId);
      return;
    }
  }

  switch (session.step) {
    case "awaiting_field_value":
      await handleAwaitingFieldValue(ctx, userId, text);
      return;
    case "editing_field_value":
      await handleEditingFieldValue(ctx, userId, text);
      return;
    case "awaiting_confirmation":
      await ctx.reply("กรุณาใช้ปุ่มที่แสดงไว้ (✅ ยืนยัน / ✏️ แก้ไข / ❌ ยกเลิก) หรือพิมพ์ /cancel เพื่อยกเลิก");
      return;
    case "awaiting_duplicate_confirmation":
      await ctx.reply("⚠️ ข้อมูลนี้ซ้ำกับที่เคยบันทึกไว้ กรุณาใช้ปุ่มที่แสดงไว้ (✅ บันทึกซ้ำจริง / ❌ ยกเลิก) หรือพิมพ์ /cancel เพื่อยกเลิก");
      return;
    case "awaiting_adsname_pick":
    case "awaiting_location_pick":
      await ctx.reply("กรุณาใช้ปุ่มที่แสดงไว้เพื่อเลือก หรือพิมพ์ /cancel เพื่อยกเลิก");
      return;
    default:
      await ctx.reply("กรุณาใช้ปุ่มที่แสดงไว้ หรือพิมพ์ /cancel เพื่อยกเลิก");
  }
}

async function downloadTelegramPhoto(ctx: Context, fileId: string, dateLabel: string, index: number): Promise<PhotoInput> {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const ext = path.extname(file.file_path ?? "") || ".jpg";
  const safeDateLabel = dateLabel.replace(/[^\w-]/g, "-");
  const filename = `${safeDateLabel}_${index}${ext}`;
  return { buffer, filename, mimeType: "image/jpeg" };
}

/**
 * Stops a save that would duplicate an existing row and asks the user what to
 * do about it. Returns true when the flow has been parked on that question.
 *
 * A failure to *check* never blocks a save: if Sheets is unreachable or the
 * tab can't be read, the error is logged and the record is written as before.
 * Refusing to save because a duplicate check couldn't run would turn a
 * best-effort safeguard into an outage.
 */
async function warnIfDuplicate(ctx: Context, userId: number, data: Partial<AdsData>): Promise<boolean> {
  let found;
  try {
    found = await findDuplicateRecords(data);
  } catch (err) {
    logError(userId, ctx.from?.username, `Duplicate check failed (saving anyway): ${String(err)}`, data.website);
    return false;
  }
  if (!found) return false;

  const first = found.matches[0];
  const rowLabels = found.matches.map((m) => `#${m.rowNumber}`).join(", ");
  logDuplicate(
    userId,
    ctx.from?.username,
    data.website ?? "",
    `Duplicate detected: ${found.matches.length} matching row(s) ${rowLabels} in ${found.fileName} [${found.tabName}] for date ${data.date}`,
    found.spreadsheetId,
    first.rowNumber
  );

  updateSession(userId, { step: "awaiting_duplicate_confirmation" });

  const extra =
    found.matches.length > 1 ? `\n\n(พบทั้งหมด ${found.matches.length} แถวที่ตรงกัน: Row ${rowLabels})` : "";
  await ctx.reply(
    `⚠️ พบข้อมูลนี้ซ้ำกับที่เคยบันทึกไว้แล้ว\n` +
      `วันที่ ${data.date} และข้อมูลที่กรอกมาตรงกันทุกอย่าง\n` +
      `📄 ไฟล์: ${found.fileName} [${found.tabName}] Row #${first.rowNumber}${extra}\n\n` +
      `📥 ข้อมูลที่เพิ่งส่งมา:\n${formatParsedSummary(data)}\n\n` +
      `📋 ข้อมูลเดิม (Row #${first.rowNumber}):\n${formatRowDisplay(found.header, first.values)}\n\n` +
      `ต้องการบันทึกซ้ำหรือไม่?`,
    { reply_markup: duplicateKeyboard() }
  );
  return true;
}

async function performConfirm(ctx: Context, userId: number): Promise<void> {
  const session = getSession(userId);
  const data = session.pendingData;
  if (!data) {
    resetSessionFlow(userId);
    await ctx.reply("ไม่มีข้อมูลที่รอการยืนยัน");
    return;
  }
  const missing = missingFieldsOf(data);
  if (missing.length > 0) {
    updateSession(userId, { missingFields: missing });
    await askForMissingField(ctx, userId, missing[0]);
    return;
  }
  // Safety net: metrics are all optional individually, but a row with none
  // of them is an empty record.
  if (!hasAnyMetricField(data as unknown as Record<string, unknown>)) {
    await ctx.reply(NO_DATA_MESSAGE);
    return;
  }

  // Last gate before the write. Deliberately placed after every other check
  // and after the auto-fill/edit confirmations, so it only ever asks about a
  // record that is otherwise ready to save — and only once, since answering
  // "save it anyway" sets duplicateAcknowledged and comes straight back here.
  if (!session.duplicateAcknowledged && (await warnIfDuplicate(ctx, userId, data))) return;

  try {
    const fileIds = session.pendingPhotoFileIds ?? [];
    const photos: PhotoInput[] = [];
    for (let i = 0; i < fileIds.length; i++) {
      photos.push(await downloadTelegramPhoto(ctx, fileIds[i], String(data.date ?? "photo"), i + 1));
    }

    const actor = { userId, username: ctx.from?.username };
    const result = await saveAdsData(data as Omit<AdsData, "photoLink" | "recordedBy" | "recordedAt">, photos, actor);
    resetSessionFlow(userId);
    updateSession(userId, { defaultWebsite: result.website, defaultPlatform: data.platform as string | undefined });
    await ctx.reply(`✅ บันทึกข้อมูลสำเร็จ! Row #${result.rowNumber} (${result.website}_${result.month}_${result.year})`);
  } catch (err) {
    logError(userId, ctx.from?.username, String(err), data.website as string | undefined);
    await ctx.reply(`❌ เกิดข้อผิดพลาดในการบันทึก: ${(err as Error).message}`);
  }
}

// Scoped to the platform's schema so a TikTok record isn't offered CPR /
// Impressions / Reach buttons for columns its tab doesn't have.
function pendingEditKeyboard(platform: string | undefined): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  editableFieldsForPlatform(platform).forEach((f, idx) => {
    keyboard.text(f.label, `pendingedit:${f.key}`);
    if (idx % 2 === 1) keyboard.row();
  });
  keyboard.row().text("🔙 กลับ", "backtoconfirm").text("❌ ยกเลิก", "cancel");
  return keyboard;
}

export function registerHandlers(bot: Bot): void {
  bot.on("callback_query:data", async (ctx) => {
    const userId = ctx.from.id;
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    if (!isAuthorizedUser(userId)) {
      logUnauthorized(userId, ctx.from.username, "Callback query from unauthorized user");
      await ctx.reply("❌ คุณไม่ได้รับอนุญาตให้ใช้งาน bot นี้");
      return;
    }

    if (data === "confirm") {
      await performConfirm(ctx, userId);
      return;
    }

    if (data === "dupconfirm") {
      const session = getSession(userId);
      if (!session.pendingData) {
        resetSessionFlow(userId);
        await ctx.reply("ไม่มีข้อมูลที่รอการยืนยัน");
        return;
      }
      logDuplicate(
        userId,
        ctx.from.username,
        session.pendingData.website ?? "",
        `User chose to save the duplicate anyway (date ${session.pendingData.date})`
      );
      updateSession(userId, { duplicateAcknowledged: true });
      await performConfirm(ctx, userId);
      return;
    }

    if (data === "dupcancel") {
      const session = getSession(userId);
      logDuplicate(
        userId,
        ctx.from.username,
        session.pendingData?.website ?? "",
        `User cancelled the save after a duplicate warning (date ${session.pendingData?.date ?? "-"})`
      );
      resetSessionFlow(userId);
      await ctx.reply("❌ ยกเลิกแล้ว ไม่ได้บันทึกข้อมูลซ้ำ");
      return;
    }

    if (data === "editrequest") {
      const session = getSession(userId);
      if (!session.pendingData) {
        await ctx.reply("ไม่มีข้อมูลที่รอการแก้ไข");
        return;
      }
      await ctx.reply("เลือก field ที่ต้องการแก้ไข:", { reply_markup: pendingEditKeyboard(session.pendingData?.platform) });
      return;
    }

    if (data.startsWith("pendingedit:")) {
      const field = data.split(":")[1];
      await askForMissingField(ctx, userId, field, { fromEditMenu: true });
      return;
    }

    if (data.startsWith("websitepick:")) {
      const pickedName = data.slice("websitepick:".length);
      const session = getSession(userId);

      // Post-save /edit flow: route picked website to the edit handler
      if (session.step === "editing_field_value" && session.pendingEdit?.field === "website") {
        await handleEditingFieldValue(ctx, userId, pickedName);
        return;
      }

      const website = normalizeWebsiteName(pickedName);
      if (!session.pendingData) {
        resetSessionFlow(userId);
        await ctx.reply("ไม่มีข้อมูลที่รอการบันทึก กรุณาส่งข้อมูลใหม่");
        return;
      }
      updateSession(userId, {
        pendingData: { ...session.pendingData, website },
        currentMissingField: undefined,
      });
      await ctx.reply(`🌐 เลือกเว็บ: ${website}`);
      await proceedAfterFieldsUpdated(ctx, userId);
      return;
    }

    if (data === "websiteother") {
      // Button is hidden for non-admins, but check as defense-in-depth.
      if (!isSuperAdmin(userId)) {
        await ctx.reply("❌ เฉพาะ Admin เท่านั้นที่สามารถเพิ่มเว็บไซต์ใหม่ได้ กรุณาเลือกจากรายการที่มีอยู่");
        return;
      }

      const session = getSession(userId);

      // Post-save /edit flow: keep step as editing_field_value so the typed
      // answer routes to handleEditingFieldValue.
      if (session.step === "editing_field_value" && session.pendingEdit?.field === "website") {
        await ctx.reply("✏️ กรุณาพิมพ์ชื่อเว็บไซต์ใหม่ที่ต้องการเพิ่ม:");
        return;
      }

      if (!session.pendingData) {
        resetSessionFlow(userId);
        await ctx.reply("ไม่มีข้อมูลที่รอการบันทึก กรุณาส่งข้อมูลใหม่");
        return;
      }
      updateSession(userId, { step: "awaiting_field_value", currentMissingField: "website" });
      await ctx.reply("✏️ กรุณาพิมพ์ชื่อเว็บไซต์ใหม่ที่ต้องการเพิ่ม:");
      return;
    }

    if (data.startsWith("platformpick:")) {
      const pickedName = data.slice("platformpick:".length);
      const session = getSession(userId);

      if (session.step === "editing_field_value" && session.pendingEdit?.field === "platform") {
        await handleEditingFieldValue(ctx, userId, pickedName);
        return;
      }

      const platform = normalizePlatformName(pickedName);
      if (!session.pendingData) {
        resetSessionFlow(userId);
        await ctx.reply("ไม่มีข้อมูลที่รอการบันทึก กรุณาส่งข้อมูลใหม่");
        return;
      }
      updateSession(userId, {
        pendingData: { ...session.pendingData, platform },
        currentMissingField: undefined,
      });
      await ctx.reply(`📱 เลือก Platform: ${platform}`);
      await proceedAfterFieldsUpdated(ctx, userId);
      return;
    }

    if (data === "platformother") {
      if (!isSuperAdmin(userId)) {
        await ctx.reply("❌ เฉพาะ Admin เท่านั้นที่สามารถเพิ่ม Platform ใหม่ได้ กรุณาเลือกจากรายการที่มีอยู่");
        return;
      }

      const session = getSession(userId);

      if (session.step === "editing_field_value" && session.pendingEdit?.field === "platform") {
        await ctx.reply("✏️ กรุณาพิมพ์ชื่อ Platform ใหม่ที่ต้องการเพิ่ม:");
        return;
      }

      if (!session.pendingData) {
        resetSessionFlow(userId);
        await ctx.reply("ไม่มีข้อมูลที่รอการบันทึก กรุณาส่งข้อมูลใหม่");
        return;
      }
      updateSession(userId, { step: "awaiting_field_value", currentMissingField: "platform" });
      await ctx.reply("✏️ กรุณาพิมพ์ชื่อ Platform ใหม่ที่ต้องการเพิ่ม:");
      return;
    }

    if (data.startsWith("adsnamepick:")) {
      const idx = Number(data.split(":")[1]);
      const session = getSession(userId);
      const leftovers = session.leftoverLines ?? [];
      if (idx < 0 || idx >= leftovers.length || Number.isNaN(idx)) {
        await ctx.reply("เกิดข้อผิดพลาด กรุณาลองใหม่");
        return;
      }
      const picked = leftovers[idx];
      const remaining = leftovers.filter((_, i) => i !== idx);
      updateSession(userId, {
        pendingData: { ...(session.pendingData ?? {}), adsName: picked },
        leftoverLines: remaining.length > 0 ? remaining : undefined,
      });
      await ctx.reply(`📢 Ads Name: ${picked}`);
      await proceedToLeftoverPicking(ctx, userId);
      return;
    }

    if (data === "adsnameskip") {
      await proceedToLeftoverPicking(ctx, userId);
      return;
    }

    if (data.startsWith("locationpick:")) {
      const idx = Number(data.split(":")[1]);
      const session = getSession(userId);
      const leftovers = session.leftoverLines ?? [];
      if (idx < 0 || idx >= leftovers.length || Number.isNaN(idx)) {
        await ctx.reply("เกิดข้อผิดพลาด กรุณาลองใหม่");
        return;
      }
      const picked = leftovers[idx];
      updateSession(userId, {
        pendingData: { ...(session.pendingData ?? {}), location: picked },
        leftoverLines: undefined,
      });
      await ctx.reply(`📍 Location: ${picked}`);
      await showConfirmation(ctx, userId);
      return;
    }

    if (data === "locationskip") {
      await showConfirmation(ctx, userId);
      return;
    }

    if (data === "backtoconfirm") {
      const session = getSession(userId);
      if (!session.pendingData) {
        resetSessionFlow(userId);
        await ctx.reply("ไม่มีข้อมูลที่รอการยืนยัน");
        return;
      }
      await showConfirmation(ctx, userId);
      return;
    }

    if (data === "backtofieldselect") {
      const session = getSession(userId);
      if (!session.pendingData) {
        resetSessionFlow(userId);
        await ctx.reply("ไม่มีข้อมูลที่รอการยืนยัน");
        return;
      }
      updateSession(userId, { step: "awaiting_confirmation", currentMissingField: undefined });
      await ctx.reply("เลือก field ที่ต้องการแก้ไข:", { reply_markup: pendingEditKeyboard(session.pendingData?.platform) });
      return;
    }

    if (data === "cancel") {
      resetSessionFlow(userId);
      await ctx.reply("ยกเลิกแล้ว");
      return;
    }

    if (data.startsWith("editfield:")) {
      const value = data.slice("editfield:".length);
      if (value === "cancel") {
        resetSessionFlow(userId);
        await ctx.reply("ยกเลิกแล้ว");
        return;
      }
      const fieldDef = findEditableField(value);
      const session = getSession(userId);
      if (!fieldDef || !session.pendingEdit) {
        resetSessionFlow(userId);
        await ctx.reply("เกิดข้อผิดพลาด กรุณาลอง /edit ใหม่");
        return;
      }
      updateSession(userId, {
        step: "editing_field_value",
        pendingEdit: { ...session.pendingEdit, field: fieldDef.key },
      });
      if (fieldDef.key === "website") {
        const keyboard = await websitePickerKeyboard(userId);
        keyboard.row().text("❌ ยกเลิก", "editfield:cancel");
        await ctx.reply(`❓ กรุณาเลือกเว็บไซต์ใหม่ (กดปุ่มเลือก หรือพิมพ์ชื่อเว็บ):`, {
          reply_markup: keyboard,
        });
        return;
      }
      if (fieldDef.key === "platform") {
        const keyboard = platformPickerKeyboard(userId);
        keyboard.row().text("❌ ยกเลิก", "editfield:cancel");
        await ctx.reply(`❓ กรุณาเลือก Platform ใหม่ (กดปุ่มเลือก หรือพิมพ์ชื่อ Platform):`, {
          reply_markup: keyboard,
        });
        return;
      }
      await ctx.reply(`กรุณาพิมพ์ค่าใหม่สำหรับ ${fieldDef.label}:`);
      return;
    }

    if (data === "delete:cancel") {
      resetSessionFlow(userId);
      await ctx.reply("ยกเลิกการลบแล้ว");
      return;
    }

    if (data === "delete:confirm1") {
      const session = getSession(userId);
      if (!session.pendingEdit) {
        resetSessionFlow(userId);
        return;
      }
      updateSession(userId, { deleteConfirmStage: 2 });
      const keyboard = new InlineKeyboard().text("✅ ยืนยันลบอีกครั้ง (ยืนยันสุดท้าย)", "delete:confirm2").text("❌ ยกเลิก", "delete:cancel");
      await ctx.reply("⚠️ ยืนยันอีกครั้ง — การลบไม่สามารถย้อนกลับได้", { reply_markup: keyboard });
      return;
    }

    if (data === "delete:confirm2") {
      const session = getSession(userId);
      const pendingEdit = session.pendingEdit;
      if (!pendingEdit) {
        resetSessionFlow(userId);
        return;
      }
      try {
        const website = pendingEdit.sheetName.split("_")[0];
        const actor = { userId, username: ctx.from.username };
        const snapshot = await deleteRowWithLog(pendingEdit.spreadsheetId, pendingEdit.tabName, pendingEdit.sheetId, pendingEdit.rowNumber, actor, website);
        resetSessionFlow(userId);
        if (!snapshot) {
          await ctx.reply(`❌ ไม่พบ row #${pendingEdit.rowNumber}`);
          return;
        }
        await ctx.reply(`✅ ลบ row #${pendingEdit.rowNumber} สำเร็จ`);
      } catch (err) {
        logError(userId, ctx.from.username, String(err));
        await ctx.reply(`❌ เกิดข้อผิดพลาดในการลบ: ${(err as Error).message}`);
      }
      return;
    }
  });

  bot.on("message", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (userId === undefined || chatId === undefined) return;

    const text = ctx.message.text ?? ctx.message.caption ?? "";
    if (text.startsWith("/")) return;

    const isPrivate = ctx.chat.type === "private";

    if (!isAuthorizedUser(userId)) {
      logUnauthorized(userId, ctx.from?.username, `Message in chat ${chatId}`);
      await ctx.reply("❌ คุณไม่ได้รับอนุญาตให้ใช้งาน bot นี้");
      return;
    }

    const session = getSession(userId);
    const fileId = extractPhotoFileId(ctx);
    const mediaGroupId = ctx.message.media_group_id;

    if (isPrivate) {
      if (session.step !== "idle") {
        await continueFlow(ctx, session, text, fileId, mediaGroupId);
        return;
      }
      await ctx.reply("❌ ไม่สามารถบันทึกข้อมูลผ่านแชทส่วนตัวได้ กรุณาส่งข้อมูลในกลุ่มที่กำหนดเท่านั้น");
      return;
    }

    if (!isAllowedGroup(chatId)) {
      return;
    }

    if (session.step !== "idle") {
      await continueFlow(ctx, session, text, fileId, mediaGroupId);
      return;
    }

    await startAdsFlow(ctx, userId, text);
  });
}
