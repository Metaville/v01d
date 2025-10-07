// API/server.js  (ESM)

// ---------- Imports ----------
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import pkg from "pg";

const { Pool } = pkg;

// ---------- App & middlewares ----------
const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Лёгкие логи всех /api/* запросов (видно в Railway Logs)
app.use(morgan("tiny"));

// Ограничим частоту обращений к API (чтобы не заспамили БД)
app.use(
  "/api/",
  rateLimit({
    windowMs: 10 * 1000, // 10 секундное окно
    max: 60,             // не более 60 запросов в окно с одного IP
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Не кэшируем ответы API
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.set("Cache-Control", "no-store");
  }
  next();
});

// ---------- Env ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null; // добавь в Variables на Railway (необязательно)
const TG_SECRET = process.env.TG_SECRET || null;          // необязательный секрет вебхука

// ---------- DB pool ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ---------- Defaults & helpers ----------
const DEFAULT_RESOURCES = { bio: 0, mvc: 0, parts: 0, energy: 0, oxygen: 0, ice: 0 };
const DEFAULT_PROGRESS  = {};
const DEFAULT_STATS     = {};

function normalizeResources(src) {
  const r = src && typeof src === "object" ? src : {};
  const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
  return {
    oxygen: num(r.oxygen),
    energy: num(r.energy),
    mvc:    num(r.mvc),
    bio:    num(r.bio),
    parts:  num(r.parts),
    ice:    num(r.ice),
  };
}

function normalizePlainObject(x, fallback = {}) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : fallback;
}

function pickTelegramId(req) {
  // 1) из body
  if (req.body?.telegramId && !Number.isNaN(Number(req.body.telegramId))) {
    return Number(req.body.telegramId);
  }
  // 2) из query ?tg=...
  if (req.query?.tg && !Number.isNaN(Number(req.query.tg))) {
    return Number(req.query.tg);
  }
  // 3) из заголовка x-telegram-init-data (если будете слать initData)
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

// ---------- Health ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "v01d API", ts: new Date().toISOString() });
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------- Telegram webhook (optional) ----------
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
    console.log("TG update:", JSON.stringify({ id: update?.update_id, text: update?.message?.text }));

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
    res.sendStatus(200); // телеграму всегда 200, чтобы не ретраил
  }
});

// ---------- POST /api/player/sync ----------
app.post("/api/player/sync", async (req, res) => {
  try {
    const telegramId = pickTelegramId(req);
    if (!telegramId) {
      return res.status(400).json({ ok: false, error: "telegramId_required" });
    }

    const callsign  = typeof req.body?.callsign === "string" && req.body.callsign.trim()
      ? req.body.callsign.trim()
      : "Citizen";
    const level     = Number(req.body?.level) || 1;
    const exp       = Number(req.body?.exp)   || 0;

    const incoming  = normalizeResources(req.body?.resources);
    const progress  = normalizePlainObject(req.body?.progress, DEFAULT_PROGRESS);
    const stats     = normalizePlainObject(req.body?.stats,    DEFAULT_STATS);

    // Полезный лог — видно входящие ресурсы и tg
    console.log("[sync]", { tg: telegramId, resources: incoming });

    const q = await pool.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign   = COALESCE(EXCLUDED.callsign, players.callsign),
        level      = GREATEST(players.level, EXCLUDED.level),
        exp        = GREATEST(players.exp,   EXCLUDED.exp),

        -- слияние JSONB: обновим только присланные ключи, остальное не трогаем
        resources  = COALESCE(players.resources, '{}'::jsonb) || EXCLUDED.resources,
        progress   = COALESCE(players.progress,  '{}'::jsonb) || EXCLUDED.progress,
        stats      = COALESCE(players.stats,     '{}'::jsonb) || EXCLUDED.stats,

        last_login = now()
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login;
      `,
      [telegramId, callsign, level, exp, incoming, progress, stats]
    );

    res.json({ ok: true, player: q.rows[0] });
  } catch (err) {
    console.error("sync error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- GET /api/player/by-tg/:telegramId ----------
app.get("/api/player/by-tg/:telegramId", async (req, res) => {
  try {
    const tg = Number(req.params.telegramId);
    if (!tg) return res.status(400).json({ ok: false, error: "invalid_telegram_id" });

    // Идемпотентный upsert: создаём дефолт при первом заходе, потом только обновляем last_login
    const q = await pool.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES ($1, 'Citizen', 1, 0, $2::jsonb, $3::jsonb, $4::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE SET
        last_login = now()
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login;
      `,
      [tg, DEFAULT_RESOURCES, DEFAULT_PROGRESS, DEFAULT_STATS]
    );

    res.json({ ok: true, player: q.rows[0] });
  } catch (err) {
    console.error("get player error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("API on:", PORT);
});
