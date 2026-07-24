import path from "path";
import { Bot, Context, InlineKeyboard } from "grammy";
import { config, isAllowedGroup, isAuthorizedUser, isCanonicalPlatform, isSuperAdmin, listCanonicalPlatforms, normalizePlatformName, normalizeWebsiteName } from "../config";
import { AdsData, FIELD_LABELS_TH, REQUIRED_FIELDS, TOTAL_MESSAGE_OR_CLICK_FIELD, UserSession } from "../types";
import { getSession, resetSessionFlow, updateSession } from "../services/memory";
import { formatParsedSummary, parseAdsMessage, parseFieldAnswer, parseTotalMessageOrClickAnswer } from "./parser";
import { EDITABLE_FIELDS } from "./fields";
import { deleteRowWithLog, editRowField, moveRowToWebsite, PhotoInput, saveAdsData } from "../services/dataProcessor";
import { isKnownWebsite, listKnownWebsites } from "../google/drive";
import { logError, logUnauthorized } from "../services/logger";

// Shortcut buttons offered when asking for the website; used as a fallback
// when the Drive folder listing is unavailable.
const FALLBACK_WEBSITES = ["SH666", "SH999", "UB89", "88F"];

const REQUIRED_FIELD_SET: readonly string[] = REQUIRED_FIELDS;

function isEmptyNumber(v: number | undefined | null): boolean {
  return v === undefined || v === null;
}

function missingFieldsOf(data: Partial<AdsData>): string[] {
  const missing: string[] = [];
  if (!data.date) missing.push("date");
  if (isEmptyNumber(data.totalMessage) && isEmptyNumber(data.totalClick)) {
    missing.push(TOTAL_MESSAGE_OR_CLICK_FIELD);
  }
  for (const f of ["cpr", "totalSpent", "reach", "website", "platform"] as const) {
    const value = (data as any)[f];
    if (value === undefined || value === null || value === "") missing.push(f);
  }
  return missing;
}

function confirmationKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ ยืนยัน", "confirm").text("✏️ แก้ไข", "editrequest").row().text("❌ ยกเลิก", "cancel");
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
  });
  const summary = formatParsedSummary(data);
  const photoCount = session.pendingPhotoFileIds?.length ?? 0;
  const photoLine = photoCount > 0 ? `\n\n📷 แนบรูปแล้ว ${photoCount} รูป` : "";
  await ctx.reply(`โปรดตรวจสอบข้อมูล:\n\n${summary}${photoLine}\n\nยืนยันบันทึกหรือไม่?`, { reply_markup: confirmationKeyboard() });
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
  await showConfirmation(ctx, userId);
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
  // Platform may auto-fill from /setplatform, but website must never be
  // silently defaulted: groups mix records for several websites, and a
  // stale session default was mis-filing other sites' data. When absent
  // from the message, website is asked for explicitly (with shortcut
  // buttons) like any other required field.
  if (!data.platform && session.defaultPlatform) data.platform = session.defaultPlatform;

  const ids = [...heldPhotoIds(session)];
  if (fileId && !ids.includes(fileId)) ids.push(fileId);

  updateSession(userId, {
    pendingData: data,
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
  const fieldDef = EDITABLE_FIELDS.find((f) => String(f.index) === pendingEdit.field);
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
    const result2 = await editRowField(pendingEdit.spreadsheetId, pendingEdit.tabName, pendingEdit.rowNumber, fieldDef.index, rawValue, actor, website);
    resetSessionFlow(userId);
    if (!result2) {
      await ctx.reply(`❌ ไม่พบ row #${pendingEdit.rowNumber}`);
      return;
    }
    await ctx.reply(`✅ แก้ไขสำเร็จ\n\nก่อนหน้า: ${result2.before[fieldDef.index]}\nปัจจุบัน: ${result2.after[fieldDef.index]}`);
  } catch (err) {
    logError(userId, ctx.from?.username, String(err));
    await ctx.reply(`❌ เกิดข้อผิดพลาดในการแก้ไข: ${(err as Error).message}`);
  }
}

async function continueFlow(ctx: Context, session: UserSession, text: string, fileId?: string, mediaGroupId?: string): Promise<void> {
  const userId = session.userId;

  if (fileId && (session.step === "awaiting_confirmation" || session.step === "awaiting_field_value")) {
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
  if ((session.step === "awaiting_field_value" || session.step === "awaiting_confirmation") && text.trim()) {
    const parsedFull = parseAdsMessage(text);
    if (Object.keys(parsedFull.data).length >= 2) {
      const current = getSession(userId);
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
      if (!data.platform && current.defaultPlatform) data.platform = current.defaultPlatform;
      updateSession(userId, { pendingData: data, currentMissingField: undefined });
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

function pendingEditKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  EDITABLE_FIELDS.forEach((f, idx) => {
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

    if (data === "editrequest") {
      const session = getSession(userId);
      if (!session.pendingData) {
        await ctx.reply("ไม่มีข้อมูลที่รอการแก้ไข");
        return;
      }
      await ctx.reply("เลือก field ที่ต้องการแก้ไข:", { reply_markup: pendingEditKeyboard() });
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
      if (session.step === "editing_field_value" && session.pendingEdit?.field === "-1") {
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
      if (session.step === "editing_field_value" && session.pendingEdit?.field === "-1") {
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

      if (session.step === "editing_field_value" && session.pendingEdit?.field === "2") {
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

      if (session.step === "editing_field_value" && session.pendingEdit?.field === "2") {
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
      await ctx.reply("เลือก field ที่ต้องการแก้ไข:", { reply_markup: pendingEditKeyboard() });
      return;
    }

    if (data === "cancel") {
      resetSessionFlow(userId);
      await ctx.reply("ยกเลิกแล้ว");
      return;
    }

    if (data.startsWith("editfield:")) {
      const value = data.split(":")[1];
      if (value === "cancel") {
        resetSessionFlow(userId);
        await ctx.reply("ยกเลิกแล้ว");
        return;
      }
      const fieldDef = EDITABLE_FIELDS[Number(value)];
      const session = getSession(userId);
      if (!fieldDef || !session.pendingEdit) {
        resetSessionFlow(userId);
        await ctx.reply("เกิดข้อผิดพลาด กรุณาลอง /edit ใหม่");
        return;
      }
      updateSession(userId, {
        step: "editing_field_value",
        pendingEdit: { ...session.pendingEdit, field: String(fieldDef.index) },
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
