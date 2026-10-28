// 予約カレンダー（Lift-Off の部品）の API　2026/10/20（10/21：お店の Gmail（GAS）から確認メール＋知らせ・先の上限なし・デモの切りかえ）
// 持つのは「日にち・時間・埋まっている時間」と、お店の画面で見るための 名前・電話・メール（2026/10/25〜。来店日の翌日（日本時間）に自動で空にする）
// 名前・電話・メールは お店の画面の API（合言葉つき）にだけ出す。お客さん向けの /api/days には出さない。ログにも出さない
// お店ごとの値は public/shop.jsonc の1つ。ここにお店の名前や値は書かない
//
// 知らせ：/api/book が名前・電話・メールも受け取り、D1 で枠を押さえたあと GAS（お店の Gmail から送る係。gas/Code.gs）へ POST。
//   GAS が {ok:true} を返さなければ枠を取り消して 502（枠だけ埋まってメールが来ない、を起こさない）
//   GAS の URL と合言葉は秘密の変数 GAS_URL・GAS_TOKEN（本番 wrangler secret put／手元 .dev.vars）
// デモ（shop.jsonc の demo: true）：GAS を呼ばず、確認メールの見本の文を返す（画面に出す）。秘密の変数がなくても予約を受け付ける
//
// GET  /api/days（allowOrigins の Origin からは CORS 付き。menus・otherMenusNote・taxNote も返す。2026/10/26）                      今日以降の営業時間と、埋まっている時間（中身は出さない。kind は 'busy'）。今の時刻（日本時間）も返す
// POST /api/book {date,start,menu か menus,name,tel,email}（menus＝複数メニュー（名前の配列）。1 つなら今までどおり slot、2 つ以上なら 前＋施術の合計＋後。料金は合計、1 つでも金額でなければその文。2026/10/28）（allowOrigins の Origin からは CORS 付き・OPTIONS にも答える。いたずら対策：同じ IP は 10 分に 5 回・同じ電話／メールの未来の予約は 3 件まで。2026/10/26） 営業時間内か・重なりがないか・締切を過ぎていないかを確かめて入れる。枠の長さは 前 preMin＋施術＋後 bufferMin（かメニューの slot）。重なったら 409
// /api/admin/…（ヘッダー X-Admin-Password が secret ADMIN_PASSWORD と同じときだけ。同じ接続元から 5 回間違えると 10 分 429）
//   POST   /api/admin/login                      合っていれば ok
//   GET    /api/admin/all                        hours・blocks（kind・menu・名前・電話・メール つき）・settings
//   POST   /api/admin/hours  {date,s,e}          営業時間を入れる・変える
//   DELETE /api/admin/hours  {date}              休みにする（ネット予約がある日は 409）
//   POST   /api/admin/block  {date,s,e[,menu,kind,name]} LINE・電話の予約（kind man。name は任意。電話・メールは持たない）か 予約停止（kind stop）を入れる（重なったら 409）
//   DELETE /api/admin/block  {id}                予約を取り消す（あける）
//   POST   /api/admin/settings {key,value}       型などを保存（value は JSON）
// GET  /manifest.webmanifest・/apple-touch-icon.png  お店の画面をホーム画面に置くときの名前とアイコン
// Cron：毎日 4:30 JST バックアップ（runBackup）／毎日 10:00 JST 2 日前のお知らせメール（runReminder。shop.jsonc の reminder.enabled が true のときだけ。2026/10/28）

import shopText from '../public/shop.jsonc';

// ---- 型（JSDoc。TypeScript には書き直さず、tsc --noEmit の checkJs で確かめる。2026/10/25）----
/** @typedef {{ name: string, min: number, price?: string, slot?: number, extraMin?: number, extraNote?: string }} ShopMenu */   // extraMin＝複数メニューのとき、このメニューが入ると所要に足す分（例 お化粧落とし 10 分）。extraNote＝その名前（画面・メールの注記）
/** @typedef {{ shopName: string, shortName?: string, color: { main: string, sub: string }, lineUrl?: string, tel?: string, mail?: string, address?: string, parking?: string, mapUrl?: string, menus: ShopMenu[], preMin?: number, bufferMin?: number, stepMin?: number, cancelPolicy?: string, daysAhead?: number, sameDayCutoffMin?: number, demo?: boolean, taxNote?: string, otherMenusNote?: string, allowOrigins?: string[], maxTotalMin?: number, reminder?: ReminderCfg }} Shop */
/** @typedef {{ enabled?: boolean, daysBefore?: number, hourJst?: number }} ReminderCfg */   // 2 日前のお知らせメール（2026/10/28）
/** @typedef {{ DB: D1Database, ASSETS: Fetcher, BACKUP?: KVNamespace, GAS_URL?: string, GAS_TOKEN?: string, ADMIN_PASSWORD?: string }} Env */
/** @typedef {{ id: string, date: string, s: string, e: string, kind: string, menu: string, created_at: string, name?: string, tel?: string, email?: string, mailng?: number }} Block */
/** @typedef {{ name: string, tel: string, email: string }} Customer */
/** @typedef {{ name: string, min: number, price: string }} BookItem */
/** @typedef {{ id: string, date: string, when: string, start: string, end: string, menu: string, min: number, slot: number, price: string, items: BookItem[], extraNote: string }} Booking */   // extraNote＝所要時間に足した分の名前（「お化粧落とし」など。なければ ''）
/** @typedef {{ name: string, shortName: string, tel: string, line: string, mail: string, address: string, parking: string, mapUrl: string, cancelPolicy: string }} ShopInfo */

// shop.jsonc の // 注釈を外して読む（行の頭か、空白のあとの // だけ。URL の :// は残す。注釈に引用符は書けない）
/** @param {string} t @returns {any} */
function parseJsonc(t) {
  return JSON.parse(t.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^"\n]*$/gm, ''));
}
/** @type {Shop} */
var SHOP = parseJsonc(shopText);
var BUFFER_MIN = +(/** @type {number} */ (SHOP.bufferMin)) || 0;   // 施術のあとに空ける時間（片づけ）
var PRE_MIN = +(/** @type {number} */ (SHOP.preMin)) || 0;        // 施術の前に空ける時間（カウンセリングなど。2026/10/21）
var STEP_MIN = +(/** @type {number} */ (SHOP.stepMin)) || 30;
var DAYS_AHEAD = +(/** @type {number} */ (SHOP.daysAhead)) || 0;   // 0 ＝ 上限なし（営業時間を入れた日はすべて受ける）
var CUTOFF_MIN = (SHOP.sameDayCutoffMin === undefined) ? 120 : +SHOP.sameDayCutoffMin;
var MAX_TOTAL_MIN = +(/** @type {number} */ (SHOP.maxTotalMin)) || 0;   // 施術の合計の上限（分。複数メニュー。0 ＝ なし。2026/10/28 決定 180）
var DEMO = SHOP.demo === true;
var LAST_DATE = '9999-12-31';
var FAIL_MSG = 'ご予約を完了できませんでした。お手数ですが LINE かお電話でご連絡ください';
/** @param {string} today @returns {string} */
function lastDate(today) { return DAYS_AHEAD > 0 ? addDays(today, DAYS_AHEAD) : LAST_DATE; }
// 予約1回の長さ（分）＝ 枠をふさぐ長さ。メニューに slot があればそれ、なければ 前 ＋ 施術 ＋ 後（画面も同じ計算）
/** @param {string} name @returns {ShopMenu|null} */
function menuOf(name) { /** @type {ShopMenu|null} */ var m = null; (SHOP.menus || []).forEach(function (x) { if (x.name === name) m = x; }); return m; }
/** @param {ShopMenu} m @returns {number} */
function slotOf(m) { return +(/** @type {number} */ (m.slot)) || (PRE_MIN + (+m.min) + BUFFER_MIN); }
// 複数メニュー（2026/10/28）：選んだメニューの組を 1 つの予約にする。禁止の組み合わせ・上限はなし（同じメニューを 2 回は不可）
// 長さ＝1 つなら slotOf（メニューの slot が効く）、2 つ以上なら 前＋施術の合計＋後（slot は使わない。準備と片づけは 1 回分）。画面（index.html の lenOf）も同じ計算
/** @param {ShopMenu[]} ms @returns {number} */
function lenOf(ms) { if (ms.length === 1) return slotOf(ms[0]); return PRE_MIN + minOf(ms) + extraOf(ms) + BUFFER_MIN; }
/** 複数のとき、各メニューの extraMin を足す（例 フェイシャルのお化粧落とし 10 分。名前はコードに書かず shop.jsonc で） @param {ShopMenu[]} ms @returns {number} */
function extraOf(ms) { var t = 0; ms.forEach(function (m) { t += +(/** @type {number} */ (m.extraMin)) || 0; }); return t; }
/** extraMin のあるメニューの注記（「お化粧落とし」など。重複なし） @param {ShopMenu[]} ms @returns {string[]} */
function extraNotes(ms) {
  /** @type {string[]} */
  var out = [];
  ms.forEach(function (m) { var n = String(m.extraNote || ''); if (+(/** @type {number} */ (m.extraMin)) > 0 && n && out.indexOf(n) < 0) out.push(n); }); return out; }
/** 施術の分の合計 @param {ShopMenu[]} ms @returns {number} */
function minOf(ms) { var t = 0; ms.forEach(function (m) { t += +m.min; }); return t; }
/** @param {number} n @returns {string} 3 けたごとに , */
function yen(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円'; }
// 料金の目安：「5,500円」の形を足して「8,800円」。「5,500円〜」が混ざれば「8,800円〜」。1 つでも金額でないもの（お問い合わせください など）があれば、固定の ASK_PRICE（その文を合計として出さない。レビュー 10/28）。割引はなし
var ASK_PRICE = 'お問い合わせください';
var PRICE_RE = /^([0-9,]+)\s*円(〜)?$/;   // shop.jsonc の price に書いてよい金額の形（テストが全メニューを確かめる）
/** @param {ShopMenu[]} ms @returns {string} */
export function priceOf(ms) {   // テストから直接呼べるように export
  if (ms.length === 1) return ms[0].price || '';
  var sum = 0, from = false, ask = false;
  ms.forEach(function (m) { var x = PRICE_RE.exec(String(m.price || '')); if (x) { sum += +x[1].replace(/,/g, ''); if (x[2]) from = true; } else ask = true; });
  return ask ? ASK_PRICE : yen(sum) + (from ? '〜' : '');
}
/** 名前をつないで台帳・メールに書く形に（例「よもぎ蒸し＋ボディケア 30分」） @param {ShopMenu[]} ms @returns {string} */
function namesOf(ms) { return ms.map(function (m) { return String(m.name); }).join('＋'); }
// 送られたメニューを設定から引く：menus（名前の配列。2026/10/28）があればそれ、なければ menu（1 つ）。配列は 1 つ以上・全部が設定にある名前・同じ名前は 2 回入れない
/** @param {any} b @returns {{ menus: ShopMenu[] }|{ error: string }} */
function pickMenus(b) {
  /** @type {unknown[]} */
  var names;
  if (b.menus !== undefined && b.menus !== null) {
    if (!Array.isArray(b.menus)) return { error: '入力の形が違います' };
    if (!b.menus.length) return { error: 'メニューを選んでください' };
    if (b.menus.length > (SHOP.menus || []).length) return { error: 'メニューが多すぎます' };
    for (var i = 0; i < b.menus.length; i++) if (typeof b.menus[i] !== 'string') return { error: '入力の形が違います' };
    names = b.menus;
  } else names = [b.menu];
  /** @type {ShopMenu[]} */
  var out = [];
  /** @type {Record<string, boolean>} */
  var seen = {};
  for (var j = 0; j < names.length; j++) {
    var m = menuOf(String(names[j]));
    if (!m) return { error: 'メニューを選んでください' };
    if (seen[m.name]) return { error: '同じメニューが 2 回入っています' };
    seen[m.name] = true; out.push(m);
  }
  if (MAX_TOTAL_MIN > 0 && minOf(out) > MAX_TOTAL_MIN) return { error: '施術の合計は ' + MAX_TOTAL_MIN + ' 分までです。組み合わせを減らすか、LINE かお電話でご相談ください' };   // 上限（2026/10/28 決定）
  return { menus: out };
}

// 予約を受け付けられるか：デモは常に。本番は GAS の秘密の変数とお店のメールがそろっているとき
/** @param {Env} env @returns {boolean} */
function isOpen(env) {
  if (DEMO) return true;
  return !!(env.GAS_URL && env.GAS_TOKEN && SHOP.mail);
}

// 表を最初のリクエストで作る（Workers Builds では migrations が自動で走らないため。schema.sql と同じ内容）
var SCHEMA = [
  'CREATE TABLE IF NOT EXISTS hours (date TEXT PRIMARY KEY, s TEXT NOT NULL, e TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, date TEXT NOT NULL, s TEXT NOT NULL, e TEXT NOT NULL, kind TEXT NOT NULL, menu TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS blocks_date ON blocks(date)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  // 合言葉の連続ミス（2026/10/25）：接続元 IP ごとの回数と止める期限。IP はここにだけ持ち、ログにも画面にも出さない。day（日本時間の日付）の翌日に消す
  "CREATE TABLE IF NOT EXISTS auth_fail (ip TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until TEXT NOT NULL DEFAULT '', day TEXT NOT NULL)",
  // いたずら対策 A（2026/10/26）：/api/book への送信の記録（接続元 IP と時刻）。10 分に 5 回まで。IP はここにだけ持ち、10 分たった行はアクセスのたびに消す
  'CREATE TABLE IF NOT EXISTS book_rate (ip TEXT NOT NULL, at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS book_rate_ip ON book_rate(ip)'
];
var RATE_N = 5, RATE_MIN = 10;   // A：同じ IP から 10 分に 5 回まで
var FUTURE_N = 3;                // B'：同じ電話・メールの、まだ来店していないネット予約は 3 件まで
var RATE_MSG = '短い間にたくさん送られました。しばらくしてからお試しください。お急ぎの場合は LINE かお電話でお願いします';
var FUTURE_MSG = '同じお電話・メールでのネット予約は ' + FUTURE_N + ' 件までです。LINE かお電話でご相談ください';
var DAILY_N = 20;                // お店全体で、受けた日（日本時間）ごとのネット予約は 1 日 20 件まで（2026/10/26 決定）
var DAILY_MSG = '本日のネット予約の受付は上限に達しました。LINE かお電話でお願いします';
var MAIL_NG_NOTE = '確認メールをお送りできませんでした。確認メールが届かない場合は LINE かお電話でご連絡ください';
var LOCK_N = 5, LOCK_MIN = 10;   // 5 回で 10 分
var LOCK_MSG = 'しばらくしてからお試しください';
/** @type {Promise<unknown>|null} */
var ready = null;
// 名前・電話・メールの列（2026/10/25）。新しい表は CREATE に入っていないので、ここで足す（前からある表にも同じ手順で足せる）
var PII_COLS = ['name', 'tel', 'email'];
// 足す列の定義（PII の 3 つ＋ mailng＝確認メールを送れなかった印。2026/10/26 レビューの直し：メールが送れなくても予約は残す）
/** @type {Record<string,string>} */
var ADD_COLS = { name: "TEXT NOT NULL DEFAULT ''", tel: "TEXT NOT NULL DEFAULT ''", email: "TEXT NOT NULL DEFAULT ''", mailng: 'INTEGER NOT NULL DEFAULT 0' };
// 列は 1 本ずつ足す。同時アクセスで別の実行環境が先に足していると「duplicate column」になるが、それは「もう足されている」だけなので握りつぶして続ける。ほかのエラーはそのまま投げる
/** @param {D1Database} db */
export async function migrate(db) {   // テストから直接呼べるように export
  await db.batch(SCHEMA.map(function (q) { return db.prepare(q); }));
  var cols = /** @type {{ name: string }[]} */ ((await db.prepare('PRAGMA table_info(blocks)').all()).results).map(function (c) { return c.name; });
  var add = Object.keys(ADD_COLS).filter(function (c) { return cols.indexOf(c) < 0; });
  for (var i = 0; i < add.length; i++) {
    try {
      await db.prepare('ALTER TABLE blocks ADD COLUMN ' + add[i] + ' ' + ADD_COLS[add[i]]).run();
    } catch (/** @type {any} */ e) {
      if (!/duplicate column/i.test(String(e && e.message || e))) throw e;
    }
  }
}
/** @param {D1Database} db */
function ensureTables(db) {
  if (!ready) ready = migrate(db).catch(function (e) { ready = null; throw e; });
  return ready;
}
// 来店日の翌日（日本時間）になったら、名前・電話・メールを空にする（枠の記録は残す）。
// Cron ではなく、/api/… のアクセスのたびに走らせる：仕組みが1つ増えず、お店の画面を開く前（どのアクセスでも）に必ず消えている。
// 該当の行がなければ何も書かない
/** @param {D1Database} db @param {string} todayKey */
export function forgetOld(db, todayKey) {   // テストから直接呼べるように export
  return db.batch([
    db.prepare("UPDATE blocks SET name = '', tel = '', email = '' WHERE date < ?1 AND (name <> '' OR tel <> '' OR email <> '')").bind(todayKey),
    db.prepare("DELETE FROM auth_fail WHERE day < ?1 AND (until = '' OR until <= ?2)").bind(todayKey, new Date().toISOString()),   // 合言葉を間違えた接続元の記録は翌日に消す。ただし止めている最中（until が先）の行は残す（日付をまたいで早く解けないように。2026/10/26）
    db.prepare('DELETE FROM book_rate WHERE at < ?1').bind(new Date(Date.now() - RATE_MIN * 60000).toISOString())   // 送信の記録（IP）は 10 分たったら消す
  ]);
}
// いたずら対策（2026/10/26）。入力の確かめを通ったあと、予約を入れる前に見る。デモ（shop.jsonc の demo:true）では見ない
//  B'：同じ電話（ハイフンを除いて比べる）か同じメール（大文字小文字を区別しない）で、来店日が今日以降のネット予約（kind net）が FUTURE_N 件あれば 429
//  A ：同じ接続元（IP）から RATE_MIN 分に RATE_N 回まで。超えたら 429。IP が無いとき（手元など）は見ない。予約が入った回も 409 になった回も数える（ここで記録する）
//  上限（1 日）：受けた日（日本時間）のネット予約が DAILY_N 件あれば 429（blocks を数えるだけ）
//  2026/10/26 レビューの直し：A の「数える→入れる」は 1 命令（INSERT … SELECT … WHERE count < N）にして、同時に送られても超えない。B' と 1 日の上限は、ここで先に見るのに加えて、枠を取る INSERT の条件にも入れる（insertNet）
/** @param {string} todayKey @returns {string} 日本時間のその日の 0:00 を UTC の ISO で */
function dayStartIso(todayKey) { return new Date(todayKey + 'T00:00:00+09:00').toISOString(); }
var FUTURE_SQL = "(SELECT count(*) FROM blocks WHERE kind = 'net' AND date >= ?T AND (replace(tel, '-', '') = ?K OR lower(email) = ?M))";
var DAILY_SQL = "(SELECT count(*) FROM blocks WHERE kind = 'net' AND created_at >= ?D)";
/** @param {D1Database} db @param {{ demo: boolean, ip: string, tel: string, email: string, today: string }} o @returns {Promise<{ status: number, error: string }|null>} */
export async function limitCheck(db, o) {   // テストから直接呼べるように export
  if (o.demo) return null;
  var telKey = String(o.tel || '').replace(/-/g, ''), mailKey = String(o.email || '').toLowerCase();
  var c = /** @type {{ fut: number, day: number }} */ (await db.prepare(
    'SELECT ' + FUTURE_SQL.replace('?T', '?1').replace('?K', '?2').replace('?M', '?3') + ' AS fut, ' + DAILY_SQL.replace('?D', '?4') + ' AS day'
  ).bind(o.today, telKey, mailKey, dayStartIso(o.today)).first());
  if (c && c.fut >= FUTURE_N) return { status: 429, error: FUTURE_MSG };
  if (c && c.day >= DAILY_N) return { status: 429, error: DAILY_MSG };
  if (o.ip) {
    // 数えて入れるを 1 命令で（同時に来ても RATE_N を超えない）
    var since = new Date(Date.now() - RATE_MIN * 60000).toISOString();
    var r = await db.prepare('INSERT INTO book_rate (ip, at) SELECT ?1, ?2 WHERE (SELECT count(*) FROM book_rate WHERE ip = ?1 AND at >= ?3) < ?4')
      .bind(o.ip, new Date().toISOString(), since, RATE_N).run();
    if (!(r.meta && r.meta.changes > 0)) return { status: 429, error: RATE_MSG };
  }
  return null;
}
// ネット予約の枠を取る（1 命令）：重なりなし・同じ電話／メールの未来の予約が FUTURE_N 未満・その日の受付が DAILY_N 未満 のときだけ入る。
// 入らなかったときは、どの理由かを数えて返す（同時に送られても上限を超えないのはこの INSERT が守る）。デモでは重なりだけ
/** @param {D1Database} db @param {Block} b @param {{ demo: boolean, today: string }} g @returns {Promise<{ status: number, error: string }|null>} null＝入った */
export async function insertNet(db, b, g) {   // テストから直接呼べるように export
  if (g.demo) return (await insertBlock(db, b)) ? null : { status: 409, error: '' };
  var telKey = String(b.tel || '').replace(/-/g, ''), mailKey = String(b.email || '').toLowerCase(), dayStart = dayStartIso(g.today);
  var r = await db.prepare(
    'INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email) ' +
    'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE date = ?2 AND s < ?4 AND e > ?3)' +
    ' AND ' + FUTURE_SQL.replace('?T', '?11').replace('?K', '?12').replace('?M', '?13') + ' < ?14' +
    ' AND ' + DAILY_SQL.replace('?D', '?15') + ' < ?16'
  ).bind(b.id, b.date, b.s, b.e, b.kind, b.menu, b.created_at, b.name || '', b.tel || '', b.email || '', g.today, telKey, mailKey, FUTURE_N, dayStart, DAILY_N).run();
  if (r.meta && r.meta.changes > 0) return null;
  var c = /** @type {{ fut: number, day: number }} */ (await db.prepare(
    'SELECT ' + FUTURE_SQL.replace('?T', '?1').replace('?K', '?2').replace('?M', '?3') + ' AS fut, ' + DAILY_SQL.replace('?D', '?4') + ' AS day'
  ).bind(g.today, telKey, mailKey, dayStart).first());
  if (c && c.fut >= FUTURE_N) return { status: 429, error: FUTURE_MSG };
  if (c && c.day >= DAILY_N) return { status: 429, error: DAILY_MSG };
  return { status: 409, error: '' };
}

/** @param {unknown} body @param {number} [status] @param {Record<string,string>} [extra] @returns {Response} */
function json(body, status, extra) {
  /** @type {Record<string,string>} */
  var h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (extra) for (var k in extra) h[k] = extra[k];
  return new Response(JSON.stringify(body), { status: status || 200, headers: h });
}
/** @param {string} t @returns {number} */
function m2(t) { var a = String(t).split(':'); return (+a[0]) * 60 + (+a[1]); }
/** @param {number} m @returns {string} */
function t2(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
/** @param {unknown} s @returns {boolean} */
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); }
/** @param {unknown} s @returns {boolean} */
function isTime(s) { return /^\d{2}:\d{2}$/.test(String(s)) && m2(/** @type {string} */ (s)) >= 0 && m2(/** @type {string} */ (s)) <= 24 * 60; }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// 日本時間（Workers は UTC で動くので、+9 時間して日付と時刻を出す）
/** @returns {{ date: string, min: number }} */
function nowJST() {
  var d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
/** @param {string} dateKey @param {number} n @returns {string} */
function addDays(dateKey, n) {
  var d = new Date(dateKey + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
var DOW = ['日', '月', '火', '水', '木', '金', '土'];
/** @param {string} k @returns {string} */
function jpDate(k) {
  var d = new Date(k + 'T00:00:00Z');
  return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日（' + DOW[d.getUTCDay()] + '）';
}

/** @param {Request} request @returns {Promise<any>} */
async function readJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

// 重ならないときだけ入れる（1つの文で確かめて入れるので、同時に2人が押しても2つ目は入らない）
/** @param {D1Database} db @param {Block} b @returns {Promise<boolean>} */
async function insertBlock(db, b) {
  var r = await db.prepare(
    'INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email) ' +
    'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE NOT EXISTS (' +
    '  SELECT 1 FROM blocks WHERE date = ?2 AND s < ?4 AND e > ?3)'
  ).bind(b.id, b.date, b.s, b.e, b.kind, b.menu, b.created_at, b.name || '', b.tel || '', b.email || '').run();
  return r.meta && r.meta.changes > 0;
}

// デモだけ（demo:true）：お店の画面で何も入れていなくても、今日から 14 日は毎日 10:00〜18:00 が空いている形にする。
// 試しの予約は 24 時間たつと消す（枠が埋まりっぱなしにならないように）。過ぎた日の営業時間も消す。/api/… のたびに動く（Cron なし）
var DEMO_DAYS = 14, DEMO_S = '10:00', DEMO_E = '18:00';
/** @param {D1Database} db */
async function demoPrepare(db) {
  var now = nowJST();
  var old = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  var q = [
    db.prepare('DELETE FROM blocks WHERE created_at < ?1 OR date < ?2').bind(old, now.date),
    db.prepare('DELETE FROM hours WHERE date < ?1').bind(now.date)
  ];
  for (var i = 0; i < DEMO_DAYS; i++) {
    q.push(db.prepare('INSERT INTO hours (date, s, e) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO NOTHING').bind(addDays(now.date, i), DEMO_S, DEMO_E));
  }
  await db.batch(q);
}

// GAS へ渡す中身（お店の情報は shop.jsonc から。GAS にお店の値は書かない）
/** @returns {ShopInfo} */
function shopInfo() {
  return { name: SHOP.shopName, shortName: SHOP.shortName || SHOP.shopName, tel: SHOP.tel || '', line: SHOP.lineUrl || '', mail: SHOP.mail || '', address: SHOP.address || '', parking: SHOP.parking || '', mapUrl: SHOP.mapUrl || '', cancelPolicy: SHOP.cancelPolicy || '' };
}

// GAS（お店の Gmail から送る係）へ送る。返事が {ok:true} のときだけ true。25 秒で打ち切り
/** @param {Env} env @param {unknown} payload @returns {Promise<boolean>} */
export async function sendGas(env, payload) {   // テストから直接呼べるように export
  var ctl = new AbortController();
  var tm = setTimeout(function () { ctl.abort(); }, 25000);
  try {
    var r = await fetch(/** @type {string} */ (env.GAS_URL), {   // isOpen() で GAS_URL があるときだけここに来る
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'follow', signal: ctl.signal
    });
    var t = await r.text(), j = null;
    try { j = JSON.parse(t); } catch (e) { }
    return !!(r.ok && j && j.ok === true);
  } catch (e) {
    return false;
  } finally {
    clearTimeout(tm);
  }
}

// デモ用：確認メールの見本の文（本物の文は gas/Code.gs の customerBody。そちらを直したらここも合わせる）
/** @param {Customer} c @param {Booking} b @param {ShopInfo} s @returns {string} */
function mailPreview(c, b, s) {
  var L = [];
  L.push('件名：【' + s.shortName + '】ご予約を承りました');
  L.push('');
  L.push(c.name + ' 様');
  L.push('このたびは ' + s.name + ' にご予約いただき、ありがとうございます。以下の内容でご予約を承りました。');
  L.push('■ 日時　　' + b.when);
  var many = b.items && b.items.length > 1;   // 複数メニュー：1 行ずつ＋施術の合計（gas/Code.gs の customerBody と同じ形）
  if (many) { L.push('■ メニュー'); b.items.forEach(function (it) { L.push('　・' + it.name + '（' + it.min + '分' + (it.price ? '・' + it.price : '') + '）'); }); L.push('■ 施術時間　合計' + b.min + '分'); }
  else L.push('■ メニュー　' + b.menu + '（' + b.min + '分）');
  if (b.slot && b.slot !== b.min) L.push('■ 所要時間　約' + b.slot + '分（カウンセリング・お片づけ' + (b.extraNote ? '・' + b.extraNote : '') + 'を含む）');
  if (b.price) L.push('■ 料金　　' + (many && /円/.test(b.price) ? '合計 ' : '') + b.price + (/円/.test(b.price) ? '（税込）' : ''));   // 金額でないときは「合計」を付けない
  L.push('■ キャンセルについて　' + (s.cancelPolicy || ''));
  L.push('ご変更・キャンセルは、公式LINE かお電話' + (s.tel ? '（' + s.tel + '）' : '') + 'でお知らせください。');
  if (s.address) L.push('■ 場所　' + s.address + (s.parking ? '　' + s.parking : ''));
  if (s.mapUrl) L.push('地図：' + s.mapUrl);
  L.push('当日お会いできるのを楽しみにしております。');
  return L.join('\n');
}

// ほかのサイト（お店の HP）から /api/days を読み、/api/book に予約を送れるようにする許可（CORS）。shop.jsonc の allowOrigins にある Origin のときだけ、その Origin を返す。
// * は使わない。一覧にない Origin・Origin なしには付けない。/api/admin には付けない（お店の画面は同じサイトからだけ）
/** @param {Request} request @returns {Record<string,string>} */
function corsFor(request) {
  var origin = request.headers.get('Origin') || '';
  var list = Array.isArray(SHOP.allowOrigins) ? SHOP.allowOrigins : [];
  if (origin && list.indexOf(origin) >= 0) return { 'access-control-allow-origin': origin, 'vary': 'Origin' };
  return {};
}
// 返事（成功でも 400・409・502・503 でも）に、許可した Origin の CORS ヘッダを足す（HP 側が失敗の文も読めるように）。許可がなければそのまま返す
/** @param {Response} res @param {Request} request @returns {Response} */
function withCors(res, request) {
  var c = corsFor(request), keys = Object.keys(c);
  if (!keys.length) return res;
  var h = new Headers(res.headers);
  keys.forEach(function (k) { h.set(k, c[k]); });
  return new Response(res.body, { status: res.status, headers: h });
}
// ブラウザの事前確認（OPTIONS /api/book）。許可した Origin には 204＋許可のヘッダ、許可していない Origin には 204 だけ（CORS ヘッダなし）。/api/admin には答えない
/** @param {Request} request @returns {Response} */
function preflightBook(request) {
  var c = corsFor(request);
  if (c['access-control-allow-origin']) {
    c['access-control-allow-methods'] = 'POST';
    c['access-control-allow-headers'] = 'content-type';
    c['access-control-max-age'] = '600';
  }
  return new Response(null, { status: 204, headers: c });
}
/** @param {Env} env @param {Request} request */
async function handleDays(env, request) {
  var now = nowJST(), last = lastDate(now.date);
  var hours = (await env.DB.prepare('SELECT date, s, e FROM hours WHERE date >= ?1 AND date <= ?2 ORDER BY date').bind(now.date, last).all()).results;
  var bl = /** @type {{ date: string, s: string, e: string }[]} */ ((await env.DB.prepare('SELECT date, s, e FROM blocks WHERE date >= ?1 AND date <= ?2 ORDER BY date, s').bind(now.date, last).all()).results);
  /** @type {Record<string, { s: string, e: string, kind: string }[]>} */
  var busy = {};
  bl.forEach(function (b) { (busy[b.date] = busy[b.date] || []).push({ s: b.s, e: b.e, kind: 'busy' }); });
  // メニュー（名前・施術の分・料金・予約1回の長さ だけ）と案内の 2 文。HP 側のカレンダーが使う。設定のほかの項目（mail・合言葉など）は出さない
  var menus = SHOP.menus.map(function (m) { return { name: m.name, min: +m.min, price: m.price || '', slot: m.slot ? +m.slot : 0, extraMin: +(/** @type {number} */ (m.extraMin)) || 0, extraNote: m.extraNote || '' }; });
  return json({ today: now.date, now: t2(now.min), bufferMin: BUFFER_MIN, preMin: PRE_MIN, stepMin: STEP_MIN, daysAhead: DAYS_AHEAD, sameDayCutoffMin: CUTOFF_MIN, open: isOpen(env), demo: DEMO, hours: hours, busy: busy,
    menus: menus, maxTotalMin: MAX_TOTAL_MIN, otherMenusNote: SHOP.otherMenusNote || '', taxNote: SHOP.taxNote || '' }, 200, corsFor(request));
}

/** @param {Request} request @param {Env} env */
async function handleBook(request, env) {
  if (!isOpen(env)) return json({ error: 'ただいまネット予約の準備中です。LINE かお電話でお願いします' }, 503);
  var b = await readJson(request);
  if (!b || typeof b !== 'object') return json({ error: '入力が足りません' }, 400);
  // 型の確かめ（文字でないものは 400。配列などを入れて内部のエラー文を引き出せないように。2026/10/26 レビューの直し）
  var fields = ['date', 'start', 'menu', 'name', 'tel', 'email'];
  for (var fi = 0; fi < fields.length; fi++) { var fv = b[fields[fi]]; if (fv !== undefined && fv !== null && typeof fv !== 'string') return json({ error: '入力の形が違います' }, 400); }
  if (!isDate(b.date) || !isTime(b.start)) return json({ error: '入力が足りません' }, 400);
  var pm = pickMenus(b);
  if ('error' in pm) return json({ error: pm.error }, 400);
  var menus = pm.menus, menuName = namesOf(menus);
  var slot = lenOf(menus);   // 枠をふさぐ長さ（1 つ：メニューの slot か 前＋施術＋後。2 つ以上：前＋施術の合計＋後）
  // 名前・電話・メール（GAS へ渡し、お店の画面用に台帳へ。来店日の翌日に空にする）
  var name = String(b.name || '').trim().slice(0, 40), tel = String(b.tel || '').trim(), email = String(b.email || '').trim();
  if (!name) return json({ error: 'お名前を入れてください' }, 400);
  if (!/^[0-9\-]{10,13}$/.test(tel)) return json({ error: '電話番号を数字で入れてください' }, 400);
  // 「?」「&」「=」「,」「;」「<」「>」入りは弾く（お店の画面の mailto: に宛先以外の指定（cc など）が混ざるのを防ぐ）
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || /[?&=,;<>]/.test(email) || email.length > 100) return json({ error: 'メールアドレスの形を確かめてください' }, 400);
  var cust = { name: name, tel: tel, email: email };
  var now = nowJST();
  if (b.date < now.date) return json({ error: '過ぎた日です' }, 400);
  if (DAYS_AHEAD > 0 && b.date > addDays(now.date, DAYS_AHEAD)) return json({ error: '先すぎる日です（' + DAYS_AHEAD + '日先まで）' }, 400);
  var s = m2(b.start), e = s + slot;   // 枠は来店から（カウンセリング込み）予約1回の長さ
  if (b.date === now.date && s < now.min + CUTOFF_MIN) return json({ error: '当日は ' + CUTOFF_MIN + ' 分前までのご予約です。LINE かお電話でお願いします' }, 400);
  var h = /** @type {{ s: string, e: string }|null} */ (await env.DB.prepare('SELECT s, e FROM hours WHERE date = ?1').bind(b.date).first());
  if (!h) return json({ error: 'この日は営業していません' }, 400);
  if ((s - m2(h.s)) % STEP_MIN !== 0) return json({ error: '開始時間の形が違います' }, 400);
  if (s < m2(h.s) || e > m2(h.e)) return json({ error: '営業時間の外です' }, 400);
  // いたずら対策（入力の確かめを全部通ったあと。デモでは見ない）
  var lim = await limitCheck(env.DB, { demo: DEMO, ip: request.headers.get('CF-Connecting-IP') || '', tel: tel, email: email, today: now.date });
  if (lim) return json({ error: lim.error }, lim.status);
  var id = newId();
  var ins = await insertNet(env.DB, { id: id, date: b.date, s: t2(s), e: t2(e), kind: 'net', menu: menuName.slice(0, 200), created_at: new Date().toISOString(), name: name, tel: tel, email: email }, { demo: DEMO, today: now.date });   // 名前・電話・メールはお店の画面用（翌日に空にする）
  if (ins) return json({ error: ins.error || 'たった今ほかの方の予約が入りました' }, ins.status);

  // お客さんに見せるのは来店の時間と施術の時間。所要（slot）はカウンセリング・片づけ込み
  // 複数メニューのときは menu が「A＋B」、min が施術の合計、price が合計（か「お問い合わせください」）、items に 1 つずつ（メールで 1 行ずつ書く）
  var items = menus.map(function (m) { return { name: String(m.name), min: +m.min, price: m.price || '' }; });
  var booking = { id: id, date: b.date, when: jpDate(b.date) + ' ' + t2(s) + '〜', start: t2(s), end: t2(e), menu: menuName, min: minOf(menus), slot: slot, price: priceOf(menus), items: items, extraNote: menus.length > 1 ? extraNotes(menus).join('・') : '' };
  var shop = shopInfo();
  if (DEMO) {
    // デモ：メールは送らない。見本の文を返して画面に出す
    return json({ ok: true, id: id, date: b.date, s: t2(s), e: t2(e), slot: slot, menus: items.map(function (x) { return x.name; }), min: booking.min, price: booking.price, demo: true, mailPreview: mailPreview(cust, booking, shop) });
  }
  // 本番：枠を押さえたあとにメールを送る。送れなくても予約は残す（2026/10/26 決定。メールだけ送られて枠が消える事故を防ぐ）。台帳に「メール未送」の印（mailng）を付け、お店の画面で分かるようにする。返事は 200 で mail:false
  var sent = await sendGas(env, { token: env.GAS_TOKEN, customer: cust, booking: booking, shop: shop });
  if (!sent) {
    await env.DB.prepare('UPDATE blocks SET mailng = 1 WHERE id = ?1').bind(id).run();
    return json({ ok: true, id: id, date: b.date, s: t2(s), e: t2(e), slot: slot, menus: items.map(function (x) { return x.name; }), min: booking.min, price: booking.price, mail: false, note: MAIL_NG_NOTE });
  }
  return json({ ok: true, id: id, date: b.date, s: t2(s), e: t2(e), slot: slot, menus: items.map(function (x) { return x.name; }), min: booking.min, price: booking.price, mail: true });
}

/** @param {Request} request @param {Env} env @param {string} path */
async function handleAdmin(request, env, path) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD が設定されていません（wrangler secret put ADMIN_PASSWORD）' }, 500);
  if (request.method === 'OPTIONS') return json({ error: 'ありません' }, 404);   // 事前確認には答えない・回数にも数えない（2026/10/26 レビューの直し）
  var pw = request.headers.get('X-Admin-Password') || '';
  if (!pw) return json({ error: 'パスワードが違います' }, 401);   // 合言葉なし（他サイトのフォームからの送信など）は、回数に数えずに 401（誰かが合言葉なしで連打してもお店を締め出せない）
  // 合言葉の連続ミス：同じ接続元から 5 回間違えたら 10 分止める。止まっている間は正しい合言葉でも通さない（文言は 1 つだけ。理由・残り時間は出さない）
  var ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  var nowIso = new Date().toISOString();
  var fail = /** @type {{ n: number, until: string }|null} */ (await env.DB.prepare('SELECT n, until FROM auth_fail WHERE ip = ?1').bind(ip).first());
  if (fail && fail.until && fail.until > nowIso) return json({ error: LOCK_MSG }, 429);
  if (pw !== env.ADMIN_PASSWORD) {
    // 加算は 1 つの命令で（同時に来ても数が飛ばない）。前の止めが切れたあとの間違いは 1 から数え直す。n が 5 以上になった回で止める
    var untilIso = new Date(Date.now() + LOCK_MIN * 60000).toISOString();
    var r = /** @type {{ n: number }} */ (await env.DB.prepare(
      "INSERT INTO auth_fail (ip, n, until, day) VALUES (?1, 1, '', ?3) " +
      'ON CONFLICT(ip) DO UPDATE SET ' +
      "  n = CASE WHEN auth_fail.until <> '' AND auth_fail.until <= ?2 THEN 1 ELSE auth_fail.n + 1 END, " +
      "  until = CASE WHEN (CASE WHEN auth_fail.until <> '' AND auth_fail.until <= ?2 THEN 1 ELSE auth_fail.n + 1 END) >= ?5 THEN ?4 ELSE '' END, " +
      '  day = ?3 ' +
      'RETURNING n'
    ).bind(ip, nowIso, nowJST().date, untilIso, LOCK_N).first());
    if (r && r.n >= LOCK_N) return json({ error: LOCK_MSG }, 429);
    return json({ error: 'パスワードが違います' }, 401);
  }
  if (fail) await env.DB.prepare('DELETE FROM auth_fail WHERE ip = ?1').bind(ip).run();   // 正しい合言葉で入れたら、その接続元の回数を 0 に
  var m = request.method;
  if (path === 'login' && m === 'POST') return json({ ok: true });
  if (path === 'all' && m === 'GET') {
    var hours = (await env.DB.prepare('SELECT date, s, e FROM hours ORDER BY date').all()).results;
    var blocks = (await env.DB.prepare('SELECT id, date, s, e, kind, menu, name, tel, email, mailng FROM blocks ORDER BY date, s').all()).results;
    var st = /** @type {{ key: string, value: string }[]} */ ((await env.DB.prepare('SELECT key, value FROM settings').all()).results);
    /** @type {Record<string, unknown>} */
    var settings = {};
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
    var net = /** @type {{ n: number }|null} */ (await env.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE date = ?1 AND kind = 'net'").bind(b.date).first());
    if (net && net.n > 0) return json({ error: 'ネット予約がある日は休みにできません' }, 409);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM blocks WHERE date = ?1').bind(b.date),
      env.DB.prepare('DELETE FROM hours WHERE date = ?1').bind(b.date)
    ]);
    return json({ ok: true });
  }
  if (path === 'block' && m === 'POST') {
    if (!isDate(b.date) || !isTime(b.s) || !isTime(b.e) || m2(b.s) >= m2(b.e)) return json({ error: '時間を確かめてください' }, 400);
    var h = /** @type {{ s: string, e: string }|null} */ (await env.DB.prepare('SELECT s, e FROM hours WHERE date = ?1').bind(b.date).first());
    if (!h) return json({ error: 'この日は休みです' }, 400);
    if (m2(b.s) < m2(h.s) || m2(b.e) > m2(h.e) + BUFFER_MIN) return json({ error: '営業時間の外です' }, 400);
    var kind = b.kind === 'stop' ? 'stop' : 'man';   // stop ＝ 予約停止（名前・内容なし。お客さんの画面では空きに出ないだけ。2026/10/21）
    var id = newId();
    var ok = await insertBlock(env.DB, { id: id, date: b.date, s: b.s, e: b.e, kind: kind, menu: kind === 'stop' ? '' : String(b.menu || '').slice(0, 40), created_at: new Date().toISOString(), name: kind === 'stop' ? '' : String(b.name || '').trim().slice(0, 40) });   // 手入力は名前だけ任意。電話・メールは持たない
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

// ---- 予約のバックアップ（2026/10/26 決定 09・規約 第13条）----
// 毎日 04:30（日本時間）に Cron（scheduled）だけが動かす。台帳 blocks・営業時間 hours・設定 settings の全行を JSON にして KV に put。
// キーは backup:YYYY-MM-DD（日本時間の日付）。1 件ごとに expirationTtl＝30 日（2592000 秒）で、過ぎたら KV が自動で消す。
// 名前・電話・メールは戻すために含める。book_rate・auth_fail（接続元 IP の記録。10 分／翌日で消すもの）は書き出さない。
// HTTP の口はない（/api/… からは読めない・書き出せない）。結果は settings の backup_last に残す（成功／失敗と時刻。予約の中身は入れない）→ お店の画面の下に出る
var BACKUP_TTL_SEC = 30 * 24 * 60 * 60;   // 2592000
var BACKUP_PREFIX = 'backup:';
/** @param {D1Database} db @returns {Promise<{ version: number, at: string, date: string, shop: string, counts: { blocks: number, hours: number, settings: number }, blocks: unknown[], hours: unknown[], settings: unknown[] }>} */
export async function buildBackup(db) {   // テストから直接呼べるように export
  var now = nowJST();
  var blocks = (await db.prepare('SELECT id, date, s, e, kind, menu, created_at, name, tel, email, mailng FROM blocks ORDER BY date, s').all()).results;
  var hours = (await db.prepare('SELECT date, s, e FROM hours ORDER BY date').all()).results;
  var settings = (await db.prepare('SELECT key, value FROM settings WHERE key <> ?1 AND key <> ?2').bind('backup_last', 'reminder_last').all()).results;   // 結果の記録（backup_last・reminder_last）は控えに入れない
  return { version: 1, at: new Date().toISOString(), date: now.date, shop: SHOP.shopName, counts: { blocks: blocks.length, hours: hours.length, settings: settings.length }, blocks: blocks, hours: hours, settings: settings };
}
/** @param {Env} env @returns {Promise<{ ok: boolean, key?: string, counts?: { blocks: number, hours: number, settings: number }, error?: string }>} */
export async function runBackup(env) {   // テストから直接呼べるように export
  var at = new Date().toISOString();
  /** @type {{ ok: boolean, at: string, key?: string, counts?: { blocks: number, hours: number, settings: number }, error?: string }} */
  var result;
  try {
    if (!env.BACKUP) throw new Error('KV がつながっていません（wrangler.jsonc の kv_namespaces）');
    await ensureTables(env.DB);
    var data = await buildBackup(env.DB);
    var key = BACKUP_PREFIX + data.date;
    await env.BACKUP.put(key, JSON.stringify(data), { expirationTtl: BACKUP_TTL_SEC, metadata: { at: at, counts: data.counts } });
    result = { ok: true, at: at, key: key, counts: data.counts };
  } catch (/** @type {any} */ e) {
    // 失敗の理由は短く（予約の中身・個人情報は入れない）
    result = { ok: false, at: at, error: String(e && e.message || e).slice(0, 120) };
  }
  try {
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('backup_last', JSON.stringify(result)).run();
  } catch (e) { }
  return result;
}

// ---- 2 日前のお知らせメール（2026/10/28。shop.jsonc の reminder。既定は無効）----
// 毎日 hourJst（日本時間）に Cron（REMINDER_CRON＝UTC に直した時刻）で動く。「日本時間の今日＋daysBefore 日」の日付の、ネット予約（kind net・メールあり）に、GAS（action: 'reminder'）から 1 通。
// 送った印は D1 の表を変えず KV に reminder:<予約の id>（REMINDER_TTL_SEC で自動で消える）。印があれば送らない（二重送信を止める）。取り消された予約は表から消えているので対象にならない。
// GAS が失敗した予約は印を付けず、settings の reminder_last と console.error（id だけ。名前・メールは出さない）に残す。翌日は日付が合わないので再送はしない。
// enabled が false のとき、GAS の秘密の変数がないとき、デモ（demo:true）のときは何も送らない（GAS が旧版のままだと変なメールが出るため、有効にするのは GAS を貼り直す日）
var BACKUP_CRON = '30 19 * * *';
/** @type {ReminderCfg} */
var REMINDER = SHOP.reminder || {};
var REMINDER_HOUR_JST = (REMINDER.hourJst === undefined) ? 10 : +REMINDER.hourJst;
var REMINDER_CRON = '0 ' + (((REMINDER_HOUR_JST - 9) % 24 + 24) % 24) + ' * * *';   // 例：10 時 JST → '0 1 * * *'
var REMINDER_PREFIX = 'reminder:';
var REMINDER_TTL_SEC = 7 * 24 * 60 * 60;   // 印は 7 日で消える（来店日を過ぎてから）
/** @param {string} menuText 台帳の menu（「A＋B」） @returns {{ items: BookItem[], min: number, extraNote: string }} 名前から設定のメニューを引き直す（設定から消えたものは名前だけ） */
function itemsOfMenuText(menuText) {
  /** @type {BookItem[]} */
  var items = [];
  /** @type {ShopMenu[]} */
  var found = [];
  String(menuText || '').split('＋').forEach(function (n) {
    if (!n) return;
    var m = menuOf(n);
    if (m) { found.push(m); items.push({ name: String(m.name), min: +m.min, price: m.price || '' }); }
    else items.push({ name: n, min: 0, price: '' });
  });
  return { items: items, min: minOf(found), extraNote: found.length > 1 ? extraNotes(found).join('・') : '' };
}
/** @param {Env} env @param {ReminderCfg} [cfg] テストから設定を差しかえるため（省略時は shop.jsonc の reminder。cfg を渡したときだけデモでも動く） @returns {Promise<{ ok: boolean, at: string, date?: string, sent: number, skipped: number, failed: number, reason?: string, error?: string }>} */
export async function runReminder(env, cfg) {   // テストから直接呼べるように export
  var c = cfg || REMINDER, at = new Date().toISOString();
  /** @type {{ ok: boolean, at: string, date?: string, sent: number, skipped: number, failed: number, reason?: string, error?: string }} */
  var result = { ok: true, at: at, sent: 0, skipped: 0, failed: 0 };
  if (c.enabled !== true) { result.reason = 'disabled'; return result; }
  if (DEMO && !cfg) { result.reason = 'demo'; return result; }   // デモのお店は Cron から送らない（テストは cfg を渡して確かめる）
  if (!(env.GAS_URL && env.GAS_TOKEN)) { result.reason = 'no-gas'; return result; }
  if (!env.BACKUP) { result.ok = false; result.error = 'KV がつながっていません（wrangler.jsonc の kv_namespaces）'; await saveReminderLast(env, result); return result; }
  var days = (c.daysBefore === undefined) ? 2 : +c.daysBefore;
  var target = addDays(nowJST().date, days);
  result.date = target;
  try {
    await ensureTables(env.DB);
    var rows = /** @type {{ id: string, date: string, s: string, e: string, menu: string, name: string, tel: string, email: string }[]} */ ((await env.DB.prepare(
      "SELECT id, date, s, e, menu, name, tel, email FROM blocks WHERE date = ?1 AND kind = 'net' AND email <> '' ORDER BY s"
    ).bind(target).all()).results);
    var shop = shopInfo();
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i], key = REMINDER_PREFIX + b.id;
      if (await env.BACKUP.get(key)) { result.skipped++; continue; }   // もう送った
      var parts = itemsOfMenuText(b.menu), slot = m2(b.e) - m2(b.s);
      /** @type {Booking} */
      var booking = { id: b.id, date: b.date, when: jpDate(b.date) + ' ' + b.s + '〜', start: b.s, end: b.e, menu: b.menu, min: parts.min, slot: slot, price: '', items: parts.items, extraNote: parts.extraNote };   // 料金は書かない（2 日前の知らせに金額は要らない・相当額は未定）
      var sent = await sendGas(env, { token: env.GAS_TOKEN, action: 'reminder', daysBefore: days, customer: { name: b.name, tel: b.tel, email: b.email }, booking: booking, shop: shop });
      if (sent) {
        await env.BACKUP.put(key, at, { expirationTtl: REMINDER_TTL_SEC, metadata: { date: b.date } });   // 印（予約の中身は入れない）
        result.sent++;
      } else {
        result.failed++;
        console.error('reminder: GAS failed id=' + b.id + ' date=' + b.date);   // 名前・メールは出さない
      }
    }
    if (result.failed) { result.ok = false; result.error = result.failed + ' 件 送れなかった（GAS の返事がない）'; }
  } catch (/** @type {any} */ e) {
    result.ok = false; result.error = String(e && e.message || e).slice(0, 120);
  }
  await saveReminderLast(env, result);
  return result;
}
/** @param {Env} env @param {unknown} result */
async function saveReminderLast(env, result) {
  try {
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('reminder_last', JSON.stringify(result)).run();
  } catch (e) { }
}

export default {
  /** @param {ScheduledController} controller @param {Env} env @param {ExecutionContext} ctx */
  async scheduled(controller, env, ctx) {
    // Cron は 2 本：バックアップ（BACKUP_CRON）と 2 日前のお知らせ（REMINDER_CRON）。どちらかを cron の文字で見分ける（知らない cron はバックアップ扱いにしない＝何もしない）
    if (controller.cron === REMINDER_CRON) ctx.waitUntil(runReminder(env));
    else if (controller.cron === BACKUP_CRON) ctx.waitUntil(runBackup(env));
  },
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    var url = new URL(request.url);
    var p = url.pathname;
    if (p === '/manifest.webmanifest') return manifest();
    if (p === '/apple-touch-icon.png' || p === '/apple-touch-icon-precomposed.png') return env.ASSETS.fetch(new Request(url.origin + '/icon-180.png', request));
    if (p.indexOf('/api/') !== 0) return env.ASSETS.fetch(request);
    if (p === '/api/book' && request.method === 'OPTIONS') return preflightBook(request);   // 事前確認は表を触らずに返す
    try {
      await ensureTables(env.DB);
      await forgetOld(env.DB, nowJST().date);   // 来店日が過ぎた予約の名前・電話・メールを空にする
      if (DEMO) await demoPrepare(env.DB);
      if (p === '/api/days' && request.method === 'GET') return await handleDays(env, request);
      if (p === '/api/book' && request.method === 'POST') return withCors(await handleBook(request, env), request);   // 許可した HP からの予約（2026/10/26）
      if (p.indexOf('/api/admin/') === 0) return await handleAdmin(request, env, p.slice('/api/admin/'.length));
      return json({ error: 'ありません' }, 404);
    } catch (/** @type {any} */ e) {
      return json({ error: 'サーバーでエラーが起きました。しばらくしてからお試しください' }, 500);   // 内部のエラー文は返さない（2026/10/26）
    }
  }
};
