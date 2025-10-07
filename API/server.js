// server.js  — ESM

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import pkg from "pg";

const { Pool } = pkg;

const app = express();

// -------- optional morgan (не обязателен) --------
let morgan = null;
try {
  ({ default: morgan } = await import("morgan")); // если пакета нет — просто пропустим
} catch {}
if (morgan) app.use(morgan("tiny"));

// -------- CORS --------
// Разрешённые источники. Можно перечислить несколько через запятую в переменной окружения CORS_ORIGINS
// Например: CORS_ORIGINS="https://raw.githack.com,https://metaville.example"
const ALLOWED = (process.env.CORS_ORIGINS || "https://raw.githack.com").split(",").map(s => s.trim());

app.use(cors({
  origin(origin, cb) {
    // Без Origin (например, curl или браузерный navigate) — пропускаем
    if (!origin) return cb(null, true);
    const ok = ALLOWED.includes(origin);
    return cb(null, ok);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-telegram-init-data"],
  maxAge: 86400,
}));

// Ответы на preflight
app.options("*", cors());

// Тела запросов
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Не кэшировать API
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.set("Cache-Control", "no-store");
  }
  next();
});

// -------- TG webhook (по желанию) --------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_SECRET = process.env.TG_SECRET || "";

app.post("/api/tg/webhook", async (req, res) => {
  try {
    if (TG_SECRET) {
      const hdr = req.get("x-telegram-bot-api-secret-token");
      if (hdr !== TG_SECRET) {
        console.warn("TG webhook: wrong secret token");
        return res.sendStatus(401);
      }
    }

    const update = req.body;
    console.log("TG update:", update?.update_id, update?.message?.text);

    if (BOT_TOKEN && update?.message?.text === "/start") {
      const chatId = update.message.chat.id;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "Вебхук работает ✅" }),
      });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("TG webhook error:", e);
    res.sendStatus(200);
  }
});

// -------- DB --------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const DEFAULT_RESOURCES = { bio: 0, mvc: 0, parts: 0, energy: 0, oxygen: 0 };
const DEFAULT_PROGRESS  = {};
const DEFAULT_STATS     = {};

function pickTelegramId(req) {
  // 1) из body
  const bId = req.body?.telegramId ?? req.body?.telegram_id;
  if (bId && !Number.isNaN(Number(bId))) return Number(bId);
  // 2) из query
  const qId = req.query?.tg;
  if (qId && !Number.isNaN(Number(qId))) return Number(qId);
  // 3) из init-data (если начнёшь слать)
  const init = req.get?.("x-telegram-init-data");
  if (init) {
    try {
      const p = new URLSearchParams(init);
      const userStr = p.get("user");
      if (userStr) {
        const user = JSON.parse(userStr);
        const n = Number(user?.id);
        if (!Number.isNaN(n)) return n;
      }
    } catch {}
  }
  return null;
}

// -------- Health --------
app.get("/", (_req, res) => res.json({ ok: true, service: "v01d API", ts: new Date().toISOString() }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// -------- GET/CREATE BY TG --------
app.get("/api/player/by-tg/:telegramId", async (req, res) => {
  const client = await pool.connect();
  try {
    const tg = Number(req.params.telegramId);
    if (!tg) return res.status(400).json({ ok: false, error: "invalid_telegram_id" });

    await client.query("BEGIN");

    const sel = await client.query(
      `SELECT id, telegram_id, callsign, level, exp, resources, progress, stats, last_login
         FROM players
        WHERE telegram_id = $1
        LIMIT 1`,
      [tg]
    );

    if (sel.rowCount > 0) {
      await client.query(`UPDATE players SET last_login = now() WHERE telegram_id = $1`, [tg]);
      await client.query("COMMIT");
      return res.json({ ok: true, player: sel.rows[0] });
    }

    const ins = await client.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES ($1, 'Citizen', 1, 0, $2::jsonb, $3::jsonb, $4::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE SET last_login = now()
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login
      `,
      [tg, DEFAULT_RESOURCES, DEFAULT_PROGRESS, DEFAULT_STATS]
    );

    await client.query("COMMIT");
    res.json({ ok: true, player: ins.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("get player error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// -------- UPSERT (полная синхронизация) --------
app.post("/api/player/sync", async (req, res) => {
  const client = await pool.connect();
  try {
    const telegramId = pickTelegramId(req);
    if (!telegramId) {
      return res.status(400).json({ ok: false, error: "telegramId_required" });
    }

    const {
      callsign  = "Citizen",
      level     = 1,
      exp       = 0,
      resources = DEFAULT_RESOURCES,
      progress  = DEFAULT_PROGRESS,
      stats     = DEFAULT_STATS,
    } = req.body || {};

    // нормализуем resources (защита от частичных апдейтов)
    const R = { ...DEFAULT_RESOURCES, ...(resources || {}) };

    await client.query("BEGIN");

    const q = await client.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign   = COALESCE(EXCLUDED.callsign, players.callsign),
        level      = GREATEST(players.level, EXCLUDED.level),
        exp        = GREATEST(players.exp,   EXCLUDED.exp),
        resources  = EXCLUDED.resources,
        progress   = EXCLUDED.progress,
        stats      = players.stats || EXCLUDED.stats,
        last_login = now()
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login
      `,
      [telegramId, callsign, level, exp, R, progress || {}, stats || {}]
    );

    await client.query("COMMIT");
    res.json({ ok: true, player: q.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("sync error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// -------- Глобальный обработчик ошибок (чтобы CORS всё равно был) --------
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ ok: false, error: "server_error" });
});

// -------- Запуск --------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("API on:", PORT, "allowed origins:", ALLOWED);
});

// На всякий случай ещё логируем необработанные промисы
process.on("unhandledRejection", (r) => console.error("unhandledRejection:", r));
