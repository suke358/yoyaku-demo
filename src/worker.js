// 予約カレンダーのデモ（架空のお店 hiyori）の API　2026/10/20
// 持つのは「日にち・時間・埋まっている時間」だけ。名前・電話・メールは保存しない（Formspree へ画面から直接送る）
//
// GET  /api/days                      今日以降の営業時間と、埋まっている時間（中身は出さない。kind は 'busy'）
// POST /api/book {date,start,minutes} 営業時間内か・重なりがないかを確かめて入れる（片づけ BUFFER_MIN を足す）。重なったら 409
// /api/admin/…（ヘッダー X-Admin-Password が secret ADMIN_PASSWORD と同じときだけ）
//   POST   /api/admin/login                      合っていれば ok
//   GET    /api/admin/all                        hours・blocks（kind・menu つき）・settings
//   POST   /api/admin/hours  {date,s,e}          営業時間を入れる・変える
//   DELETE /api/admin/hours  {date}              休みにする（ネット予約がある日は 409）
//   POST   /api/admin/block  {date,s,e}          LINE・電話の予約を入れる（重なったら 409）
//   DELETE /api/admin/block  {id}                予約を取り消す（あける）
//   POST   /api/admin/settings {key,value}       型などを保存（value は JSON）

var BUFFER_MIN = 20;   // 片づけ・準備の時間（分）。画面の CONFIG.bufferMin と同じにする
var STEP_MIN = 30;     // 開始時間のきざみ（分）

// 表を最初のリクエストで作る（Workers Builds では migrations が自動で走らないため。schema.sql と同じ内容）
var SCHEMA = [
  'CREATE TABLE IF NOT EXISTS hours (date TEXT PRIMARY KEY, s TEXT NOT NULL, e TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, date TEXT NOT NULL, s TEXT NOT NULL, e TEXT NOT NULL, kind TEXT NOT NULL, menu TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS blocks_date ON blocks(date)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
];
var ready = null;
function ensureTables(db) {
  if (!ready) ready = db.batch(SCHEMA.map(function (q) { return db.prepare(q); })).catch(function (e) { ready = null; throw e; });
  return ready;
}

function json(body, status, extra) {
  var h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (extra) for (var k in extra) h[k] = extra[k];
  return new Response(JSON.stringify(body), { status: status || 200, headers: h });
}
function m2(t) { var a = String(t).split(':'); return (+a[0]) * 60 + (+a[1]); }
function t2(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); }
function isTime(s) { return /^\d{2}:\d{2}$/.test(String(s)) && m2(s) >= 0 && m2(s) <= 24 * 60; }
function todayJST() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

async function readJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

// 重ならないときだけ入れる（1つの文で確かめて入れるので、同時に2人が押しても2つ目は入らない）
async function insertBlock(db, b) {
  var r = await db.prepare(
    'INSERT INTO blocks (id, date, s, e, kind, menu, created_at) ' +
    'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE NOT EXISTS (' +
    '  SELECT 1 FROM blocks WHERE date = ?2 AND s < ?4 AND e > ?3)'
  ).bind(b.id, b.date, b.s, b.e, b.kind, b.menu, b.created_at).run();
  return r.meta && r.meta.changes > 0;
}

async function handleDays(env) {
  var today = todayJST();
  var hours = (await env.DB.prepare('SELECT date, s, e FROM hours WHERE date >= ?1 ORDER BY date').bind(today).all()).results;
  var bl = (await env.DB.prepare('SELECT date, s, e FROM blocks WHERE date >= ?1 ORDER BY date, s').bind(today).all()).results;
  var busy = {};
  bl.forEach(function (b) { (busy[b.date] = busy[b.date] || []).push({ s: b.s, e: b.e, kind: 'busy' }); });
  return json({ today: today, bufferMin: BUFFER_MIN, stepMin: STEP_MIN, hours: hours, busy: busy });
}

async function handleBook(request, env) {
  var b = await readJson(request);
  if (!b || !isDate(b.date) || !isTime(b.start) || !(b.minutes > 0 && b.minutes <= 240)) return json({ error: '入力が足りません' }, 400);
  if (b.date < todayJST()) return json({ error: '過ぎた日です' }, 400);
  var h = await env.DB.prepare('SELECT s, e FROM hours WHERE date = ?1').bind(b.date).first();
  if (!h) return json({ error: 'この日は営業していません' }, 400);
  var s = m2(b.start), e = s + Number(b.minutes), eb = e + BUFFER_MIN;
  if ((s - m2(h.s)) % STEP_MIN !== 0) return json({ error: '開始時間の形が違います' }, 400);
  if (s < m2(h.s) || e > m2(h.e)) return json({ error: '営業時間の外です' }, 400);
  var ok = await insertBlock(env.DB, { id: newId(), date: b.date, s: t2(s), e: t2(eb), kind: 'net', menu: String(b.menu || '').slice(0, 40), created_at: new Date().toISOString() });
  if (!ok) return json({ error: 'たった今ほかの方の予約が入りました' }, 409);
  var row = await env.DB.prepare('SELECT id FROM blocks WHERE date = ?1 AND s = ?2 AND kind = ?3').bind(b.date, t2(s), 'net').first();
  return json({ ok: true, id: row ? row.id : null, date: b.date, s: t2(s), e: t2(e), busyUntil: t2(eb) });
}

async function handleAdmin(request, env, path) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD が設定されていません（wrangler secret put ADMIN_PASSWORD）' }, 500);
  var pw = request.headers.get('X-Admin-Password') || '';
  if (pw !== env.ADMIN_PASSWORD) return json({ error: 'パスワードが違います' }, 401);
  var m = request.method;
  if (path === 'login' && m === 'POST') return json({ ok: true });
  if (path === 'all' && m === 'GET') {
    var hours = (await env.DB.prepare('SELECT date, s, e FROM hours ORDER BY date').all()).results;
    var blocks = (await env.DB.prepare('SELECT id, date, s, e, kind, menu FROM blocks ORDER BY date, s').all()).results;
    var st = (await env.DB.prepare('SELECT key, value FROM settings').all()).results, settings = {};
    st.forEach(function (r) { try { settings[r.key] = JSON.parse(r.value); } catch (e) { } });
    return json({ hours: hours, blocks: blocks, settings: settings, bufferMin: BUFFER_MIN, stepMin: STEP_MIN });
  }
  var b = await readJson(request) || {};
  if (path === 'hours' && m === 'POST') {
    if (!isDate(b.date) || !isTime(b.s) || !isTime(b.e) || m2(b.s) >= m2(b.e)) return json({ error: '日にちと時間を確かめてください' }, 400);
    await env.DB.prepare('INSERT INTO hours (date, s, e) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO UPDATE SET s = ?2, e = ?3').bind(b.date, b.s, b.e).run();
    return json({ ok: true });
  }
  if (path === 'hours' && m === 'DELETE') {
    if (!isDate(b.date)) return json({ error: '日にちを確かめてください' }, 400);
    var net = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE date = ?1 AND kind = 'net'").bind(b.date).first();
    if (net && net.n > 0) return json({ error: 'ネット予約がある日は休みにできません' }, 409);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM blocks WHERE date = ?1').bind(b.date),
      env.DB.prepare('DELETE FROM hours WHERE date = ?1').bind(b.date)
    ]);
    return json({ ok: true });
  }
  if (path === 'block' && m === 'POST') {
    if (!isDate(b.date) || !isTime(b.s) || !isTime(b.e) || m2(b.s) >= m2(b.e)) return json({ error: '時間を確かめてください' }, 400);
    var h = await env.DB.prepare('SELECT s, e FROM hours WHERE date = ?1').bind(b.date).first();
    if (!h) return json({ error: 'この日は休みです' }, 400);
    if (m2(b.s) < m2(h.s) || m2(b.e) > m2(h.e) + BUFFER_MIN) return json({ error: '営業時間の外です' }, 400);
    var id = newId();
    var ok = await insertBlock(env.DB, { id: id, date: b.date, s: b.s, e: b.e, kind: 'man', menu: String(b.menu || '').slice(0, 40), created_at: new Date().toISOString() });
    if (!ok) return json({ error: 'ほかの予約と重なっています' }, 409);
    return json({ ok: true, id: id });
  }
  if (path === 'block' && m === 'DELETE') {
    if (!b.id) return json({ error: 'id がありません' }, 400);
    await env.DB.prepare('DELETE FROM blocks WHERE id = ?1').bind(String(b.id)).run();
    return json({ ok: true });
  }
  if (path === 'settings' && m === 'POST') {
    if (!/^[a-z]{1,20}$/.test(String(b.key)) || b.value === undefined) return json({ error: 'key と value が要ります' }, 400);
    var v = JSON.stringify(b.value); if (v.length > 8000) return json({ error: '大きすぎます' }, 400);
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(String(b.key), v).run();
    return json({ ok: true });
  }
  return json({ error: 'ありません' }, 404);
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var p = url.pathname;
    if (p.indexOf('/api/') !== 0) return env.ASSETS.fetch(request);
    try {
      await ensureTables(env.DB);
      if (p === '/api/days' && request.method === 'GET') return await handleDays(env);
      if (p === '/api/book' && request.method === 'POST') return await handleBook(request, env);
      if (p.indexOf('/api/admin/') === 0) return await handleAdmin(request, env, p.slice('/api/admin/'.length));
      return json({ error: 'ありません' }, 404);
    } catch (e) {
      var msg = String(e && e.message || e);
      return json({ error: 'サーバーでエラー：' + msg }, 500);
    }
  }
};
