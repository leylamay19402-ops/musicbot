const { Telegraf, Markup } = require("telegraf");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN || "8611421854:AAEhZq9nZOdgfF0KAt22RBrvQxaNELoauH8";
const WEB_APP_URL = process.env.WEB_APP_URL || "";

const bot = new Telegraf(BOT_TOKEN);

const DOWNLOAD_FOLDER = "./downloads";
if (!fs.existsSync(DOWNLOAD_FOLDER)) fs.mkdirSync(DOWNLOAD_FOLDER);

function checkYtDlp() {
  try { execSync("yt-dlp --version", { stdio: "pipe" }); return true; }
  catch { return false; }
}
const ytdlpAvailable = checkYtDlp();
if (!ytdlpAvailable) console.warn("⚠️ yt-dlp не найден — скачивание треков недоступно");
else console.log("✅ yt-dlp найден");

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
function addTrackToLibrary(userId, track) {
  const tracks = getUserLibrary(userId);
  if (!tracks.find(t => t.id === track.id)) {
    tracks.push(track);
    setUserLibrary(userId, tracks);
  }
}

try {
  fs.readdirSync(DOWNLOAD_FOLDER).forEach(f => {
    try { fs.unlinkSync(path.join(DOWNLOAD_FOLDER, f)); } catch {}
  });
} catch {}

function mainKeyboard() {
  return Markup.keyboard([
    [Markup.button.webApp("🎧 Открыть плеер", WEB_APP_URL)],
    ["📚 Библиотека", "❓ Помощь"]
  ]).resize();
}

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf-8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

const pendingTracks = new Map();
const activeUsers = new Set();

bot.start((ctx) => {
  ctx.reply(
    "🎵 Привет! Я музыкальный бот.\n\n" +
    "• Напиши название песни — найду и пришлю MP3\n" +
    "• Кинь MP3 файл — добавлю в плеер\n" +
    "• Открой плеер кнопкой ниже 👇",
    mainKeyboard()
  );
});

bot.hears("❓ Помощь", (ctx) => {
  ctx.reply(
    "📖 <b>Как пользоваться:</b>\n\n" +
    "1. Напиши название песни — найду MP3\n" +
    "2. Или кинь свой MP3 файл — добавлю в плеер\n" +
    "3. После загрузки MP3 можешь отправить фото — станет обложкой\n\n" +
    "❤️ Все треки синхронизируются с плеером",
    { parse_mode: "HTML", ...mainKeyboard() }
  );
});

bot.hears("📚 Библиотека", (ctx) => {
  const tracks = getUserLibrary(ctx.from.id);
  if (tracks.length === 0) {
    return ctx.reply("📚 Библиотека пуста.\n\nОткрой плеер и нажми ❤️ на треке чтобы добавить.", mainKeyboard());
  }
  const list = tracks.map((t, i) => `${i + 1}. 🎵 <b>${t.title}</b>\n    👤 ${t.channel || '—'}`).join("\n\n");
  ctx.reply(`📚 <b>Библиотека</b> (${tracks.length} треков):\n\n${list}`, { parse_mode: "HTML", ...mainKeyboard() });
});

bot.on("audio", async (ctx) => {
  const userId = ctx.from.id;
  const audio = ctx.message.audio;

  const rawTitle = audio.title || audio.file_name?.replace(/\.mp3$/i, '') || 'Без названия';
  const artist = audio.performer || '';
  const trackId = `tg_${audio.file_id.slice(-12)}`;

  const track = {
    id: trackId,
    title: rawTitle,
    channel: artist,
    thumbnail: '',
    tgFileId: audio.file_id,
    source: 'telegram'
  };

  pendingTracks.set(userId, { track });
  addTrackToLibrary(userId, track);

  await ctx.reply(
    `✅ Трек добавлен в библиотеку!\n\n🎵 <b>${rawTitle}</b>${artist ? `\n👤 ${artist}` : ''}\n\nХочешь добавить обложку? Отправь фото, или /skip`,
    { parse_mode: "HTML", ...mainKeyboard() }
  );
});

bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;
  const pending = pendingTracks.get(userId);
  if (!pending) return;

  const photos = ctx.message.photo;
  const bestPhoto = photos[photos.length - 1];

  try {
    const fileInfo = await ctx.telegram.getFile(bestPhoto.file_id);
    const photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;

    const db = loadLibrary();
    const tracks = db[String(userId)] || [];
    const idx = tracks.findIndex(t => t.id === pending.track.id);
    if (idx > -1) {
      tracks[idx].thumbnail = photoUrl;
      db[String(userId)] = tracks;
      saveLibrary(db);
    }

    pendingTracks.delete(userId);
    await ctx.reply("✅ Обложка добавлена! Открой плеер — трек уже там.", mainKeyboard());
  } catch (err) {
    await ctx.reply("❌ Не удалось сохранить обложку.", mainKeyboard());
  }
});

bot.command("skip", (ctx) => {
  pendingTracks.delete(ctx.from.id);
  ctx.reply("👍 Ок! Открой плеер — трек уже там.", mainKeyboard());
});

bot.on("text", async (ctx) => {
  const query = ctx.message.text;
  const userId = ctx.from.id;

  if (query.startsWith("/") || query.startsWith("📚") || query.startsWith("❓")) return;

  if (!ytdlpAvailable) {
    return ctx.reply("❌ Скачивание недоступно.\n\nОткрой плеер для поиска музыки 🎧", mainKeyboard());
  }

  if (activeUsers.has(userId)) return ctx.reply("⏳ Подожди...");
  activeUsers.add(userId);

  let statusMsg;
  let filePath;

  try {
    statusMsg = await ctx.reply(`🔍 Ищу: <b>${query}</b>...`, { parse_mode: "HTML" });
    const searchQuery = query.replace(/"/g, "").replace(/`/g, "");

    const videoId = await runCommand(
      `yt-dlp --print id --no-playlist --match-filter "duration < 600" "ytsearch1:${searchQuery}"`
    );
    if (!videoId || videoId.length < 5) throw new Error("Видео не найдено");

    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "⏳ Скачиваю MP3...");

    const timestamp = Date.now();
    const outputTemplate = path.join(DOWNLOAD_FOLDER, `${timestamp}.%(ext)s`);

    await runCommand(
      `yt-dlp -x --audio-format mp3 --audio-quality 2 --no-playlist --no-mtime -o "${outputTemplate}" "https://www.youtube.com/watch?v=${videoId}"`
    );

    const files = fs.readdirSync(DOWNLOAD_FOLDER).filter(f => f.startsWith(`${timestamp}`));
    if (files.length === 0) throw new Error("Файл не найден");
    filePath = path.join(DOWNLOAD_FOLDER, files[0]);

    if (fs.statSync(filePath).size > 50 * 1024 * 1024) throw new Error("Файл больше 50MB");

    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, "📤 Отправляю...");

    let title = query;
    try { title = await runCommand(`yt-dlp --print title "https://www.youtube.com/watch?v=${videoId}"`); } catch {}

    await ctx.replyWithAudio({ source: filePath }, {
      caption: `🎵 ${title}\n🔗 https://youtu.be/${videoId}`,
      ...mainKeyboard()
    });

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (err) {
    const errText = err.message.includes("50MB") ? "❌ Трек слишком длинный" : "❌ Не нашёл трек. Попробуй другой запрос.";
    if (statusMsg) {
      try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, errText); }
      catch { await ctx.reply(errText, mainKeyboard()); }
    } else {
      await ctx.reply(errText, mainKeyboard());
    }
  } finally {
    if (filePath && fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch {}
    activeUsers.delete(userId);
  }
});

// Бот запускается через polling — сервер отдельно в server.js
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log("✅ Бот запущен!");
}).catch(err => {
  console.error("❌ Ошибка запуска бота:", err.message);
});

process.once("SIGINT", () => { bot.stop("SIGINT"); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); });

module.exports = { bot };
