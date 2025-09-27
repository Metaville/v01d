
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import pkg from "pg";

const { Pool } = pkg;

// ========= env =========
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "change_me_please";

// Для Railway Postgres обычно нужен SSL. Если в DATABASE_URL уже есть ?sslmode=require,
// этого достаточно. На всякий случай добавим настройку ssl ниже.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ========= init DB (один раз при старте) =========
async function ensureSchema() {
  // id BIGSERIAL — чтобы не зависеть от расширений uuid/pgcrypto
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}
ensureSchema().catch(e => {
  console.error("DB init error:", e);
  process.exit(1);
});

// ========= app =========
const app = express();
app.use(express.json());

// Разрешим фронтенду ходить к API (замени на свой домен, когда появится)
app.use(cors({
  origin: true,        // на первое время — любой Origin
  credentials: false
}));

// helper: создать JWT
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}

// ========= endpoints =========

// Регистрация
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ ok: false, error: "Введите email и пароль (мин. 6 символов)" });
    }
    const hash = await bcrypt.hash(password, 10);
    const q = await pool.query(
      "INSERT INTO users(email, password_hash) VALUES($1, $2) RETURNING id, email, created_at",
      [email.toLowerCase(), hash]
    );
    const user = q.rows[0];
    return res.json({ ok: true, user, token: signToken(user) });
  } catch (e) {
    if (String(e?.message || "").includes("duplicate key")) {
      return res.status(409).json({ ok: false, error: "Почта уже зарегистрирована" });
    }
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Логин
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const q = await pool.query("SELECT * FROM users WHERE email=$1", [String(email || "").toLowerCase()]);
    const user = q.rows[0];
    if (!user) return res.status(401).json({ ok: false, error: "Неверные креды" });

    const ok = await bcrypt.compare(password || "", user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: "Неверные креды" });

    return res.json({
      ok: true,
      user: { id: user.id, email: user.email, created_at: user.created_at },
      token: signToken(user)
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Профиль по токену
app.get("/api/me", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: "Нет токена" });

    const payload = jwt.verify(token, JWT_SECRET);
    const q = await pool.query("SELECT id, email, created_at FROM users WHERE id=$1", [payload.id]);
    const user = q.rows[0];
    if (!user) return res.status(404).json({ ok: false, error: "Пользователь не найден" });
    res.json({ ok: true, user });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Неавторизован" });
  }
});

app.get("/", (req, res) => res.send("Metaville API is running"));

app.listen(PORT, () => console.log("API listening on", PORT));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('API on :' + PORT));

const cors = require('cors'); // или: import cors from 'cors'

const allowed = (process.env.FRONT_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                 // curl/health
    return allowed.includes(origin) ? cb(null, true) : cb(new Error('CORS'));
  }
}));
