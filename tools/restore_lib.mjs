// 予約のバックアップ（JSON）→ D1 に戻す SQL を作る（純粋な処理。Node の道具もテストもここを使う。2026/10/26）

const TABLES = [
  'CREATE TABLE IF NOT EXISTS hours (date TEXT PRIMARY KEY, s TEXT NOT NULL, e TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, date TEXT NOT NULL, s TEXT NOT NULL, e TEXT NOT NULL, kind TEXT NOT NULL, menu TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', tel TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', mailng INTEGER NOT NULL DEFAULT 0)",
  'CREATE INDEX IF NOT EXISTS blocks_date ON blocks(date)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
];
const q = (v) => (v === null || v === undefined) ? 'NULL' : (typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");

/** バックアップの JSON → SQL の文の配列（表を作る文 ＋ INSERT）。テストからも使う */
export function toStatements(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.blocks)) throw new Error('バックアップの形が違います（version 1 の JSON ではない）');
  const out = [...TABLES];
  for (const h of data.hours || []) out.push(`INSERT INTO hours (date, s, e) VALUES (${q(h.date)}, ${q(h.s)}, ${q(h.e)})`);
  for (const b of data.blocks) out.push(`INSERT INTO blocks (id, date, s, e, kind, menu, created_at, name, tel, email, mailng) VALUES (${q(b.id)}, ${q(b.date)}, ${q(b.s)}, ${q(b.e)}, ${q(b.kind)}, ${q(b.menu || '')}, ${q(b.created_at || '')}, ${q(b.name || '')}, ${q(b.tel || '')}, ${q(b.email || '')}, ${q(+b.mailng || 0)})`);
  for (const s of data.settings || []) { if (s.key !== 'backup_last') out.push(`INSERT INTO settings (key, value) VALUES (${q(s.key)}, ${q(s.value)})`); }
  return out;
}
export function counts(data) { return { blocks: (data.blocks || []).length, hours: (data.hours || []).length, settings: (data.settings || []).filter((s) => s.key !== 'backup_last').length }; }

