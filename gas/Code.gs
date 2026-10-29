// 予約カレンダー（Lift-Off の部品）：お店の Gmail からメールを送る係（Google Apps Script）2026/10/21
// Worker（src/worker.js）が、予約の枠を押さえたあとに、ここへ JSON を POST する。
// 送るのは2通：(a) お客さんへ確認メール (b) お店へ知らせ。action: 'reminder' のときは 2 日前のお知らせ 1 通（お客さんへ。2026/10/28）。MailApp だけを使う（許可を「メールの送信」だけにするため。appsscript.json の oauthScopes で送信だけに絞る）
// お店の情報（店名・電話・LINE・住所・駐車場・メール・キャンセルの決まり）は Worker が shop.jsonc から渡す。ここには書かない。
// 合言葉：「スクリプト プロパティ」の GAS_TOKEN。Worker の秘密の変数 GAS_TOKEN と同じ値にする。合わなければ何もしない。
// 入れ方は gas/入れ方.md

function doPost(e) {
  var out = { ok: false };
  try {
    var want = PropertiesService.getScriptProperties().getProperty('GAS_TOKEN') || '';
    var d = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!want || !d.token || d.token !== want) {
      return reply({ ok: false, error: 'token' });      // 合言葉が違う：何もしない
    }
    // 2 日前のお知らせ（2026/10/28。Worker の runReminder が action: 'reminder' で送ってくる）：お客さんへ 1 通だけ。お店への知らせは出さない。
    // 中身は d.reminder の下（旧版の Code.gs はこの形を input エラーで止めるので、貼り直す前に有効にしても予約確認メールは出ない）。返事に action を入れる（Worker がそれを見て印を付ける）
    if (d.action === 'reminder') {
      var rm = d.reminder || {};
      if (!rm.customer || !rm.booking || !rm.shop) return reply({ ok: false, error: 'input' });
      if (!rm.customer.email || !rm.shop.mail) return reply({ ok: false, error: 'mail' });
      var days = +d.daysBefore || 2;
      MailApp.sendEmail({
        to: rm.customer.email,
        replyTo: rm.shop.mail,
        name: rm.shop.name,
        subject: '【' + (rm.shop.shortName || rm.shop.name) + '】' + days + '日後のご予約のお知らせ',
        body: reminderBody(rm.customer, rm.booking, rm.shop, days)
      });
      return reply({ ok: true, action: 'reminder' });
    }
    if (!d.customer || !d.booking || !d.shop) return reply({ ok: false, error: 'input' });
    var c = d.customer, b = d.booking, s = d.shop;
    if (!c.email || !s.mail) return reply({ ok: false, error: 'mail' });

    // (a) お客さんへ確認メール
    MailApp.sendEmail({
      to: c.email,
      replyTo: s.mail,
      name: s.name,
      subject: '【' + (s.shortName || s.name) + '】ご予約を承りました',
      body: customerBody(c, b, s)
    });
    // (b) お店へ知らせ
    MailApp.sendEmail({
      to: s.mail,
      name: s.name + ' 予約カレンダー',
      subject: '【ネット予約】' + b.when + ' ' + c.name + ' 様',
      body: shopBody(c, b)
    });
    out = { ok: true };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return reply(out);
}

// ブラウザで URL を開いたときの表示（動いているかの確かめ用。メールは送らない）
function doGet() {
  return reply({ ok: true, hello: 'yoyaku mail' });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function customerBody(c, b, s) {
  var L = [];
  L.push(c.name + ' 様');
  L.push('');
  L.push('このたびは ' + s.name + ' にご予約いただき、ありがとうございます。');
  L.push('以下の内容でご予約を承りました。');
  L.push('');
  L.push('■ 日時　　' + b.when);
  // 複数メニュー（2026/10/28）：items に 1 つずつ入ってくる。1 行ずつ書き、施術の合計と所要時間（前後の時間込み）を添える。worker.js の mailPreview（デモの見本）と同じ形
  var many = b.items && b.items.length > 1;
  if (many) {
    L.push('■ メニュー');
    for (var i = 0; i < b.items.length; i++) L.push('　・' + b.items[i].name + '（' + b.items[i].min + '分' + (b.items[i].price ? '・' + b.items[i].price : '') + '）');
    L.push('■ 施術時間　合計' + b.min + '分');
  } else {
    L.push('■ メニュー　' + b.menu + '（' + b.min + '分）');
  }
  if (b.slot && b.slot !== b.min) L.push('■ 所要時間　約' + b.slot + '分（カウンセリング・お片づけ' + (b.extraNote ? '・' + b.extraNote : '') + 'を含む）');   // extraNote＝お化粧落としなど（shop.jsonc）
  if (b.price) L.push('■ 料金　　' + (many && /円/.test(b.price) ? '合計 ' : '') + b.price + (/円/.test(b.price) ? '（税込）' : ''));   // 「お問い合わせください」のときは「合計」も（税込）も付けない
  L.push('');
  L.push('■ キャンセルについて');
  L.push(s.cancelPolicy || '前日のキャンセルは料金の50%、当日のキャンセルは料金の100%をいただきます。');
  L.push('ご変更・キャンセルは、公式LINE かお電話（' + (s.tel || '') + '）でお知らせください。');
  if (s.line) L.push('公式LINE：' + s.line);
  L.push('');
  L.push('■ 場所');
  if (s.address) L.push(s.address);
  if (s.parking) L.push(s.parking);
  if (s.mapUrl) L.push('地図：' + s.mapUrl);
  L.push('');
  L.push('当日お会いできるのを楽しみにしております。');
  L.push('');
  L.push('―――');
  L.push(s.name);
  if (s.tel) L.push('電話 ' + s.tel);
  L.push('（このメールに返信すると、お店に届きます）');
  return L.join('\n');
}

// 2 日前のお知らせの文（料金は書かない。効果を断定する言葉は使わない）
function reminderBody(c, b, s, days) {
  var L = [];
  L.push(c.name + ' 様');
  L.push('');
  L.push(s.name + ' です。ご予約日の ' + days + ' 日前になりましたので、お知らせいたします。');
  L.push('');
  L.push('■ 日時　　' + b.when);
  if (b.items && b.items.length > 1) {
    L.push('■ メニュー');
    for (var i = 0; i < b.items.length; i++) L.push('　・' + b.items[i].name + (b.items[i].min ? '（' + b.items[i].min + '分）' : ''));
    if (b.min) L.push('■ 施術時間　合計' + b.min + '分');
  } else {
    L.push('■ メニュー　' + b.menu + (b.min ? '（' + b.min + '分）' : ''));
  }
  if (b.slot && b.slot !== b.min) L.push('■ 所要時間　約' + b.slot + '分（カウンセリング・お片づけ' + (b.extraNote ? '・' + b.extraNote : '') + 'を含む）');   // customerBody と同じ条件
  L.push('');
  if (s.cancelPolicy) { L.push('■ キャンセルについて'); L.push(s.cancelPolicy); }   // お店が決めていないときは書かない（勝手に作らない）
  L.push('ご都合が悪くなったときは、公式LINE かお電話' + (s.tel ? '（' + s.tel + '）' : '') + 'でお早めにご連絡ください。');
  if (s.line) L.push('公式LINE：' + s.line);
  L.push('');
  L.push('■ 場所');
  if (s.address) L.push(s.address);
  if (s.parking) L.push(s.parking);
  if (s.mapUrl) L.push('地図：' + s.mapUrl);
  L.push('');
  L.push('当日お会いできるのを楽しみにしております。');
  L.push('');
  L.push('―――');
  L.push(s.name);
  if (s.tel) L.push('電話 ' + s.tel);
  L.push('（このメールに返信すると、お店に届きます）');
  return L.join('\n');
}

function shopBody(c, b) {
  var L = [];
  L.push('ネット予約が入りました。');
  L.push('');
  L.push('お名前　　' + c.name + ' 様');
  L.push('電話　　　' + c.tel);
  L.push('メール　　' + c.email);
  L.push('日時　　　' + b.when);
  if (b.items && b.items.length > 1) {   // 複数メニュー：1 つずつ＋合計（2026/10/28）
    L.push('メニュー　' + b.items.length + 'つ（施術 合計' + b.min + '分・所要 約' + b.slot + '分）');
    for (var i = 0; i < b.items.length; i++) L.push('　・' + b.items[i].name + '（' + b.items[i].min + '分' + (b.items[i].price ? '・' + b.items[i].price : '') + '）');
    if (b.price) L.push('　' + (/円/.test(b.price) ? '合計 ' : '') + b.price);
  } else {
    L.push('メニュー　' + b.menu + '（' + b.min + '分）' + (b.price ? '　' + b.price : ''));
  }
  if (b.id) L.push('予約の番号　' + b.id);
  L.push('');
  L.push('お客さんには確認メールを送ってあります。予約の取り消しはお店の画面（/admin）から。');
  return L.join('\n');
}
