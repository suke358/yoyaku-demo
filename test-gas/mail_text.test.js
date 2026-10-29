// gas/Code.gs の文面のテスト（Node。2026/10/28）。Code.gs から文を作る関数（customerBody・shopBody・reminderBody）だけを取り出して動かす。送信（MailApp）は含めない
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const pick = (name) => { const m = src.match(new RegExp('\\nfunction ' + name + '\\([\\s\\S]*?\\n}\\n')); if (!m) throw new Error(name + ' が Code.gs にない'); return m[0]; };
const fns = new Function(pick('customerBody') + pick('shopBody') + pick('reminderBody') + pick('cancelCustomerBody') + pick('cancelShopBody') + pick('lateWord') + '\nreturn { customerBody, shopBody, reminderBody, cancelCustomerBody, cancelShopBody, lateWord };')();
const SHOP = { name: 'テストのお店', shortName: 'テスト', tel: '000-0000-0000', line: 'https://line.example/x', mail: 'shop@example.com', address: '〒000-0000 どこか市 1-2-3', parking: '駐車場は 1 番', mapUrl: 'https://www.google.com/maps/place/?q=place_id:ABC123', cancelPolicy: '前日のキャンセルは料金の50%、当日のキャンセルは料金の100%をいただきます。', cancelDays: 2 };
const C = { name: 'テスト 花子', email: 'hana@example.com' };
const ONE = { id: 'a1', date: '2027-03-12', when: '3月12日（金） 10:00〜', start: '10:00', end: '11:00', menu: 'よもぎ蒸し', min: 40, slot: 60, price: '', items: [{ name: 'よもぎ蒸し', min: 40, price: '5,500円' }], extraNote: '' };
const TWO = { ...ONE, menu: 'よもぎ蒸し＋フェイシャル', min: 70, slot: 100, items: [{ name: 'よもぎ蒸し', min: 40, price: '5,500円' }, { name: 'フェイシャル', min: 30, price: '5,500円' }], extraNote: 'お化粧落とし' };
const TWO_NOEX = { ...ONE, menu: 'よもぎ蒸し＋ボディケア 60分', min: 100, slot: 120, items: [{ name: 'よもぎ蒸し', min: 40, price: '5,500円' }, { name: 'ボディケア 60分', min: 60, price: '6,600円' }], extraNote: '' };

describe('2 日前のお知らせの文面（reminderBody）', () => {
  it('1 メニュー：メニューは 1 行、所要時間に「お化粧落とし」は出ない。崩れない（空行が続かない・undefined が出ない）', () => {
    const t = fns.reminderBody(C, ONE, SHOP, 2);
    expect(t).toContain('テスト 花子 様');
    expect(t).toContain('ご予約日の 2 日前になりましたので');
    expect(t).toContain('■ 日時　　3月12日（金） 10:00〜');
    expect(t).toContain('■ メニュー　よもぎ蒸し（40分）');
    expect(t).not.toContain('■ 施術時間');
    expect(t).toContain('■ 所要時間　約60分（カウンセリング・お片づけを含む）');
    expect(t).not.toContain('お化粧落とし');
    expect(t).not.toMatch(/undefined|null|NaN/);
    expect(t).not.toMatch(/\n\n\n/);
    expect(t).not.toMatch(/円/);   // 料金は書かない
  });
  it('2 メニュー：1 行ずつ＋施術の合計。フェイシャルが入るときだけ「お化粧落とし」が出る', () => {
    const t = fns.reminderBody(C, TWO, SHOP, 2);
    expect(t).toContain('■ メニュー\n　・よもぎ蒸し（40分）\n　・フェイシャル（30分）\n■ 施術時間　合計70分');
    expect(t).toContain('■ 所要時間　約100分（カウンセリング・お片づけ・お化粧落としを含む）');
    const u = fns.reminderBody(C, TWO_NOEX, SHOP, 2);
    expect(u).toContain('■ 所要時間　約120分（カウンセリング・お片づけを含む）');
    expect(u).not.toContain('お化粧落とし');
  });
  it('地図の行は shop.jsonc の mapUrl をそのまま（お店ごとに変えられる）。空なら出ない。住所・駐車場も同じ', () => {
    const t = fns.reminderBody(C, ONE, SHOP, 2);
    expect(t).toContain('地図：https://www.google.com/maps/place/?q=place_id:ABC123');
    expect(t).toContain('■ 場所\n〒000-0000 どこか市 1-2-3\n駐車場は 1 番\n地図：');
    const u = fns.reminderBody(C, ONE, { ...SHOP, mapUrl: '', parking: '' }, 2);
    expect(u).not.toContain('地図：'); expect(u).not.toContain('駐車場');
  });
  it('キャンセルの決まり・連絡先・LINE。cancelPolicy が空なら その段落は出ない（勝手に作らない）', () => {
    const t = fns.reminderBody(C, ONE, SHOP, 2);
    expect(t).toContain('■ キャンセルについて\n前日のキャンセルは料金の50%、当日のキャンセルは料金の100%をいただきます。\nご都合が悪くなったときは、公式LINE かお電話（000-0000-0000）でお早めにご連絡ください。\n公式LINE：https://line.example/x');
    const u = fns.reminderBody(C, ONE, { ...SHOP, cancelPolicy: '' }, 2);
    expect(u).not.toContain('キャンセルについて'); expect(u).not.toContain('50%');
    expect(u).toContain('ご都合が悪くなったときは、公式LINE かお電話（000-0000-0000）でお早めにご連絡ください。');
  });
  it('末尾（署名・返信の案内）は予約確認メール（customerBody）と同じ言い方', () => {
    const tail = (t) => t.trim().split('\n').slice(-4).join('\n');
    const r = fns.reminderBody(C, ONE, SHOP, 2), c = fns.customerBody({ ...C, tel: '090-0000-0000' }, ONE, SHOP);
    expect(tail(r)).toBe(tail(c));
    expect(tail(r)).toBe('―――\nテストのお店\n電話 000-0000-0000\n（このメールに返信すると、お店に届きます）');
    expect(r.trim().split('\n').slice(-5)[0]).toBe('');   // 署名の前は空行 1 つ
  });
  it('使わない言葉（効果の断定・極上・No.1・デトックス）が入っていない', () => {
    for (const b of [ONE, TWO]) {
      const t = fns.reminderBody(C, b, SHOP, 2);
      expect(t).not.toMatch(/治る|必ず|極上|No\.1|デトックス|効果/);
    }
  });
});

describe('お客さんの取り消し（2026/10/30）', () => {
  const CT = { ...C, tel: '090-0000-0000' };
  const LINKED = { ...ONE, cancelUrl: 'https://x/cancel?t=abc', cancelPage: 'https://x/cancel', cancelBy: '3月10日（水）' };
  it('予約確認メール（customerBody）：期限前の予約には「〇日までは こちらから取り消せます：リンク」「開けないときは /cancel で 3 つ」「前日・当日は LINE・電話」の 3 行。キャンセルの決まりの下・公式LINE の上', () => {
    const t = fns.customerBody(CT, LINKED, SHOP);
    expect(t).toContain('■ キャンセルについて\n前日のキャンセルは料金の50%、当日のキャンセルは料金の100%をいただきます。\n3月10日（水） までは、こちらから取り消せます：https://x/cancel?t=abc\n（リンクが開けないときは https://x/cancel で、予約日・電話番号・メールアドレスを入れてください）\n前日・当日のご変更・キャンセルは、公式LINE かお電話（000-0000-0000）でお知らせください。\n公式LINE：https://line.example/x');
    expect(t).not.toContain('\nご変更・キャンセルは、公式LINE かお電話（000-0000-0000）でお知らせください。');   // 前の 1 行は出ない（「前日・当日の…」の行に置きかわる）
    expect(t).not.toMatch(/undefined|null|NaN/); expect(t).not.toMatch(/\n\n\n/);
  });
  it('期限の呼び方（lateWord）は cancelDays に追従する：2 → 前日・当日、1 → 当日、3 → ご予約日の 2 日前から、渡ってこなければ 2 扱い', () => {
    expect(fns.lateWord(2)).toBe('前日・当日'); expect(fns.lateWord(1)).toBe('当日'); expect(fns.lateWord(3)).toBe('ご予約日の 2 日前から'); expect(fns.lateWord(undefined)).toBe('前日・当日');
    expect(fns.customerBody(CT, LINKED, { ...SHOP, cancelDays: 1 })).toContain('当日のご変更・キャンセルは');
    expect(fns.customerBody(CT, LINKED, { ...SHOP, cancelDays: 1 })).not.toContain('前日・当日');
  });
  it('予約確認メール：リンクがない予約（前日・当日の予約。旧版の Worker も）は今までどおり 1 行', () => {
    const t = fns.customerBody(CT, ONE, SHOP);
    expect(t).toContain('■ キャンセルについて\n前日のキャンセルは料金の50%、当日のキャンセルは料金の100%をいただきます。\nご変更・キャンセルは、公式LINE かお電話（000-0000-0000）でお知らせください。\n公式LINE：');
    expect(t).not.toContain('取り消せます'); expect(t).not.toContain('/cancel');
  });
  it('取り消しの確認メール（cancelCustomerBody）：1 メニューは 1 行、複数は 1 行ずつ。料金・キャンセル料は書かない。末尾は予約確認メールと同じ', () => {
    const t = fns.cancelCustomerBody(C, ONE, SHOP);
    expect(t).toContain('テスト 花子 様\n\nテストのお店 です。以下のご予約の取り消しを承りました。\n\n■ 日時　　3月12日（金） 10:00〜\n■ メニュー　よもぎ蒸し（40分）\n\nまたのご予約を、お待ちしております。\n公式LINE：https://line.example/x');
    expect(t).not.toMatch(/円|%|キャンセル料/);
    expect(t).not.toMatch(/undefined|null|NaN/); expect(t).not.toMatch(/\n\n\n/);
    const u = fns.cancelCustomerBody(C, TWO, SHOP);
    expect(u).toContain('■ メニュー\n　・よもぎ蒸し（40分）\n　・フェイシャル（30分）\n\nまたの');
    const tail = (x) => x.trim().split('\n').slice(-4).join('\n');
    expect(tail(t)).toBe(tail(fns.customerBody(CT, ONE, SHOP)));
    expect(t.trim().split('\n').slice(-5)[0]).toBe('');
    const v = fns.cancelCustomerBody(C, ONE, { ...SHOP, line: '', tel: '' });
    expect(v).not.toContain('公式LINE'); expect(v).not.toContain('電話 ');
  });
  it('お店への知らせ（cancelShopBody）：名前・電話・メール・日時・メニュー・予約の番号・「この時間はあきました」', () => {
    const t = fns.cancelShopBody(CT, ONE);
    expect(t).toContain('お客さまがネット予約を取り消しました。\n\nお名前　　テスト 花子 様\n電話　　　090-0000-0000\nメール　　hana@example.com\n日時　　　3月12日（金） 10:00〜\nメニュー　よもぎ蒸し（40分）\n予約の番号　a1\n\nこの時間はあきました');
    const u = fns.cancelShopBody(CT, TWO);
    expect(u).toContain('メニュー　2つ\n　・よもぎ蒸し（40分）\n　・フェイシャル（30分）\n予約の番号');
    expect(u).not.toMatch(/undefined|null|NaN/);
  });
  it('使わない言葉が入っていない', () => {
    for (const b of [ONE, TWO]) {
      expect(fns.cancelCustomerBody(C, b, SHOP)).not.toMatch(/治る|必ず|極上|No\.1|デトックス|効果/);
      expect(fns.customerBody(CT, { ...b, ...LINKED }, SHOP)).not.toMatch(/治る|必ず|極上|No\.1|デトックス|効果/);
    }
  });
});
