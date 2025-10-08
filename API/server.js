// server.js — Metaville API без Mongo. Хранение в JSON-файле.
// CommonJS, Node 18+.

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

// ---------- конфиг ----------
const {
  PORT = 3000,
  NODE_ENV = "production",
  CORS_ORIGIN = "*",
  // Где хранить JSON-файл. На Railway подключи Volume и смонтируй /data.
  DATA_FILE = process.env.DATA_FILE || "/data/metaville.json",
} = process.env;

const app = express();
app.use(
  cors({
    origin:
      CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: false,
  })
);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- "БД" на JSON ----------
const ResourceDefaults = Object.freeze({
  oxygen: 0,
  energy: 0,
  mvc: 0,
  ice: 0,
  bio: 0,
  parts: 0,
  polymers: 0,
  rare: 0,
});

const EMPTY_DB = { players: {} }; // ключ = telegram_id (string), значение = профиль

async function ensureDir(p) {
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
}

async function loadDB() {
  try {
    await ensureDir(DATA_FILE);
    if (!fs.existsSync(DATA_FILE)) {
      await fsp.writeFile(DATA_FILE, JSON.stringify(EMPTY_DB, null, 2));
      return { ...EMPTY_DB };
    }
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    const db = JSON.parse(raw || "{}");
    if (!db || typeof db !== "object" || !db.players) return { ...EMPTY_DB };
    return db;
  } catch (e) {
    console.error("[db] load failed:", e.message);
    return { ...EMPTY_DB };
  }
}

// простейшая очередь на запись, чтобы не колбасило файл
let __saving = Promise.resolve();
function saveDB(db) {
  __saving = __saving.then(async () => {
    try {
      const tmp = DATA_FILE + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
      await fsp.rename(tmp, DATA_FILE);
    } catch (e) {
      console.error("[db] save failed:", e.message);
    }
  });
  return __saving;
}

function normalizeResources(r = {}) {
  const out = { ...ResourceDefaults, ...(r || {}) };
  for (const k of Object.keys(ResourceDefaults)) {
    const v = out[k];
    out[k] = typeof v === "number" ? v : Number(v || 0);
    if (!Number.isFinite(out[k])) out[k] = 0;
    if (out[k] < 0) out[k] = 0;
  }
  return out;
}

function mergePlayer(prev, incoming, tg) {
  const prevRes = normalizeResources(prev?.resources);
  const incRes = normalizeResources(incoming?.resources);
  return {
    telegram_id: tg,
    callsign: incoming?.callsign ?? prev?.callsign ?? "Citizen",
    level:
      typeof incoming?.level === "number" ? incoming.level : prev?.level ?? 1,
    exp: typeof incoming?.exp === "number" ? incoming.exp : prev?.exp ?? 0,
    resources: { ...prevRes, ...incRes }, // ВАЖНО: MERGE, не перезапись!
    progress: incoming?.progress ?? prev?.progress ?? {},
    stats: incoming?.stats ?? prev?.stats ?? {},
    created_at: prev?.created_at || new Date().toISOString(),
    last_login: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function readTelegramId(req) {
  const toN = (v) =>
    v === undefined || v === null || v === "" ? undefined : Number(v);
  return (
    toN(req.params?.tg) ??
    toN(req.query?.tg) ??
    toN(req.body?.telegramId) ??
    toN(req.body?.telegram_id)
  );
}

// ---------- маршруты ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// GET /api/player/by-tg/:tg  -> { player: {...} } | { player: null }
app.get("/api/player/by-tg/:tg", async (req, res) => {
  const tg = readTelegramId(req);
  if (!Number.isFinite(tg)) return res.status(400).json({ error: "invalid tg" });

  const db = await loadDB();
  const key = String(tg);
  const p = db.players[key];
  if (!p) return res.json({ player: null });

  // Всегда отдаём полный resources
  const full = { ...p, resources: normalizeResources(p.resources) };
  return res.json({ player: full });
});

// POST /api/player/sync?tg=...
// тело: { telegramId?, callsign, level, exp, resources, progress, stats, reason? }
// ответ: { player: { ...полный профиль... } }
app.post("/api/player/sync", async (req, res) => {
  const tg = readTelegramId(req);
  if (!Number.isFinite(tg)) return res.status(400).json({ error: "missing tg" });

  const db = await loadDB();
  const key = String(tg);
  const prev = db.players[key];

  const incoming = {
    callsign: req.body?.callsign,
    level: req.body?.level,
    exp: req.body?.exp,
    resources: req.body?.resources,
    progress: req.body?.progress,
    stats: req.body?.stats,
  };

  const merged = mergePlayer(prev, incoming, tg);
  db.players[key] = merged;

  await saveDB(db);

  // ещё раз нормализуем ресурсы в ответе (на всякий случай)
  merged.resources = normalizeResources(merged.resources);
  return res.json({ player: merged });
});

// ---------- запуск ----------
app.listen(PORT, () => {
  console.log(`[metaville] API up on :${PORT} (json db: ${DATA_FILE})`);
});
