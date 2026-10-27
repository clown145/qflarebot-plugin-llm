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
  // 产物要提交且 CI 用 git diff 校验：必须固定 absWorkingDir，否则 esbuild 的
  // `// web/api.ts` 这类注释会随 process.cwd() 变化，同一份源码在不同目录跑出不同字节。
  absWorkingDir: root,
  minify: true,
  legalComments: 'none',
  logLevel: 'silent',
})

const js = result.outputFiles?.[0]?.text
if (!js) throw new Error('esbuild 没有产出 JS')

const [html, css] = await Promise.all([
  readFile(path.join(root, 'web/index.html'), 'utf8'),
  readFile(path.join(root, 'web/style.css'), 'utf8'),
])

// `</script` 会提前结束内联脚本；`<!--` 在 HTML 解析里也有特殊含义，一并转义
const safeJs = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')

/**
 * 用函数式 replace：字符串形式的替换值里 `$&`、`$1`、`$\`` 有特殊含义，
 * CSS/JS 里出现这些序列会把整段 HTML 插进来。函数返回值不做任何替换解释。
 */
const page = html
  .replace('<!--STYLE-->', () => `<style>\n${css}\n</style>`)
  .replace('<!--SCRIPT-->', () => `<script type="module">\n${safeJs}\n</script>`)

const out = `// 由 scripts/build-page.mjs 生成，不要手改。\nexport const PAGE_HTML = ${JSON.stringify(page)}\n`
await writeFile(path.join(root, 'src/page.generated.ts'), out)

console.log(`页面已生成：src/page.generated.ts（${(Buffer.byteLength(page) / 1024).toFixed(1)} KB）`)
