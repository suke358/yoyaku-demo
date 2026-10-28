// gas/Code.gs の文面（customerBody・shopBody・reminderBody）を Node で確かめる設定（2026/10/28）。GAS の MailApp は使わず、文を作る関数だけを読みこむ。本物の GAS は呼ばない
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test-gas/**/*.test.js'], environment: 'node' } });
