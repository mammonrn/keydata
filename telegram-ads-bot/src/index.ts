import { Bot } from "grammy";
import { config, validateEnv } from "./config";
import { registerCommands } from "./bot/commands";
import { registerHandlers } from "./bot/handlers";
import { logError } from "./services/logger";

async function main(): Promise<void> {
  validateEnv();

  const bot = new Bot(config.telegramBotToken);

  registerCommands(bot);
  registerHandlers(bot);

  bot.catch((err) => {
    const ctx = err.ctx;
    const userId = ctx.from?.id ?? 0;
    console.error("Bot error:", err.error);
    logError(userId, ctx.from?.username, String(err.error));
  });

  console.log("🤖 Telegram Ads Bot กำลังเริ่มทำงาน (long polling)...");
  await bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Bot @${botInfo.username} เริ่มทำงานแล้ว`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal error starting bot:", err);
  process.exit(1);
});
