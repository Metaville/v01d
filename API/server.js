// API/server.js  (ESM)

// ---------- Imports ----------
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import pkg from "pg";

const { Pool } = pkg;

// ---------- App & middlewares ----------
const app = express();
app.use(cors());
app.use(bodyParser.json());           // JSON body
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- DB pool ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ---------- Helpers ----------
const DEFAULT_RESOURCES = { bio: 0, mvc: 0, parts: 0, energy: 0, oxygen: 0 };
const DEFAULT_PROGRESS  = {};
const DEFAULT_STATS     = {};

function pickTelegramId(req) {
  // 1) из body
  if (req.body?.telegramId && !Number.isNaN(Number(req.body.telegramId))) {
    return Number(req.body.telegramId);
  }
  // 2) из query ?tg=...
  if (req.query?.tg && !Number.isNaN(Number(req.query.tg))) {
    return Number(req.query.tg);
  }
  // 3) из заголовка x-telegram-init-data (если когда-нибудь начнёте слать initData)
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

// ---------- UPSERT PLAYER ----------
app.post("/api/player/sync", async (req, res) => {
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

    const q = await pool.query(
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
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login;
      `,
      [telegramId, callsign, level, exp, resources, progress, stats]
    );

    res.json({ ok: true, player: q.rows[0] });
  } catch (err) {
    console.error("sync error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- GET/CREATE BY TELEGRAM ID ----------
app.get("/api/player/by-tg/:telegramId", async (req, res) => {
  try {
    const tg = Number(req.params.telegramId);
    if (!tg) return res.status(400).json({ ok: false, error: "invalid_telegram_id" });

    // Попробуем найти
    const sel = await pool.query(
      `SELECT id, telegram_id, callsign, level, exp, resources, progress, stats, last_login
         FROM players
        WHERE telegram_id = $1`,
      [tg]
    );

    if (sel.rowCount > 0) {
      // Обновим last_login и вернём игрока
      await pool.query(`UPDATE players SET last_login = now() WHERE telegram_id = $1`, [tg]);
      return res.json({ ok: true, player: sel.rows[0] });
    }

    // Если не нашли — создаём запись с дефолтами
    const ins = await pool.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES ($1, 'Citizen', 1, 0, $2::jsonb, $3::jsonb, $4::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE SET last_login = now()
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login;
      `,
      [tg, DEFAULT_RESOURCES, DEFAULT_PROGRESS, DEFAULT_STATS]
    );

    res.json({ ok: true, player: ins.rows[0] });
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
