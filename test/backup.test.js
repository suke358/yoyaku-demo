// 予約のバックアップ（KV・毎日 4:30 の Cron）のテスト（2026/10/26）。偽物の KV（テストの実行環境のもの）に書く。本番には触らない
import { SELF, env, createScheduledController, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { runBackup, buildBackup } from '../src/worker.js';
import { toStatements, counts } from '../tools/restore_lib.mjs';

const ADMIN = 'test-admin-password';
const NOW_UTC = '2027-03-10T01:00:00Z', TODAY = '2027-03-10', FAR = '2027-04-15';
const TTL = 2592000;
const api = (path, init) => SELF.fetch('https://x' + path, init);
const admin = (method, path, body) => api('/api/admin/' + path, { method, headers: { 'content-type': 'application/json', 'X-Admin-Password': ADMIN }, body: JSON.stringify(body) });
const hoursN = async () => (await env.DB.prepare('SELECT count(*) AS n FROM hours').first()).n;
const seed = async () => {
  await api('/api/days');
  await env.DB.batch([env.DB.prepare('DELETE FROM blocks'), env.DB.prepare('DELETE FROM hours'), env.DB.prepare('DELETE FROM settings'), env.DB.prepare('DELETE FROM auth_fail'), env.DB.prepare('DELETE FROM book_rate')]);
  expect((await admin('POST', 'hours', { date: FAR, s: '10:00', e: '18:00' })).status).toBe(200);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email) VALUES ('b1', ?1, '10:00', '11:00', 'net', 'よもぎ蒸し', '2027-03-09T00:00:00.000Z', 'テスト 花子', '090-0000-0000', 'hana@example.com')").bind(FAR),
    env.DB.prepare("INSERT INTO blocks (id, date, s, e, kind, menu, created_at) VALUES ('b2', ?1, '13:00', '14:00', 'man', '電話', '2027-03-09T00:00:00.000Z')").bind(FAR),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('pats', '[{\"name\":\"1日\",\"s\":\"10:00\",\"e\":\"18:00\"}]')"),
    env.DB.prepare("INSERT INTO auth_fail (ip, n, until, day) VALUES ('203.0.113.9', 2, '', ?1)").bind(TODAY),
    env.DB.prepare("INSERT INTO book_rate (ip, at) VALUES ('203.0.113.9', ?1)").bind(new Date().toISOString()),
  ]);
};
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_UTC));
  await seed();
  for (const k of (await env.BACKUP.list()).keys) await env.BACKUP.delete(k.name);
});

describe('予約のバックアップ（KV）', () => {
  it('runBackup：backup:日付 のキーに、blocks（名前・電話・メール込み）・hours・settings が入り、件数が合う。backup_last に成功が残る', async () => {
    const r = await runBackup(env);
    const hn = await hoursN();   // デモでは demoPrepare が営業日を足すので、実際の行数と比べる
    expect(r).toMatchObject({ ok: true, key: 'backup:' + TODAY, counts: { blocks: 2, hours: hn, settings: 1 } });
    const data = await env.BACKUP.get('backup:' + TODAY, 'json');
    expect(data.version).toBe(1);
    expect(data.counts).toEqual({ blocks: 2, hours: hn, settings: 1 });
    expect(data.blocks.find((b) => b.id === 'b1')).toMatchObject({ name: 'テスト 花子', tel: '090-0000-0000', email: 'hana@example.com', kind: 'net', mailng: 0 });
    expect(data.hours.find((h) => h.date === FAR)).toEqual({ date: FAR, s: '10:00', e: '18:00' });
    expect(data.settings[0].key).toBe('pats');
    const last = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_last'").first()).value);
    expect(last).toMatchObject({ ok: true, key: 'backup:' + TODAY, counts: { blocks: 2 } });
  });
  it('IP の記録（book_rate・auth_fail）と backup_last は書き出さない', async () => {
    await runBackup(env);
    const text = await env.BACKUP.get('backup:' + TODAY, 'text');
    expect(text).not.toMatch(/book_rate|auth_fail|203\.0\.113|"ip"|backup_last/);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['at', 'blocks', 'counts', 'date', 'hours', 'settings', 'shop', 'version']);
  });
  it('1 件ごとに 30 日（2592000 秒）の期限が付く', async () => {
    await runBackup(env);
    const k = (await env.BACKUP.list({ prefix: 'backup:' })).keys.find((x) => x.name === 'backup:' + TODAY);
    expect(k).toBeTruthy();
    expect(typeof k.expiration).toBe('number');
    // 期限 ＝ 書いた時刻 ＋ TTL。KV の時計は本当の時刻（Date は偽物にしてあるので performance から本当の今を出す）。どちらかと 2 分以内
    const fake = Math.floor(new Date(NOW_UTC).getTime() / 1000) + TTL;
    const real = Math.floor((performance.timeOrigin + performance.now()) / 1000) + TTL;
    const diff = Math.min(Math.abs(k.expiration - fake), Math.abs(k.expiration - real));
    expect(diff).toBeLessThanOrEqual(120);
    expect(k.metadata).toMatchObject({ counts: { blocks: 2 } });
  });
  it('KV に書けないとき：backup_last に失敗と短い理由が残り、予約の中身は入らない。KV がつながっていなくても落ちない', async () => {
    const broken = { ...env, BACKUP: { put: async () => { throw new Error('KV down テスト 花子'); } } };
    const r = await runBackup(broken);
    expect(r.ok).toBe(false);
    const last = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_last'").first()).value);
    expect(last.ok).toBe(false);
    expect(last.error).toMatch(/KV down/);
    expect(JSON.stringify(last)).not.toMatch(/090-0000-0000|hana@example\.com/);
    const none = await runBackup({ ...env, BACKUP: undefined });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/KV/);
  });
  it('Cron の入口（scheduled）から動く。HTTP からは読めない・書き出せない', async () => {
    const ctrl = createScheduledController({ scheduledTime: new Date(NOW_UTC), cron: '30 19 * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled(ctrl, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.BACKUP.get('backup:' + TODAY, 'json')).toBeTruthy();
    for (const p of ['/api/backup', '/api/backup/' + TODAY, '/backup:' + TODAY, '/api/admin/backup']) {
      const r = await api(p, { headers: { 'X-Admin-Password': ADMIN } });
      expect([404, 401]).toContain(r.status);
      expect(await r.text()).not.toMatch(/hana@example\.com/);
    }
    const all = await (await admin('GET', 'all')).json();
    expect(JSON.stringify(all.settings)).not.toMatch(/hana@example\.com|"blocks":\[/);   // 設定に控えの中身は入らない（backup_last は件数だけ）
    expect(all.settings.backup_last.ok).toBe(true);
    expect(JSON.stringify(await (await api('/api/days')).json())).not.toMatch(/backup|hana@example\.com/);
  });
  it('戻し：控えの JSON から SQL を作り、空の D1 に流すと行数が一致し、中身も同じ', async () => {
    const data = await buildBackup(env.DB);
    const stmts = toStatements(data);
    expect(stmts.filter((s) => /^INSERT INTO blocks/.test(s))).toHaveLength(2);
    const hn = await hoursN();
    expect(counts(data)).toEqual({ blocks: 2, hours: hn, settings: 1 });
    // 空にしてから戻す（テストの D1。本番ではない）
    await env.DB.batch([env.DB.prepare('DELETE FROM blocks'), env.DB.prepare('DELETE FROM hours'), env.DB.prepare('DELETE FROM settings')]);
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
    const n = await env.DB.prepare('SELECT (SELECT count(*) FROM blocks) b, (SELECT count(*) FROM hours) h, (SELECT count(*) FROM settings) s').first();
    expect(n).toEqual({ b: 2, h: hn, s: 1 });
    const b1 = await env.DB.prepare("SELECT * FROM blocks WHERE id = 'b1'").first();
    expect(b1).toMatchObject({ date: FAR, s: '10:00', e: '11:00', kind: 'net', name: 'テスト 花子', tel: '090-0000-0000', email: 'hana@example.com', mailng: 0 });
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key = 'pats'").first()).value).toMatch(/1日/);
  });
});
