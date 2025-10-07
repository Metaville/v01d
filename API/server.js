// server.js (ESM)
import express from 'express';
import cors from 'cors';
import { createHmac, createHash } from 'crypto';
import pg from 'pg';

const { Pool } = pg;
const app = express();

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

// ---- миграции/схема ----
async function ensureSchema() {
  // базовая таблица если её не было
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL
    )
  `);

  // догоняем недостающие колонки
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS callsign   TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS level     INTEGER DEFAULT 1`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS exp       INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS resources JSONB   DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);

  // починка last_login: создать если нет, задать DEFAULT, проставить пустые, затем NOT NULL
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE players ALTER COLUMN last_login SET DEFAULT now()`);
  await pool.query(`UPDATE players SET last_login = now() WHERE last_login IS NULL`);
  await pool.query(`ALTER TABLE players ALTER COLUMN last_login SET NOT NULL`);
}
ensureSchema().catch(e => {
  console.error('DB schema init error:', e);
  process.exit(1);
});

// ---- CORS ----
const allowlist = [
  'https://t.me',
  'https://web.telegram.org',
  'https://telegram.org',
  'https://metaville.github.io',
  'https://raw.githack.com',
  'https://rawcdn.githack.com',
  'https://preview.githack.com',
];
const isAllowedOrigin = (origin='') =>
  !origin ||
  allowlist.includes(origin) ||
  /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin);

app.use((req,res,next)=>{ res.header('Vary','Origin'); next(); });
app.use(cors({
  origin(o,cb){ cb(null, isAllowedOrigin(o)); },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Telegram-Init','Accept'],
  optionsSuccessStatus: 204,
}));
app.options('*', (req,res)=>res.sendStatus(204));

app.use(express.json({ limit: '1mb' }));

// ---- утилиты ----
function verifyTelegramInitData(initData){
  if (!TELEGRAM_BOT_TOKEN || !initData) return true;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    const arr = [];
    for (const [k,v] of params.entries()) if (k !== 'hash') arr.push(`${k}=${v}`);
    arr.sort();
    const dataCheckString = arr.join('\n');
    const secretKey = createHmac('sha256','WebAppData')
      .update(createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest())
      .digest();
    const calc = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return calc === hash;
  } catch { return false; }
}
const nInt = (x, d=0) => Number.isFinite(Number(x)) ? Number(x) : d;
const defaultResources = () => ({
  oxygen:200, energy:600, mvc:100, bio:0, parts:0, ice:20, polymers:0, rare:0,
});

// ---- роуты ----
app.get('/health', (req,res)=>res.json({ok:true, ts:new Date().toISOString()}));

app.get('/api/player/by-tg/:tg', async (req,res)=>{
  try{
    const tg = nInt(req.params.tg, 0);
    if (!tg) return res.status(400).json({ error:'bad_telegram_id' });
    const { rows } = await pool.query('SELECT * FROM players WHERE telegram_id=$1 LIMIT 1',[tg]);
    res.json({ player: rows[0] || null });
  }catch(e){ console.error('GET /by-tg error:', e); res.status(500).json({error:'server_error'}); }
});

app.post('/api/player/sync', async (req,res)=>{
  const origin = req.get('Origin') || '';
  const initData = req.get('X-Telegram-Init') || '';
  if ((/t\.me|telegram\.org/i.test(origin) || initData) && !verifyTelegramInitData(initData)) {
    return res.status(401).json({ error:'bad_telegram_signature' });
  }

  try{
    const tg = nInt(req.query.tg || req.body.telegram_id, 0);
    if (!tg) return res.status(400).json({ error:'bad_telegram_id' });

    const body = Object(req.body || {});
    const callsign = (body.callsign || '').toString().slice(0,64) || 'Citizen';
    const level = nInt(body.level, 1);
    const exp   = nInt(body.exp, 0);
    const incomingRes = body.resources && typeof body.resources==='object' ? body.resources : {};
    const resources = { ...defaultResources(), ...incomingRes };

    // INSERT без last_login (дефолт now()), при UPDATE обновляем updated_at и last_login
    const { rows } = await pool.query(`
      INSERT INTO players (telegram_id, callsign, level, exp, resources)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign   = COALESCE(EXCLUDED.callsign, players.callsign),
        level      = COALESCE(EXCLUDED.level, players.level),
        exp        = COALESCE(EXCLUDED.exp, players.exp),
        resources  = COALESCE(EXCLUDED.resources, players.resources),
        updated_at = now(),
        last_login = now()
      RETURNING *;
    `, [tg, callsign, level, exp, JSON.stringify(resources)]);

    res.json({ player: rows[0] });
  }catch(e){
    console.error('POST /sync error:', e);
    res.status(500).json({ error:'server_error' });
  }
});

// ---- старт ----
app.listen(PORT, ()=>{
  console.log(`Server listening on :${PORT}`);
  console.log('CORS allowlist:', allowlist.join(', '));
  if (!DATABASE_URL) console.warn('DATABASE_URL не задан — БД не подключится.');
  if (!TELEGRAM_BOT_TOKEN) console.warn('TELEGRAM_BOT_TOKEN не задан — подпись Telegram не проверяется.');
});
