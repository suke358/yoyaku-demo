#!/usr/bin/env node
// 予約のバックアップ（KV の JSON）から、D1 に戻す SQL を作る道具（2026/10/26）。
// 使い方：node tools/restore_backup.mjs backup.json > restore.sql   ／  node tools/restore_backup.mjs backup.json --counts（件数だけ）
// 本番の D1 には流さない（まずテスト用の空の D1 で）。README「戻す手順」。
import { readFileSync } from 'node:fs';
import { toStatements, counts } from './restore_lib.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error('使い方：node tools/restore_backup.mjs backup.json [--counts]'); process.exit(1); }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (process.argv.includes('--counts')) { console.log(JSON.stringify(counts(data))); }
  else { console.log(toStatements(data).map((s) => s + ';').join('\n')); }
}
