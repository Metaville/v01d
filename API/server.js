// API/server.js  (ESM)

// ---------- Imports ----------
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import pkg from "pg";
import rateLimit from "express-rate-limit";
import morgan from "morgan";

const { Pool } = pkg;

// ---------- App & middlewares ----------
const app = express();
app.use(cors());
app.use(bodyParser.json());           // JSON body
app.use(bodyParser.urlencoded({ extended: true }));

app.use(morgan('tiny'));
app.use('/api/', rateLimit({
  windowMs: 10 * 1000,   // 10 сек
  max: 60,                // не чаще 60 запросов за окно с одного IP
  standardHeaders: true,
  legacyHeaders: false
}));

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
    if (TG_SECRET) {
      const hdr = req.get('x-telegram-bot-api-secret-token');
      if (hdr !== TG_SECRET) {
        console.warn('TG webhook: wrong secret token');
        return res.sendStatus(401);
      }
    }
    const update = req.body;
    console.log('TG update:', JSON.stringify(update));

    if (BOT_TOKEN && update?.message?.text === '/start') {
      const chatId = update.message.chat.id;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: 'Вебхук работает ✅' })
      });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('TG webhook error:', e);
    res.sendStatus(200); // телеграму всегда ок
  }
});

// ---------- DB pool ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ---------- Helpers ----------
const DEFAULT_RESOURCES = { bio: 0, mvc: 0, parts: 0, energy: 0, oxygen: 0, ice: 0 };
const DEFAULT_PROGRESS  = {};
const DEFAULT_STATS     = {};

// гарантированно приводим resources/progress/stats к ожидаемой форме
function normalizeResources(src) {
  const base = { ...DEFAULT_RESOURCES };
  if (src && typeof src === 'object') {
    for (const k of Object.keys(base)) {
      const v = Number(src[k]);
      if (Number.isFinite(v)) base[k] = v;
    }
  }
  return base;
}
function normalizePlainObject(x, fallback = {}) {
  return x && typeof x === 'object' && !Array.isArray(x) ? x : fallback;
}

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

    // нормализуем вход
    const callsign  = typeof req.body?.callsign === 'string' && req.body.callsign.trim()
      ? req.body.callsign.trim()
      : 'Citizen';
    const level     = Number(req.body?.level) || 1;
    const exp       = Number(req.body?.exp)   || 0;
    const resources = normalizeResources(req.body?.resources);
    const progress  = normalizePlainObject(req.body?.progress, DEFAULT_PROGRESS);
    const stats     = normalizePlainObject(req.body?.stats,    DEFAULT_STATS);

    // единый upsert (если телеграм-id уже есть — обновим; если нет — создадим)
    const q = await pool.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign   = COALESCE(EXCLUDED.callsign, players.callsign),
        level      = GREATEST(players.level, EXCLUDED.level),
        exp        = GREATEST(players.exp,   EXCLUDED.exp),
        -- ВАЖНО: тут всегда кладём полный нормализованный снимок
        resources  = EXCLUDED.resources,
        progress   = EXCLUDED.progress,
        -- stats наращиваем (ключи из EXCLUDED перетряхнут существующие)
        stats      = players.stats || EXCLUDED.stats,
        last_login = now()
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login;
      `,
      [telegramId, callsign, level, exp, resources, progress, stats]
    );

    // полезный лог (видно в deploy logs)
    console.log('SYNC ok', telegramId, q.rows[0]?.resources);

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

    const q = await pool.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats, last_login)
      VALUES ($1, 'Citizen', 1, 0, $2::jsonb, $3::jsonb, $4::jsonb, now())
      ON CONFLICT (telegram_id) DO UPDATE SET
        last_login = now()
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats, last_login;
      `,
      [tg, DEFAULT_RESOURCES, DEFAULT_PROGRESS, DEFAULT_STATS]
    );

    res.json({ ok: true, player: q.rows[0] });
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
