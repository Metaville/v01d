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

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store'); // не кэшировать API
  }
  next();
});
// после app.use(cors()); app.use(bodyParser.json()); и до app.listen(...)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;   // добавь в Variables на Railway
const TG_SECRET = process.env.TG_SECRET;            // опционально: секрет для проверки

// Телеграм шлёт JSON POST на этот путь — он ДОЛЖЕН совпадать с setWebhook
app.post('/api/tg/webhook', async (req, res) => {
  try {
    // (необязательно) проверяем секрет, если задан
    if (TG_SECRET) {
      const hdr = req.get('x-telegram-bot-api-secret-token');
      if (hdr !== TG_SECRET) {
        console.warn('TG webhook: wrong secret token');
        return res.sendStatus(401);
      }
    }

    const update = req.body; // апдейт от Telegram
    console.log('TG update:', update?.update_id, update?.message?.text);

    // Простейший ответ на /start (чтобы увидеть, что вебхук жив)
    if (BOT_TOKEN && update?.message?.text === '/start') {
      const chatId = update.message.chat.id;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: 'Вебхук работает ✅' })
      });
    }

    // Важное: всегда быстро отвечаем 200, иначе Telegram будет ретраить
    res.sendStatus(200);
  } catch (e) {
    console.error('TG webhook error:', e);
    // всё равно 200, чтобы Телеграм не засыпал повторными запросами
    res.sendStatus(200);
  }
});

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
  const client = await pool.connect();
  try {
    const telegramId = pickTelegramId(req);
    if (!telegramId) {
      client.release();
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

    await client.query('BEGIN');

    // 1) сначала пробуем UPDATE — sequence не трогаем
    const upd = await client.query(
      `
      UPDATE players
         SET callsign   = COALESCE($2, callsign),
             level      = GREATEST(level, $3),
             exp        = GREATEST(exp,   $4),
             resources  = $5::jsonb,
             progress   = $6::jsonb,
             stats      = stats || $7::jsonb,
             last_login = now()
       WHERE telegram_id = $1
       RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login
      `,
      [telegramId, callsign, level, exp, resources, progress, stats]
    );

    let row = upd.rows[0];

    // 2) если не нашли — тогда реальный INSERT (sequence дернётся только здесь)
    if (upd.rowCount === 0) {
      const ins = await client.query(
        `
        INSERT INTO players
          (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now())
        RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login
        `,
        [telegramId, callsign, level, exp, resources, progress, stats]
      );
      row = ins.rows[0];
    }

    await client.query('COMMIT');
    client.release();
    res.json({ ok: true, player: row });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    console.error("sync error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});


// ---------- GET/CREATE BY TELEGRAM ID ----------
app.get("/api/player/by-tg/:telegramId", async (req, res) => {
  const client = await pool.connect();
  try {
    const tg = Number(req.params.telegramId);
    if (!tg) {
      client.release();
      return res.status(400).json({ ok: false, error: "invalid_telegram_id" });
    }

    await client.query('BEGIN');

    // Пытаемся вставить (для новых) — без конфликта просто получим строку
    const ins = await client.query(
      `
      INSERT INTO players (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES ($1, 'Citizen', 1, 0, $2::jsonb, $3::jsonb, $4::jsonb, now())
      ON CONFLICT (telegram_id) DO NOTHING
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login
      `,
      [tg, DEFAULT_RESOURCES, DEFAULT_PROGRESS, DEFAULT_STATS]
    );

    let row = ins.rows[0];

    if (!row) {
      // Уже существует — обновим last_login и вернём
      const sel = await client.query(
        `
        UPDATE players
           SET last_login = now()
         WHERE telegram_id = $1
         RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login
        `,
        [tg]
      );
      row = sel.rows[0];
    }

    await client.query('COMMIT');
    client.release();
    res.json({ ok: true, player: row });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    console.error("get player error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});


// ---------- Start ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("API on:", PORT);
});



