// お客さん側の予約の取り消し（/api/cancel・/cancel?t=…・3 つの照合・期限・二重取り消し・GAS action: 'cancel'）のテスト（2026/10/30）。GAS は偽物の fetch が受け止める（本物には送らない）
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { buildBackup, forgetOld } from '../src/worker.js';
import shopText from '../public/shop.jsonc?raw';

const SHOP = JSON.parse(shopText.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^"\n]*$/gm, ''));
const IS_DEMO = SHOP.demo === true;
const CD = SHOP.cancelDeadlineDays === undefined ? 2 : +SHOP.cancelDeadlineDays;   // 取り消せるのは来店日の CD 日前まで
const ADMIN = 'test-admin-password';
const NOW_UTC = '2027-03-10T01:00:00Z';   // 日本時間 2027-03-10（水）10:00
const TODAY = '2027-03-10';
const addDays = (k, n) => { const d = new Date(k + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const jpDate = (k) => { const d = new Date(k + 'T00:00:00Z'); return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日（' + DOW[d.getUTCDay()] + '）'; };
const D = addDays(TODAY, CD);          // 期限の最後の日が「今日」になる来店日（今日の 23:59 までは取り消せる）
const LATE = addDays(TODAY, CD - 1);   // もう期限を過ぎている来店日（前日）
const M1 = SHOP.menus[0];
const NF = { error: 'ご予約が見つかりませんでした' };
const TEL = '090-0000-0000', MAIL = 'hana@example.com';

const api = (path, init) => SELF.fetch('https://x' + path, init);
const post = (path, body, headers) => api(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
const admin = (method, path, body) => api('/api/admin/' + path, { method, headers: { 'content-type': 'application/json', 'X-Admin-Password': ADMIN }, body: body ? JSON.stringify(body) : undefined });
const cancel = (body, headers) => post('/api/cancel', body, headers);
const setHours = async (date) => { expect((await admin('POST', 'hours', { date, s: '10:00', e: '18:00' })).status).toBe(200); };
const book = async (date, start, extra) => {
  const r = await post('/api/book', { date, start: start || '10:00', menu: M1.name, name: 'テスト 花子', tel: TEL, email: MAIL, ...(extra || {}) });
  expect(r.status).toBe(200);
  const j = await r.json();
  const row = await env.DB.prepare('SELECT cancel_token FROM blocks WHERE id = ?1').bind(j.id).first();
  return { id: j.id, token: row.cancel_token, body: j };
};
const tokenOf = async (id) => (await env.DB.prepare('SELECT cancel_token FROM blocks WHERE id = ?1').bind(id).first());
const blocksOf = async (date) => (await env.DB.prepare('SELECT id FROM blocks WHERE date = ?1').bind(date).all()).results;
const cancelsAll = async () => (await env.DB.prepare('SELECT * FROM cancels ORDER BY date, s').all()).results;

const gasCalls = [];
let gasMode = 'ok';
beforeAll(() => {
  vi.stubGlobal('fetch', async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === env.GAS_URL) {
      const d = JSON.parse(String(init && init.body || '{}'));
      gasCalls.push(d);
      if (gasMode === 'fail') return new Response('error', { status: 500 });
      if (gasMode === 'drop') throw new Error('network dropped');
      if (gasMode === 'old') {   // 旧版の GAS：action を見ない。トップに customer/booking/shop があれば予約確認メール 2 通を送って ok:true、なければ input エラー
        if (d.customer && d.booking && d.shop) return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ ok: false, error: 'input' }), { headers: { 'content-type': 'application/json' } });
      }
      if (gasMode === 'noaction') return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      if (d.action === 'cancel') return new Response(JSON.stringify(d.cancel && d.cancel.customer ? { ok: true, action: 'cancel' } : { ok: false, error: 'input' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error('テストからは外へ送らない: ' + url);
  });
});
beforeEach(async () => {
  gasCalls.length = 0; gasMode = 'ok';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_UTC));
  await api('/api/days');
  await env.DB.batch([env.DB.prepare('DELETE FROM blocks'), env.DB.prepare('DELETE FROM hours'), env.DB.prepare('DELETE FROM cancels'), env.DB.prepare('DELETE FROM auth_fail'), env.DB.prepare('DELETE FROM book_rate')]);
  await setHours(D); await setHours(LATE); await setHours(TODAY);
});

describe('お客さん側の予約の取り消し（2026/10/30）', () => {
  it('前提：shop.jsonc の cancelDeadlineDays は 1〜30 の整数（既定 2）。/api/days に cancelDeadlineDays が出る', async () => {
    expect(Number.isInteger(CD) && CD >= 1 && CD <= 30).toBe(true);
    expect((await (await api('/api/days')).json()).cancelDeadlineDays).toBe(CD);
  });

  it('予約すると、推測できない文字列（16 進 32 文字・毎回違う）が台帳に入る。予約の返事・/api/days・お店の画面の API には出ない', async () => {
    const a = await book(D, '10:00'), b = await book(D, '12:00', { tel: '090-1111-1111', email: 'b@example.com' });
    expect(a.token).toMatch(/^[0-9a-f]{32}$/); expect(b.token).toMatch(/^[0-9a-f]{32}$/); expect(a.token).not.toBe(b.token);
    expect(JSON.stringify({ ...a.body, mailPreview: '' })).not.toContain(a.token);   // デモの見本のメール（mailPreview）にはリンクとして入る。それ以外には出ない
    if (!IS_DEMO) expect(JSON.stringify(a.body)).not.toContain(a.token);
    expect(await (await api('/api/days')).text()).not.toContain(a.token);
    const all = await (await admin('GET', 'all')).text();
    expect(all).not.toContain(a.token); expect(all).not.toContain('cancel_token');
  });

  it('確認メールに取り消しの案内：期限前の予約にはリンク（この予約システムの住所 /cancel?t=文字列）・照合のページ・取り消せる最後の日。期限を過ぎた日（前日）の予約には入らない', async () => {
    const a = await book(D, '10:00');
    const b = await book(LATE, '10:00', { tel: '090-1111-1111', email: 'b@example.com' });
    if (IS_DEMO) {
      expect(a.body.mailPreview).toContain(jpDate(TODAY) + ' までは、こちらから取り消せます：https://x/cancel?t=' + a.token);
      expect(a.body.mailPreview).toContain('https://x/cancel で、予約日・電話番号・メールアドレス');
      expect(a.body.mailPreview).toContain('前日・当日のご変更・キャンセルは');
      expect(b.body.mailPreview).not.toContain('/cancel');
      expect(b.body.mailPreview).toContain('ご変更・キャンセルは、公式LINE かお電話');
    } else {
      expect(gasCalls).toHaveLength(2);
      expect(gasCalls[0].booking.cancelUrl).toBe('https://x/cancel?t=' + a.token);
      expect(gasCalls[0].booking.cancelPage).toBe('https://x/cancel');
      expect(gasCalls[0].booking.cancelBy).toBe(jpDate(TODAY));
      expect(gasCalls[0].shop.cancelDays).toBe(CD);
      expect(gasCalls[1].booking.cancelUrl).toBeUndefined(); expect(gasCalls[1].booking.cancelBy).toBeUndefined();
    }
  });

  it('リンクの文字列で探すと、日時・メニュー・施術の分だけ返る（名前・電話・メールは返さない）。取り消してはいない', async () => {
    const a = await book(D, '10:00');
    const r = await cancel({ t: a.token });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({ ok: true, found: true, when: jpDate(D) + ' 10:00〜', menu: M1.name, min: +M1.min, cancelBy: jpDate(TODAY) });
    const t = JSON.stringify(j);
    expect(t).not.toContain('花子'); expect(t).not.toContain(TEL); expect(t).not.toContain(MAIL); expect(t).not.toContain(a.id);
    expect(await blocksOf(D)).toHaveLength(1);
  });

  it('3 つの照合：予約日・電話・メールが全部合えば見つかる（電話のハイフン違い・メールの大文字小文字違いは同じ扱い）。1 つでも違えば「見つかりません」（他人の予約は見えない）', async () => {
    await book(D, '10:00');
    await book(D, '12:00', { name: '別の 人', tel: '090-2222-2222', email: 'other@example.com' });
    const ok = await cancel({ date: D, tel: TEL, email: MAIL });
    expect(ok.status).toBe(200); expect((await ok.json()).when).toBe(jpDate(D) + ' 10:00〜');
    const ok2 = await cancel({ date: D, tel: '09000000000', email: 'Hana@Example.com' });
    expect(ok2.status).toBe(200); expect((await ok2.json()).found).toBe(true);
    for (const body of [
      { date: D, tel: '090-9999-9999', email: MAIL },          // 電話違い
      { date: D, tel: TEL, email: 'x@example.com' },            // メール違い
      { date: addDays(D, 1), tel: TEL, email: MAIL },           // 日付違い
      { date: D, tel: TEL, email: 'other@example.com' },        // 自分の電話＋他人のメール
      { date: D, tel: '090-2222-2222', email: MAIL },           // 他人の電話＋自分のメール
      { date: D, tel: TEL },                                    // 足りない
      { date: 'D', tel: TEL, email: MAIL },                     // 日付の形が違う
      {}
    ]) {
      const r = await cancel(body);
      expect(r.status).toBe(404); expect(await r.json()).toEqual(NF);
    }
    expect(await blocksOf(D)).toHaveLength(2);
  });

  it('見つからないときの返事は全部同じ（理由を分けない）：知らない文字列・形の違う文字列・過ぎた予約・取り消しの記録もない', async () => {
    const a = await book(D, '10:00');
    await env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email, cancel_token) VALUES ('old1', ?1, '10:00', '11:00', 'net', ?2, '2027-01-01T00:00:00Z', '', '', '', ?3)").bind(addDays(TODAY, -1), M1.name, 'a'.repeat(32)).run();
    const bodies = [];
    for (const body of [{ t: 'f'.repeat(32) }, { t: a.token.slice(0, 31) }, { t: a.token + '0' }, { t: a.token.toUpperCase() }, { t: 'a'.repeat(32) }, { t: '' }]) {
      const r = await cancel(body);
      expect(r.status).toBe(404); bodies.push(await r.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual(NF);
  });

  it('期限の境目（日本時間）：前々日の 23:59 までは取り消せる。前日の 0:00 になると late（LINE・電話の案内）で、取り消さない', async () => {
    const a = await book(D, '10:00');
    vi.setSystemTime(new Date(addDays(TODAY, 0) + 'T14:59:00Z'));   // 日本時間 今日 23:59
    expect((await (await cancel({ t: a.token })).json()).found).toBe(true);
    vi.setSystemTime(new Date(TODAY + 'T15:00:00Z'));   // 日本時間 翌日 0:00
    const r = await cancel({ t: a.token });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.late).toBe(true); expect(j.ok).toBe(false);
    expect(j.message).toContain('前日・当日のお取り消しは、公式LINE かお電話');
    if (SHOP.tel) expect(j.message).toContain(SHOP.tel);
    const r2 = await cancel({ t: a.token, confirm: true });
    expect((await r2.json()).late).toBe(true);
    expect(await blocksOf(D)).toHaveLength(1);   // 消えていない
    expect(await cancelsAll()).toHaveLength(0);
    expect(gasCalls.filter((c) => c.action === 'cancel')).toHaveLength(0);
    vi.setSystemTime(new Date(TODAY + 'T14:59:59Z'));   // 23:59:59 はまだ取り消せる
    expect((await (await cancel({ t: a.token, confirm: true })).json()).canceled).toBe(true);
  });

  it('前日の予約・当日の予約は、探せても late（3 つの照合でも同じ）', async () => {
    const a = await book(LATE, '10:00');
    const b = await book(TODAY, '14:00', { tel: '090-1111-1111', email: 'b@example.com' });
    expect((await (await cancel({ t: a.token })).json()).late).toBe(true);
    expect((await (await cancel({ date: LATE, tel: TEL, email: MAIL })).json()).late).toBe(true);
    expect((await (await cancel({ t: b.token, confirm: true })).json()).late).toBe(true);
    expect(await blocksOf(LATE)).toHaveLength(1); expect(await blocksOf(TODAY)).toHaveLength(1);
  });

  it('confirm:true で取り消す：台帳から消えて枠があく（/api/days の busy から消え、同じ時間にまた予約できる）。cancels に記録。GAS には action cancel で 1 回（customer などは cancel の下・料金なし）', async () => {
    const a = await book(D, '10:00');
    gasCalls.length = 0;
    const r = await cancel({ t: a.token, confirm: true });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true); expect(j.canceled).toBe(true); expect(j.when).toBe(jpDate(D) + ' 10:00〜'); expect(j.menu).toBe(M1.name);
    expect(JSON.stringify({ ...j, mailPreview: '' })).not.toContain('花子');   // 名前は返さない（デモの見本のメールの中だけ）
    expect(await blocksOf(D)).toHaveLength(0);
    expect(((await (await api('/api/days')).json()).busy[D] || [])).toHaveLength(0);
    const cx = await cancelsAll();
    expect(cx).toHaveLength(1);
    expect(cx[0]).toMatchObject({ id: a.id, date: D, s: '10:00', menu: M1.name, name: 'テスト 花子', tel: TEL, email: MAIL, token: a.token, mailng: 0 });
    expect(cx[0].at).toBe(new Date(NOW_UTC).toISOString());
    if (IS_DEMO) {
      expect(j.demo).toBe(true); expect(j.mailPreview).toContain('取り消しを承りました'); expect(gasCalls).toHaveLength(0);
    } else {
      expect(j.mail).toBe(true);
      expect(gasCalls).toHaveLength(1);
      const g = gasCalls[0];
      expect(g.action).toBe('cancel'); expect(g.token).toBe(env.GAS_TOKEN);
      expect(g.customer).toBeUndefined(); expect(g.booking).toBeUndefined(); expect(g.shop).toBeUndefined();   // 旧版の GAS が受け付けない形
      expect(g.cancel.customer).toEqual({ name: 'テスト 花子', tel: TEL, email: MAIL });
      expect(g.cancel.booking).toMatchObject({ id: a.id, date: D, when: jpDate(D) + ' 10:00〜', menu: M1.name, min: +M1.min, price: '' });
      expect(g.cancel.booking.items).toEqual([{ name: M1.name, min: +M1.min, price: M1.price || '' }]);
      expect(g.cancel.shop.mail).toBe(SHOP.mail);
    }
    // 同じ時間にまた予約できる
    const r2 = await post('/api/book', { date: D, start: '10:00', menu: M1.name, name: '次の 人', tel: '090-3333-3333', email: 'next@example.com' });
    expect(r2.status).toBe(200);
  });

  it('2 回目は 200 で「取り消し済み」（リンクでも 3 つの照合でも）。GAS へは送らない・壊れない', async () => {
    const a = await book(D, '10:00');
    expect((await (await cancel({ t: a.token, confirm: true })).json()).canceled).toBe(true);
    gasCalls.length = 0;
    for (const body of [{ t: a.token, confirm: true }, { t: a.token }, { date: D, tel: TEL, email: MAIL, confirm: true }, { date: D, tel: '09000000000', email: MAIL }]) {
      const r = await cancel(body);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, already: true, message: 'この予約は取り消し済みです' });
    }
    expect(gasCalls).toHaveLength(0);
    expect(await cancelsAll()).toHaveLength(1);
  });

  it('同時に 2 回押しても、取り消しは 1 回・GAS へも 1 回。もう片方は「取り消し済み」', async () => {
    const a = await book(D, '10:00');
    gasCalls.length = 0;
    const rs = await Promise.all([cancel({ t: a.token, confirm: true }), cancel({ t: a.token, confirm: true }), cancel({ date: D, tel: TEL, email: MAIL, confirm: true })]);
    const js = await Promise.all(rs.map((r) => r.json()));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(js.filter((j) => j.canceled)).toHaveLength(1);
    expect(js.filter((j) => j.already)).toHaveLength(2);
    expect(await cancelsAll()).toHaveLength(1);
    expect(await blocksOf(D)).toHaveLength(0);
    if (!IS_DEMO) expect(gasCalls).toHaveLength(1);
  });

  it.skipIf(IS_DEMO)('GAS が失敗（500・通信切れ・旧版・action なしの返事）でも取り消しは残る。mailng の印が付き、お店の画面の API に出る。お客さんには mail:false と案内', async () => {
    for (const mode of ['fail', 'drop', 'old', 'noaction']) {
      await env.DB.batch([env.DB.prepare('DELETE FROM blocks'), env.DB.prepare('DELETE FROM cancels')]);
      const a = await book(D, '10:00');
      gasMode = mode; gasCalls.length = 0;
      const j = await (await cancel({ t: a.token, confirm: true })).json();
      expect(j.canceled).toBe(true); expect(j.mail).toBe(false); expect(j.note).toContain('念のため LINE かお電話');
      expect(await blocksOf(D)).toHaveLength(0);
      const cx = await cancelsAll();
      expect(cx).toHaveLength(1); expect(cx[0].mailng).toBe(1);
      expect(gasCalls).toHaveLength(1);
      const all = await (await admin('GET', 'all')).json();
      expect(all.cancels).toHaveLength(1);
      expect(all.cancels[0]).toMatchObject({ id: a.id, date: D, s: '10:00', e: cx[0].e, menu: M1.name, name: 'テスト 花子', tel: TEL, email: MAIL, mailng: 1 });
      expect(all.cancels[0].token).toBeUndefined();
      gasMode = 'ok';
    }
  });

  it('レビュー 10/30：cancels に同じ番号の古い記録が残っていても（バックアップから戻したあと など）、取り消しは正しく進む（台帳から消え・記録は新しくなり・GAS に送る）。黙って枠だけ消えない', async () => {
    const a = await book(D, '10:00');
    await env.DB.prepare("INSERT INTO cancels (id, date, s, e, menu, name, tel, email, token, at, mailng) VALUES (?1, ?2, '10:00', '11:00', 'x', '', '', '', '', '2027-01-01T00:00:00Z', 1)").bind(a.id, D).run();
    gasCalls.length = 0;
    const j = await (await cancel({ t: a.token, confirm: true })).json();
    expect(j.canceled).toBe(true); expect(j.already).toBeUndefined();
    expect(await blocksOf(D)).toHaveLength(0);
    const cx = await cancelsAll();
    expect(cx).toHaveLength(1);
    expect(cx[0]).toMatchObject({ id: a.id, name: 'テスト 花子', token: a.token, at: new Date(NOW_UTC).toISOString(), mailng: IS_DEMO ? 0 : 0 });
    if (!IS_DEMO) expect(gasCalls.filter((c) => c.action === 'cancel')).toHaveLength(1);
  });

  it('レビュー 10/30：メールが 100 文字を超える・大文字の照合（lower は表と入力の両方に）', async () => {
    await book(D, '10:00');
    expect((await cancel({ date: D, tel: TEL, email: 'a'.repeat(95) + '@example.com' })).status).toBe(404);
    expect((await cancel({ date: D, tel: TEL, email: 'HANA@EXAMPLE.COM' })).status).toBe(200);
  });

  it('取り消した予約の名前・電話・メールは来店日の翌日に空になる。記録は来店日から 30 日で消える。バックアップには入れない', async () => {
    const a = await book(D, '10:00');
    expect((await (await cancel({ t: a.token, confirm: true })).json()).canceled).toBe(true);
    await env.DB.prepare("INSERT INTO cancels (id, date, s, e, menu, name, tel, email, token, at, mailng) VALUES ('oldc', ?1, '10:00', '11:00', 'x', 'な', '090', 'm@example.com', '', '2027-01-01T00:00:00Z', 0)").bind(addDays(TODAY, -31)).run();
    const bk = await buildBackup(env.DB);
    expect(bk.cancels).toBeUndefined();
    await forgetOld(env.DB, addDays(D, 1));   // 来店日の翌日
    const cx = await cancelsAll();
    expect(cx).toHaveLength(1);   // 31 日前の記録は消えた
    expect(cx[0]).toMatchObject({ id: a.id, name: '', tel: '', email: '' });
    // 翌日は「見つかりません」（取り消し済み とも言わない）
    vi.setSystemTime(new Date(addDays(D, 1) + 'T01:00:00Z'));
    expect((await cancel({ t: a.token })).status).toBe(404);
  });

  it('お店の画面で消した予約は「見つかりません」（取り消し済み ではない）。手入力の予約（LINE・電話）は照合で見つからない', async () => {
    const a = await book(D, '10:00');
    expect((await admin('DELETE', 'block', { id: a.id })).status).toBe(200);
    expect((await cancel({ t: a.token })).status).toBe(404);
    expect((await admin('POST', 'block', { date: D, s: '14:00', e: '15:00', menu: M1.name, name: 'テスト 花子' })).status).toBe(200);
    expect((await cancel({ date: D, tel: TEL, email: MAIL })).status).toBe(404);
    expect(await blocksOf(D)).toHaveLength(1);
  });

  it('入力の形：t・date・tel・email が文字でない、confirm が真偽でない は 400（表を引かない・内部のエラー文を返さない）', async () => {
    for (const body of [{ t: ['x'] }, { t: {} }, { date: 1, tel: TEL, email: MAIL }, { date: D, tel: ['x'], email: MAIL }, { date: D, tel: TEL, email: MAIL, confirm: 'true' }, { t: 'a'.repeat(32), confirm: 1 }]) {
      const r = await cancel(body);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('入力の形が違います');
    }
    const r = await api('/api/cancel', { method: 'POST', body: '{bad' });
    expect(r.status).toBe(400);
  });

  it.skipIf(IS_DEMO)('いたずら対策：同じ IP から 10 分に 5 回まで（探すだけでも数える）。6 回目は 429。別の IP は通る。予約（/api/book）の回数とは別', async () => {
    const IP = { 'CF-Connecting-IP': '203.0.113.9' };
    for (let i = 0; i < 5; i++) expect((await cancel({ t: 'f'.repeat(32) }, IP)).status).toBe(404);
    const r = await cancel({ date: D, tel: TEL, email: MAIL }, IP);
    expect(r.status).toBe(429); expect((await r.json()).error).toContain('短い間にたくさん');
    expect((await cancel({ t: 'f'.repeat(32) }, { 'CF-Connecting-IP': '203.0.113.10' })).status).toBe(404);
    // 同じ IP でも予約は通る（別に数えている）
    expect((await post('/api/book', { date: D, start: '10:00', menu: M1.name, name: 'テスト 花子', tel: TEL, email: MAIL }, IP)).status).toBe(200);
    vi.setSystemTime(new Date(Date.now() + 11 * 60000));
    expect((await cancel({ t: 'f'.repeat(32) }, IP)).status).toBe(404);   // 10 分たつと戻る
  });

  it('CORS：許可した Origin からの /api/cancel には CORS ヘッダ（404 にも）。事前確認も答える。許可していない Origin には付かない', async () => {
    const OK = SHOP.allowOrigins[0];
    const r = await cancel({ t: 'f'.repeat(32) }, { Origin: OK });
    expect(r.status).toBe(404); expect(r.headers.get('access-control-allow-origin')).toBe(OK); expect(r.headers.get('vary')).toBe('Origin');
    const o = await api('/api/cancel', { method: 'OPTIONS', headers: { Origin: OK, 'Access-Control-Request-Method': 'POST' } });
    expect(o.status).toBe(204); expect(o.headers.get('access-control-allow-origin')).toBe(OK); expect(o.headers.get('access-control-allow-methods')).toBe('POST');
    const ng = await cancel({ t: 'f'.repeat(32) }, { Origin: 'https://evil.example' });
    expect(ng.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('取り消しのページ /cancel が開ける（noindex・照合の入力・確認の作り）', async () => {
    const r = await api('/cancel');
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain('noindex'); expect(t).toContain('/api/cancel'); expect(t).toContain('本当に取り消す'); expect(t).toContain('やめる');
    expect(t).not.toMatch(/=>|\bconst\b|\blet\b|async /);   // 古いスマホ向け（var・function だけ）
  });
});
