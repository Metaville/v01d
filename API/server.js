// API/server.js (ESM)

import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

// ---------- конфиг ----------
const PORT = process.env.PORT || 8080;
const DEV = process.env.NODE_ENV !== "production";

// Railway -> DATABASE_URL уже есть в переменных
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: DEV ? false : { rejectUnauthorized: false },
});

// ---------- базовые объекты по умолчанию ----------
const DEFAULT_RESOURCES = { bio: 0, mvc: 0, parts: 0, energy: 0, oxygen: 0 };
const DEFAULT_PROGRESS  = {};
const DEFAULT_STATS     = {};

// ---------- утилиты ----------
const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// пытаемся вытащить telegramId из body, из query (?tg=...), либо из заголовка x-telegram-init-data
function extractTelegramId(req) {
  // 1) body.telegramId
  if (req.body?.telegramId != null) {
    const n = toNumber(req.body.telegramId);
    if (n) return n;
  }
  // 2) ?tg=...
  if (req.query?.tg != null) {
    const n = toNumber(req.query.tg);
    if (n) return n;
  }
  // 3) x-telegram-init-data (если когда-нибудь начнёшь его присылать с клиента)
  const init = req.get("x-telegram-init-data");
  if (init) {
    try {
      const p = new URLSearchParams(init);
      const userStr = p.get("user");
      if (userStr) {
        const user = JSON.parse(userStr);
        const n = toNumber(user?.id);
        if (n) return n;
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

// ---------- app ----------
const app = express();

app.use(cors());                 // пока что без жёсткого списка origin
app.use(express.json({ limit: "1mb" }));

// health
app.get("/", (_req, res) => res.json({ ok: true, message: "API is running" }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------- UPSERT игрока ----------
app.post("/api/player/sync", async (req, res) => {
  try {
    const telegramId = extractTelegramId(req);
    if (!telegramId) {
      return res.status(400).json({ ok: false, error: "telegramId_required" });
    }

    // данные из клиента
    const {
      callsign  = "Citizen",
      level     = 1,
      exp       = 0,
      resources = DEFAULT_RESOURCES,
      progress  = DEFAULT_PROGRESS,
      stats     = DEFAULT_STATS,
    } = req.body || {};

    const q = await pool.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign  = COALESCE(EXCLUDED.callsign, players.callsign),
        level     = GREATEST(players.level, EXCLUDED.level),
        exp       = GREATEST(players.exp,   EXCLUDED.exp),
        resources = EXCLUDED.resources,
        progress  = EXCLUDED.progress,
        -- безопасное слияние jsonb (если вдруг NULL)
        stats     = COALESCE(players.stats, '{}'::jsonb) || COALESCE(EXCLUDED.stats, '{}'::jsonb)
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats;
      `,
      [telegramId, callsign, level, exp, resources, progress, stats]
    );

    return res.json({ ok: true, player: q.rows[0] });
  } catch (err) {
    console.error("sync error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- GET игрока по Telegram ID с автосозданием ----------
app.get("/api/player/by-tg/:telegramId", async (req, res) => {
  try {
    const telegramId = toNumber(req.params.telegramId);
    if (!telegramId) {
      return res.status(400).json({ ok: false, error: "invalid_telegram_id" });
    }

    // сначала пробуем найти
    let r = await pool.query(
      `SELECT id, telegram_id, callsign, level, exp, resources, progress, stats
         FROM players
        WHERE telegram_id = $1`,
      [telegramId]
    );

    // если нет — создаём минимальную запись и читаем снова
    if (r.rows.length === 0) {
      await pool.query(
        `
        INSERT INTO players (telegram_id, callsign, level, exp, resources, progress, stats)
        VALUES ($1, 'Citizen', 1, 0, $2::jsonb, $3::jsonb, $4::jsonb)
        ON CONFLICT (telegram_id) DO NOTHING
        `,
        [telegramId, DEFAULT_RESOURCES, DEFAULT_PROGRESS, DEFAULT_STATS]
      );

      r = await pool.query(
        `SELECT id, telegram_id, callsign, level, exp, resources, progress, stats
           FROM players
          WHERE telegram_id = $1`,
        [telegramId]
      );
    }

    return res.json({ ok: true, player: r.rows[0] });
  } catch (err) {
    console.error("get player error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- запуск ----------
app.listen(PORT, () => {
  console.log("API on:", PORT);
});
