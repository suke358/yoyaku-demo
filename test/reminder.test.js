// 2 日前のお知らせメール（Cron・KV の印・GAS へ action: 'reminder'）のテスト（2026/10/28）。GAS は偽物の fetch が受け止める（本物には送らない）。本番には触らない
import { SELF, env, createScheduledController, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import worker, { runReminder, runBackup } from '../src/worker.js';
import shopText from '../public/shop.jsonc?raw';
import wranglerText from '../wrangler.jsonc?raw';

const SHOP = JSON.parse(shopText.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^"\n]*$/gm, ''));
const ON = { enabled: true, daysBefore: 2, hourJst: 10 };   // テスト用の設定（shop.jsonc の既定は無効）
const NOW_UTC = '2027-03-10T01:00:00Z';   // 日本時間 2027-03-10 10:00（Cron の時刻）
const T2 = '2027-03-12';                   // 今日＋2 日
const api = (path, init) => SELF.fetch('https://x' + path, init);
const M1 = SHOP.menus[0], M2 = SHOP.menus.find((m) => m !== M1 && !/\d+分$/.test(m.name)) || SHOP.menus[1];

const gasCalls = [], oldSent = [];
let gasMode = 'ok';
beforeAll(() => {
  vi.stubGlobal('fetch', async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === env.GAS_URL) {
      gasCalls.push(JSON.parse(String(init && init.body || '{}')));
      if (gasMode === 'fail') return new Response('error', { status: 500 });
      if (gasMode === 'drop') throw new Error('network dropped');
      const d = gasCalls[gasCalls.length - 1];
      if (gasMode === 'old') {   // 旧版の GAS（25aea49 の Code.gs）：action を見ない。customer/booking/shop がトップにあれば「予約確認メール 2 通」を送って ok:true
        if (d.customer && d.booking && d.shop) { oldSent.push(d.booking.id); return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }); }
        return new Response(JSON.stringify({ ok: false, error: 'input' }), { headers: { 'content-type': 'application/json' } });
      }
      if (gasMode === 'noaction') return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      // 新版の GAS：reminder は d.reminder の下から読み、返事に action を入れる
      if (d.action === 'reminder') return new Response(JSON.stringify(d.reminder && d.reminder.customer ? { ok: true, action: 'reminder' } : { ok: false, error: 'input' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error('テストからは外へ送らない: ' + url);
  });
});
const ins = (id, date, s, e, kind, menu, email) => env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2027-03-01T00:00:00.000Z', ?7, ?8, ?9)")
  .bind(id, date, s, e, kind, menu, kind === 'net' ? 'テスト 花子' : '', kind === 'net' ? '090-0000-0000' : '', email || '').run();
beforeEach(async () => {
  gasCalls.length = 0; oldSent.length = 0; gasMode = 'ok';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_UTC));
  await api('/api/days');
  await env.DB.batch([env.DB.prepare('DELETE FROM blocks'), env.DB.prepare('DELETE FROM hours'), env.DB.prepare('DELETE FROM settings')]);
  for (const k of (await env.BACKUP.list()).keys) await env.BACKUP.delete(k.name);
});

describe('2 日前のお知らせメール（2026/10/28）', () => {
  it('設定：shop.jsonc の reminder は既定で無効（enabled false・daysBefore 2・hourJst 10）。wrangler.jsonc に 10:00 JST（01:00 UTC）の Cron がある', () => {
    expect(SHOP.reminder).toEqual({ enabled: false, daysBefore: 2, hourJst: 10 });
    const h = ((SHOP.reminder.hourJst - 9) % 24 + 24) % 24;   // hourJst → UTC の時（wrangler.jsonc の Cron と食い違えば黙って止まるので、ここで縛る。レビュー 10/28）
    expect(Number.isInteger(SHOP.reminder.hourJst) && SHOP.reminder.hourJst >= 0 && SHOP.reminder.hourJst <= 23).toBe(true);
    expect(wranglerText).toMatch(new RegExp('"0 ' + h + ' \\* \\* \\*"'));
    expect(wranglerText).toMatch(/"30 19 \* \* \*"/);   // バックアップの Cron も残っている
  });
  it('無効（既定の設定）のときは、対象があっても何も送らない・印も付けない', async () => {
    await ins('r1', T2, '10:00', '11:00', 'net', M1.name, 'hana@example.com');
    const r = await runReminder(env, { enabled: false, daysBefore: 2 });
    expect(r.sent).toBe(0); expect(r.reason).toBe('disabled');
    expect(gasCalls).toHaveLength(0);
    expect((await env.BACKUP.list({ prefix: 'reminder:' })).keys).toHaveLength(0);
    const d = await runReminder(env);   // 引数なし＝shop.jsonc の既定（無効 か デモ）
    expect(d.sent).toBe(0); expect(['disabled', 'demo']).toContain(d.reason);
  });
  it('今日＋2 日のネット予約（メールあり）に 1 通。手入力（メールなし）・取り消し済み（表にない）・前日・3 日前・同じ日の過去分は送らない', async () => {
    await ins('r1', T2, '10:00', '11:00', 'net', M1.name, 'hana@example.com');     // 対象
    await ins('r2', T2, '13:00', '14:00', 'man', '電話', '');                      // 手入力（メールなし）
    await ins('r3', '2027-03-11', '10:00', '11:00', 'net', M1.name, 'a@example.com');   // 前日
    await ins('r4', '2027-03-13', '10:00', '11:00', 'net', M1.name, 'b@example.com');   // 3 日前
    await ins('r5', T2, '15:00', '16:00', 'net', M1.name, 'c@example.com');     // 対象（取り消す）
    await env.DB.prepare('DELETE FROM blocks WHERE id = ?1').bind('r5').run();  // 取り消し＝表から消える
    await ins('r6', T2, '16:00', '17:00', 'stop', '', '');                      // 予約停止
    const r = await runReminder(env, ON);
    expect(r.ok).toBe(true); expect(r.date).toBe(T2); expect(r.sent).toBe(1); expect(r.failed).toBe(0);
    expect(gasCalls).toHaveLength(1);
    const g = gasCalls[0];
    expect(g.action).toBe('reminder'); expect(g.token).toBe(env.GAS_TOKEN); expect(g.daysBefore).toBe(2);
    expect(g.customer).toBeUndefined(); expect(g.booking).toBeUndefined(); expect(g.shop).toBeUndefined();   // 旧版の GAS が受け付けない形（reminder の下に入れる。レビュー 10/28）
    const rm = g.reminder;
    expect(rm.customer).toEqual({ name: 'テスト 花子', email: 'hana@example.com' });   // 電話は渡さない（文面に使わない）
    expect(rm.booking.id).toBe('r1'); expect(rm.booking.when).toBe('3月12日（金） 10:00〜'); expect(rm.booking.menu).toBe(M1.name);
    expect(rm.booking.min).toBe(+M1.min); expect(rm.booking.slot).toBe(60); expect(rm.booking.price).toBe('');   // 料金は書かない
    expect(rm.shop.name).toBe(SHOP.shopName);
    expect(await env.BACKUP.get('reminder:r1')).toBeTruthy();
    expect((await env.BACKUP.list({ prefix: 'reminder:' })).keys).toHaveLength(1);
    const last = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'reminder_last'").first()).value);
    expect(last.ok).toBe(true); expect(last.sent).toBe(1);
    expect(JSON.stringify(last)).not.toMatch(/hana@example\.com|花子/);   // 記録に個人情報は入れない
  });
  it('二重送信しない：Cron を 2 回動かしても 1 通。印は 7 日の期限つき', async () => {
    await ins('r1', T2, '10:00', '11:00', 'net', M1.name, 'hana@example.com');
    expect((await runReminder(env, ON)).sent).toBe(1);
    const r2 = await runReminder(env, ON);
    expect(r2.sent).toBe(0); expect(r2.skipped).toBe(1);
    expect(gasCalls).toHaveLength(1);
    const k = (await env.BACKUP.list({ prefix: 'reminder:' })).keys.find((x) => x.name === 'reminder:r1');
    const real = vi.getRealSystemTime() / 1000;   // KV の期限は本当の時計で付く（テストの偽の時計ではない）
    expect(k.expiration).toBeGreaterThan(real + 6 * 86400);
    expect(k.expiration).toBeLessThanOrEqual(real + 7 * 86400 + 60);
  });
  it('GAS が失敗（500・通信切れ）したら印を付けず、結果の記録に残す。ほかの予約には送る。同じ日にもう一度動かせばその分だけ送る', async () => {
    await ins('r1', T2, '10:00', '11:00', 'net', M1.name, 'hana@example.com');
    await ins('r2', T2, '13:00', '14:00', 'net', M1.name, 'taro@example.com');
    gasMode = 'fail';
    const r = await runReminder(env, ON);
    expect(r.ok).toBe(false); expect(r.sent).toBe(0); expect(r.failed).toBe(2);
    expect((await env.BACKUP.list({ prefix: 'reminder:' })).keys).toHaveLength(0);
    const last = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'reminder_last'").first()).value);
    expect(last.ok).toBe(false); expect(last.failed).toBe(2); expect(JSON.stringify(last)).not.toMatch(/example\.com/);
    gasMode = 'drop';
    expect((await runReminder(env, ON)).failed).toBe(2);
    gasMode = 'ok';
    const r3 = await runReminder(env, ON);
    expect(r3.sent).toBe(2); expect(r3.failed).toBe(0);
    expect((await env.BACKUP.list({ prefix: 'reminder:' })).keys).toHaveLength(2);
  });
  it('日付の計算：月またぎ・年またぎ・日本時間と UTC のずれ（UTC の 15:30 は日本時間の翌日 0:30）', async () => {
    const cases = [['2027-03-30T01:00:00Z', '2027-04-01'], ['2027-12-30T01:00:00Z', '2028-01-01'], ['2027-03-10T15:30:00Z', '2027-03-13'], ['2028-02-27T01:00:00Z', '2028-02-29']];
    for (const [now, want] of cases) {
      vi.setSystemTime(new Date(now));
      await env.DB.prepare('DELETE FROM blocks').run(); gasCalls.length = 0;
      await ins('x', want, '10:00', '11:00', 'net', M1.name, 'x@example.com');
      await ins('y', (await (async () => { const d = new Date(want + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })()), '10:00', '11:00', 'net', M1.name, 'y@example.com');
      const r = await runReminder(env, ON);
      expect(r.date).toBe(want); expect(r.sent).toBe(1); expect(gasCalls[0].reminder.booking.id).toBe('x');
      await env.BACKUP.delete('reminder:x');
    }
  });
  it('daysBefore を変えると、その日数後の予約が対象になる', async () => {
    await ins('d1', '2027-03-11', '10:00', '11:00', 'net', M1.name, 'a@example.com');
    const r = await runReminder(env, { enabled: true, daysBefore: 1 });
    expect(r.date).toBe('2027-03-11'); expect(r.sent).toBe(1);
  });
  it('複数メニュー（台帳の menu が「A＋B」）は 1 つずつ items に分け、施術の合計と所要（枠の長さ）を渡す', async () => {
    await ins('m1', T2, '10:00', '11:40', 'net', M1.name + '＋' + M2.name, 'hana@example.com');
    const r = await runReminder(env, ON);
    expect(r.sent).toBe(1);
    const b = gasCalls[0].reminder.booking;
    expect(b.items).toEqual([{ name: M1.name, min: +M1.min, price: M1.price || '' }, { name: M2.name, min: +M2.min, price: M2.price || '' }]);
    expect(b.min).toBe(+M1.min + +M2.min); expect(b.slot).toBe(100); expect(b.menu).toBe(M1.name + '＋' + M2.name);
  });
  it('Cron の入口：01:00 UTC の cron で runReminder、19:30 UTC の cron でバックアップ。知らない cron は何もしない。HTTP からは動かせない', async () => {
    await ins('r1', T2, '10:00', '11:00', 'net', M1.name, 'hana@example.com');
    const run = async (cron) => { const ctrl = createScheduledController({ scheduledTime: new Date(NOW_UTC), cron }); const ctx = createExecutionContext(); await worker.scheduled(ctrl, env, ctx); await waitOnExecutionContext(ctx); };
    await run('0 1 * * *');
    // 既定の設定は無効（か デモ）なので送らない。D1 にも何も書かない
    expect(gasCalls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'reminder_last'").first()).toBeNull();
    expect((await env.BACKUP.list({ prefix: 'reminder:' })).keys).toHaveLength(0);
    await run('30 19 * * *');
    expect(await env.BACKUP.get('backup:2027-03-10', 'json')).toBeTruthy();   // バックアップは今までどおり
    const bk = await env.BACKUP.get('backup:2027-03-10', 'json');
    expect(bk.settings.map((s) => s.key)).not.toContain('reminder_last');   // 控えに結果の記録は入れない
    await run('15 15 * * *');
    expect(gasCalls).toHaveLength(0);
    for (const p of ['/api/reminder', '/api/admin/reminder', '/__scheduled']) {
      const r = await api(p, { method: 'POST', headers: { 'X-Admin-Password': 'test-admin-password' } });
      expect([401, 404]).toContain(r.status);
    }
    expect(gasCalls).toHaveLength(0);
  });
  it('旧版の GAS（action を知らない）に送っても、予約確認メールは出ず（旧版は input エラーで止まる）、印も付かない。ok:true だけの返事（action なし）も失敗扱い（レビュー 10/28）', async () => {
    await ins('r1', T2, '10:00', '11:00', 'net', M1.name, 'hana@example.com');
    gasMode = 'old';
    const r = await runReminder(env, ON);
    expect(oldSent).toHaveLength(0);   // 旧版の「2 通送る」分岐に入らない
    expect(r.sent).toBe(0); expect(r.failed).toBe(1); expect(r.ok).toBe(false);
    expect((await env.BACKUP.list({ prefix: 'reminder:' })).keys).toHaveLength(0);
    gasMode = 'noaction';
    const r2 = await runReminder(env, ON);
    expect(r2.sent).toBe(0); expect(r2.failed).toBe(1);
    expect((await env.BACKUP.list({ prefix: 'reminder:' })).keys).toHaveLength(0);
    gasMode = 'ok';
    expect((await runReminder(env, ON)).sent).toBe(1);
  });
  it('設定から消えたメニューが混ざる・menu が空のときは、施術の合計を出さない（min 0）。名前は残す', async () => {
    await ins('m1', T2, '10:00', '11:40', 'net', M1.name + '＋むかしのメニュー', 'a@example.com');
    await ins('m2', T2, '13:00', '14:00', 'net', '', 'b@example.com');
    const r = await runReminder(env, ON);
    expect(r.sent).toBe(2);
    const b1 = gasCalls.find((g) => g.reminder.booking.id === 'm1').reminder.booking, b2 = gasCalls.find((g) => g.reminder.booking.id === 'm2').reminder.booking;
    expect(b1.items.map((x) => x.name)).toEqual([M1.name, 'むかしのメニュー']); expect(b1.min).toBe(0); expect(b1.slot).toBe(100);
    expect(b2.items).toEqual([]); expect(b2.min).toBe(0); expect(b2.menu).toBe('');
  });
  it('D1 が落ちたら、結果は ok:false で error に理由（console.error にも id なしで出す）。送らない・印も付けない', async () => {
    await ins('r1', T2, '10:00', '11:00', 'net', M1.name, 'hana@example.com');
    const errs = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.join(' ')); });
    const broken = { ...env, DB: { prepare() { throw new Error('D1_ERROR: down'); }, batch() { throw new Error('D1_ERROR: down'); } } };
    const r = await runReminder(broken, ON);
    spy.mockRestore();
    expect(r.ok).toBe(false); expect(r.error).toMatch(/D1_ERROR/); expect(r.sent).toBe(0);
    expect(errs.join('\n')).toMatch(/reminder/); expect(errs.join('\n')).not.toMatch(/hana@example\.com|花子/);
    expect(gasCalls).toHaveLength(0);
    expect((await env.BACKUP.list({ prefix: 'reminder:' })).keys).toHaveLength(0);
  });
  it('GAS の秘密の変数がなければ送らない（印も付けない）', async () => {
    await ins('r1', T2, '10:00', '11:00', 'net', M1.name, 'hana@example.com');
    const r = await runReminder({ ...env, GAS_URL: '', GAS_TOKEN: '' }, ON);
    expect(r.sent).toBe(0); expect(r.reason).toBe('no-gas'); expect(gasCalls).toHaveLength(0);
  });
});
