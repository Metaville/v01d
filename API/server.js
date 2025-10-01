import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Подключение к Postgres (Railway даёт переменную DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

// ========== TEST ROUTE ==========
app.get("/", (req, res) => {
  res.json({ ok: true, message: "API is running" });
});

// ========== UPSERT PLAYER ==========
app.post("/api/player/sync", async (req, res) => {
  try {
    console.log("sync request:", req.body, req.query);

    let telegramId = null;

    // 1) ищем в body
    if (req.body?.telegramId) {
      const n = Number(req.body.telegramId);
      if (!Number.isNaN(n)) telegramId = n;
    }

    // 2) ищем в query ?tg=...
    if (!telegramId && req.query?.tg) {
      const n = Number(req.query.tg);
      if (!Number.isNaN(n)) telegramId = n;
    }

    if (!telegramId) {
      return res.status(400).json({ ok: false, error: "telegramId_required" });
    }

    const {
      callsign = "Citizen",
      level = 1,
      exp = 0,
      resources = {},
      progress = {},
      stats = {}
    } = req.body || {};

    const q = await pool.query(
      `
      INSERT INTO players (telegram_id, callsign, level, exp, resources, progress, stats)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign  = COALESCE(EXCLUDED.callsign, players.callsign),
        level     = GREATEST(players.level, EXCLUDED.level),
        exp       = GREATEST(players.exp,   EXCLUDED.exp),
        resources = EXCLUDED.resources,
        progress  = EXCLUDED.progress,
        stats     = players.stats || EXCLUDED.stats
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

// ========== GET PLAYER BY TELEGRAM ID ==========
app.get("/api/player/by-tg/:telegramId", async (req, res) => {
  try {
    const telegramId = Number(req.params.telegramId);
    if (!telegramId) {
      return res.status(400).json({ ok: false, error: "invalid_telegram_id" });
    }

    const result = await pool.query(
      `SELECT id, telegram_id, callsign, level, exp, resources, progress, stats
       FROM players
       WHERE telegram_id = $1`,
      [telegramId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    return res.json({ ok: true, player: result.rows[0] });
  } catch (err) {
    console.error("get player error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("API on:", PORT);
});
