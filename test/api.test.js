// 予約 API のテスト（2026/10/25）。本番と同じ Workers の実行環境（workerd）＋ D1 の中で、空きの計算と二重予約を守る
// 守ること：営業日／前10分・後10分（枠の長さ）／メニューの slot／長いメニューは開始時間が絞られる／予約停止は選べない／当日は締切前まで／きざみ／二重予約は 409／busy に中身を出さない
// お店の値（前後の分・きざみ・締切・メニュー）は public/shop.jsonc から読む（ここに数字を決め打ちしない）
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import shopText from '../public/shop.jsonc?raw';
import { forgetOld, migrate, sendGas, limitCheck, insertNet, priceOf } from '../src/worker.js';

const SHOP = JSON.parse(shopText.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^"\n]*$/gm, ''));
const PRE = +SHOP.preMin || 0, BUF = +SHOP.bufferMin || 0, STEP = +SHOP.stepMin || 30;
const CUTOFF = SHOP.sameDayCutoffMin === undefined ? 120 : +SHOP.sameDayCutoffMin;
const ADMIN = 'test-admin-password';           // vitest.config.js の bindings と同じ
const NOW_UTC = '2027-03-10T01:00:00Z';         // テストの「今」＝日本時間 2027-03-10（水）10:00
const TODAY = '2027-03-10';
const FAR = '2027-04-15';                       // 今日から 30 日以上先（デモが自動で入れる 14 日の外）
const FAR2 = '2027-04-16';

const slotOf = (m) => +m.slot || PRE + +m.min + BUF;
const menu = (name) => SHOP.menus.find((m) => m.name === name);
const m2 = (t) => +t.split(':')[0] * 60 + +t.split(':')[1];
const t2 = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
// 施術 60 分で slot なしのメニュー（前後の分がそのまま効く）と、slot 付きのメニュー、いちばん長いメニュー
const M_PLAIN = SHOP.menus.find((m) => !m.slot && +m.min === 60);
const M_SLOT = SHOP.menus.find((m) => m.slot);
const M_LONG = SHOP.menus.reduce((a, b) => (slotOf(a) >= slotOf(b) ? a : b));

const api = (path, init) => SELF.fetch('https://x' + path, init);
const post = (path, body, headers) => api(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
const admin = (method, path, body) => api('/api/admin/' + path, { method, headers: { 'content-type': 'application/json', 'X-Admin-Password': ADMIN }, body: JSON.stringify(body) });
const book = (date, start, menuName, extra) => post('/api/book', { date, start, menu: menuName, name: 'テスト 太郎', tel: '090-0000-0000', email: 'test@example.com', ...(extra || {}) });
const setHours = async (date, s, e) => { const r = await admin('POST', 'hours', { date, s, e }); expect(r.status).toBe(200); };
const blocksOf = async (date) => { const all = await (await admin('GET', 'all')).json(); return all.blocks.filter((b) => b.date === date); };

// 外への送信は全部ここで受け止める（テストと Worker は同じ実行環境なので、Worker の fetch にも効く）。
// GAS（vitest.config.js の GAS_URL のテスト値）には {ok:true} の偽物の返事。それ以外の外向きの fetch はエラーにして、本物のどこにも届かせない。
// → demo でないお店の写し先（colore など）でこのテストを回しても、お店の Gmail からメールは出ない
const gasCalls = [];
let gasMode = 'ok';   // 'ok'＝成功の返事／'drop'＝受け取ったあと返事が届かない（通信切れ）／'fail'＝500
beforeAll(() => {
  vi.stubGlobal('fetch', async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === env.GAS_URL) {
      gasCalls.push(JSON.parse(String(init && init.body || '{}')));
      if (gasMode === 'drop') throw new Error('network dropped after GAS received');
      if (gasMode === 'fail') return new Response('error', { status: 500 });
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error('テストからは外へ送らない: ' + url);
  });
});

beforeEach(async () => {
  gasCalls.length = 0; gasMode = 'ok';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_UTC));
  // テストごとに D1 をまっさらに（前のテストの予約・営業時間を持ちこさない）。表は最初の /api/days で作られる
  await api('/api/days');
  await env.DB.batch([env.DB.prepare('DELETE FROM blocks'), env.DB.prepare('DELETE FROM hours'), env.DB.prepare('DELETE FROM auth_fail'), env.DB.prepare('DELETE FROM book_rate')]);
});

describe('時計', () => {
  it('テストの「今」が日本時間 2027-03-10 10:00 になっている（/api/days の today・now）', async () => {
    const d = await (await api('/api/days')).json();
    expect(d.today).toBe(TODAY);
    expect(d.now).toBe('10:00');
    expect(d.open).toBe(true);
  });
});

describe('営業日', () => {
  it('営業時間のない日は予約できない（400）。入れると予約できる', async () => {
    expect((await book(FAR, '10:00', M_SLOT.name)).status).toBe(400);
    expect((await (await book(FAR, '10:00', M_SLOT.name)).json()).error).toMatch(/営業していません/);
    await setHours(FAR, '10:00', '18:00');
    expect((await book(FAR, '10:00', M_SLOT.name)).status).toBe(200);
  });
  it('営業時間の外は予約できない', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await book(FAR, '09:30', M_SLOT.name)).status).toBe(400);
  });
  it('開始時間はきざみ（stepMin）に合っていないと 400', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await book(FAR, t2(m2('10:00') + Math.floor(STEP / 2)), M_SLOT.name)).status).toBe(400);
  });
});

describe('枠の長さ（前の時間・施術・後の時間）', () => {
  it(`slot のないメニューは 前${PRE}分＋施術＋後${BUF}分 ぶん枠をふさぐ`, async () => {
    await setHours(FAR, '10:00', '18:00');
    const r = await (await book(FAR, '10:00', M_PLAIN.name)).json();
    expect(r.ok).toBe(true);
    expect(r.s).toBe('10:00');
    expect(r.e).toBe(t2(m2('10:00') + PRE + +M_PLAIN.min + BUF));   // 例：10:00〜11:20
    const bl = await blocksOf(FAR);
    expect(bl).toHaveLength(1);
    expect(bl[0].e).toBe(r.e);
    expect(bl[0].kind).toBe('net');
  });
  it('slot のあるメニューは slot ぶん枠をふさぐ（施術の分より長い）', async () => {
    await setHours(FAR, '10:00', '18:00');
    const r = await (await book(FAR, '10:00', M_SLOT.name)).json();
    expect(r.slot).toBe(+M_SLOT.slot);
    expect(r.e).toBe(t2(m2('10:00') + +M_SLOT.slot));
    expect(+M_SLOT.slot).toBeGreaterThan(+M_SLOT.min);
  });
  it('前の予約の枠（後の時間を含む）に重なる開始時間は 409、重ならなければ 200', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await book(FAR, '10:00', M_PLAIN.name)).status).toBe(200);   // 10:00〜11:20
    const end = m2('10:00') + PRE + +M_PLAIN.min + BUF;
    const inside = t2(Math.floor((end - 1) / STEP) * STEP);              // 枠の終わりの直前のきざみ（例 11:00）→ 重なる
    const after = t2(Math.ceil(end / STEP) * STEP);                      // 枠の終わりの次のきざみ（例 11:30）→ 空いている
    expect((await book(FAR, inside, M_SLOT.name)).status).toBe(409);
    expect((await book(FAR, after, M_SLOT.name)).status).toBe(200);
  });
});

describe('長いメニューは開始時間が絞られる', () => {
  it('枠が営業時間の終わりを越える開始時間は 400、収まる開始時間は 200', async () => {
    await setHours(FAR, '10:00', '18:00');
    const slot = slotOf(M_LONG);
    const lastOk = t2(Math.floor((m2('18:00') - slot - m2('10:00')) / STEP) * STEP + m2('10:00'));   // 収まる最後のきざみ
    const tooLate = t2(m2(lastOk) + STEP);
    expect((await book(FAR, tooLate, M_LONG.name)).status).toBe(400);
    expect((await (await book(FAR, tooLate, M_LONG.name)).json()).error).toMatch(/営業時間の外/);
    expect((await book(FAR, lastOk, M_LONG.name)).status).toBe(200);
  });
  it('短いメニューなら、長いメニューで入らなかった開始時間にも入る', async () => {
    await setHours(FAR, '10:00', '18:00');
    const slotLong = slotOf(M_LONG), slotShort = slotOf(M_SLOT);
    expect(slotShort).toBeLessThan(slotLong);
    const t = t2(m2('18:00') - slotShort);                               // 短いメニューがぎりぎり入る開始時間
    expect((await book(FAR2, t, M_SLOT.name)).status).toBe(400);         // 営業時間がない日は 400（前提）
    await setHours(FAR2, '10:00', '18:00');
    expect((await book(FAR2, t, M_LONG.name)).status).toBe(400);
    expect((await book(FAR2, t, M_SLOT.name)).status).toBe(200);
  });
});

describe('予約停止（お店の画面で入れた時間）', () => {
  it('停止の時間と重なる開始時間は 409。停止の中身（kind）はお客さん向けの /api/days に出ない', async () => {
    await setHours(FAR, '10:00', '18:00');
    const r = await admin('POST', 'block', { date: FAR, s: '13:00', e: '14:00', kind: 'stop' });
    expect(r.status).toBe(200);
    expect((await book(FAR, '13:00', M_SLOT.name)).status).toBe(409);
    expect((await book(FAR, t2(m2('13:00') - STEP), M_SLOT.name)).status).toBe(409);   // 12:30〜13:30 も重なる
    expect((await book(FAR, '14:00', M_SLOT.name)).status).toBe(200);
    const d = await (await api('/api/days')).json();
    const busy = d.busy[FAR];
    expect(busy.some((b) => b.s === '13:00' && b.e === '14:00')).toBe(true);
    expect(busy.every((b) => b.kind === 'busy' && !('menu' in b) && !('id' in b))).toBe(true);
    // menus（メニューの name）と案内文は 2026/10/26 から返すので除いて見る。残り（hours・busy など）に予約の中身や名前の欄がないこと
    const { menus, otherMenusNote, taxNote, ...rest } = d;
    expect(JSON.stringify(rest)).not.toMatch(/stop|man|net|テスト 太郎|090-0000-0000|test@example.com|name|tel|email/);
  });
});

describe('当日の締切', () => {
  it(`今（10:00）から ${CUTOFF} 分より前の開始時間は 400、それ以降は 200`, async () => {
    await setHours(TODAY, '10:00', '22:00');
    const limit = m2('10:00') + CUTOFF;
    const before = t2(Math.floor((limit - 1) / STEP) * STEP);
    const okTime = t2(Math.ceil(limit / STEP) * STEP);
    const r1 = await book(TODAY, before, M_SLOT.name);
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toMatch(/当日は/);
    expect((await book(TODAY, okTime, M_SLOT.name)).status).toBe(200);
  });
  it('過ぎた日は 400', async () => {
    expect((await book('2027-03-09', '10:00', M_SLOT.name)).status).toBe(400);
  });
});

describe('二重予約', () => {
  it('同じ時間に 2 件目を順に送ると 409、枠は 1 つだけ', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await book(FAR, '11:00', M_SLOT.name)).status).toBe(200);
    const r = await book(FAR, '11:00', M_SLOT.name);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/ほかの方の予約/);
    expect(await blocksOf(FAR)).toHaveLength(1);
  });
  it('同じ時間に 2 件を同時に送っても、200 と 409 が 1 つずつで、枠は 1 つだけ', async () => {
    await setHours(FAR, '10:00', '18:00');
    const [a, b] = await Promise.all([book(FAR, '15:00', M_SLOT.name), book(FAR, '15:00', M_SLOT.name)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await blocksOf(FAR)).toHaveLength(1);
  });
  it('お店の画面から入れる予約（LINE・電話）も、ネット予約と重なれば 409', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await book(FAR, '11:00', M_SLOT.name)).status).toBe(200);
    const r = await admin('POST', 'block', { date: FAR, s: '11:30', e: '12:00', menu: '電話' });
    expect(r.status).toBe(409);
  });
});

describe('入力の確かめ', () => {
  it('名前・電話・メールが足りなければ 400（枠は取らない）', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await book(FAR, '10:00', M_SLOT.name, { name: '' })).status).toBe(400);
    expect((await book(FAR, '10:00', M_SLOT.name, { tel: '12' })).status).toBe(400);
    expect((await book(FAR, '10:00', M_SLOT.name, { email: 'x' })).status).toBe(400);
    expect((await book(FAR, '10:00', 'ないメニュー')).status).toBe(400);
    expect(await blocksOf(FAR)).toHaveLength(0);
  });
  it('お店の画面の API は合言葉がないと 401', async () => {
    expect((await api('/api/admin/all')).status).toBe(401);
  });
});

describe('名前・電話・メール（お店の画面用。2026/10/25）', () => {
  it('ネット予約の名前・電話・メールは保存され、お店の画面の API（合言葉つき）に出る', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await book(FAR, '10:00', M_SLOT.name)).status).toBe(200);
    const bl = await blocksOf(FAR);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toMatchObject({ kind: 'net', name: 'テスト 太郎', tel: '090-0000-0000', email: 'test@example.com' });
  });
  it('お客さん向けの /api/days には、名前・電話・メールもその欄の名前も絶対に出ない', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await book(FAR, '10:00', M_SLOT.name)).status).toBe(200);
    const { menus, otherMenusNote, taxNote, ...rest } = await (await api('/api/days')).json();   // menus のメニュー名は除いて見る（2026/10/26）
    const text = JSON.stringify(rest);
    expect(text).not.toMatch(/テスト 太郎|090-0000-0000|test@example\.com|"name"|"tel"|"email"|"menu"|"id"/);
    expect(JSON.stringify(menus)).not.toMatch(/テスト 太郎|090-0000-0000|test@example\.com|"tel"|"email"|"id"/);
  });
  it('お店の画面の API は合言葉がないと 401（all・block）。間違った合言葉も 401', async () => {
    expect((await api('/api/admin/all')).status).toBe(401);
    expect((await post('/api/admin/block', { date: FAR, s: '10:00', e: '11:00' })).status).toBe(401);
    expect((await api('/api/admin/all', { headers: { 'X-Admin-Password': 'wrong' } })).status).toBe(401);
  });
  it('来店日の翌日（日本時間）になると、名前・電話・メールは空になる（枠の記録は残る）', async () => {
    await setHours(TODAY, '10:00', '22:00');
    expect((await book(TODAY, '14:00', M_SLOT.name)).status).toBe(200);
    expect((await blocksOf(TODAY))[0].name).toBe('テスト 太郎');
    // 日本時間の翌日 0:05 に進める（UTC では前日 15:05）
    vi.setSystemTime(new Date('2027-03-10T15:05:00Z'));
    await api('/api/days');                               // お客さん側のアクセスでも消える
    // 翌日には、名前・電話・メールがどこにも残らない。
    // 本番（demo:false）は forgetOld が行を残して 3 つの欄を空にする。デモ（demo:true）はそのあと demoPrepare が過ぎた日の行ごと消す（前からの仕組み）
    const all = await (await admin('GET', 'all')).json();
    expect(JSON.stringify(all)).not.toMatch(/テスト 太郎|090-0000-0000|test@example\.com/);
    const bl = all.blocks.filter((b) => b.date === TODAY);
    bl.forEach((b) => expect(b).toMatchObject({ name: '', tel: '', email: '' }));
    // forgetOld そのもの（本番の道）：過ぎた日の行に直接 名前を入れ、forgetOld を通すと 3 つの欄が空になり、行は残る
    await env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email) VALUES ('t1', '2027-03-09', '10:00', '11:00', 'net', 'm', '2027-03-09T00:00:00Z', 'テスト 太郎', '090-0000-0000', 'test@example.com')").run();
    await forgetOld(env.DB, '2027-03-11');
    const row = await env.DB.prepare("SELECT * FROM blocks WHERE id = 't1'").first();
    expect(row).toMatchObject({ s: '10:00', name: '', tel: '', email: '' });
  });
  it('当日のうちは消えない', async () => {
    await setHours(TODAY, '10:00', '22:00');
    expect((await book(TODAY, '14:00', M_SLOT.name)).status).toBe(200);
    vi.setSystemTime(new Date('2027-03-10T14:50:00Z'));   // 日本時間 23:50（まだ当日）
    await api('/api/days');
    expect((await blocksOf(TODAY))[0].name).toBe('テスト 太郎');
  });
  it('LINE・電話で受けた予約の手入力は、名前だけ任意で入る。電話・メールは送っても持たない。予約停止には名前が付かない', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await admin('POST', 'block', { date: FAR, s: '10:00', e: '11:00', menu: '電話', name: ' 山田 花子 ', tel: '090-1111-1111', email: 'x@example.com' })).status).toBe(200);
    expect((await admin('POST', 'block', { date: FAR, s: '12:00', e: '13:00', menu: '電話' })).status).toBe(200);
    expect((await admin('POST', 'block', { date: FAR, s: '15:00', e: '16:00', kind: 'stop', name: '止め' })).status).toBe(200);
    const bl = await blocksOf(FAR);
    expect(bl.find((b) => b.s === '10:00')).toMatchObject({ kind: 'man', name: '山田 花子', tel: '', email: '' });
    expect(bl.find((b) => b.s === '12:00')).toMatchObject({ kind: 'man', name: '' });
    expect(bl.find((b) => b.s === '15:00')).toMatchObject({ kind: 'stop', name: '' });
  });
});

describe('守り（2026/10/25 夜）', () => {
  it('列を足す migrate を同時に 2 回走らせても両方成功する（duplicate column は握りつぶす）', async () => {
    // いちど列を落として、足す前の状態にする
    await env.DB.batch(['name', 'tel', 'email'].map((c) => env.DB.prepare('ALTER TABLE blocks DROP COLUMN ' + c)));
    const cols0 = (await env.DB.prepare('PRAGMA table_info(blocks)').all()).results.map((c) => c.name);
    expect(cols0).not.toContain('name');
    await expect(Promise.all([migrate(env.DB), migrate(env.DB)])).resolves.toHaveLength(2);
    const cols = (await env.DB.prepare('PRAGMA table_info(blocks)').all()).results.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['name', 'tel', 'email']));
    // もう一度走らせても何も起きない
    await expect(migrate(env.DB)).resolves.toBeUndefined();
  });
  it('メールに ? & = , ; < > が入っていると 400（mailto: に宛先以外の指定が混ざるのを防ぐ）', async () => {
    await setHours(FAR, '10:00', '18:00');
    for (const bad of ['a@b.com?cc=x@y.com', 'a@b.com&bcc=x@y.com', 'a@b.com,c@d.com', 'a@b.com;c@d.com', '<a@b.com>', 'a=b@c.com']) {
      const r = await book(FAR, '10:00', M_SLOT.name, { email: bad });
      expect(r.status, bad).toBe(400);
    }
    expect(await blocksOf(FAR)).toHaveLength(0);
    expect((await book(FAR, '10:00', M_SLOT.name, { email: 'ok.name+tag@example.co.jp' })).status).toBe(200);
  });
});

describe('合言葉の連続ミス（同じ接続元から 5 回で 10 分止める。2026/10/25）', () => {
  const LOCK_MSG = 'しばらくしてからお試しください';
  const tryPw = (pw, ip) => api('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Admin-Password': pw, 'CF-Connecting-IP': ip || '203.0.113.1' }, body: '{}' });
  const rows = async () => (await env.DB.prepare('SELECT ip, n, until FROM auth_fail').all()).results;
  it('4 回目までは 401、5 回目で 429 になり、以後は正しい合言葉でも 429。文言は 1 つだけで残り時間は出さない', async () => {
    for (let i = 0; i < 4; i++) expect((await tryPw('wrong')).status).toBe(401);
    const r5 = await tryPw('wrong');
    expect(r5.status).toBe(429);
    expect(await r5.json()).toEqual({ error: LOCK_MSG });
    expect(r5.headers.get('retry-after')).toBeNull();
    const ok = await tryPw(ADMIN);
    expect(ok.status).toBe(429);
    expect(await ok.json()).toEqual({ error: LOCK_MSG });
    expect((await tryPw('wrong')).status).toBe(429);
  });
  it('同時に 10 回間違えても、通る（401 で試せる）のは 4 回まで。あとは 429 で、正しい合言葉も止まる', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => tryPw('wrong')));
    const codes = rs.map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(4);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(6);
    expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
    expect((await tryPw(ADMIN)).status).toBe(429);
    // 加算は 1 つの命令なので同時でも数が飛ばない。止まったあとの分は、先に止めが効けば加算せず 429 で返る（CI のように直列に近いと 6、同時だと 10）。守るのは「5 以上で止まる」こと
    const n = (await rows())[0].n;
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(10);
  });
  it('10 分たつと解除され、正しい合言葉で入れる。そのあとの間違いは 1 から数え直す', async () => {
    for (let i = 0; i < 5; i++) await tryPw('wrong');
    vi.setSystemTime(new Date(new Date(NOW_UTC).getTime() + 9 * 60000));
    expect((await tryPw(ADMIN)).status).toBe(429);   // 9 分ではまだ
    vi.setSystemTime(new Date(new Date(NOW_UTC).getTime() + 10 * 60000 + 1000));
    expect((await tryPw(ADMIN)).status).toBe(200);
    expect(await rows()).toHaveLength(0);           // 正解で 0 に（行が消える）
    for (let i = 0; i < 5; i++) await tryPw('wrong');
    vi.setSystemTime(new Date(new Date(NOW_UTC).getTime() + 21 * 60000));
    expect((await tryPw('wrong')).status).toBe(401);   // 止めが切れたあとの間違いは 1 回目
    expect((await rows())[0].n).toBe(1);
  });
  it('別の接続元（IP）には影響しない', async () => {
    for (let i = 0; i < 5; i++) await tryPw('wrong', '203.0.113.1');
    expect((await tryPw(ADMIN, '203.0.113.1')).status).toBe(429);
    expect((await tryPw(ADMIN, '198.51.100.7')).status).toBe(200);
    expect((await tryPw('wrong', '198.51.100.7')).status).toBe(401);
  });
  it('正しい合言葉で入れたら回数は 0 に戻る（4 回間違え → 正解 → また 4 回間違えても 401 のまま）', async () => {
    for (let i = 0; i < 4; i++) await tryPw('wrong');
    expect((await rows())[0].n).toBe(4);
    expect((await tryPw(ADMIN)).status).toBe(200);
    expect(await rows()).toHaveLength(0);
    for (let i = 0; i < 4; i++) expect((await tryPw('wrong')).status).toBe(401);
    expect((await tryPw('wrong')).status).toBe(429);
  });
  it('IP の記録は翌日（日本時間）に消える。お客さん向け /api/days にも出ない', async () => {
    for (let i = 0; i < 2; i++) await tryPw('wrong');
    expect(await rows()).toHaveLength(1);
    const days = await (await api('/api/days')).text();
    expect(days).not.toMatch(/203\.0\.113|auth_fail/);
    vi.setSystemTime(new Date('2027-03-10T15:05:00Z'));   // 日本時間の翌日 0:05
    await api('/api/days');
    expect(await rows()).toHaveLength(0);
  });
});

describe('テストから本物の GAS に届かない（2026/10/25）', () => {
  it('GAS の URL はテスト値で、Worker の送信（sendGas）は偽物の fetch が受け止めて成功を返す', async () => {
    expect(env.GAS_URL).toBe('https://gas.test/exec');
    expect(env.GAS_TOKEN).toBe('test-gas-token');
    const ok = await sendGas(env, { token: env.GAS_TOKEN, customer: { name: 'テスト' }, booking: {}, shop: {} });
    expect(ok).toBe(true);
    expect(gasCalls).toHaveLength(1);
    expect(gasCalls[0].token).toBe('test-gas-token');
  });
  it('本物らしい URL（script.google.com）へは送れず、失敗（false）になる', async () => {
    const ok = await sendGas({ ...env, GAS_URL: 'https://script.google.com/macros/s/xxxx/exec' }, { token: 'x' });
    expect(ok).toBe(false);
    expect(gasCalls).toHaveLength(0);
  });
});

describe('HP から空きを読む（CORS と menus。2026/10/26）', () => {
  const OK_ORIGIN = (SHOP.allowOrigins || [])[0];
  const NG_ORIGIN = 'https://evil.example';
  const days = (origin) => api('/api/days', origin ? { headers: { Origin: origin } } : undefined);
  it('shop.jsonc の allowOrigins に 1 つ以上ある（このテストの前提）', () => {
    expect(OK_ORIGIN).toMatch(/^https:\/\//);
    expect(SHOP.allowOrigins).not.toContain('*');
  });
  it('許可した Origin からの /api/days には、その Origin だけの CORS ヘッダと Vary: Origin が付く（一覧の全部で。本番と確認用の両方を入れたときも）', async () => {
    for (const o of SHOP.allowOrigins) {
      const r = await days(o);
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe(o);
      expect(r.headers.get('vary')).toBe('Origin');
      const b = await post('/api/book', {}, { Origin: o });   // /api/book も同じ一覧
      expect(b.headers.get('access-control-allow-origin')).toBe(o);
    }
    // 似ているが一覧にない Origin（http・末尾スラッシュ・別のサブドメイン）には付かない
    for (const o of ['http://colore-yomogi.com', 'https://www.colore-yomogi.com', 'https://colore-yomogi.com.evil.example', OK_ORIGIN + '/']) {
      expect((await days(o)).headers.get('access-control-allow-origin')).toBeNull();
    }
  });
  it('許可していない Origin・Origin なしには CORS ヘッダが付かない（* も出ない）', async () => {
    expect((await days(NG_ORIGIN)).headers.get('access-control-allow-origin')).toBeNull();
    expect((await days()).headers.get('access-control-allow-origin')).toBeNull();
  });
  it('/api/admin には、許可した Origin でも CORS ヘッダが付かない（/api/book は 2026/10/26 から付く。下の組で確かめる）', async () => {
    const a = await api('/api/admin/all', { headers: { Origin: OK_ORIGIN, 'X-Admin-Password': ADMIN } });
    expect(a.status).toBe(200);
    expect(a.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('返事に menus（name・min・price・slot だけ）・otherMenusNote・taxNote があり、設定の秘密（mail・合言葉・allowOrigins）や名前・電話・メールは入らない', async () => {
    const d = await (await days(OK_ORIGIN)).json();
    expect(d.menus.length).toBe(SHOP.menus.length);
    d.menus.forEach((m, i) => {
      expect(Object.keys(m).sort()).toEqual(['min', 'name', 'price', 'slot']);
      expect(m.name).toBe(SHOP.menus[i].name);
      expect(m.min).toBe(+SHOP.menus[i].min);
      expect(m.slot).toBe(+SHOP.menus[i].slot || 0);
    });
    expect(d.otherMenusNote).toBe(SHOP.otherMenusNote || '');
    expect(d.taxNote).toBe(SHOP.taxNote || '');
    const text = JSON.stringify(d);
    for (const k of ['mail', 'demoPassword', 'allowOrigins', 'password', 'token', 'GAS', 'name"', 'tel"', 'email', 'phone', 'address', 'lineUrl', 'cancelPolicy']) {
      if (k === 'name"') expect(text.split('"name"').length - 1).toBe(SHOP.menus.length);   // "name" はメニューの名前の分だけ
      else expect(text).not.toContain(k);
    }
    if (SHOP.mail) expect(text).not.toContain(SHOP.mail);
  });
  it('お店の画面で手入力した予約（LINE・電話）も、/api/days の busy に入る（中身は時間だけ）', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await admin('POST', 'block', { date: FAR, s: '13:00', e: '14:00', menu: '電話', name: '山田 花子' })).status).toBe(200);
    const d = await (await days(OK_ORIGIN)).json();
    expect(d.busy[FAR]).toEqual([{ s: '13:00', e: '14:00', kind: 'busy' }]);
    expect(JSON.stringify(d)).not.toContain('山田');
  });
});

describe('HP から予約を送る（/api/book の CORS と事前確認。2026/10/26）', () => {
  const OK_ORIGIN = (SHOP.allowOrigins || [])[0];
  const NG_ORIGIN = 'https://evil.example';
  const bookFrom = (origin, body) => post('/api/book', body, origin ? { Origin: origin } : {});
  const good = { date: FAR, start: '10:00', menu: M_SLOT.name, name: 'HP 花子', tel: '090-0000-0000', email: 'hp@example.com' };
  const options = (path, origin) => api(path, { method: 'OPTIONS', headers: origin ? { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } : {} });
  it('許可した Origin からの予約は 200 で CORS ヘッダ付き。台帳に入り、/api/days には名前・電話・メールが出ない', async () => {
    await setHours(FAR, '10:00', '18:00');
    const r = await bookFrom(OK_ORIGIN, good);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(OK_ORIGIN);
    expect(r.headers.get('vary')).toBe('Origin');
    const rows = await blocksOf(FAR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'net', name: 'HP 花子', tel: '090-0000-0000', email: 'hp@example.com' });
    const d = await (await api('/api/days', { headers: { Origin: OK_ORIGIN } })).json();
    expect(d.busy[FAR]).toEqual([{ s: '10:00', e: t2(m2('10:00') + slotOf(M_SLOT)), kind: 'busy' }]);
    expect(JSON.stringify(d)).not.toMatch(/HP 花子|090-0000-0000|hp@example\.com/);
  });
  it('失敗の返事（409 の二重予約・400 の入力不足）にも CORS ヘッダが付く（HP 側が文を読めるように）', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await bookFrom(OK_ORIGIN, good)).status).toBe(200);
    const dup = await bookFrom(OK_ORIGIN, good);
    expect(dup.status).toBe(409);
    expect(dup.headers.get('access-control-allow-origin')).toBe(OK_ORIGIN);
    expect((await dup.json()).error).toMatch(/たった今/);
    const bad = await bookFrom(OK_ORIGIN, { ...good, start: '14:00', email: 'a@b.com?cc=x@y.com' });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('access-control-allow-origin')).toBe(OK_ORIGIN);
    expect(await blocksOf(FAR)).toHaveLength(1);
  });
  it('許可していない Origin・Origin なしの予約には CORS ヘッダが付かない（* も出ない）', async () => {
    await setHours(FAR, '10:00', '18:00');
    const a = await bookFrom(NG_ORIGIN, good);
    expect(a.status).toBe(200);
    expect(a.headers.get('access-control-allow-origin')).toBeNull();
    const b = await bookFrom(null, { ...good, start: '14:00' });
    expect(b.status).toBe(200);
    expect(b.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('事前確認（OPTIONS /api/book）：許可した Origin には 204＋POST・content-type・max-age 600。許可していない Origin には CORS ヘッダなし', async () => {
    const ok = await options('/api/book', OK_ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(OK_ORIGIN);
    expect(ok.headers.get('access-control-allow-methods')).toBe('POST');
    expect(ok.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(ok.headers.get('access-control-max-age')).toBe('600');
    const ng = await options('/api/book', NG_ORIGIN);
    expect(ng.headers.get('access-control-allow-origin')).toBeNull();
    expect(ng.headers.get('access-control-allow-methods')).toBeNull();
    const none = await options('/api/book');
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('/api/admin には付かず、OPTIONS にも答えない', async () => {
    const r = await api('/api/admin/all', { headers: { Origin: OK_ORIGIN, 'X-Admin-Password': ADMIN } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const o = await options('/api/admin/all', OK_ORIGIN);
    expect(o.status).not.toBe(204);
    expect(o.headers.get('access-control-allow-origin')).toBeNull();
    expect(o.headers.get('access-control-allow-methods')).toBeNull();
  });
});

describe('いたずら対策（A：同じ IP は 10 分に 5 回・B\'：同じ電話／メールの未来の予約は 3 件。2026/10/26）', () => {
  const OK_ORIGIN = (SHOP.allowOrigins || [])[0];
  const IS_DEMO = SHOP.demo === true;
  const IP1 = '203.0.113.10', IP2 = '198.51.100.20';
  const chk = (o) => limitCheck(env.DB, { demo: false, ip: '', tel: '', email: '', today: TODAY, ...o });
  const bookIp = (ip, extra, origin) => post('/api/book', { date: FAR, start: '10:00', menu: M_SLOT.name, name: 'テスト', tel: '090-0000-0000', email: 'test@example.com', ...(extra || {}) }, { 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) });
  it('A：同じ IP は 5 回まで。6 回目は 429。別の IP は通る。IP が無いときは数えない', async () => {
    for (let i = 0; i < 5; i++) expect(await chk({ ip: IP1 })).toBeNull();
    expect(await chk({ ip: IP1 })).toMatchObject({ status: 429, error: expect.stringMatching(/しばらく/) });
    expect(await chk({ ip: IP2 })).toBeNull();
    for (let i = 0; i < 8; i++) expect(await chk({ ip: '' })).toBeNull();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM book_rate').first()).n).toBe(6);   // IP なしの分は記録しない
  });
  it('A：10 分たつと戻る。古い記録はアクセスのたびに消える（IP を残さない）', async () => {
    for (let i = 0; i < 5; i++) await chk({ ip: IP1 });
    expect(await chk({ ip: IP1 })).toMatchObject({ status: 429 });
    vi.setSystemTime(new Date(new Date(NOW_UTC).getTime() + 10 * 60000 + 1000));
    expect(await chk({ ip: IP1 })).toBeNull();
    await forgetOld(env.DB, TODAY);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM book_rate').first()).n).toBe(1);   // 10 分より前の 5 件は消え、いまの 1 件だけ
  });
  it('B\'：同じ電話（ハイフン違い）・同じメール（大文字小文字違い）の未来のネット予約が 3 件あれば 429。別の電話は通る。手入力・過ぎた予約は数えない', async () => {
    await setHours(FAR, '10:00', '18:00'); await setHours(FAR2, '10:00', '18:00');
    // ネット予約を 3 件（SELF から。デモでないときは B' も通る＝3 件目までは入る）
    expect((await book(FAR, '10:00', M_PLAIN.name, { tel: '090-1234-5678', email: 'Hana@Example.com' })).status).toBe(200);
    expect((await book(FAR, '14:00', M_PLAIN.name, { tel: '09012345678', email: 'other1@example.com' })).status).toBe(200);
    expect((await book(FAR2, '10:00', M_PLAIN.name, { tel: '080-0000-0000', email: 'hana@example.com' })).status).toBe(200);
    // 手入力（kind man）と、過ぎた日のネット予約は数えない
    expect((await admin('POST', 'block', { date: FAR2, s: '14:00', e: '15:00', menu: '電話', name: '花子' })).status).toBe(200);
    await env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email) VALUES ('old1', '2027-03-01', '10:00', '11:00', 'net', 'x', '', '花子', '090-1234-5678', 'hana@example.com')").run();
    // 電話はハイフンなし・メールは大文字で照合 → 3 件（#1 電話・#2 電話・#3 メール）に当たる
    expect(await chk({ tel: '09012345678', email: 'HANA@EXAMPLE.COM' })).toMatchObject({ status: 429, error: expect.stringMatching(/3 件まで/) });
    // 電話だけ同じ（メールは別）なら 2 件（#1・#2）なので通る。別の電話・メールも通る
    expect(await chk({ tel: '090-1234-5678', email: 'nobody@example.com' })).toBeNull();
    expect(await chk({ tel: '070-0000-0000', email: 'nobody@example.com' })).toBeNull();
  });
  it.skipIf(IS_DEMO)('本番の作り：同じ IP の 6 回目は 429 で CORS 付き。400 の入力は数えない。同じ電話の 4 件目は 429', async () => {
    await setHours(FAR, '10:00', '18:00'); await setHours(FAR2, '10:00', '18:00');
    for (let i = 0; i < 3; i++) expect((await bookIp(IP1, { start: '09:00' })).status).toBe(400);   // 営業時間の外＝入力の確かめで落ちる。数えない
    const starts = ['10:00', '11:00', '12:00', '13:00', '14:00'];
    for (let i = 0; i < 5; i++) {
      const r = await bookIp(IP1, { start: starts[i], email: 'ip' + i + '@example.com', tel: '090-1111-000' + i }, OK_ORIGIN);
      expect([200, 409]).toContain(r.status);
    }
    const six = await bookIp(IP1, { start: '15:00', email: 'ip6@example.com', tel: '090-1111-0006' }, OK_ORIGIN);
    expect(six.status).toBe(429);
    expect(six.headers.get('access-control-allow-origin')).toBe(OK_ORIGIN);
    expect((await six.json()).error).toMatch(/しばらく/);
    // 同じ電話で 4 件目（別の IP から）
    expect((await bookIp(IP2, { date: FAR2, start: '10:00', tel: '090-2222-0000', email: 'a@example.com' })).status).toBe(200);
    expect((await bookIp(IP2, { date: FAR2, start: '12:00', tel: '09022220000', email: 'b@example.com' })).status).toBe(200);
    expect((await bookIp(IP2, { date: FAR2, start: '14:00', tel: '090-2222-0000', email: 'c@example.com' })).status).toBe(200);
    const four = await bookIp(IP2, { date: FAR2, start: '16:00', tel: '090-2222-0000', email: 'd@example.com' }, OK_ORIGIN);
    expect(four.status).toBe(429);
    expect(four.headers.get('access-control-allow-origin')).toBe(OK_ORIGIN);
    expect((await four.json()).error).toMatch(/3 件まで/);
  });
  it.skipIf(!IS_DEMO)('デモでは制限が働かない（同じ IP から 6 回でも 429 にならない）', async () => {
    await setHours(FAR, '10:00', '18:00');
    const starts = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
    for (let i = 0; i < 6; i++) expect([200, 409]).toContain((await bookIp(IP1, { start: starts[i] })).status);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM book_rate').first()).n).toBe(0);
  });
});

describe('別の目のレビューの直し（2026/10/26）', () => {
  const IS_DEMO = SHOP.demo === true;
  const OK_ORIGIN = (SHOP.allowOrigins || [])[0];
  const IP = '203.0.113.50';
  const tryPw = (pw, ip, method) => api('/api/admin/login', { method: method || 'POST', headers: { 'content-type': 'application/json', ...(pw === null ? {} : { 'X-Admin-Password': pw }), 'CF-Connecting-IP': ip || IP }, body: method === 'OPTIONS' ? undefined : '{}' });
  const bookIp = (ip, extra, origin) => post('/api/book', { date: FAR, start: '10:00', menu: M_SLOT.name, name: 'テスト', tel: '090-0000-0000', email: 'test@example.com', ...(extra || {}) }, { 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) });
  const nowIso = () => new Date().toISOString();
  it('高1：合言葉なしの送信や OPTIONS を何回しても、回数に数えない（お店を締め出せない）', async () => {
    for (let i = 0; i < 6; i++) expect((await tryPw(null)).status).toBe(401);
    for (let i = 0; i < 6; i++) expect((await tryPw(null, IP, 'OPTIONS')).status).not.toBe(204);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM auth_fail').first()).n).toBe(0);
    expect((await tryPw(ADMIN)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await tryPw('wrong')).status).toBe(401);   // 値があって違うときだけ数える
    expect((await tryPw('wrong')).status).toBe(429);
  });
  it('高2-A：同じ IP から 10 件を同時に送っても、通るのは 5 件まで（数えて入れるを 1 命令に）', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => limitCheck(env.DB, { demo: false, ip: IP, tel: '', email: '', today: TODAY })));
    const ok = rs.filter((r) => r === null).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(ok).toBeLessThanOrEqual(5);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM book_rate').first()).n).toBe(ok);
  });
  it("高2-B'：同じ電話で 8 件を同時に入れても、入るのは 3 件まで（枠を取る INSERT の条件に）", async () => {
    const mk = (i) => ({ id: 'c' + i, date: FAR, s: t2(m2('10:00') + i * 60), e: t2(m2('10:00') + i * 60 + 30), kind: 'net', menu: 'x', created_at: nowIso(), name: 'x', tel: '090-2222-3333', email: 'c' + i + '@example.com' });
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => insertNet(env.DB, mk(i), { demo: false, today: TODAY })));
    const ok = rs.filter((r) => r === null).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(ok).toBeLessThanOrEqual(3);
    expect(rs.filter((r) => r && r.status === 429 && /3 件まで/.test(r.error)).length).toBe(8 - ok);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM blocks WHERE kind = 'net'").first()).n).toBe(ok);
  });
  it.skipIf(IS_DEMO)('高2（本番の作り）：同じ IP の 10 件同時は 5 件まで、同じ電話の 8 件同時は 3 件まで。429 にも CORS', async () => {
    await setHours(FAR, '10:00', '20:00'); await setHours(FAR2, '10:00', '20:00');
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => bookIp(IP, { start: t2(m2('10:00') + i * 60), tel: '090-1111-' + (1000 + i), email: 'r2-' + i + '@example.com' }, OK_ORIGIN)));
    const ok = rs.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1); expect(ok).toBeLessThanOrEqual(5);
    expect(rs.every((r) => r.headers.get('access-control-allow-origin') === OK_ORIGIN)).toBe(true);
    const rs2 = await Promise.all(Array.from({ length: 8 }, (_, i) => bookIp('198.51.100.' + (10 + i), { date: FAR2, start: t2(m2('10:00') + i * 60), tel: '090-2222-3333', email: 'r3-' + i + '@example.com' })));
    const ok2 = rs2.filter((r) => r.status === 200).length;
    expect(ok2).toBeGreaterThanOrEqual(1); expect(ok2).toBeLessThanOrEqual(3);
  });
  it('中5：23:58 に 5 回間違えると、日付をまたいでも 10 分は解けない', async () => {
    vi.setSystemTime(new Date('2027-03-10T14:58:00Z'));   // 日本時間 23:58
    for (let i = 0; i < 5; i++) await tryPw('wrong');
    vi.setSystemTime(new Date('2027-03-10T15:01:00Z'));   // 翌日 0:01（掃除が走る）
    await api('/api/days');
    expect((await tryPw(ADMIN)).status).toBe(429);
    vi.setSystemTime(new Date('2027-03-10T15:09:00Z'));   // 0:09（10 分すぎ）
    expect((await tryPw(ADMIN)).status).toBe(200);
  });
  it('低6：date・name などが文字でないときは 400（内部のエラー文を返さない）', async () => {
    await setHours(TODAY, '10:00', '22:00');
    const r = await book(TODAY, '09:00', M_SLOT.name, { date: [TODAY] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('入力の形が違います');
    expect((await book(FAR, '10:00', M_SLOT.name, { name: 123 })).status).toBe(400);
    expect((await book(FAR, '10:00', M_SLOT.name, { email: { a: 1 } })).status).toBe(400);
  });
  it('上限：受けた日（日本時間）のネット予約が 20 件あれば 429。前日に受けた分は数えない', async () => {
    const chk = () => limitCheck(env.DB, { demo: false, ip: '', tel: '090-9999-0000', email: 'cap@example.com', today: TODAY });
    const stmts = [];
    for (let i = 0; i < 19; i++) stmts.push(env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email) VALUES (?1, ?2, '10:00', '11:00', 'net', 'x', ?3, 'x', ?4, ?5)").bind('d' + i, '2027-04-' + String(20 + (i % 9)).padStart(2, '0'), new Date().toISOString(), '080-0000-' + String(1000 + i), 'd' + i + '@example.com'));
    stmts.push(env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email) VALUES ('old', '2027-04-29', '10:00', '11:00', 'net', 'x', ?1, 'x', '080-0000-9999', 'old@example.com')").bind('2027-03-09T10:00:00.000Z'));   // 前日に受けた分
    stmts.push(env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at) VALUES ('man', '2027-04-29', '12:00', '13:00', 'man', 'x', ?1)").bind(new Date().toISOString()));   // 手入力は数えない
    await env.DB.batch(stmts);
    expect(await chk()).toBeNull();   // 今日のネット予約は 19 件
    await env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email) VALUES ('d19', '2027-04-29', '14:00', '15:00', 'net', 'x', ?1, 'x', '080-0000-1019', 'd19@example.com')").bind(new Date().toISOString()).run();
    expect(await chk()).toMatchObject({ status: 429, error: expect.stringMatching(/上限に達しました/) });
    const ins = await insertNet(env.DB, { id: 'x21', date: '2027-04-29', s: '16:00', e: '17:00', kind: 'net', menu: 'x', created_at: new Date().toISOString(), name: 'x', tel: '090-9999-0000', email: 'cap@example.com' }, { demo: false, today: TODAY });
    expect(ins).toMatchObject({ status: 429, error: expect.stringMatching(/上限に達しました/) });
  });
  it.skipIf(IS_DEMO)('メールが送れなくても予約は残る：GAS が受け取ったあと返事が届かない→200・mail:false・台帳に「メール未送」の印。お店の画面の API に出る', async () => {
    await setHours(FAR, '10:00', '18:00');
    gasMode = 'drop';
    const r = await book(FAR, '10:00', M_SLOT.name);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true); expect(j.mail).toBe(false); expect(j.note).toMatch(/LINE かお電話/);
    expect(gasCalls).toHaveLength(1);
    const rows = await blocksOf(FAR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'net', mailng: 1 });
    gasMode = 'fail';
    expect((await (await book(FAR, '14:00', M_SLOT.name, { tel: '090-1111-2222', email: 'b@example.com' })).json()).mail).toBe(false);
    gasMode = 'ok';
    const r3 = await (await book(FAR, '16:00', M_SLOT.name, { tel: '090-1111-3333', email: 'c@example.com' })).json();
    expect(r3.mail).toBe(true);
    const all = await blocksOf(FAR);
    expect(all.filter((b) => b.mailng === 1)).toHaveLength(2);
    expect(JSON.stringify(await (await api('/api/days')).json())).not.toMatch(/mailng|テスト 太郎/);
  });
});

describe('複数メニュー（menus＝名前の配列。2026/10/28）', () => {
  const IS_DEMO = SHOP.demo === true;
  const bookM = (date, start, names, extra) => post('/api/book', { date, start, menus: names, name: 'テスト 太郎', tel: '090-0000-0000', email: 'test@example.com', ...(extra || {}) });
  // 金額のメニュー 2 つ（slot のあるものと ないもの）と、金額でない（お問い合わせください）メニュー
  const M_ASK = SHOP.menus.find((m) => !/円$/.test(m.price || ''));
  const yenOf = (m) => +String(m.price).replace(/[^0-9]/g, '');
  const yen = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
  const PAIR = [M_SLOT.name, M_PLAIN.name];
  const PAIR_LEN = PRE + +M_SLOT.min + +M_PLAIN.min + BUF;   // 2 つ以上は slot を使わず 前＋施術の合計＋後
  it('このテストの前提：金額のメニューが 2 つ以上、金額でないメニューが 1 つ以上ある', () => {
    expect(/円$/.test(M_SLOT.price)).toBe(true); expect(/円$/.test(M_PLAIN.price)).toBe(true); expect(M_ASK).toBeTruthy();
  });
  it('2 つ選ぶと、枠は 前＋施術の合計＋後（slot は使わない）。返事に menus・施術の合計・合計の料金', async () => {
    await setHours(FAR, '10:00', '18:00');
    const r = await (await bookM(FAR, '10:00', PAIR)).json();
    expect(r.ok).toBe(true);
    expect(r.slot).toBe(PAIR_LEN);
    expect(r.e).toBe(t2(m2('10:00') + PAIR_LEN));
    expect(r.menus).toEqual(PAIR);
    expect(r.min).toBe(+M_SLOT.min + +M_PLAIN.min);
    expect(r.price).toBe(yen(yenOf(M_SLOT) + yenOf(M_PLAIN)));
    expect(PAIR_LEN).not.toBe(+M_SLOT.slot + PRE + +M_PLAIN.min + BUF);   // slot を足していない（例：10＋40＋60＋10＝120）
    const bl = await blocksOf(FAR);
    expect(bl).toHaveLength(1);
    expect(bl[0].e).toBe(r.e);
    expect(bl[0].menu).toBe(M_SLOT.name + '＋' + M_PLAIN.name);   // お店の画面の一覧には 2 つの名前が出る
  });
  it('menus に 1 つだけなら今までどおり（slot のあるメニューは slot が効く）', async () => {
    await setHours(FAR, '10:00', '18:00');
    const r = await (await bookM(FAR, '10:00', [M_SLOT.name])).json();
    expect(r.ok).toBe(true);
    expect(r.slot).toBe(+M_SLOT.slot);
    expect(r.e).toBe(t2(m2('10:00') + +M_SLOT.slot));
    expect(r.price).toBe(M_SLOT.price);
    expect(r.menus).toEqual([M_SLOT.name]);
  });
  it('menu（1 つ・前の形）も今までどおり通る。menu と menus の両方があれば menus を使う', async () => {
    await setHours(FAR, '10:00', '18:00');
    const r1 = await (await book(FAR, '10:00', M_PLAIN.name)).json();
    expect(r1.ok).toBe(true); expect(r1.slot).toBe(slotOf(M_PLAIN)); expect(r1.menus).toEqual([M_PLAIN.name]);
    await setHours(FAR2, '10:00', '18:00');
    const r2 = await (await book(FAR2, '10:00', M_PLAIN.name, { menus: PAIR })).json();
    expect(r2.ok).toBe(true); expect(r2.slot).toBe(PAIR_LEN); expect(r2.menus).toEqual(PAIR);
  });
  it('合計が営業時間の終わりを越える開始時間は 400、収まる開始時間は 200（1 つなら入る時間でも、2 つでは入らない）', async () => {
    const end = m2('10:00') + PAIR_LEN;   // 2 つの合計がちょうど収まる終わり
    await setHours(FAR, '10:00', t2(end - STEP));   // 終わりを 1 きざみ早く → 2 つでは収まらない
    expect((await bookM(FAR, '10:00', PAIR)).status).toBe(400);
    expect((await bookM(FAR, '10:00', [M_SLOT.name])).status).toBe(200);   // 1 つなら入る
    await setHours(FAR2, '10:00', t2(end));          // ちょうど収まる
    expect((await bookM(FAR2, '10:00', PAIR)).status).toBe(200);
    expect(await blocksOf(FAR)).toHaveLength(1);
  });
  it('二重予約：複数メニューの長い枠の中の時間は 409。順でも同時でも枠は 1 つだけ', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await bookM(FAR, '10:00', PAIR)).status).toBe(200);          // 10:00〜（PAIR_LEN 分）
    const end = m2('10:00') + PAIR_LEN;
    const inside = t2(Math.floor((end - 1) / STEP) * STEP);              // 枠の終わりの直前のきざみ → 重なる
    const after = t2(Math.ceil(end / STEP) * STEP);                      // 次のきざみ → 空いている
    expect((await book(FAR, inside, M_PLAIN.name)).status).toBe(409);
    expect((await bookM(FAR, inside, PAIR)).status).toBe(409);
    expect((await book(FAR, after, M_PLAIN.name)).status).toBe(200);
    // 同時に 2 件（別の日）：200 と 409 が 1 つずつ
    await setHours(FAR2, '10:00', '18:00');
    const rs = await Promise.all([bookM(FAR2, '10:00', PAIR, { tel: '090-1111-1111', email: 'a@example.com' }), bookM(FAR2, '10:30', PAIR, { tel: '090-2222-2222', email: 'b@example.com' })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await blocksOf(FAR2)).toHaveLength(1);
  });
  it('入力の確かめ：空の配列・存在しない名前・同じ名前 2 回・文字でない要素・配列でない menus・menu も menus もない は 400 で枠を取らない', async () => {
    await setHours(FAR, '10:00', '18:00');
    const bad = [[], ['ないメニュー'], [M_PLAIN.name, M_PLAIN.name], [M_PLAIN.name, 123], [null], 'もじ', { a: 1 }];
    for (const v of bad) expect((await bookM(FAR, '10:00', v)).status).toBe(400);
    expect((await post('/api/book', { date: FAR, start: '10:00', name: 'テスト 太郎', tel: '090-0000-0000', email: 'test@example.com' })).status).toBe(400);
    expect((await bookM(FAR, '10:00', SHOP.menus.map((m) => m.name).concat([M_PLAIN.name]))).status).toBe(400);   // 設定の数より多い
    expect(await blocksOf(FAR)).toHaveLength(0);
    // 設定にある全部を 1 回ずつなら通る（上限は設けない）
    await setHours(FAR2, '06:00', '23:00');
    const r = await (await bookM(FAR2, '10:00', SHOP.menus.map((m) => m.name))).json();
    expect(r.ok).toBe(true);
    expect(r.slot).toBe(PRE + SHOP.menus.reduce((a, m) => a + +m.min, 0) + BUF);
  });
  it('料金：1 つでも「お問い合わせください」のメニューが入ると、合計を出さずその文', async () => {
    await setHours(FAR, '10:00', '18:00');
    const r = await (await bookM(FAR, '10:00', [M_PLAIN.name, M_ASK.name])).json();
    expect(r.ok).toBe(true);
    expect(r.price).toBe('お問い合わせください');
    expect(/円/.test(r.price)).toBe(false);
    if (IS_DEMO) { expect(r.mailPreview).toContain('■ 料金　　お問い合わせください'); expect(r.mailPreview).not.toContain('合計 お問い合わせ'); }   // 「合計 お問い合わせください」にしない（レビュー 10/28）
  });
  it('料金の形（レビュー 10/28）：「5,500円〜」が混ざれば足して「〜」付き。金額でない文は、その文ではなく固定の「お問い合わせください」。shop.jsonc の price は決まった形だけ', () => {
    const m = (price) => ({ name: 'x', min: 10, price });
    expect(priceOf([m('5,500円'), m('3,300円')])).toBe('8,800円');
    expect(priceOf([m('5,500円〜'), m('3,300円')])).toBe('8,800円〜');
    expect(priceOf([m('5500円'), m('5,500 円')])).toBe('11,000円');
    expect(priceOf([m('5,500円'), m('時価')])).toBe('お問い合わせください');
    expect(priceOf([m('5,500円'), m('')])).toBe('お問い合わせください');
    expect(priceOf([m('999,999円'), m('1円')])).toBe('1,000,000円');
    expect(priceOf([m('5,500円（税込）')])).toBe('5,500円（税込）');   // 1 つのときはそのまま
    for (const x of SHOP.menus) expect(x.price === 'お問い合わせください' || /^[0-9,]+\s*円(〜)?$/.test(x.price)).toBe(true);   // 設定の形を縛る（他のお店に写したとき二度目を止める）
  });
  it('メール：お客さん宛・お店宛の元（GAS へ渡す booking）に全メニューが 1 つずつ・施術の合計・所要時間・合計の料金が入る。デモは見本の文に同じ内容', async () => {
    await setHours(FAR, '10:00', '18:00');
    const r = await (await bookM(FAR, '10:00', PAIR)).json();
    expect(r.ok).toBe(true);
    if (IS_DEMO) {
      expect(gasCalls).toHaveLength(0);
      expect(r.mailPreview).toContain('　・' + M_SLOT.name + '（' + M_SLOT.min + '分・' + M_SLOT.price + '）');
      expect(r.mailPreview).toContain('　・' + M_PLAIN.name + '（' + M_PLAIN.min + '分・' + M_PLAIN.price + '）');
      expect(r.mailPreview).toContain('■ 施術時間　合計' + (+M_SLOT.min + +M_PLAIN.min) + '分');
      expect(r.mailPreview).toContain('■ 所要時間　約' + PAIR_LEN + '分');
      expect(r.mailPreview).toContain('■ 料金　　合計 ' + yen(yenOf(M_SLOT) + yenOf(M_PLAIN)) + '（税込）');
    } else {
      expect(gasCalls).toHaveLength(1);
      const b = gasCalls[0].booking;
      expect(b.menu).toBe(M_SLOT.name + '＋' + M_PLAIN.name);
      expect(b.items).toEqual([{ name: M_SLOT.name, min: +M_SLOT.min, price: M_SLOT.price }, { name: M_PLAIN.name, min: +M_PLAIN.min, price: M_PLAIN.price }]);
      expect(b.min).toBe(+M_SLOT.min + +M_PLAIN.min);
      expect(b.slot).toBe(PAIR_LEN);
      expect(b.price).toBe(yen(yenOf(M_SLOT) + yenOf(M_PLAIN)));
      expect(b.end).toBe(t2(m2('10:00') + PAIR_LEN));
    }
  });
  it('お客さん向けの /api/days には、複数メニューでも名前・メニューは出ず、埋まっている時間だけ（長い枠で出る）', async () => {
    await setHours(FAR, '10:00', '18:00');
    expect((await bookM(FAR, '10:00', PAIR)).status).toBe(200);
    const d = await (await api('/api/days')).json();
    expect(d.busy[FAR]).toEqual([{ s: '10:00', e: t2(m2('10:00') + PAIR_LEN), kind: 'busy' }]);
    const text = JSON.stringify(d.busy);
    expect(text).not.toContain('テスト'); expect(text).not.toContain('example.com'); expect(text).not.toContain('＋');
  });
  it('いたずら対策（同じ電話・メールの未来のネット予約 3 件）は複数メニューでも同じに数える', async () => {
    if (IS_DEMO) return;   // デモでは制限が働かない（別のテストで確認済み）
    await setHours(FAR, '06:00', '23:00');
    expect((await bookM(FAR, '06:00', PAIR)).status).toBe(200);
    expect((await bookM(FAR, '10:00', PAIR)).status).toBe(200);
    expect((await bookM(FAR, '14:00', PAIR)).status).toBe(200);
    expect((await bookM(FAR, '18:00', PAIR)).status).toBe(429);
  });
});
