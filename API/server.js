// server.js — ESM
import express from "express";
import cors from "cors";
import pg from "pg";
import { randomUUID } from "crypto";

const { Pool } = pg;

/* ========= ENV ========= */
const PORT = process.env.PORT || 8080;
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const PLAYERS_TABLE = process.env.PLAYERS_TABLE || "v01dsql";
const EVENTS_TABLE  = process.env.EVENTS_TABLE  || "events";

// CORS: список доменов, через запятую, без завершающего '/'
// например: FRONT_ORIGIN=https://raw.githack.com,https://metaville.github.io
const ALLOWED_ORIGINS = (process.env.FRONT_ORIGIN || "")
  .split(",")
  .map(s => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

/* ========= APP ========= */
const app = express();
app.use(express.json({ limit: "1mb" }));

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/health/webhooks
    const o = origin.replace(/\/$/, "");
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(o)) return cb(null, true);
    return cb(new Error("CORS"));
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-Requested-With","X-Telegram-Init"]
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // preflight for all

// дружелюбная обработка CORS-ошибок
app.use((err, req, res, next) => {
  if (err && err.message === "CORS") return res.status(403).json({ ok:false, error:"CORS" });
  return next(err);
});

/* ========= DB ========= */
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false } // Railway PG обычно требует SSL
});

// в рантайме запомним тип и наличие дефолта у id (чтобы знать, подставлять ли uuid вручную)
let ID_META = { dataType: null, hasDefault: false };

async function ensureSchema() {
  const client = await pool.connect();
  try {
    // Попробуем включить расширения для UUID (не критично, просто удобнее)
    try { await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto'); } catch {}
    try { await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'); } catch {}

    // Основная таблица игроков (безопасно выполнять повторно)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${PLAYERS_TABLE}(
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

    // Таблица событий (по желанию)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE}(
        id         BIGSERIAL PRIMARY KEY,
        player_id  UUID,
        type       TEXT NOT NULL,
        payload    JSON DEFAULT '{}'::json,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Узнаем тип/дефолт у id (на случай, если таблица создана была иначе)
    const q = await client.query(
      `SELECT data_type, column_default
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'id'`,
      [PLAYERS_TABLE]
    );
    const row = q.rows[0] || {};
    const dataType = row.data_type;                  // 'uuid' | 'bigint' | 'integer' | ...
    const hasDefault = !!row.column_default;

    // Если это UUID и дефолта нет — попробуем поставить на стороне БД
    if (dataType === 'uuid' && !hasDefault) {
      try {
        await client.query(`ALTER TABLE ${PLAYERS_TABLE} ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
        ID_META = { dataType: 'uuid', hasDefault: true };
      } catch {
        try {
          await client.query(`ALTER TABLE ${PLAYERS_TABLE} ALTER COLUMN id SET DEFAULT uuid_generate_v4()`);
          ID_META = { dataType: 'uuid', hasDefault: true };
        } catch {
          // Не смогли — будем генерировать uuid из приложения
          ID_META = { dataType: 'uuid', hasDefault: false };
        }
      }
    } else if (!dataType) {
      // Странно, но пусть будет безопасно
      ID_META = { dataType: 'uuid', hasDefault: true };
    } else {
      ID_META = { dataType, hasDefault };
    }
    console.log("ID_META:", ID_META);
  } finally {
    client.release();
  }
}

/* ========= ROUTES ========= */

// Health
app.get("/api/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    console.error("health db:", e);
    res.status(500).json({ ok:false });
  }
});

// Получить игрока по Telegram ID (ensure=1 создаст если нет)
app.get("/api/player/by-tg/:tg", async (req, res) => {
  try {
    const ensure = req.query.ensure === '1';
    const tg = (req.params.tg || '').trim();
    if (!tg || !/^\d+$/.test(tg)) return res.status(400).json({ ok:false, error:"bad_telegram_id" });

    const q = await pool.query(
      `SELECT id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login
         FROM ${PLAYERS_TABLE}
        WHERE telegram_id = $1::bigint OR telegram_id::text = $1::text
        LIMIT 1`,
      [tg]
    );
    if (q.rowCount) return res.json({ ok:true, player: q.rows[0] });

    if (!ensure) return res.status(404).json({ ok:false, error:"not_found" });

    // создаём минимальную запись
    const callsign = "Citizen";
    const level = 1, exp = 0;
    const resources = { oxygen:200, energy:600, mvc:100, bio:0, parts:0, ice:20 };
    const progress = {}, stats = {};

    let text, args;
    if (ID_META.dataType === 'uuid' && !ID_META.hasDefault) {
      text = `INSERT INTO ${PLAYERS_TABLE} (id, telegram_id, callsign, level, exp, resources, progress, stats)
              VALUES ($1,$2,$3,$4,$5,$6::json,$7::json,$8::json)
              RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`;
      args = [randomUUID(), tg, callsign, level, exp, resources, progress, stats];
    } else {
      text = `INSERT INTO ${PLAYERS_TABLE} (telegram_id, callsign, level, exp, resources, progress, stats)
              VALUES ($1,$2,$3,$4,$5::json,$6::json,$7::json)
              RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`;
      args = [tg, callsign, level, exp, resources, progress, stats];
    }
    const ins = await pool.query(text, args);
    return res.json({ ok:true, player: ins.rows[0], created:true });
  } catch (e) {
    console.error("by-tg error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/**
 * POST /api/player/sync
 * Body:
 *  telegramId? / telegram_id?  (number/string)
 *  solAddress? / sol_address?  (string)
 *  callsign?   (string)
 *  level?      (number)
 *  exp?        (number)
 *  resources?  (json)
 *  progress?   (json)
 *  stats?      (json)
 * Требуется минимум одно из: telegramId или solAddress
 */
app.post("/api/player/sync", async (req, res) => {
  const b = req.body || {};
  const telegramId = b.telegramId ?? b.telegram_id ?? null;
  const solAddress = b.solAddress ?? b.sol_address ?? null;
  const callsign   = b.callsign ?? null;
  const level      = b.level ?? null;
  const exp        = b.exp ?? null;
  const resources  = b.resources ?? null;
  const progress   = b.progress ?? null;
  const stats      = b.stats ?? null;

  if (!telegramId && !solAddress) {
    return res.status(400).json({ ok:false, error:"Need telegramId or solAddress" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let row = null;

    if (telegramId) {
      // UPDATE по telegram_id
      const upd = await client.query(
        `UPDATE ${PLAYERS_TABLE} SET
            sol_address = COALESCE($2, sol_address),
            callsign    = COALESCE($3, callsign),
            level       = COALESCE($4, level),
            exp         = COALESCE($5, exp),
            resources   = COALESCE($6::json, resources),
            progress    = COALESCE($7::json, progress),
            stats       = (COALESCE(stats, '{}'::json)::jsonb || COALESCE($8::json, '{}'::json)::jsonb)::json,
            last_login  = now()
         WHERE telegram_id = $1::bigint OR telegram_id::text = $1::text
         RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`,
        [telegramId, solAddress, callsign, level, exp, resources, progress, stats]
      );
      row = upd.rows[0];

      // Если нет — INSERT
      if (!row) {
        let text, args;
        if (ID_META.dataType === 'uuid' && !ID_META.hasDefault) {
          text = `INSERT INTO ${PLAYERS_TABLE} (id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats)
                  VALUES ($1,$2,$3,$4,$5,$6,$7::json,$8::json,$9::json)
                  RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`;
          args = [randomUUID(), telegramId, solAddress, callsign, level ?? 1, exp ?? 0, resources ?? {}, progress ?? {}, stats ?? {}];
        } else {
          text = `INSERT INTO ${PLAYERS_TABLE} (telegram_id, sol_address, callsign, level, exp, resources, progress, stats)
                  VALUES ($1,$2,$3,$4,$5,$6::json,$7::json,$8::json)
                  RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`;
          args = [telegramId, solAddress, callsign, level ?? 1, exp ?? 0, resources ?? {}, progress ?? {}, stats ?? {}];
        }
        const ins = await client.query(text, args);
        row = ins.rows[0];
      }
    } else {
      // Ветка без telegramId — по sol_address
      const upd = await client.query(
        `UPDATE ${PLAYERS_TABLE} SET
            callsign    = COALESCE($2, callsign),
            level       = COALESCE($3, level),
            exp         = COALESCE($4, exp),
            resources   = COALESCE($5::json, resources),
            progress    = COALESCE($6::json, progress),
            stats       = (COALESCE(stats, '{}'::json)::jsonb || COALESCE($7::json, '{}'::json)::jsonb)::json,
            last_login  = now()
         WHERE sol_address = $1
         RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`,
        [solAddress, callsign, level, exp, resources, progress, stats]
      );
      row = upd.rows[0];

      if (!row) {
        let text, args;
        if (ID_META.dataType === 'uuid' && !ID_META.hasDefault) {
          text = `INSERT INTO ${PLAYERS_TABLE} (id, sol_address, callsign, level, exp, resources, progress, stats)
                  VALUES ($1,$2,$3,$4,$5,$6::json,$7::json,$8::json)
                  RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`;
          args = [randomUUID(), solAddress, callsign, level ?? 1, exp ?? 0, resources ?? {}, progress ?? {}, stats ?? {}];
        } else {
          text = `INSERT INTO ${PLAYERS_TABLE} (sol_address, callsign, level, exp, resources, progress, stats)
                  VALUES ($1,$2,$3,$4,$5::json,$6::json,$7::json)
                  RETURNING id, telegram_id, sol_address, callsign, level, exp, resources, progress, stats, created_at, last_login`;
          args = [solAddress, callsign, level ?? 1, exp ?? 0, resources ?? {}, progress ?? {}, stats ?? {}];
        }
        const ins = await client.query(text, args);
        row = ins.rows[0];
      }
    }

    await client.query("COMMIT");
    console.log("sync ok:", { telegramId, solAddress, playerId: row.id });
    res.json({ ok:true, player: row });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("sync error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  } finally {
    // client.release() обязательно в finally
    try { client.release(); } catch {}
  }
});

// Простая главная
app.get("/", (_, res) => res.type("text/plain").send("Metaville API is running"));

/* ========= START ========= */
ensureSchema()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log("API on :", PORT));
  })
  .catch(e => {
    console.error("ensureSchema fatal:", e);
    process.exit(1);
  });
