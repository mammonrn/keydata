import path from "path";
import { Bot, Context, InlineKeyboard } from "grammy";
import { config, isAllowedGroup, isAuthorizedUser } from "../config";
import { AdsData, FIELD_LABELS_TH, REQUIRED_FIELDS, UserSession } from "../types";
import { getSession, resetSessionFlow, updateSession } from "../services/memory";
import { parseAdsMessage, parseSingleFieldValue, formatParsedSummary } from "./parser";
import { EDITABLE_FIELDS } from "./fields";
import { deleteRowWithLog, editRowField, PhotoInput, saveAdsData } from "../services/dataProcessor";
import { logError, logUnauthorized } from "../services/logger";

function missingFieldsOf(data: Partial<AdsData>): string[] {
  return REQUIRED_FIELDS.filter((f) => {
    const value = (data as any)[f];
    return value === undefined || value === null || value === "";
  });
}

function confirmationKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ ยืนยัน", "confirm").text("✏️ แก้ไข", "editrequest").row().text("❌ ยกเลิก", "cancel");
}

async function askForMissingField(ctx: Context, userId: number, field: string): Promise<void> {
  updateSession(userId, { step: "awaiting_field_value", currentMissingField: field });
  const label = FIELD_LABELS_TH[field] ?? field;
  await ctx.reply(`❓ กรุณาระบุ ${label}:`);
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
  await ctx.reply(`โปรดตรวจสอบข้อมูล:\n\n${summary}\n\nยืนยันบันทึกหรือไม่?`, { reply_markup: confirmationKeyboard() });
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

async function startAdsFlow(ctx: Context, userId: number, text: string): Promise<void> {
  const session = getSession(userId);
  const parsed = parseAdsMessage(text);
  const message = ctx.message;
  const photos = message?.photo;

  if (Object.keys(parsed.data).length === 0 && !photos) {
    return;
  }

  const data: Partial<AdsData> = { ...parsed.data };
  if (!data.website && session.defaultWebsite) data.website = session.defaultWebsite;
  if (!data.platform && session.defaultPlatform) data.platform = session.defaultPlatform;

  const photoFileId = photos && photos.length > 0 ? photos[photos.length - 1].file_id : undefined;

  updateSession(userId, {
    pendingData: data,
    pendingPhotoFileId: photoFileId,
  });

  await proceedAfterFieldsUpdated(ctx, userId);
}

async function handleAwaitingFieldValue(ctx: Context, userId: number, text: string): Promise<void> {
  const session = getSession(userId);
  const field = session.currentMissingField;
  if (!field) {
    resetSessionFlow(userId);
    return;
  }
  const value = parseSingleFieldValue(field, text);
  const data = { ...(session.pendingData ?? {}) } as Partial<AdsData>;
  (data as any)[field] = value;
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
  const rawValue = fieldDef.numeric ? String(parseSingleFieldValue(fieldDef.key, text)) : text.trim();
  const actor = { userId, username: ctx.from?.username };
  try {
    const website = pendingEdit.sheetName.split("_")[0];
    const result = await editRowField(pendingEdit.spreadsheetId, pendingEdit.rowNumber, fieldDef.index, rawValue, actor, website);
    resetSessionFlow(userId);
    if (!result) {
      await ctx.reply(`❌ ไม่พบ row #${pendingEdit.rowNumber}`);
      return;
    }
    await ctx.reply(`✅ แก้ไขสำเร็จ\n\nก่อนหน้า: ${result.before[fieldDef.index]}\nปัจจุบัน: ${result.after[fieldDef.index]}`);
  } catch (err) {
    logError(userId, ctx.from?.username, String(err));
    await ctx.reply(`❌ เกิดข้อผิดพลาดในการแก้ไข: ${(err as Error).message}`);
  }
}

async function continueFlow(ctx: Context, session: UserSession, text: string): Promise<void> {
  const userId = session.userId;
  switch (session.step) {
    case "awaiting_field_value":
      await handleAwaitingFieldValue(ctx, userId, text);
      return;
    case "editing_field_value":
      await handleEditingFieldValue(ctx, userId, text);
      return;
    default:
      await ctx.reply("กรุณาใช้ปุ่มที่แสดงไว้ หรือพิมพ์ /cancel เพื่อยกเลิก");
  }
}

async function downloadTelegramPhoto(ctx: Context, fileId: string, dateLabel: string): Promise<PhotoInput> {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const ext = path.extname(file.file_path ?? "") || ".jpg";
  const safeDateLabel = dateLabel.replace(/[^\w-]/g, "-");
  const filename = `${safeDateLabel}_ads_screenshot_${Date.now()}${ext}`;
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

  let photo: PhotoInput | undefined;
  try {
    if (session.pendingPhotoFileId) {
      photo = await downloadTelegramPhoto(ctx, session.pendingPhotoFileId, String(data.date ?? "photo"));
    }
    const actor = { userId, username: ctx.from?.username };
    const result = await saveAdsData(data as Omit<AdsData, "photoLink" | "recordedBy" | "recordedAt">, photo, actor);
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
  keyboard.row().text("❌ ยกเลิก", "cancel");
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
      await askForMissingField(ctx, userId, field);
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
        const snapshot = await deleteRowWithLog(pendingEdit.spreadsheetId, pendingEdit.rowNumber, actor, website);
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

    if (isPrivate) {
      if (session.step !== "idle") {
        await continueFlow(ctx, session, text);
        return;
      }
      await ctx.reply("❌ ไม่สามารถบันทึกข้อมูลผ่านแชทส่วนตัวได้ กรุณาส่งข้อมูลในกลุ่มที่กำหนดเท่านั้น");
      return;
    }

    if (!isAllowedGroup(chatId)) {
      return;
    }

    if (session.step !== "idle") {
      await continueFlow(ctx, session, text);
      return;
    }

    await startAdsFlow(ctx, userId, text);
  });
}
