import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

/* ========= ENV ========= */
const PORT = process.env.PORT || 8080;
const DB_URL = process.env.DATABASE_URL;

const PLAYERS_TABLE = "v01dsql";
const EVENTS_TABLE  = "events";

const FRONT_URL = (process.env.FRONT_URL || "https://v01d-production.up.railway.app").replace(/\/$/, "");
const ALLOWED_ORIGINS = (process.env.FRONT_ORIGIN || "")
  .split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_SECRET    = process.env.TG_SECRET || "";

/* ========= DB ========= */
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false }
});

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
ensureSchema().catch(e => { console.error("DB init error:", e); process.exit(1); });

/* ========= APP ========= */
const app = express();
app.use(express.json({ limit: "1mb" }));

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // health/webhook
    const o = origin.replace(/\/$/, "");
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(o)) return cb(null, true);
    return cb(new Error("CORS"));
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-Requested-With","X-Telegram-Bot-Api-Secret-Token"]
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use((err, req, res, next) => {
  if (err && err.message === "CORS") return res.status(403).json({ ok:false, error:"CORS" });
  return next(err);
});

/* ========= HELPERS ========= */
const J = (x) => JSON.stringify(x ?? {}); // всегда строка для ::json

/* ========= ROUTES ========= */

app.get("/api/health", async (_, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok:true }); }
  catch(e){ console.error("health:", e); res.status(500).json({ ok:false }); }
});

/**
 * /api/player/sync
 * Требует хотя бы одно из: telegramId ИЛИ solAddress
 * Порядок:
 *  - если есть telegramId: UPDATE по telegram_id → 0 строк? тогда если есть sol_address — UPDATE по sol_address (дописываем telegram_id, если null) → иначе INSERT
 *  - если есть только sol_address: UPDATE по sol_address → 0 строк? → INSERT
 *  - если INSERT словил 23505 (unique_violation) — повторный UPDATE по альтернативному ключу.
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
  const resources = J(b.resources);
  const progress  = J(b.progress);
  const stats     = J(b.stats);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let row;

    const selectByTg = async (tg) =>
      (await client.query(
        `SELECT id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login
         FROM ${PLAYERS_TABLE} WHERE telegram_id = $1`, [tg])).rows[0];

    const selectBySol = async (sa) =>
      (await client.query(
        `SELECT id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login
         FROM ${PLAYERS_TABLE} WHERE sol_address = $1`, [sa])).rows[0];

    // Обновление по telegram_id
    if (telegramId) {
      const upd = await client.query(
        `UPDATE ${PLAYERS_TABLE} SET
           sol_address = COALESCE($2, sol_address),
           callsign    = COALESCE($3, callsign),
           level       = GREATEST(level, $4),
           exp         = GREATEST(exp,   $5),
           resources   = COALESCE($6::json, resources),
           progress    = COALESCE($7::json, progress),
           stats       = (COALESCE(stats,'{}'::json)::jsonb || COALESCE($8::json,'{}'::json)::jsonb)::json,
           last_login  = now()
         WHERE telegram_id = $1
         RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`,
        [telegramId, solAddress, callsign, level, exp, resources, progress, stats]
      );
      row = upd.rows[0];

      // Не нашли по TG — попробуем по sol_address
      if (!row && solAddress) {
        const updSol = await client.query(
          `UPDATE ${PLAYERS_TABLE} SET
             telegram_id = COALESCE(telegram_id, $2),
             callsign    = COALESCE($3, callsign),
             level       = GREATEST(level, $4),
             exp         = GREATEST(exp,   $5),
             resources   = COALESCE($6::json, resources),
             progress    = COALESCE($7::json, progress),
             stats       = (COALESCE(stats,'{}'::json)::jsonb || COALESCE($8::json,'{}'::json)::jsonb)::json,
             last_login  = now()
           WHERE sol_address = $1
           RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`,
          [solAddress, telegramId, callsign, level, exp, resources, progress, stats]
        );
        row = updSol.rows[0];
      }

      if (!row) {
        // Вставка
        try {
          const ins = await client.query(
            `INSERT INTO ${PLAYERS_TABLE}
               (telegram_id, sol_address, callsign, level, exp, resources, progress, stats, last_login)
             VALUES ($1,$2,$3,$4,$5,$6::json,$7::json,$8::json, now())
             RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`,
            [telegramId, solAddress, callsign, level, exp, resources, progress, stats]
          );
          row = ins.rows[0];
        } catch (e) {
          // 23505 — кто-то уже есть. Сольём по альтернативному ключу.
          if (e.code === "23505" && solAddress) {
            row = await selectBySol(solAddress);
            if (!row) throw e;
            const updAlt = await client.query(
              `UPDATE ${PLAYERS_TABLE} SET
                 telegram_id = COALESCE(telegram_id, $2),
                 callsign    = COALESCE($3, callsign),
                 level       = GREATEST(level, $4),
                 exp         = GREATEST(exp,   $5),
                 resources   = COALESCE($6::json, resources),
                 progress    = COALESCE($7::json, progress),
                 stats       = (COALESCE(stats,'{}'::json)::jsonb || COALESCE($8::json,'{}'::json)::jsonb)::json,
                 last_login  = now()
               WHERE sol_address = $1
               RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`,
              [solAddress, telegramId, callsign, level, exp, resources, progress, stats]
            );
            row = updAlt.rows[0];
          } else {
            throw e;
          }
        }
      }
    } else {
      // Ветка без telegramId: работаем по sol_address
      const upd = await client.query(
        `UPDATE ${PLAYERS_TABLE} SET
           callsign    = COALESCE($2, callsign),
           level       = GREATEST(level, $3),
           exp         = GREATEST(exp,   $4),
           resources   = COALESCE($5::json, resources),
           progress    = COALESCE($6::json, progress),
           stats       = (COALESCE(stats,'{}'::json)::jsonb || COALESCE($7::json,'{}'::json)::jsonb)::json,
           last_login  = now()
         WHERE sol_address = $1
         RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`,
        [solAddress, callsign, level, exp, resources, progress, stats]
      );
      row = upd.rows[0];

      if (!row) {
        try {
          const ins = await client.query(
            `INSERT INTO ${PLAYERS_TABLE}
               (sol_address, callsign, level, exp, resources, progress, stats, last_login)
             VALUES ($1,$2,$3,$4,$5::json,$6::json,$7::json, now())
             RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`,
            [solAddress, callsign, level, exp, resources, progress, stats]
          );
          row = ins.rows[0];
        } catch (e) {
          if (e.code === "23505" && telegramId) {
            row = await selectByTg(telegramId);
            if (!row) throw e;
            const updAlt = await client.query(
              `UPDATE ${PLAYERS_TABLE} SET
                 sol_address = COALESCE(sol_address, $2),
                 callsign    = COALESCE($3, callsign),
                 level       = GREATEST(level, $4),
                 exp         = GREATEST(exp,   $5),
                 resources   = COALESCE($6::json, resources),
                 progress    = COALESCE($7::json, progress),
                 stats       = (COALESCE(stats,'{}'::json)::jsonb || COALESCE($8::json,'{}'::json)::jsonb)::json,
                 last_login  = now()
               WHERE telegram_id = $1
               RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`,
              [telegramId, solAddress, callsign, level, exp, resources, progress, stats]
            );
            row = updAlt.rows[0];
          } else {
            throw e;
          }
        }
      }
    }

    await client.query("COMMIT");
    return res.json({ ok:true, player: row });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("sync 500:", e.code || "", e.detail || "", e.message);
    return res.status(500).json({ ok:false, error:"server_error" });
  } finally {
    client.release();
  }
});

app.post("/api/events", async (req, res) => {
  try {
    const { playerId, type, payload = {} } = req.body || {};
    if (!playerId || !type) return res.status(400).json({ ok:false, error:"bad_request" });
    const q = await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (player_id, type, payload) VALUES ($1,$2,$3::json)
       RETURNING id, created_at`,
      [playerId, type, J(payload)]
    );
    res.json({ ok:true, id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (e) {
    console.error("events error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

app.post("/api/tg/webhook", async (req, res) => {
  try {
    const hdr = req.get("X-Telegram-Bot-Api-Secret-Token");
    if (TG_SECRET && hdr !== TG_SECRET) return res.sendStatus(401);

    const u = req.body;
    if (u?.message && TG_BOT_TOKEN) {
      const chatId = u.message.chat.id;
      const text = (u.message.text || "").trim();

      if (text === "/start" || text.startsWith("/start")) {
        const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "Открыть игру 👇",
            reply_markup: { inline_keyboard: [[{ text: "Metaville", web_app: { url: FRONT_URL } }]] }
          })
        });
        const body = await r.text();
        if (!r.ok) console.error("TG sendMessage failed:", r.status, body);
        else       console.log("TG sendMessage ok");
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("tg webhook error:", e);
    res.sendStatus(200);
  }
});

app.get("/", (_, res) => res.type("text/plain").send("Metaville API is running"));

app.listen(PORT, "0.0.0.0", () => console.log("API on :", PORT));
