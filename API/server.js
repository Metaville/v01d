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

// CORS (пока открыто; позже сузишь FRONT_ORIGIN-ом)
app.use(cors());

// health + простая главная
app.get('/api/health', async (_, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ ok:false, error:'db' }); }
});
app.get('/', (_, res) => res.type('text/plain').send('Metaville API is running'));

// --- ЕДИНСТВЕННЫЙ запуск ---
app.listen(PORT, '0.0.0.0', () => console.log('API on :', PORT));

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
