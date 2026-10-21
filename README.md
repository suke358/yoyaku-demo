# 予約カレンダー（Lift-Off の部品）

小さなお店の「ネット予約」。お店は営業日の時間を入れるだけ。お客さんはメニュー → 空いている開始時間 → 名前・電話・メール → 同意 → 予約。
予約が入ると、**お店の Gmail から**お客さんへ確認メール・お店へ知らせが届く（Google Apps Script＝GAS）。
このリポジトリは架空のお店 **hiyori** のデモ（https://yoyaku-demo.liftoff-358.workers.dev/ ・デモではメールを送らず見本を出す）。お店ごとに、このフォルダをコピーして使う。

## ファイル
- `public/shop.jsonc` … **お店ごとの値はここだけ**（店名・短い名前・色・LINE・電話・お店のメール・住所・駐車場・メニュー・ほかのメニューの案内文・片づけの分・きざみ・営業日の型・予約の型・キャンセルの文・一言・何日先まで・当日は何分前まで・デモの切りかえ）。worker.js・画面・gas/Code.gs にお店の値は書かない
- `public/index.html` … お客さんの予約ページ
- `public/admin.html` … お店の画面（`/admin`。パスワード付き。ホーム画面に置くと「〇〇 予約管理」）
- `src/worker.js` … API（Cloudflare Workers）。保存は D1。表は最初のアクセスで自動で作る。**名前・電話・メールは保存しない**（枠を押さえたあと GAS へ渡すだけ。GAS が失敗したら枠を取り消す）。日付・時刻は日本時間
- `gas/Code.gs`・`gas/appsscript.json`・`gas/入れ方.md` … お店の Gmail からメールを送る係（許可は「メールの送信」だけ）
- `tools/make_icon.py` … ホーム画面のアイコン `public/icon-180.png` を shop.jsonc の色で作る（お店のロゴを使うなら手で置く）
- `wrangler.jsonc` … Cloudflare の設定（name・D1 の database_id）。`schema.sql` は表の控え
- 秘密の変数（Cloudflare の secret。git に入れない）：`ADMIN_PASSWORD`（お店の画面）・`GAS_URL`・`GAS_TOKEN`（メールの係）。手元は `.dev.vars`

## 新しいお店で使う手順
1. **フォルダをコピー**：`cp -R ~/src/yoyaku-demo ~/src/yoyaku-〇〇` → コピー先で `.git`・`.wrangler`・`.dev.vars` を除く（残っていたら消す）
2. **shop.jsonc を書く**：お店の値に全部書きかえる。**`demo` を `false` に、`demoPassword` の行を消す**。`mail` は GAS を入れる Google のメール。仮の値には `// 仮` と書く。アイコンは `python3 tools/make_icon.py` か、お店のロゴを `public/icon-180.png` に
3. **D1 を作る（チャット）**：Cloudflare → D1 → Create → 名前 `yoyaku-〇〇` → database_id を控える
4. **wrangler.jsonc** の `name` を `yoyaku-〇〇` に、`database_id` を 3 の値に
5. **手元で試す**：`cp .dev.vars.example .dev.vars`（ADMIN_PASSWORD を入れる。GAS はまだなくてよい＝「準備中」と出る）→ `PATH=/usr/local/bin:$PATH npx -y wrangler@4 dev` → http://localhost:8787/ と /admin
6. **GitHub**：空の公開リポジトリ `suke358/yoyaku-〇〇` を作る → `git init && git add -A && git commit -m "〇〇 の予約カレンダー" && git remote add origin https://github.com/suke358/yoyaku-〇〇.git && git push -u origin main`
7. **GAS をお店の Google に入れる**：`gas/入れ方.md` のとおり（お店の人が、シークレット ウィンドウで。合言葉は担当者が決めて渡す）→ ウェブアプリの URL をもらう
8. **Cloudflare に出す（担当者）**：`PATH=/usr/local/bin:$PATH npx -y wrangler@4 login` → `… wrangler@4 deploy` → https://yoyaku-〇〇.liftoff-358.workers.dev/ が 200
9. **secret 3つ（担当者がターミナルで。値は画面に出さない）**：`… wrangler@4 secret put ADMIN_PASSWORD`／`… secret put GAS_URL`／`… secret put GAS_TOKEN` → `/api/days` の `open` が true
10. **試す**：お客さんの画面で予約 → お客さんとお店にメール → お店の画面で見える → キャンセルで空く。お店のスマホで `/admin` をホーム画面に追加
11. **独自ドメイン（チャット）**：Cloudflare の Worker → Settings → Domains & Routes → Custom Domain `yoyaku.〇〇.com`。お店の HP の「ネットで予約する」の行き先をそこに

## 決まり
- お客さんの情報（名前・電話・メール）はサーバーに残さない。D1 にあるのは日にち・時間・埋まっている時間だけ
- 同じ枠を同時に押しても、2つ目は 409（「たった今ほかの方の予約が入りました」）。確かめ方：`curl` で同じ枠を2本並行して POST → 200 と 409 が1つずつ
- GAS の秘密の変数か `mail` がないと予約を受け付けない（「準備中」と出る）。GAS が返事をしない・合言葉が違うと、枠を取り消して「ご予約を完了できませんでした」。D1 や通信が止まると「ただいまネット予約が使えません」
- 片づけの分・きざみ・何日先まで・当日は何分前まで は shop.jsonc の1か所（画面とサーバーが同じ値を読む）。`daysAhead` 0 は上限なし
- 確認メールの文は `gas/Code.gs`（本物）と `src/worker.js` の mailPreview（デモの見本）の2か所。直すときは両方
- 古いスマホ対策（var・function）はしてあるが、`-webkit-` の予備と `<wbr>` は省いている
- デモの `demoPassword` は画面に出る（架空のお店だけ）。本番の shop.jsonc には書かない
