// API/server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { Pool } from "pg";

const app = express();
const PORT = process.env.PORT || 8080;

// Разрешим фронту ходить к API
app.use(cors({
  origin: true, // можно сузить до нужных доменов
  credentials: false
}));
app.use(bodyParser.json({ limit: "1mb" }));

// Railway: Postgres → DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : undefined
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

/**
 * Синхронизация игрока (UPsert по telegram_id).
 * Требуется: telegramId (bigint).
 * Остальные поля — опциональны.
 */
app.post("/api/player/sync", async (req, res) => {
  try {
    const {
      telegramId,       // number | string (bigint)
      callsign,         // string?
      level,            // number?
      exp,              // number?
      resources,        // object?
      progress,         // object?
      stats             // object?
    } = req.body || {};

    // Жёстко требуем telegramId (ты этого и хотел).
    if (!telegramId) {
      return res.status(400).json({ ok: false, error: "telegramId_required" });
    }

    // Приводим типы и ставим дефолты
    const tg = BigInt(String(telegramId));               // гарантируем bigint
    const _callsign = callsign ?? "Citizen";
    const _level    = Math.max(1, parseInt(level ?? 1, 10));
    const _exp      = Math.max(0, parseInt(exp ?? 0, 10));
    const _res      = resources ?? {};
    const _prog     = progress  ?? {};
    const _stats    = stats     ?? {};

    // Важно: таблица players и upsert по telegram_id
    const sql = `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES
        ($1::bigint, $2::text,   $3::int, $4::int, $5::jsonb, $6::jsonb, $7::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign   = COALESCE(EXCLUDED.callsign, players.callsign),
        level      = GREATEST(players.level, EXCLUDED.level),
        exp        = GREATEST(players.exp,   EXCLUDED.exp),
        resources  = COALESCE(EXCLUDED.resources, players.resources),
        progress   = COALESCE(EXCLUDED.progress,  players.progress),
        stats      = (COALESCE(players.stats,'{}'::jsonb) || COALESCE(EXCLUDED.stats,'{}'::jsonb)),
        last_login = now()
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, created_at, last_login;
    `;

    const params = [tg, _callsign, _level, _exp, _res, _prog, _stats];
    const { rows } = await pool.query(sql, params);

    return res.json({ ok: true, player: rows[0] });
  } catch (err) {
    console.error("sync error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/**
 * Лёгкий лог событий (опционально; если таблица events есть).
 * body: { playerId, type, payload }
 */
app.post("/api/events", async (req, res) => {
  try {
    const { playerId, type, payload } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok: false, error: "bad_body" });

    const sql = `INSERT INTO events (player_id, type, payload) VALUES ($1,$2,$3::jsonb) RETURNING id`;
    const { rows } = await pool.query(sql, [playerId, String(type), payload ?? {}]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error("event error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(PORT, () => console.log("API on:", PORT));
