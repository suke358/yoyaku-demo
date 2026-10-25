// テストの設定（2026/10/25）。@cloudflare/vitest-plugin＝テストを本番と同じ Workers の実行環境（workerd）と D1 の中で動かす Cloudflare 公式の道具
// （前の名前 @cloudflare/vitest-pool-workers は更新が止まったので、新しい名前のほうを使う）
// wrangler.jsonc の設定（D1・shop.jsonc を文字として読む rules）をそのまま使う。D1 はテストごとにまっさら（isolatedStorage）
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      isolatedStorage: true,
      miniflare: {
        // テスト用の秘密の変数（本物ではない。お店の画面の API を呼ぶため）
        bindings: { ADMIN_PASSWORD: 'test-admin-password' },
      },
    }),
  ],
  test: { include: ['test/**/*.test.js'] },
});
