// 予約カレンダー（Lift-Off の部品）の API　2026/10/20（10/20 夜：お店ごとの値を public/shop.jsonc に。日本時間で計算）
// 持つのは「日にち・時間・埋まっている時間」だけ。名前・電話・メールは保存しない（Formspree へ画面から直接送る）
//
// GET  /api/days                      今日以降（daysAhead 日先まで）の営業時間と、埋まっている時間（中身は出さない。kind は 'busy'）。今の時刻（日本時間）も返す
// POST /api/book {date,start,minutes} 営業時間内か・重なりがないか・締切を過ぎていないかを確かめて入れる（片づけ bufferMin を足す）。重なったら 409
// /api/admin/…（ヘッダー X-Admin-Password が secret ADMIN_PASSWORD と同じときだけ）
//   POST   /api/admin/login                      合っていれば ok
//   GET    /api/admin/all                        hours・blocks（kind・menu つき）・settings
//   POST   /api/admin/hours  {date,s,e}          営業時間を入れる・変える
//   DELETE /api/admin/hours  {date}              休みにする（ネット予約がある日は 409）
//   POST   /api/admin/block  {date,s,e}          LINE・電話の予約を入れる（重なったら 409）
//   DELETE /api/admin/block  {id}                予約を取り消す（あける）
//   POST   /api/admin/settings {key,value}       型などを保存（value は JSON）
// GET  /manifest.webmanifest・/apple-touch-icon.png  お店の画面をホーム画面に置くときの名前とアイコン

import shopText from '../public/shop.jsonc';

// shop.jsonc の // 注釈を外して読む（行の頭か、空白のあとの // だけ。URL の :// は残す）
function parseJsonc(t) {
  return JSON.parse(t.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^"\n]*$/gm, ''));
}
var SHOP = parseJsonc(shopText);
var BUFFER_MIN = +SHOP.bufferMin || 20;
var STEP_MIN = +SHOP.stepMin || 30;
var DAYS_AHEAD = +SHOP.daysAhead || 60;
var CUTOFF_MIN = (SHOP.sameDayCutoffMin === undefined) ? 120 : +SHOP.sameDayCutoffMin;

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
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// 日本時間（Workers は UTC で動くので、+9 時間して日付と時刻を出す）
function nowJST() {
  var d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function addDays(dateKey, n) {
  var d = new Date(dateKey + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

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
  var now = nowJST(), last = addDays(now.date, DAYS_AHEAD);
  var hours = (await env.DB.prepare('SELECT date, s, e FROM hours WHERE date >= ?1 AND date <= ?2 ORDER BY date').bind(now.date, last).all()).results;
  var bl = (await env.DB.prepare('SELECT date, s, e FROM blocks WHERE date >= ?1 AND date <= ?2 ORDER BY date, s').bind(now.date, last).all()).results;
  var busy = {};
  bl.forEach(function (b) { (busy[b.date] = busy[b.date] || []).push({ s: b.s, e: b.e, kind: 'busy' }); });
  return json({ today: now.date, now: t2(now.min), bufferMin: BUFFER_MIN, stepMin: STEP_MIN, daysAhead: DAYS_AHEAD, sameDayCutoffMin: CUTOFF_MIN, open: !!SHOP.formspree, hours: hours, busy: busy });
}

async function handleBook(request, env) {
  if (!SHOP.formspree) return json({ error: 'ただいまネット予約の準備中です。LINE かお電話でお願いします' }, 503);
  var b = await readJson(request);
  if (!b || !isDate(b.date) || !isTime(b.start) || !(b.minutes > 0 && b.minutes <= 240)) return json({ error: '入力が足りません' }, 400);
  var now = nowJST();
  if (b.date < now.date) return json({ error: '過ぎた日です' }, 400);
  if (b.date > addDays(now.date, DAYS_AHEAD)) return json({ error: '先すぎる日です（' + DAYS_AHEAD + '日先まで）' }, 400);
  var s = m2(b.start), e = s + Number(b.minutes), eb = e + BUFFER_MIN;
  if (b.date === now.date && s < now.min + CUTOFF_MIN) return json({ error: '当日は ' + CUTOFF_MIN + ' 分前までのご予約です。LINE かお電話でお願いします' }, 400);
  var h = await env.DB.prepare('SELECT s, e FROM hours WHERE date = ?1').bind(b.date).first();
  if (!h) return json({ error: 'この日は営業していません' }, 400);
  if ((s - m2(h.s)) % STEP_MIN !== 0) return json({ error: '開始時間の形が違います' }, 400);
  if (s < m2(h.s) || e > m2(h.e)) return json({ error: '営業時間の外です' }, 400);
  var id = newId();
  var ok = await insertBlock(env.DB, { id: id, date: b.date, s: t2(s), e: t2(eb), kind: 'net', menu: String(b.menu || '').slice(0, 40), created_at: new Date().toISOString() });
  if (!ok) return json({ error: 'たった今ほかの方の予約が入りました' }, 409);
  return json({ ok: true, id: id, date: b.date, s: t2(s), e: t2(e), busyUntil: t2(eb) });
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
    return json({ today: nowJST().date, hours: hours, blocks: blocks, settings: settings, bufferMin: BUFFER_MIN, stepMin: STEP_MIN });
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

// ホーム画面用（お店の画面）：名前は「〇〇 予約管理」。アイコンは public/icon-180.png（tools/make_icon.py で作る）
function manifest() {
  var name = SHOP.shopName + ' 予約管理';
  return new Response(JSON.stringify({
    name: name, short_name: '予約管理', start_url: '/admin', display: 'standalone',
    background_color: '#f7f2ea', theme_color: SHOP.color.main,
    icons: [{ src: '/icon-180.png', sizes: '180x180', type: 'image/png' }]
  }), { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var p = url.pathname;
    if (p === '/manifest.webmanifest') return manifest();
    if (p === '/apple-touch-icon.png' || p === '/apple-touch-icon-precomposed.png') return env.ASSETS.fetch(new Request(url.origin + '/icon-180.png', request));
    if (p.indexOf('/api/') !== 0) return env.ASSETS.fetch(request);
    try {
      await ensureTables(env.DB);
      if (p === '/api/days' && request.method === 'GET') return await handleDays(env);
      if (p === '/api/book' && request.method === 'POST') return await handleBook(request, env);
      if (p.indexOf('/api/admin/') === 0) return await handleAdmin(request, env, p.slice('/api/admin/'.length));
      return json({ error: 'ありません' }, 404);
    } catch (e) {
      return json({ error: 'サーバーでエラー：' + String(e && e.message || e) }, 500);
    }
  }
};
