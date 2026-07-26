import { Bot, Context, InlineKeyboard } from "grammy";
import {
  addAllowedGroup,
  addAuthorizedUser,
  addWebsiteAlias,
  getAllowedGroups,
  getAuthorizedUsers,
  getWebsiteAliases,
  isAuthorizedUser,
  isSuperAdmin,
  normalizePlatformName,
  removeAllowedGroup,
  removeAuthorizedUser,
  ALL_DATA_FIELDS,
  DataField,
  FIELD_SHORT_LABELS,
  MONTH_NAMES_EN,
  cellOf,
  columnIndexOfSystem,
  numericCell,
} from "../config";
import { getSession, resetSessionFlow, setDefaultPlatform, setDefaultWebsite, updateSession } from "../services/memory";
import { FieldTotals, getMonthlyStatus, findSheetForCurrentMonth, listRows } from "../services/dataProcessor";
import { getRow } from "../google/sheets";
import { getRecentLogs, logCommand, logUnauthorized } from "../services/logger";
import { editableFieldsForPlatform, formatRowDisplay } from "./fields";

function username(ctx: Context): string | undefined {
  return ctx.from?.username;
}

async function requireAuthorized(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId === undefined) return false;
  if (!isAuthorizedUser(userId)) {
    logUnauthorized(userId, username(ctx), `Attempted command in chat ${ctx.chat?.id}`);
    await ctx.reply("❌ คุณไม่ได้รับอนุญาตให้ใช้งาน bot นี้");
    return false;
  }
  return true;
}

async function requireSuperAdmin(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId === undefined) return false;
  if (!isSuperAdmin(userId)) {
    await ctx.reply("⛔ เฉพาะ Admin เท่านั้นที่สามารถใช้คำสั่งนี้ได้");
    return false;
  }
  return true;
}

function parseArgs(ctx: Context): string[] {
  const match = (ctx.match as string) ?? "";
  return match.trim().length > 0 ? match.trim().split(/\s+/) : [];
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Money-valued fields render with 2 decimals; counts render as plain
// integers. Averaged rather than summed where a sum would be meaningless.
const MONEY_FIELDS: DataField[] = ["cpr", "totalSpent", "mainBudget"];
const AVERAGED_FIELDS: DataField[] = ["cpr"];

const STATUS_EMOJI: Partial<Record<DataField, string>> = {
  totalMessage: "💬",
  totalClick: "🖱",
  cpr: "💰",
  totalSpent: "💵",
  mainBudget: "🏦",
  impressions: "👁",
  reach: "📈",
  views: "▶️",
  joined: "🙋",
};

/**
 * Renders the metric lines of a /status block. A field only appears when
 * some row actually reported it — with per-platform schemas, a blank column
 * means "this platform doesn't report this", so printing it as 0 would be a
 * lie. Averages divide by the contributing-row count, not the record count.
 */
function statusMetricLines(sums: FieldTotals, counts: FieldTotals): string[] {
  const lines: string[] = [];
  for (const field of ALL_DATA_FIELDS) {
    const count = counts[field] ?? 0;
    const sum = sums[field];
    if (count === 0 || sum === undefined) continue;

    const emoji = STATUS_EMOJI[field] ?? "•";
    const label = FIELD_SHORT_LABELS[field];
    if (AVERAGED_FIELDS.includes(field)) {
      lines.push(`${emoji} ${label} เฉลี่ย: ${formatMoney(sum / count)} บาท (จาก ${count} รายการ)`);
    } else if (MONEY_FIELDS.includes(field)) {
      lines.push(`${emoji} ${label} รวม: ${formatMoney(sum)} บาท (จาก ${count} รายการ)`);
    } else {
      lines.push(`${emoji} ${label} รวม: ${formatInt(sum)} (จาก ${count} รายการ)`);
    }
  }
  return lines;
}

function mergeTotals(entries: { sums: FieldTotals; counts: FieldTotals }[]): { sums: FieldTotals; counts: FieldTotals } {
  const sums: FieldTotals = {};
  const counts: FieldTotals = {};
  for (const entry of entries) {
    for (const field of ALL_DATA_FIELDS) {
      if (entry.counts[field] === undefined) continue;
      sums[field] = (sums[field] ?? 0) + (entry.sums[field] ?? 0);
      counts[field] = (counts[field] ?? 0) + (entry.counts[field] ?? 0);
    }
  }
  return { sums, counts };
}

// One compact line per row for /list, built from whatever that row's tab
// actually has — no empty "CPR: -" padding for platforms without a CPR.
const LIST_PREFERRED_FIELDS: DataField[] = [
  "totalSpent",
  "cpr",
  "views",
  "totalClick",
  "totalMessage",
  "reach",
  "impressions",
  "joined",
  "mainBudget",
];

function formatListRow(header: string[], values: string[]): string {
  const rowNumber = values[0] ?? "?";
  const date = cellOf(header, values, "date") || "-";
  const platformIndex = columnIndexOfSystem(header, "Platform");
  const platform = platformIndex >= 0 ? values[platformIndex] ?? "" : "";

  const parts: string[] = [];
  for (const field of LIST_PREFERRED_FIELDS) {
    if (parts.length >= 3) break;
    const raw = cellOf(header, values, field);
    const num = numericCell(raw);
    if (num === null) continue;
    const rendered = MONEY_FIELDS.includes(field) ? `${formatMoney(num)}฿` : formatInt(num);
    parts.push(`${FIELD_SHORT_LABELS[field]}: ${rendered}`);
  }

  const head = [`#${rowNumber}`, date, platform].filter((p) => p).join(" | ");
  return parts.length > 0 ? `${head} | ${parts.join(" | ")}` : head;
}

export function registerCommands(bot: Bot): void {
  bot.command("start", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    logCommand(ctx.from!.id, username(ctx), "/start");
    await ctx.reply(
      [
        "👋 สวัสดี! ฉันคือ Bot เก็บข้อมูลโฆษณา",
        "",
        "ส่งข้อมูลโฆษณาในกลุ่มที่กำหนด แล้วฉันจะบันทึกลง Google Sheets และเก็บรูปใน Google Drive ให้อัตโนมัติ",
        "",
        "พิมพ์ /help เพื่อดูคำสั่งทั้งหมด",
      ].join("\n")
    );
  });

  bot.command("help", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    logCommand(ctx.from!.id, username(ctx), "/help");
    const isAdmin = isSuperAdmin(ctx.from!.id);
    const lines = [
      "📖 คำสั่งทั้งหมด",
      "",
      "/start - แนะนำ bot",
      "/help - แสดงคำสั่งทั้งหมด",
      "/status - สถานะข้อมูลเดือนนี้",
      "/edit [row] - แก้ไขข้อมูล (ใช้ default website + เดือนปัจจุบัน)",
      "/list [website] [month] [platform] - แสดงรายการข้อมูล",
      "/setwebsite [name] - ตั้งเว็บโปรด (ปุ่มลัดแรกตอนถูกถาม + เว็บเป้าหมายของ /edit และ /delete — ไม่เติมอัตโนมัติตอนบันทึก)",
      "/setplatform [name] - ตั้ง platform โปรด (ปุ่มลัดแรกตอนถูกถาม — ไม่เติมอัตโนมัติตอนบันทึก)",
      "/listalias - แสดง alias ของชื่อเว็บทั้งหมด",
      "/log - แสดง log ล่าสุด 10 รายการ",
    ];
    if (isAdmin) {
      lines.push(
        "",
        "⛔ คำสั่ง Admin เท่านั้น:",
        "/delete [row] - ลบข้อมูล (ต้องยืนยัน 2 ครั้ง)",
        "/addalias [canonical] [alias] - ผูกชื่อเรียกอื่นกับชื่อเว็บมาตรฐาน",
        "/adduser [id] - เพิ่ม authorized user",
        "/removeuser [id] - ลบ authorized user",
        "/addgroup [id] - เพิ่มกลุ่มที่อนุญาต",
        "/removegroup [id] - ลบกลุ่มที่อนุญาต",
        "/users - แสดง authorized users",
        "/groups - แสดง allowed groups"
      );
    }
    lines.push(
      "",
      "หมายเหตุ: บันทึกข้อมูลโฆษณาได้เฉพาะในกลุ่มที่กำหนดเท่านั้น ห้ามส่งข้อมูลผ่านแชทส่วนตัว"
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.command("status", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    logCommand(ctx.from!.id, username(ctx), "/status");
    await ctx.reply("⏳ กำลังตรวจสอบสถานะ...");
    try {
      const status = await getMonthlyStatus();
      const now = new Date();
      const monthLabel = `${MONTH_NAMES_EN[now.getMonth()]} ${now.getFullYear()}`;
      if (status.length === 0) {
        await ctx.reply(`📊 สถานะเดือน ${monthLabel}\n\nยังไม่มีข้อมูลบันทึกในเดือนนี้`);
        return;
      }

      for (const s of status) {
        const lines = [
          `📊 สถานะเว็บ ${s.website} - ${monthLabel}`,
          `📝 จำนวนรายการ: ${formatInt(s.recordCount)} รายการ`,
          ...statusMetricLines(s.sums, s.counts),
        ];
        await ctx.reply(lines.join("\n"));
      }

      const totalRecords = status.reduce((sum, s) => sum + s.recordCount, 0);
      const overall = mergeTotals(status);

      const summaryLines = [
        `📊 สรุปภาพรวมทุกเว็บไซต์ - ${monthLabel}`,
        `🌐 จำนวนเว็บไซต์ที่มีข้อมูล: ${status.length}`,
        `📝 จำนวนรายการรวม: ${formatInt(totalRecords)} รายการ`,
        ...statusMetricLines(overall.sums, overall.counts),
      ];
      await ctx.reply(summaryLines.join("\n"));
    } catch (err) {
      await ctx.reply(`❌ เกิดข้อผิดพลาดในการดึงสถานะ: ${(err as Error).message}`);
    }
  });

  bot.command("setwebsite", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    const args = parseArgs(ctx);
    if (args.length === 0) {
      await ctx.reply("กรุณาระบุชื่อเว็บ เช่น /setwebsite SH666");
      return;
    }
    setDefaultWebsite(ctx.from!.id, args[0]);
    logCommand(ctx.from!.id, username(ctx), `/setwebsite ${args[0]}`);
    await ctx.reply(
      `✅ ตั้งเว็บโปรดเป็น: ${args[0]}\n\nหมายเหตุ: ระบบจะไม่เติมชื่อเว็บให้อัตโนมัติอีกต่อไป — เว็บโปรดจะแสดงเป็นปุ่มแรกตอนถูกถามหาเว็บไซต์ และใช้เป็นเว็บเป้าหมายของ /edit และ /delete`
    );
  });

  bot.command("setplatform", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    const args = parseArgs(ctx);
    if (args.length === 0) {
      await ctx.reply("กรุณาระบุ platform เช่น /setplatform Facebook");
      return;
    }
    const platform = normalizePlatformName(args.join(" "));
    setDefaultPlatform(ctx.from!.id, platform);
    logCommand(ctx.from!.id, username(ctx), `/setplatform ${platform}`);
    await ctx.reply(
      `✅ ตั้ง platform โปรดเป็น: ${platform}\n\nหมายเหตุ: ระบบจะไม่เติม platform ให้อัตโนมัติอีกต่อไป — platform โปรดจะแสดงเป็นปุ่มแรกตอนถูกถามหา platform และใช้เป็น platform เป้าหมายของ /edit และ /delete`
    );
  });

  bot.command("edit", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    const args = parseArgs(ctx);
    const rowNumber = Number(args[0]);
    if (!args[0] || Number.isNaN(rowNumber)) {
      await ctx.reply("กรุณาระบุหมายเลข row เช่น /edit 15");
      return;
    }
    const session = getSession(ctx.from!.id);
    const website = session.defaultWebsite;
    if (!website) {
      await ctx.reply("กรุณาตั้งค่าเว็บก่อนด้วย /setwebsite [name]");
      return;
    }
    const platform = session.defaultPlatform;
    if (!platform) {
      await ctx.reply("กรุณาตั้งค่า platform ก่อนด้วย /setplatform [name] (แต่ละ platform แยก tab กัน)");
      return;
    }
    const sheetInfo = await findSheetForCurrentMonth(website, platform);
    if (!sheetInfo) {
      await ctx.reply(`❌ ไม่พบข้อมูลของเว็บ ${website} (platform: ${platform}) ในเดือนนี้`);
      return;
    }
    const row = await getRow(sheetInfo.spreadsheetId, sheetInfo.tabName, rowNumber);
    if (!row) {
      await ctx.reply(`❌ ไม่พบ row #${rowNumber} ใน tab ${sheetInfo.tabName}`);
      return;
    }

    updateSession(ctx.from!.id, {
      step: "editing_field_select",
      pendingEdit: {
        sheetName: `${website}_${sheetInfo.month}_${sheetInfo.year}`,
        spreadsheetId: sheetInfo.spreadsheetId,
        tabName: sheetInfo.tabName,
        sheetId: sheetInfo.sheetId,
        rowNumber,
        website,
        month: sheetInfo.month,
        year: sheetInfo.year,
      },
    });

    const keyboard = new InlineKeyboard();
    editableFieldsForPlatform(platform).forEach((f, idx) => {
      keyboard.text(f.label, `editfield:${f.key}`);
      if (idx % 2 === 1) keyboard.row();
    });
    keyboard.row().text("❌ ยกเลิก", "editfield:cancel");

    await ctx.reply(
      `📝 ข้อมูล row #${rowNumber} ปัจจุบัน:\n\n${formatRowDisplay(sheetInfo.header, row)}\n\nเลือก field ที่ต้องการแก้ไข:`,
      { reply_markup: keyboard }
    );
    logCommand(ctx.from!.id, username(ctx), `/edit ${rowNumber}`);
  });

  bot.command("list", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    const args = parseArgs(ctx);
    const session = getSession(ctx.from!.id);
    const website = args[0] ?? session.defaultWebsite;
    if (!website) {
      await ctx.reply("กรุณาระบุชื่อเว็บ เช่น /list SH666 July Facebook");
      return;
    }
    const now = new Date();
    let month = MONTH_NAMES_EN[now.getMonth()];
    let platformFilter: string | undefined;

    if (args[1]) {
      const matchedMonth = MONTH_NAMES_EN.find((m) => m.toLowerCase() === args[1].toLowerCase());
      if (matchedMonth) {
        month = matchedMonth;
        if (args[2]) platformFilter = args.slice(2).join(" ");
      } else {
        platformFilter = args.slice(1).join(" ");
      }
    }

    logCommand(ctx.from!.id, username(ctx), `/list ${website} ${month} ${platformFilter ?? ""}`);
    const result = await listRows(website, month, String(now.getFullYear()), platformFilter);
    if (!result || result.rows.length === 0) {
      await ctx.reply(`ไม่พบข้อมูลของ ${website} เดือน ${month}${platformFilter ? ` (platform: ${platformFilter})` : ""}`);
      return;
    }

    const lines = result.rows.slice(0, 30).map((r) => formatListRow(r.header, r.values));
    const header = `📋 ${website} - ${month}${platformFilter ? ` (${platformFilter})` : ""} (${result.rows.length} รายการ)`;
    const suffix = result.rows.length > 30 ? "\n\n(แสดง 30 รายการแรก)" : "";
    await ctx.reply(`${header}\n\n${lines.join("\n")}${suffix}`);
  });

  bot.command("delete", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    if (!(await requireSuperAdmin(ctx))) return;
    const args = parseArgs(ctx);
    const rowNumber = Number(args[0]);
    if (!args[0] || Number.isNaN(rowNumber)) {
      await ctx.reply("กรุณาระบุหมายเลข row เช่น /delete 15");
      return;
    }
    const session = getSession(ctx.from!.id);
    const website = session.defaultWebsite;
    if (!website) {
      await ctx.reply("กรุณาตั้งค่าเว็บก่อนด้วย /setwebsite [name]");
      return;
    }
    const platform = session.defaultPlatform;
    if (!platform) {
      await ctx.reply("กรุณาตั้งค่า platform ก่อนด้วย /setplatform [name] (แต่ละ platform แยก tab กัน)");
      return;
    }
    const sheetInfo = await findSheetForCurrentMonth(website, platform);
    if (!sheetInfo) {
      await ctx.reply(`❌ ไม่พบข้อมูลของเว็บ ${website} (platform: ${platform}) ในเดือนนี้`);
      return;
    }
    const row = await getRow(sheetInfo.spreadsheetId, sheetInfo.tabName, rowNumber);
    if (!row) {
      await ctx.reply(`❌ ไม่พบ row #${rowNumber} ใน tab ${sheetInfo.tabName}`);
      return;
    }

    updateSession(ctx.from!.id, {
      step: "awaiting_delete_confirmation",
      pendingEdit: {
        sheetName: `${website}_${sheetInfo.month}_${sheetInfo.year}`,
        spreadsheetId: sheetInfo.spreadsheetId,
        tabName: sheetInfo.tabName,
        sheetId: sheetInfo.sheetId,
        rowNumber,
        website,
        month: sheetInfo.month,
        year: sheetInfo.year,
      },
      deleteConfirmStage: 1,
    });

    const keyboard = new InlineKeyboard().text("✅ ยืนยันลบ", "delete:confirm1").text("❌ ยกเลิก", "delete:cancel");
    await ctx.reply(`⚠️ ยืนยันการลบ row #${rowNumber}?\n\n${formatRowDisplay(sheetInfo.header, row)}`, { reply_markup: keyboard });
    logCommand(ctx.from!.id, username(ctx), `/delete ${rowNumber}`);
  });

  bot.command("log", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    const isAdmin = isSuperAdmin(ctx.from!.id);
    const entries = getRecentLogs(10, isAdmin ? undefined : ctx.from!.id);
    logCommand(ctx.from!.id, username(ctx), "/log");
    if (entries.length === 0) {
      await ctx.reply("ไม่มี log");
      return;
    }
    const lines = entries.map((e) => `[${e.timestamp}] ${e.action} - ${e.details}`);
    await ctx.reply(`🪵 Log ล่าสุด:\n\n${lines.join("\n")}`);
  });

  bot.command("adduser", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    if (!(await requireSuperAdmin(ctx))) return;
    const args = parseArgs(ctx);
    const id = Number(args[0]);
    if (!args[0] || Number.isNaN(id)) {
      await ctx.reply("กรุณาระบุ telegram id เช่น /adduser 123456789");
      return;
    }
    const added = addAuthorizedUser(id);
    logCommand(ctx.from!.id, username(ctx), `/adduser ${id}`);
    await ctx.reply(added ? `✅ เพิ่ม ${id} เป็น authorized user แล้ว` : `${id} เป็น authorized user อยู่แล้ว`);
  });

  bot.command("removeuser", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    if (!(await requireSuperAdmin(ctx))) return;
    const args = parseArgs(ctx);
    const id = Number(args[0]);
    if (!args[0] || Number.isNaN(id)) {
      await ctx.reply("กรุณาระบุ telegram id เช่น /removeuser 123456789");
      return;
    }
    const removed = removeAuthorizedUser(id);
    logCommand(ctx.from!.id, username(ctx), `/removeuser ${id}`);
    await ctx.reply(removed ? `✅ ลบ ${id} ออกจาก authorized users แล้ว` : `${id} ไม่ได้อยู่ใน authorized users`);
  });

  bot.command("addgroup", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    if (!(await requireSuperAdmin(ctx))) return;
    const args = parseArgs(ctx);
    const id = Number(args[0]);
    if (!args[0] || Number.isNaN(id)) {
      await ctx.reply("กรุณาระบุ group id เช่น /addgroup -100123456789");
      return;
    }
    const added = addAllowedGroup(id);
    logCommand(ctx.from!.id, username(ctx), `/addgroup ${id}`);
    await ctx.reply(added ? `✅ เพิ่มกลุ่ม ${id} เป็นกลุ่มที่อนุญาตแล้ว` : `กลุ่ม ${id} อยู่ในรายการอยู่แล้ว`);
  });

  bot.command("removegroup", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    if (!(await requireSuperAdmin(ctx))) return;
    const args = parseArgs(ctx);
    const id = Number(args[0]);
    if (!args[0] || Number.isNaN(id)) {
      await ctx.reply("กรุณาระบุ group id เช่น /removegroup -100123456789");
      return;
    }
    const removed = removeAllowedGroup(id);
    logCommand(ctx.from!.id, username(ctx), `/removegroup ${id}`);
    await ctx.reply(removed ? `✅ ลบกลุ่ม ${id} ออกจากรายการแล้ว` : `กลุ่ม ${id} ไม่ได้อยู่ในรายการ`);
  });

  bot.command("users", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    if (!(await requireSuperAdmin(ctx))) return;
    logCommand(ctx.from!.id, username(ctx), "/users");
    await ctx.reply(`👥 Authorized Users:\n\n${getAuthorizedUsers().join("\n")}`);
  });

  bot.command("groups", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    if (!(await requireSuperAdmin(ctx))) return;
    logCommand(ctx.from!.id, username(ctx), "/groups");
    await ctx.reply(`👥 Allowed Groups:\n\n${getAllowedGroups().join("\n")}`);
  });

  bot.command("addalias", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    if (!(await requireSuperAdmin(ctx))) return;
    const args = parseArgs(ctx);
    if (args.length < 2) {
      await ctx.reply("กรุณาระบุ canonical และ alias เช่น /addalias SH999 shwe999");
      return;
    }
    const result = addWebsiteAlias(args[0], args[1]);
    logCommand(ctx.from!.id, username(ctx), `/addalias ${args[0]} ${args[1]}`);
    await ctx.reply(
      result.added
        ? `✅ เพิ่ม alias "${result.alias}" → ${result.canonical} แล้ว`
        : `"${result.alias}" เป็น alias ของ ${result.canonical} อยู่แล้ว`
    );
  });

  bot.command("listalias", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    logCommand(ctx.from!.id, username(ctx), "/listalias");
    const aliases = getWebsiteAliases();
    const entries = Object.entries(aliases);
    if (entries.length === 0) {
      await ctx.reply("ยังไม่มี alias ในระบบ");
      return;
    }
    const lines = entries.map(([canonical, list]) => `• ${canonical}: ${list.join(", ") || "-"}`);
    await ctx.reply(`🔗 Website Aliases:\n\n${lines.join("\n")}`);
  });

  bot.command("cancel", async (ctx) => {
    if (!(await requireAuthorized(ctx))) return;
    resetSessionFlow(ctx.from!.id);
    await ctx.reply("ยกเลิกการทำงานปัจจุบันแล้ว");
  });
}
