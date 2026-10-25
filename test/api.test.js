// 予約 API のテスト（2026/10/25）。本番と同じ Workers の実行環境（workerd）＋ D1 の中で、空きの計算と二重予約を守る
// 守ること：営業日／前10分・後10分（枠の長さ）／メニューの slot／長いメニューは開始時間が絞られる／予約停止は選べない／当日は締切前まで／きざみ／二重予約は 409／busy に中身を出さない
// お店の値（前後の分・きざみ・締切・メニュー）は public/shop.jsonc から読む（ここに数字を決め打ちしない）
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import shopText from '../public/shop.jsonc?raw';
import { forgetOld, migrate } from '../src/worker.js';

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

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_UTC));
  // テストごとに D1 をまっさらに（前のテストの予約・営業時間を持ちこさない）。表は最初の /api/days で作られる
  await api('/api/days');
  await env.DB.batch([env.DB.prepare('DELETE FROM blocks'), env.DB.prepare('DELETE FROM hours')]);
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
    expect(JSON.stringify(d)).not.toMatch(/stop|man|net|テスト 太郎|090-0000-0000|test@example.com|name|tel|email/);
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
    const text = JSON.stringify(await (await api('/api/days')).json());
    expect(text).not.toMatch(/テスト 太郎|090-0000-0000|test@example\.com|"name"|"tel"|"email"|"menu"|"id"/);
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
