// ====== SAVE / UPDATE PLAYER ======
app.post('/api/player/sync', async (req, res) => {
  try {
    // лог на всякий случай
    console.log('sync: origin=', req.headers.origin, 'ua=', req.headers['user-agent']);

    // 1) Берём telegramId из трёх мест, НО ОБЪЯВЛЯЕМ ПЕРЕМЕННУЮ ОДИН РАЗ
    let telegramId = null;

    // из body
    if (req.body && req.body.telegramId != null) {
      const n = Number(req.body.telegramId);
      if (!Number.isNaN(n)) telegramId = n;
    }

    // из query ?tg=...
    if (!telegramId && req.query && req.query.tg) {
      const n = Number(req.query.tg);
      if (!Number.isNaN(n)) telegramId = n;
    }

    // из заголовка x-telegram-init-data (если будете его присылать)
    if (!telegramId) {
      const init = req.get('x-telegram-init-data');
      if (init) {
        try {
          const p = new URLSearchParams(init);
          const userStr = p.get('user');
          if (userStr) {
            const user = JSON.parse(userStr);
            const n = Number(user?.id);
            if (!Number.isNaN(n)) telegramId = n;
          }
        } catch (_) {}
      }
    }

    if (!telegramId) {
      return res.status(400).json({ ok:false, error:'telegramId_required' });
    }

    // 2) Остальные поля из body
    const {
      callsign = 'Citizen',
      level = 1,
      exp = 0,
      resources = {},
      progress = {},
      stats = {}
    } = req.body || {};

    // 3) UPSERT в таблицу players (как вы её создали)
    const q = await pool.query(
      `
      INSERT INTO players
        (telegram_id, callsign, level, exp, resources, progress, stats)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
      ON CONFLICT (telegram_id) DO UPDATE SET
        callsign  = COALESCE(EXCLUDED.callsign, players.callsign),
        level     = GREATEST(players.level, EXCLUDED.level),
        exp       = GREATEST(players.exp,   EXCLUDED.exp),
        resources = EXCLUDED.resources,
        progress  = EXCLUDED.progress,
        stats     = players.stats || EXCLUDED.stats
      RETURNING id, telegram_id, callsign, level, exp, resources, progress, stats;
      `,
      [telegramId, callsign, level, exp, resources, progress, stats]
    );

    return res.json({ ok:true, player: q.rows[0] });
  } catch (e) {
    console.error('sync error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});
