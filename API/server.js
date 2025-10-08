// server.js
// --- Metaville API (Express + Mongoose) ---
// Фиксы: мердж ресурсов, полный ответ { player }, кросс-доменные запросы.

import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

// ---------- конфиг ----------

const {
  PORT = 3000,
  NODE_ENV = "production",
  MONGODB_URI = "mongodb://127.0.0.1:27017/metaville",
  CORS_ORIGIN = "*" // можно перечислить через запятую: "https://raw.githack.com,https://yourdomain"
} = process.env;

const app = express();

// CORS
const origins =
  CORS_ORIGIN === "*"
    ? "*"
    : CORS_ORIGIN.split(",").map((s) => s.trim());
app.use(
  cors({
    origin: origins,
    credentials: false,
  })
);

// базовая безопасность/логи
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));

// парсеры
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- БД / Модель ----------

await mongoose.connect(MONGODB_URI, {
  autoIndex: NODE_ENV !== "production",
});

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

const ResourcesSchema = new mongoose.Schema(
  {
    oxygen: { type: Number, default: 0 },
    energy: { type: Number, default: 0 },
    mvc: { type: Number, default: 0 },
    ice: { type: Number, default: 0 },
    bio: { type: Number, default: 0 },
    parts: { type: Number, default: 0 },
    polymers: { type: Number, default: 0 },
    rare: { type: Number, default: 0 },
  },
  { _id: false }
);

const PlayerSchema = new mongoose.Schema(
  {
    telegram_id: { type: Number, required: true, unique: true, index: true },
    callsign: { type: String, default: "Citizen" },
    level: { type: Number, default: 1 },
    exp: { type: Number, default: 0 },
    resources: { type: ResourcesSchema, default: () => ({}) },
    progress: { type: Object, default: () => ({}) },
    stats: { type: Object, default: () => ({}) },
    created_at: { type: Date, default: () => new Date() },
    last_login: { type: Date, default: () => new Date() },
  },
  {
    timestamps: { createdAt: false, updatedAt: "updated_at" },
    toJSON: {
      transform(_doc, ret) {
        // привести к "плоскому" виду, убрать _id, __v
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// безопасная нормализация ресурсов (всегда все ключи)
function normalizeResources(r = {}) {
  const out = { ...ResourceDefaults, ...(r || {}) };
  // приведение типов (если вдруг пришли строки)
  for (const k of Object.keys(ResourceDefaults)) {
    const v = out[k];
    out[k] = typeof v === "number" ? v : Number(v || 0);
  }
  return out;
}

// склеиваем профиль от клиента с тем, что в БД (сервер — источник истины)
function mergePlayer(prev, incoming, tg) {
  const prevRes = normalizeResources(prev?.resources);
  const incRes = normalizeResources(incoming?.resources);

  return {
    telegram_id: tg,
    callsign:
      incoming?.callsign ?? prev?.callsign ?? "Citizen",
    level:
      typeof incoming?.level === "number"
        ? incoming.level
        : prev?.level ?? 1,
    exp:
      typeof incoming?.exp === "number"
        ? incoming.exp
        : prev?.exp ?? 0,
    resources: { ...prevRes, ...incRes }, // ВАЖНО: MERGE!!!
    progress: incoming?.progress ?? prev?.progress ?? {},
    stats: incoming?.stats ?? prev?.stats ?? {},
    last_login: new Date(),
  };
}

const Player = mongoose.model("Player", PlayerSchema);

// ---------- хелперы ----------

function readTelegramId(req) {
  const tryNum = (v) =>
    v === undefined || v === null || v === "" ? undefined : Number(v);
  return (
    tryNum(req.query.tg) ??
    tryNum(req.body?.telegramId) ??
    tryNum(req.body?.telegram_id)
  );
}

function ok(res, data) {
  return res.status(200).json(data);
}

function bad(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

// ---------- маршруты ----------

app.get("/api/health", (_req, res) => ok(res, { ok: true }));

// GET /api/player/by-tg/:tg  -> { player: {...} } | { player: null }
app.get("/api/player/by-tg/:tg", async (req, res) => {
  const tg = Number(req.params.tg);
  if (!Number.isFinite(tg)) return bad(res, "invalid tg", 400);

  const p = await Player.findOne({ telegram_id: tg }).lean();
  if (!p) return ok(res, { player: null });

  // ВСЕГДА отдаем полный resources
  const full = {
    ...p,
    resources: normalizeResources(p.resources),
  };
  return ok(res, { player: full });
});

// POST /api/player/sync?tg=...
// тело: { telegramId?, callsign, level, exp, resources, progress, stats, reason? }
// ответ: { player: { ...полный профиль... } }
app.post("/api/player/sync", async (req, res) => {
  const tg = readTelegramId(req);
  if (!Number.isFinite(tg)) return bad(res, "missing tg", 400);

  const incoming = {
    callsign: req.body?.callsign,
    level: req.body?.level,
    exp: req.body?.exp,
    resources: req.body?.resources,
    progress: req.body?.progress,
    stats: req.body?.stats,
  };

  const prev = await Player.findOne({ telegram_id: tg }).lean();

  const merged = mergePlayer(prev, incoming, tg);

  // upsert с возвратом новой версии
  const saved = await Player.findOneAndUpdate(
    { telegram_id: tg },
    { $set: merged },
    { upsert: true, new: true }
  ).lean();

  // ещё раз нормализуем ресурсы в ответе (на всякий случай)
  saved.resources = normalizeResources(saved.resources);

  return ok(res, { player: saved });
});

// ---------- запуск ----------

app.listen(PORT, () => {
  console.log(`[metaville] API up on :${PORT} env=${NODE_ENV}`);
});
