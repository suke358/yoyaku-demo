-- 予約カレンダーのデモ（hiyori）の表（控え。本物は src/worker.js の SCHEMA＋migrate が最初のアクセスで作る）
-- 2026/10/25：blocks に 名前・電話・メールの列を足した（お店の画面で見る用。来店日の翌日に自動で空にする）。
--   前からある表には worker.js の migrate が ALTER TABLE blocks ADD COLUMN name/tel/email TEXT NOT NULL DEFAULT '' で足す（手で流すなら同じ 3 文）
-- 作り方：手元 npx wrangler d1 execute yoyaku-demo --local --file schema.sql ／ 本番 --remote
CREATE TABLE IF NOT EXISTS hours (
  date TEXT PRIMARY KEY,   -- "2026-10-21"
  s TEXT NOT NULL,         -- "10:00"
  e TEXT NOT NULL          -- "18:00"
);
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  s TEXT NOT NULL,         -- 始まり
  e TEXT NOT NULL,         -- 終わり（片づけの時間込み）
  kind TEXT NOT NULL,      -- 'net'（ネット予約）か 'man'（お店が手で入れた）
  menu TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',   -- お客さんの名前（ネット予約・手入力は任意）。翌日に ''
  tel TEXT NOT NULL DEFAULT '',    -- 電話（ネット予約だけ）。翌日に ''
  email TEXT NOT NULL DEFAULT ''   -- メール（ネット予約だけ）。翌日に ''
);
CREATE INDEX IF NOT EXISTS blocks_date ON blocks(date);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,    -- 'pats'（営業日の型）'bpats'（予約の型）'step'（いつもの区切り）
  value TEXT NOT NULL      -- JSON
);

-- 合言葉の連続ミス（2026/10/25）：接続元 IP ごとの回数と止める期限（5 回で 10 分）。IP はここにだけ。day（日本時間）の翌日に消える。
-- お店の人が止まってしまったとき、担当者が今すぐ解除する 1 コマンド（そのお店のフォルダで）：
--   PATH=/usr/local/bin:$PATH npx -y wrangler@4 d1 execute <database_name> --remote --command "DELETE FROM auth_fail"
CREATE TABLE IF NOT EXISTS auth_fail (ip TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until TEXT NOT NULL DEFAULT '', day TEXT NOT NULL);

-- いたずら対策 A（2026/10/26）：/api/book への送信の記録（接続元 IP と時刻）。同じ IP から 10 分に 5 回まで。10 分たった行はアクセスのたびに消す（IP はここにだけ）。
-- B'（同じ電話・メールの未来のネット予約は 3 件まで）は blocks を数えるだけで表は増えない。デモ（demo:true）では両方とも見ない。
CREATE TABLE IF NOT EXISTS book_rate (ip TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS book_rate_ip ON book_rate(ip);
