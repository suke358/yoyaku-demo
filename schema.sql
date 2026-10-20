-- 予約カレンダーのデモ（hiyori）の表。名前・電話・メールは持たない
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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_date ON blocks(date);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,    -- 'pats'（営業日の型）'bpats'（予約の型）'step'（いつもの区切り）
  value TEXT NOT NULL      -- JSON
);
