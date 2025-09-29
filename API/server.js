// API/server.js  (ESM, Node 18+)
import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

/* ========= ENV ========= */
const PORT         = process.env.PORT || 8080;
const DB_URL       = process.env.DATABASE_URL;
const FRONT_URL    = (process.env.FRONT_URL || "https://v01d-production.up.railway.app").replace(/\/$/, "");
const ALLOWED_ORIG = (process.env.FRONT_ORIGIN || "")
  .split(",")
  .map(s => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Telegram
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_SECRET    = process.env.TG_SECRET || "";

/* ========= CONSTANTS ========= */
const PLAYERS_TABLE = "v01dsql"; // твоя таблица игроков
const EVENTS_TABLE  = "events";  // опционально (создадим, если нужно)

/* ========= DB ========= */
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false }
});

// Опционально: создадим таблицы, если их нет (безопасно для существующих)
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${PLAYERS_TABLE} (
      id           BIGSERIAL PRIMARY KEY,
      telegram_id  BIGINT UNIQUE,
      sol_address  TEXT UNIQUE,
      callsign     TEXT,
      level        INT DEFAULT 1,
      exp          INT DEFAULT 0,
      resources    JSON DEFAULT '{}'::json,
      progress     JSON DEFAULT '{}'::json,
      stats        JSON DEFAULT '{}'::json,
      last_login   TIMESTAMPTZ DEFAULT now(),
      created_at   TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
      id         BIGSERIAL PRIMARY KEY,
      player_id  BIGINT NOT NULL,
      type       TEXT NOT NULL,
      payload    JSON DEFAULT '{}'::json,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Индексы с учётом возможных NULL
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${PLAYERS_TABLE}_telegram_id_uq
      ON ${PLAYERS_TABLE} (telegram_id) WHERE telegram_id IS NOT NULL;
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${PLAYERS_TABLE}_sol_address_uq
      ON ${PLAYERS_TABLE} (sol_address) WHERE sol_address IS NOT NULL;
  `);
}
ensureSchema().catch(e => {
  console.error("DB ensureSchema error:", e);
  // не падаем, если таблица уже в другом формате — код ниже всё равно работает
});

/* ========= APP (порядок важен) ========= */
const app = express();
app.use(express.json());

// CORS
const corsOptions = {
  origin(origin, cb) {
    // Разрешаем пустой Origin (health/webhook/curl) и любой из ALLOWED_ORIG
    if (!origin) return cb(null, true);
    const o = origin.replace(/\/$/, "");
    if (!ALLOWED_ORIG.length || ALLOWED_ORIG.includes(o)) return cb(null, true);
    return cb(new Error("CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Лог префлайтов для дебага
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    console.log("CORS preflight:", req.path, "origin=", req.headers.origin);
  }
  next();
});

// Акуратная обработка ошибок CORS
app.use((err, req, res, next) => {
  if (err && err.message === "CORS") {
    return res.status(403).json({ ok: false, error: "CORS" });
  }
  return next(err);
});

/* ========= ROUTES ========= */

// Health
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    console.error("health db:", e);
    res.status(500).json({ ok: false });
  }
});

// Синхронизация игрока
app.post("/api/player/sync", async (req, res) => {
  try {
    const b = req.body || {};
    const telegramId = b.telegramId ?? null;
    const solAddress = b.solAddress ?? null;

    if (!telegramId && !solAddress) {
      return res.status(400).json({ ok: false, error: "Need telegramId or solAddress" });
    }

    const callsign   = b.callsign ?? "Citizen";
    const level      = Number.isFinite(+b.level) ? +b.level : 1;
    const exp        = Number.isFinite(+b.exp)   ? +b.exp   : 0;
    const resources  = b.resources ?? {};
    const progress   = b.progress  ?? {};
    const stats      = b.stats     ?? {};

    let q;
    if (telegramId) {
      q = await pool.query(
        `
        INSERT INTO ${PLAYERS_TABLE}
          (telegram_id, sol_address, callsign, level, exp, resources, progress, stats, last_login)
        VALUES ($1, $2, $3, $4, $5, $6::json, $7::json, $8::json, now())
        ON CONFLICT (telegram_id) DO UPDATE SET
          sol_address = COALESCE(EXCLUDED.sol_address, ${PLAYERS_TABLE}.sol_address),
          callsign    = COALESCE(EXCLUDED.callsign,    ${PLAYERS_TABLE}.callsign),
          level       = GREATEST(${PLAYERS_TABLE}.level, EXCLUDED.level),
          exp         = GREATEST(${PLAYERS_TABLE}.exp,   EXCLUDED.exp),
          resources   = COALESCE(EXCLUDED.resources, ${PLAYERS_TABLE}.resources),
          progress    = COALESCE(EXCLUDED.progress,  ${PLAYERS_TABLE}.progress),
          stats = (
            COALESCE(${PLAYERS_TABLE}.stats, '{}'::json)::jsonb
            || COALESCE(EXCLUDED.stats,      '{}'::json)::jsonb
          )::json,
          last_login  = now()
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login;
        `,
        [telegramId, solAddress, callsign, level, exp, resources, progress, stats]
      );
    } else {
      q = await pool.query(
        `
        INSERT INTO ${PLAYERS_TABLE}
          (sol_address, callsign, level, exp, resources, progress, stats, last_login)
        VALUES ($1, $2, $3, $4, $5::json, $6::json, $7::json, now())
        ON CONFLICT (sol_address) DO UPDATE SET
          callsign    = COALESCE(EXCLUDED.callsign,    ${PLAYERS_TABLE}.callsign),
          level       = GREATEST(${PLAYERS_TABLE}.level, EXCLUDED.level),
          exp         = GREATEST(${PLAYERS_TABLE}.exp,   EXCLUDED.exp),
          resources   = COALESCE(EXCLUDED.resources, ${PLAYERS_TABLE}.resources),
          progress    = COALESCE(EXCLUDED.progress,  ${PLAYERS_TABLE}.progress),
          stats = (
            COALESCE(${PLAYERS_TABLE}.stats, '{}'::json)::jsonb
            || COALESCE(EXCLUDED.stats,      '{}'::json)::jsonb
          )::json,
          last_login  = now()
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login;
        `,
        [solAddress, callsign, level, exp, resources, progress, stats]
      );
    }

    return res.json({ ok: true, player: q.rows[0] });
  } catch (e) {
    console.error("sync 500:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// (опционально) Лог событий
app.post("/api/events", async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }
    const q = await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (player_id, type, payload)
       VALUES ($1, $2, $3::json)
       RETURNING id, created_at`,
      [playerId, type, payload]
    );
    res.json({ ok: true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    console.error("events 500:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Telegram webhook
app.post("/api/tg/webhook", async (req, res) => {
  try {
    if (TG_SECRET) {
      const hdr = req.get("X-Telegram-Bot-Api-Secret-Token");
      if (hdr !== TG_SECRET) return res.sendStatus(401);
    }
    const u = req.body;

    // Ответ на /start
    const text = u?.message?.text?.trim() || "";
    const chatId = u?.message?.chat?.id;

    if (chatId && text.startsWith("/start") && TG_BOT_TOKEN) {
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Открыть игру 👇",
          reply_markup: {
            inline_keyboard: [[
              { text: "Metaville", web_app: { url: FRONT_URL } }
            ]]
          }
        })
      });
      const body = await r.text();
      if (!r.ok) console.error("TG sendMessage failed:", r.status, body);
      else       console.log("TG sendMessage ok");
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("tg webhook 500:", e);
    res.sendStatus(200); // не даём TG переотправлять слишком агрессивно
  }
});

// Корневой
app.get("/", (_req, res) => res.type("text/plain").send("Metaville API is running"));

/* ========= START ========= */
app.listen(PORT, "0.0.0.0", () => {
  console.log("API on :", PORT);
});
