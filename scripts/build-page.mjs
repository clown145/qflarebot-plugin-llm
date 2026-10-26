#!/usr/bin/env node
/**
 * 把 web/ 下的页面打成一张单文件 HTML，写进 src/page.generated.ts。
 * 插件构建机不跑前端构建，所以生成物要提交；改了 web/ 就重跑 npm run build:page。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'web/main.ts')

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['/bridge.js'],
  minify: false,
  legalComments: 'none',
  logLevel: 'silent',
})

const js = result.outputFiles?.[0]?.text
if (!js) throw new Error('esbuild 没有产出 JS')

const [html, css] = await Promise.all([
  readFile(path.join(root, 'web/index.html'), 'utf8'),
  readFile(path.join(root, 'web/style.css'), 'utf8'),
])

const safeJs = js.replace(/<\/script/gi, '<\\/script')
const page = html
  .replace('<!--STYLE-->', `<style>\n${css}\n</style>`)
  .replace('<!--SCRIPT-->', `<script type="module">\n${safeJs}\n</script>`)

const out = `// 由 scripts/build-page.mjs 生成，不要手改。\nexport const PAGE_HTML = ${JSON.stringify(page)}\n`
await writeFile(path.join(root, 'src/page.generated.ts'), out)

console.log(`页面已生成：src/page.generated.ts（${(Buffer.byteLength(page) / 1024).toFixed(1)} KB）`)
