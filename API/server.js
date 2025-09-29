// API/server.js  (ESM, Node 18+)
import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

/* ========= ENV ========= */
const PORT = process.env.PORT || 8080;
const DB_URL = process.env.DATABASE_URL;

// твоя таблица
const PLAYERS_TABLE = "players";
const EVENTS_TABLE  = "events"; // опционально, если есть

// домены фронта (через запятую, без завершающего /)
const FRONT_URL       = process.env.FRONT_URL || "https://v01d-production.up.railway.app";
const FRONT_ORIGINENV = process.env.FRONT_ORIGIN || "";
const ALLOWED_ORIGINS = [FRONT_URL, ...FRONT_ORIGINENV.split(",")]
  .map(s => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Telegram (не обязательно)
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_SECRET    = process.env.TG_SECRET || "";

/* ========= DB ========= */
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false }
});

// Быстрая миграция — создаст таблицу и уникальный индекс при первом старте (если их нет)
async function ensureSchema() {
  const sql = `
  CREATE TABLE IF NOT EXISTS ${PLAYERS_TABLE} (
    id          BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE,
    callsign    TEXT,
    level       INTEGER NOT NULL DEFAULT 1,
    exp         INTEGER NOT NULL DEFAULT 0,
    resources   JSONB   NOT NULL DEFAULT '{}'::jsonb,
    progress    JSONB   NOT NULL DEFAULT '{}'::jsonb,
    stats       JSONB   NOT NULL DEFAULT '{}'::jsonb
  );

  -- на всякий случай
  CREATE UNIQUE INDEX IF NOT EXISTS ${PLAYERS_TABLE}_telegram_id_uq ON ${PLAYERS_TABLE}(telegram_id);
  `;
  await pool.query(sql);
}

/* ========= APP ========= */
const app = express();

// CORS
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // Telegram WebView / curl / health
    const o = origin.replace(/\/$/, "");
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(o)) return cb(null, true);
    return cb(new Error("CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
};

app.use((req, _res, next) => {
  if (req.method === "OPTIONS") {
    console.log("CORS preflight:", req.path, "origin=", req.headers.origin);
  }
  next();
});

app.use(cors(corsOptions));
app.options("/api/*", cors(corsOptions));
app.use(express.json());

// Красивая обработка cors-ошибки
app.use((err, _req, res, next) => {
  if (err && err.message === "CORS") return res.status(403).json({ ok: false, error: "CORS" });
  return next(err);
});

/* ========= ROUTES ========= */

// health
app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch (e) { console.error("health db:", e); res.status(500).json({ ok: false }); }
});

// синхрон игрока — ТЕПЕРЬ ТОЛЬКО ПО telegram_id
app.post("/api/player/sync", async (req, res) => {
  try {
    const body = req.body || {};
    const telegramId = body.telegramId ?? null;       // обязателен
    const callsign   = body.callsign   ?? "Citizen";
    const level      = Number(body.level ?? 1);
    const exp        = Number(body.exp   ?? 0);
    const resources  = body.resources   ?? {};
    const progress   = body.progress    ?? {};
    const stats      = body.stats       ?? {};

    if (!telegramId) {
      return res.status(400).json({ ok:false, error: "telegramId_required" });
    }

    // Вставляем или обновляем: level/exp берём максимум, jsonb подставляем/сливаем
    const q = await pool.query(
      `
      INSERT INTO ${PLAYERS_TABLE}
        (telegram_id, callsign, level, exp, resources, progress, stats)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign  = COALESCE(EXCLUDED.callsign, ${PLAYERS_TABLE}.callsign),
        level     = GREATEST(${PLAYERS_TABLE}.level, EXCLUDED.level),
        exp       = GREATEST(${PLAYERS_TABLE}.exp,   EXCLUDED.exp),
        resources = COALESCE(EXCLUDED.resources, ${PLAYERS_TABLE}.resources),
        progress  = COALESCE(EXCLUDED.progress,  ${PLAYERS_TABLE}.progress),
        stats     = COALESCE(${PLAYERS_TABLE}.stats, '{}'::jsonb) || COALESCE(EXCLUDED.stats, '{}'::jsonb)
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats;
      `,
      [telegramId, callsign, level, exp, resources, progress, stats]
    );

    return res.json({ ok: true, player: q.rows[0] });
  } catch (e) {
    console.error("sync error:", e);
    return res.status(500).json({ ok:false, error:"server_error" });
  }
});

// (опционально) события, если есть таблица events (id, player_id, type, payload jsonb, created_at timestamptz default now())
app.post("/api/events", async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok:false, error:"bad_request" });

    const q = await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (player_id, type, payload) VALUES ($1,$2,$3::jsonb)
       RETURNING id, created_at`,
      [playerId, type, payload]
    );
    res.json({ ok:true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    console.error("events error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// Telegram webhook (один эндпоинт)
app.post("/api/tg/webhook", async (req, res) => {
  try {
    // при желании можно включить проверку секрета
    const hdr = req.get("X-Telegram-Bot-Api-Secret-Token");
    if (TG_SECRET && hdr !== TG_SECRET) return res.sendStatus(401);

    const u = req.body;
    if (u?.message && TG_BOT_TOKEN) {
      const chatId = u.message.chat.id;
      const text = (u.message.text || "").trim();

      if (text === "/start" || text.startsWith("/start")) {
        const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "Открыть игру 👇",
            reply_markup: {
              inline_keyboard: [[{ text: "Metaville", web_app: { url: FRONT_URL } }]]
            }
          })
        });
        const t = await r.text();
        if (!r.ok) console.error("TG sendMessage failed:", r.status, t);
        else       console.log("TG sendMessage ok");
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("tg webhook error:", e);
    res.sendStatus(200);
  }
});

// корневой
app.get("/", (_req, res) => res.type("text/plain").send("Metaville API is running"));

/* ========= START ========= */
ensureSchema()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log("API on :", PORT));
  })
  .catch((e) => {
    console.error("ensureSchema failed:", e);
    process.exit(1);
  });
