# 予約カレンダー（Lift-Off の部品）

小さなお店の「ネット予約」。お店は営業時間を入れるだけ。お客さんはメニュー → 空いている開始時間 → 名前・電話 → 同意 → 予約。
このリポジトリは架空のお店 **hiyori** のデモ（https://yoyaku-demo.liftoff-358.workers.dev/ ）。お店ごとに、このフォルダをコピーして使う。

- `public/shop.jsonc` … **お店ごとの値はここだけ**（店名・色・LINE・電話・メニュー・片づけの分・きざみ・型の初期値・キャンセルの文・知らせの送り先・何日先まで・当日は何分前まで）
- `public/index.html` … お客さんの予約ページ
- `public/admin.html` … お店の画面（`/admin`。パスワード付き。ホーム画面に置くと「〇〇 予約管理」）
- `src/worker.js` … API（Cloudflare Workers）。保存は D1。表は最初のアクセスで自動で作る。**名前・電話・メールは保存しない**（予約が成功したら画面から Formspree へ送る）。日付・時刻は日本時間
- `tools/make_icon.py` … ホーム画面のアイコン `public/icon-180.png` を shop.jsonc の色で作る
- `wrangler.jsonc` … Cloudflare の設定（name・D1 の database_id）。`schema.sql` は表の控え

## 新しいお店で使う手順
1. **フォルダをコピー**：`cp -R ~/src/yoyaku-demo ~/src/yoyaku-〇〇`（`.git`・`.wrangler`・`.dev.vars` は入れない）
2. **shop.jsonc を書く**（店名・色・LINE・電話・メニュー・片づけ・型・キャンセルの文・Formspree の URL・何日先まで・当日は何分前まで）。仮の値には `// 仮` と書く。`python3 tools/make_icon.py` でアイコンを作り直す
3. **D1 を作る（チャット）**：Cloudflare → D1 → Create → 名前 `yoyaku-〇〇` → database_id を控える
4. **wrangler.jsonc** の `name` を `yoyaku-〇〇` に、`database_id` を 3 の値に
5. **手元で試す**：`cp .dev.vars.example .dev.vars`（ADMIN_PASSWORD を入れる）→ `npx -y wrangler@4 dev` → http://localhost:8787/ と /admin
6. **GitHub**：空の公開リポジトリ `suke358/yoyaku-〇〇` を作る → `git init && git add -A && git commit -m "〇〇 の予約カレンダー" && git remote add origin https://github.com/suke358/yoyaku-〇〇.git && git push -u origin main`
7. **Cloudflare につなぐ（チャット）**：Workers & Pages → Create → GitHub の `yoyaku-〇〇` → Workers Builds。確認用は `preview-yoyaku-〇〇.liftoff-358.workers.dev`
8. **ADMIN_PASSWORD（担当者）**：`npx wrangler secret put ADMIN_PASSWORD`（値は `~/お店のアカウント/` の決まりで。チャット・紙には書かない）
9. **試す**：お客さんの画面で予約 → お店の画面で見える → キャンセルで空く → Formspree にメールが届く。お店のスマホで `/admin` をホーム画面に追加
10. お店の HP の「ネットで予約する」の行き先を、この予約ページの住所（独自ドメインなら `yoyaku.〇〇.com` を Custom Domain で）に

## 決まり
- お客さんの情報（名前・電話・メール）はサーバーに残さない。D1 にあるのは日にち・時間・埋まっている時間だけ
- 同じ枠を同時に押しても、2つ目は 409（「たった今ほかの方の予約が入りました」）。確かめ方：`curl` で同じ枠を2本並行して POST → 200 と 409 が1つずつ
- `formspree` が空だと予約を受け付けない（「準備中」と出る）。D1 や通信が止まると「ただいまネット予約が使えません」と出る
- 片づけの分・きざみ・何日先まで・当日は何分前まで は shop.jsonc の1か所（画面とサーバーが同じ値を読む）
- 古いスマホ対策（var・function）はしてあるが、`-webkit-` の予備と `<wbr>` は省いている（デモ）。`inset` は使っていない
