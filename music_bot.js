const { Telegraf, Markup } = require("telegraf");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// ============================================================
// НАСТРОЙКИ
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN || "8611421854:AAEhZq9nZOdgfF0KAt22RBrvQxaNELoauH8";
const WEB_APP_URL = process.env.WEB_APP_URL || "https://effortless-fox-43285b.netlify.app";
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

const DOWNLOAD_FOLDER = "./downloads";
if (!fs.existsSync(DOWNLOAD_FOLDER)) fs.mkdirSync(DOWNLOAD_FOLDER);

// ─── Проверка yt-dlp ─────────────────────────────────────────
function checkYtDlp() {
  try { execSync("yt-dlp --version", { stdio: "pipe" }); return true; }
  catch { return false; }
}

if (!checkYtDlp()) {
  console.warn("⚠️ yt-dlp не найден — скачивание треков недоступно");
}
console.log("✅ yt-dlp найден");

// ─── Библиотека ───────────────────────────────────────────────
const DB_FILE = "./library.json";

function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf-8")); }
  catch { return {}; }
}

function saveLibrary(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function getUserLibrary(userId) {
  return loadLibrary()[String(userId)] || [];
}

function setUserLibrary(userId, tracks) {
  const db = loadLibrary();
  db[String(userId)] = tracks;
  saveLibrary(db);
}

// ─── Очистка downloads при запуске ───────────────────────────
function cleanDownloads() {
  try {
    const files = fs.readdirSync(DOWNLOAD_FOLDER);
    files.forEach(f => {
      try { fs.unlinkSync(path.join(DOWNLOAD_FOLDER, f)); } catch {}
    });
    if (files.length > 0) console.log(`🧹 Удалено старых файлов: ${files.length}`);
  } catch {}
}
cleanDownloads();

// ─── Клавиатура ───────────────────────────────────────────────
function mainKeyboard() {
  return Markup.keyboard([
    [Markup.button.webApp("🎧 Открыть плеер", WEB_APP_URL)],
    ["📚 Библиотека", "❓ Помощь"]
  ]).resize();
}

// ─── Защита от спама ──────────────────────────────────────────
const activeUsers = new Set();

// ─── Запуск команды ───────────────────────────────────────────
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf-8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ─── /start ───────────────────────────────────────────────────
bot.start((ctx) => {
  ctx.reply(
    "🎵 Привет! Я музыкальный бот.\n\n" +
    "• Напиши название песни — пришлю MP3\n" +
    "• Или открой плеер кнопкой ниже 👇",
    mainKeyboard()
  );
});

// ─── Помощь ───────────────────────────────────────────────────
bot.hears("❓ Помощь", (ctx) => {
  ctx.reply(
    "📖 <b>Как пользоваться:</b>\n\n" +
    "1. Напиши название песни или исполнителя\n" +
    "2. Подожди — скачаю и пришлю MP3\n" +
    "3. Открой <b>плеер</b> для поиска и сохранения треков\n\n" +
    "❤️ Треки из плеера автоматически синхронизируются в <b>Библиотеку</b>",
    { parse_mode: "HTML", ...mainKeyboard() }
  );
});

// ─── Библиотека ───────────────────────────────────────────────
bot.hears("📚 Библиотека", (ctx) => {
  const tracks = getUserLibrary(ctx.from.id);

  if (tracks.length === 0) {
    return ctx.reply(
      "📚 Библиотека пуста.\n\nОткрой плеер и нажми ❤️ на треке чтобы добавить.",
      mainKeyboard()
    );
  }

  const list = tracks
    .map((t, i) => `${i + 1}. 🎵 <b>${t.title}</b>\n    👤 ${t.channel}\n    🔗 https://youtu.be/${t.id}`)
    .join("\n\n");

  ctx.reply(
    `📚 <b>Библиотека</b> (${tracks.length} треков):\n\n${list}`,
    { parse_mode: "HTML", ...mainKeyboard() }
  );
});

// ─── СИНХРОНИЗАЦИЯ БИБЛИОТЕКИ ИЗ ПЛЕЕРА ──────────────────────
// favorite.js на Netlify отправляет скрытую команду /sync_library
// бот перехватывает и обновляет library.json
bot.command("sync_library", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Извлекаем base64 payload
  const parts = text.split(" ");
  if (parts.length < 2) return;

  try {
    const payload = Buffer.from(parts[1], "base64").toString("utf-8");
    const { action, track } = JSON.parse(payload);

    if (!action || !track || !track.id) return;

    let tracks = getUserLibrary(userId);

    if (action === "add") {
      // Не добавляем дубликаты
      if (!tracks.find(t => t.id === track.id)) {
        tracks.push({
          id: track.id,
          title: track.title,
          channel: track.channel,
          thumbnail: track.thumbnail || ""
        });
        setUserLibrary(userId, tracks);
        console.log(`✅ [${userId}] Добавлен трек: ${track.title}`);
      }
    } else if (action === "remove") {
      tracks = tracks.filter(t => t.id !== track.id);
      setUserLibrary(userId, tracks);
      console.log(`🗑 [${userId}] Удалён трек: ${track.title}`);
    }

    // Удаляем служебное сообщение чтобы не засорять чат
    try {
      await ctx.deleteMessage();
    } catch {}

  } catch (err) {
    console.error("Sync error:", err.message);
  }
});

// ─── Скачивание треков ────────────────────────────────────────
bot.on("text", async (ctx) => {
  const query = ctx.message.text;
  const userId = ctx.from.id;

  // Игнорируем кнопки и команды
  if (query.startsWith("/") || query.startsWith("📚") || query.startsWith("❓")) return;

  // Защита от спама
  if (activeUsers.has(userId)) {
    return ctx.reply("⏳ Подожди, ещё скачиваю предыдущий трек...");
  }

  activeUsers.add(userId);
  let statusMsg;
  let filePath;

  try {
    statusMsg = await ctx.reply(`🔍 Ищу: <b>${query}</b>...`, { parse_mode: "HTML" });

    const searchQuery = query.replace(/"/g, "").replace(/`/g, "");

    // Ищем видео (не длиннее 10 минут)
    const videoId = await runCommand(
      `yt-dlp --print id --no-playlist --match-filter "duration < 600" "ytsearch1:${searchQuery}"`
    );

    if (!videoId || videoId.length < 5) throw new Error("Видео не найдено");

    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      "⏳ Скачиваю MP3..."
    );

    const timestamp = Date.now();
    const outputTemplate = path.join(DOWNLOAD_FOLDER, `${timestamp}.%(ext)s`);

    await runCommand(
      `yt-dlp -x --audio-format mp3 --audio-quality 2 ` +
      `--no-playlist --no-mtime ` +
      `-o "${outputTemplate}" ` +
      `"https://www.youtube.com/watch?v=${videoId}"`
    );

    const files = fs.readdirSync(DOWNLOAD_FOLDER)
      .filter(f => f.startsWith(`${timestamp}`));

    if (files.length === 0) throw new Error("Файл не найден после скачивания");

    filePath = path.join(DOWNLOAD_FOLDER, files[0]);

    // Проверяем размер (лимит Telegram 50MB)
    if (fs.statSync(filePath).size > 50 * 1024 * 1024) {
      throw new Error("Файл больше 50MB");
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null, "📤 Отправляю..."
    );

    // Получаем название
    let title = query;
    try {
      title = await runCommand(
        `yt-dlp --print title "https://www.youtube.com/watch?v=${videoId}"`
      );
    } catch {}

    await ctx.replyWithAudio(
      { source: filePath },
      {
        caption: `🎵 ${title}\n🔗 https://youtu.be/${videoId}`,
        ...mainKeyboard()
      }
    );

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

  } catch (err) {
    console.error("Ошибка:", err.message);

    const errText = err.message.includes("50MB")
      ? "❌ Трек слишком длинный (больше 50MB)"
      : "❌ Не нашёл трек. Попробуй:\n• Написать на английском\n• Добавить имя исполнителя\n• Проверить правописание";

    if (statusMsg) {
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, errText);
      } catch {
        await ctx.reply(errText, mainKeyboard());
      }
    } else {
      await ctx.reply(errText, mainKeyboard());
    }
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    activeUsers.delete(userId);
  }
});

// ─── Запуск ───────────────────────────────────────────────────
bot.launch({
  allowedUpdates: [],
  dropPendingUpdates: true
}).then(() => {
  console.log("✅ Бот запущен!");
  console.log(`🌐 Mini App: ${WEB_APP_URL}`);
}).catch(err => {
  console.error("❌ Ошибка запуска бота:", err.message);
  // Если 409 — подождём и попробуем снова
  if (err.message.includes('409')) {
    console.log("⏳ Конфликт — жду 5 секунд и перезапускаю...");
    setTimeout(() => {
      bot.launch({ dropPendingUpdates: true }).then(() => {
        console.log("✅ Бот перезапущен!");
      }).catch(e => console.error("❌ Повторная ошибка:", e.message));
    }, 5000);
  }
});

process.once("SIGINT", () => { console.log("\n🛑 Остановлен"); bot.stop("SIGINT"); });
process.once("SIGTERM", () => { console.log("\n🛑 Остановлен"); bot.stop("SIGTERM"); });

