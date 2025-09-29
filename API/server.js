// API/server.js  — ESM
import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

/* ========= ENV ========= */
const PORT = process.env.PORT || 8080;
const DB_URL = process.env.DATABASE_URL;

const PLAYERS_TABLE = "v01dsql";
const EVENTS_TABLE  = "events";

// CORS: список доменов (через запятую), БЕЗ завершающего /
// пример: FRONT_ORIGIN=https://v01d-production.up.railway.app,https://raw.githack.com
const ALLOWED_ORIGINS = (process.env.FRONT_ORIGIN || "")
  .split(",")
  .map(s => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Telegram (необязательно, но можно включить)
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_SECRET    = process.env.TG_SECRET || "";
const FRONT_URL    = (process.env.FRONT_URL || "https://v01d-production.up.railway.app").replace(/\/$/, "");

/* ========= DB ========= */
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false } // Railway PG обычно требует SSL
});

// создадим схемы, если их нет (работает безопасно повторно)
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${PLAYERS_TABLE}(
      id           BIGSERIAL PRIMARY KEY,
      telegram_id  BIGINT UNIQUE,
      sol_address  TEXT UNIQUE,
      callsign     TEXT,
      level        INTEGER DEFAULT 1,
      exp          INTEGER DEFAULT 0,
      resources    JSON   DEFAULT '{}'::json,
      progress     JSON   DEFAULT '{}'::json,
      stats        JSON   DEFAULT '{}'::json,
      settings     JSON   DEFAULT '{}'::json,
      last_login   TIMESTAMPTZ DEFAULT now(),
      created_at   TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE}(
      id         BIGSERIAL PRIMARY KEY,
      player_id  BIGINT REFERENCES ${PLAYERS_TABLE}(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      payload    JSON DEFAULT '{}'::json,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}
ensureSchema().catch(e => {
  console.error("DB init error:", e);
  process.exit(1);
});

/* ========= APP ========= */
const app = express();
app.use(express.json({ limit: "1mb" }));

const corsOptions = {
  origin(origin, cb) {
    // Разрешим пустой origin (health, Telegram webhook, curl)
    if (!origin) return cb(null, true);
    const o = origin.replace(/\/$/, "");
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(o)) return cb(null, true);
    return cb(new Error("CORS"));
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-Requested-With","X-Telegram-Bot-Api-Secret-Token"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // префлайт на всё

// дружелюбная обработка CORS-ошибки
app.use((err, req, res, next) => {
  if (err && err.message === "CORS") return res.status(403).json({ ok:false, error:"CORS" });
  return next(err);
});

/* ========= ROUTES ========= */

// health
app.get("/api/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    console.error("health db:", e);
    res.status(500).json({ ok:false });
  }
});

/**
 * /api/player/sync
 * Принимает:
 *  telegramId?  (number)
 *  solAddress?  (string)
 *  callsign?    (string)
 *  level?       (number)
 *  exp?         (number)
 *  resources?   (json)
 *  progress?    (json)
 *  stats?       (json)
 *
 * Требуется минимум одно из: telegramId ИЛИ solAddress
 *
 * Реализация — UPDATE → если 0 строк, то INSERT (без ON CONFLICT),
 * поэтому работает с любым текущим состоянием таблицы.
 */
app.post("/api/player/sync", async (req, res) => {
  const b = req.body || {};
  const telegramId = b.telegramId ?? null;
  const solAddress = b.solAddress ?? null;

  if (!telegramId && !solAddress) {
    return res.status(400).json({ ok:false, error:"Need telegramId or solAddress" });
  }

  const callsign  = b.callsign ?? "Citizen";
  const level     = Number.isFinite(+b.level) ? +b.level : 1;
  const exp       = Number.isFinite(+b.exp)   ? +b.exp   : 0;
  const resources = b.resources ?? {};
  const progress  = b.progress  ?? {};
  const stats     = b.stats     ?? {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let row;

    if (telegramId) {
      // 1) UPDATE по telegram_id
      const upd = await client.query(
        `
        UPDATE ${PLAYERS_TABLE} SET
          sol_address = COALESCE($2, sol_address),
          callsign    = COALESCE($3, callsign),
          level       = GREATEST(level, $4),
          exp         = GREATEST(exp,   $5),
          resources   = COALESCE($6::json, resources),
          progress    = COALESCE($7::json, progress),
          -- слияние JSON: json -> jsonb -> json
          stats       = (COALESCE(stats, '{}'::json)::jsonb || COALESCE($8::json, '{}'::json)::jsonb)::json,
          last_login  = now()
        WHERE telegram_id = $1
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login;
        `,
        [telegramId, solAddress, callsign, level, exp, resources, progress, stats]
      );

      row = upd.rows[0];

      // 2) Если нет — INSERT
      if (!row) {
        const ins = await client.query(
          `
          INSERT INTO ${PLAYERS_TABLE}
            (telegram_id, sol_address, callsign, level, exp, resources, progress, stats, last_login)
          VALUES ($1, $2, $3, $4, $5, $6::json, $7::json, $8::json, now())
          RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login;
          `,
          [telegramId, solAddress, callsign, level, exp, resources, progress, stats]
        );
        row = ins.rows[0];
      }
    } else {
      // Ветка без telegramId — работаем по sol_address
      const upd = await client.query(
        `
        UPDATE ${PLAYERS_TABLE} SET
          callsign    = COALESCE($2, callsign),
          level       = GREATEST(level, $3),
          exp         = GREATEST(exp,   $4),
          resources   = COALESCE($5::json, resources),
          progress    = COALESCE($6::json, progress),
          stats       = (COALESCE(stats, '{}'::json)::jsonb || COALESCE($7::json, '{}'::json)::jsonb)::json,
          last_login  = now()
        WHERE sol_address = $1
        RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login;
        `,
        [solAddress, callsign, level, exp, resources, progress, stats]
      );

      row = upd.rows[0];

      if (!row) {
        const ins = await client.query(
          `
          INSERT INTO ${PLAYERS_TABLE}
            (sol_address, callsign, level, exp, resources, progress, stats, last_login)
          VALUES ($1, $2, $3, $4, $5::json, $6::json, $7::json, now())
          RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login;
          `,
          [solAddress, callsign, level, exp, resources, progress, stats]
        );
        row = ins.rows[0];
      }
    }

    await client.query("COMMIT");
    return res.json({ ok:true, player: row });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("sync 500:", e);
    return res.status(500).json({ ok:false, error:"server_error" });
  } finally {
    client.release();
  }
});

// события (безопасно — есть ensureSchema)
app.post("/api/events", async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok:false, error:"bad_request" });

    const q = await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (player_id, type, payload) VALUES ($1,$2,$3::json)
       RETURNING id, created_at`,
      [playerId, type, payload]
    );
    res.json({ ok:true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    console.error("events error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// Telegram webhook
app.post("/api/tg/webhook", async (req, res) => {
  try {
    // в проде лучше проверять секрет
    const hdr = req.get("X-Telegram-Bot-Api-Secret-Token");
    if (TG_SECRET && hdr !== TG_SECRET) return res.sendStatus(401);

    const u = req.body;
    if (u?.message && TG_BOT_TOKEN) {
      const chatId = u.message.chat.id;
      const text = (u.message.text || "").trim();

      if (text === "/start" || text.startsWith("/start")) {
        const resp = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type":"application/json" },
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
        const body = await resp.text();
        if (!resp.ok) console.error("TG sendMessage failed:", resp.status, body);
        else          console.log("TG sendMessage ok");
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("tg webhook error:", e);
    res.sendStatus(200);
  }
});

// корень — просто проверка
app.get("/", (_, res) => res.type("text/plain").send("Metaville API is running"));

/* ========= START ========= */
app.listen(PORT, "0.0.0.0", () => console.log("API on :", PORT));
