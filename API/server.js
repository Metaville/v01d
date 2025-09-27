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
