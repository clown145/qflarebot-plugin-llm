import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./node_modules/@qqbot/plugin-cli/dist/stubs/cloudflare-workers.js', import.meta.url),
      ),
    },
  },
  test: {
    // web/ 有 DOM 相关单测（field() 的 for/id、dialog 状态机），需要 jsdom；
    // src/ 是 Worker 侧代码，保持 node 环境，避免 DOM 全局污染与 workers-types 冲突。
    // 注意：不要在根 test 里再写 include，projects 会继承它并让两个 project 都跑全部用例。
    projects: [
      {
        extends: true,
        test: {
          name: 'src',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: ['web/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
    ],
  },
})
