import express from 'express';
import cors from 'cors';
import pg from 'pg';
const { Pool } = pg;

// --- ENV ---
const PORT = process.env.PORT || 3000;
const conn = process.env.DATABASE_URL;
const ssl = conn && conn.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined;

// --- DB ---
const pool = new Pool({ connectionString: conn, ssl });

// --- APP ---
const app = express();
app.use(express.json());

// === Telegram Webhook ===
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_SECRET    = process.env.TG_SECRET || 'change_me';
const FRONT_URL    = process.env.FRONT_URL || 'https://v01d-production.up.railway.app';
const TG_API       = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;

async function tgSend(chat_id, text, extra = {}) {
  if (!TG_API) return;
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id, text, ...extra })
  });
}

// сам webhook
app.post('/api/tg/webhook', async (req, res) => {
  // (опц.) проверяем секрет
  const hdr = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (TG_SECRET && hdr !== TG_SECRET) return res.sendStatus(401);

  const u = req.body;
  try {
    if (u.message) {
      const chatId = u.message.chat.id;
      const text = (u.message.text || '').trim();

      if (text === '/start' || text.startsWith('/start ')) {
        await tgSend(chatId, 'Запускаю WebApp 👇', {
          reply_markup: {
            inline_keyboard: [[{ text: 'Открыть игру', web_app: { url: FRONT_URL } }]]
          }
        });
      } else {
        await tgSend(chatId, 'Напишите /start, чтобы открыть игру');
      }
    }
    // Телеграму достаточно 200 OK
    res.json({ ok: true });
  } catch (e) {
    console.error('tg webhook error:', e);
    res.json({ ok: true });
  }
});


// CORS (пока открыто; позже сузишь FRONT_ORIGIN-ом)
app.use(cors());

// health + простая главная
app.get('/api/health', async (_, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ ok:false, error:'db' }); }
});
app.get('/', (_, res) => res.type('text/plain').send('Metaville API is running'));



// сохранить снапшот прогресса
app.post('/api/player/sync', async (req,res) => {
  const { telegramId, solAddress, callsign, level=1, exp=0, resources={}, progress={}, stats={} } = req.body||{};
  if (!telegramId && !solAddress) return res.status(400).json({ ok:false, error:'Need telegramId or solAddress' });

  const args = [telegramId ?? null, solAddress ?? null, callsign ?? null, level, exp, resources, progress, stats];
  const sqlByTg = `
    INSERT INTO players(telegram_id, sol_address, callsign, level, exp, resources, progress, stats)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
    ON CONFLICT (telegram_id) DO UPDATE SET
      sol_address = COALESCE(EXCLUDED.sol_address, players.sol_address),
      callsign    = COALESCE(EXCLUDED.callsign, players.callsign),
      level       = GREATEST(players.level, EXCLUDED.level),
      exp         = GREATEST(players.exp, EXCLUDED.exp),
      resources   = EXCLUDED.resources,
      progress    = EXCLUDED.progress,
      stats       = players.stats || EXCLUDED.stats
    RETURNING *`;
  const sqlBySol = `
    INSERT INTO players(sol_address, callsign, level, exp, resources, progress, stats)
    VALUES ($2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
    ON CONFLICT (sol_address) DO UPDATE SET
      callsign  = COALESCE(EXCLUDED.callsign, players.callsign),
      level     = GREATEST(players.level, EXCLUDED.level),
      exp       = GREATEST(players.exp, EXCLUDED.exp),
      resources = EXCLUDED.resources,
      progress  = EXCLUDED.progress,
      stats     = players.stats || EXCLUDED.stats
    RETURNING *`;
  const q = await pool.query(telegramId ? sqlByTg : sqlBySol, args);
  res.json({ ok:true, player:q.rows[0] });
});

// журнал событий
app.post('/api/events', async (req,res)=>{
  const { playerId, type, payload = {} } = req.body||{};
  if (!playerId || !type) return res.status(400).json({ ok:false, error:'bad_request' });
  const q = await pool.query(
    'INSERT INTO events(player_id, type, payload) VALUES ($1,$2,$3::jsonb) RETURNING id, created_at',
    [playerId, type, payload]
  );
  res.json({ ok:true, ...q.rows[0] });
});

// --- ЕДИНСТВЕННЫЙ запуск ---
app.listen(PORT, '0.0.0.0', () => console.log('API on :', PORT));
