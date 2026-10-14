/* ============================================================
 *  生成「云端回测页」 paper/backtest.html
 *
 *  目的：把本地回测控制台搬到线上，云端自带数据集 ——
 *        即使本机文件全删了，打开网页就能对任意策略做回测验证。
 *
 *  原则：**不二次实现**。直接由本地 index.html 生成，只做 4 处替换：
 *    1. title / 顶部导航加「云端版」+ 回到「每日收益看板」的链接
 *    2. 删掉 <script src="output/dataset.js">（云端没有这个文件）
 *    3. 注入 window.__DS_URL__ = 'data/store.json'（每日自动更新的累积数据集，全量历史）
 *    4. 封板强度路径 output/seal-map.json → data/seal-map.json
 *  并顺带把 output/seal-map.json 复制到 data/ 一起上传。
 *
 *  node build-cloud.js
 * ============================================================ */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const SRC = path.join(ROOT, '..', 'index.html')
const OUT = path.join(ROOT, 'backtest.html')
const SEAL_SRC = path.join(ROOT, '..', 'output', 'seal-map.json')
const SEAL_DST = path.join(ROOT, 'data', 'seal-map.json')

const NAV = `  <div class="cloudbar">
    <a href="./">← 每日收益看板</a>
    <span class="sep">|</span>
    <a href="./backtest.html" class="on">策略回测（云端）</a>
    <span class="note">数据集 = 仓库内累积数据集 <code>data/store.json</code>，由每日收盘后的自动任务追加，<b>只增不减</b>；本页与本地「打板策略模拟器」共用同一份引擎源码</span>
  </div>
`

const NAV_CSS = `  .cloudbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 10px;font-size:12px}
  .cloudbar a{color:var(--accent);text-decoration:none;border:1px solid var(--bd);border-radius:5px;padding:4px 10px;background:#fff}
  .cloudbar a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
  .cloudbar .sep{color:var(--tx3)}
  .cloudbar .note{color:var(--tx3);font-size:11px}
  .cloudbar code{background:var(--bd2);padding:0 3px;border-radius:3px}
`

function render () {
  if (!fs.existsSync(SRC)) throw new Error('缺少源文件：' + SRC)
  let out = fs.readFileSync(SRC, 'utf8')
  const before = out

  /* 1. 标题 + 导航 */
  out = out.replace('<title>打板策略模拟器 · 连板接力回测</title>',
    '<title>打板策略模拟器（云端版）· 连板接力回测</title>')
  if (!out.includes('<body>')) throw new Error('index.html 结构已变更：找不到 <body>')
  out = out.replace('<body>', '<body>\n' + NAV)
  out = out.replace('</style>', NAV_CSS + '</style>')

  /* 2. 去掉 dataset.js 外链 */
  const dsRe = /<script src="output\/dataset\.js"[^>]*><\/script>\s*/
  if (!dsRe.test(out)) throw new Error('index.html 结构已变更：找不到 <script src="output/dataset.js">')
  out = out.replace(dsRe, '')

  /* 3. 注入外链数据集地址 */
  const stratTag = '<script src="lib/strategy.js"></script>'
  if (!out.includes(stratTag)) throw new Error('index.html 结构已变更：找不到 lib/strategy.js 引用')
  out = out.replace(stratTag, "<script>window.__DS_URL__='data/store.json'</script>\n" + stratTag)

  /* 4. 封板强度路径 */
  const n = out.split("fetch('output/seal-map.json')").length - 1
  if (n !== 1) throw new Error('index.html 结构已变更：seal-map 引用出现 ' + n + ' 次')
  out = out.replace("fetch('output/seal-map.json')", "fetch('data/seal-map.json')")

  if (out === before) throw new Error('没有任何替换生效')
  return out
}

/* --check：只校验 paper/backtest.html 是否与当前 index.html 同步（不写盘，漂移则退出非 0） */
function check () {
  const want = render()
  if (!fs.existsSync(OUT)) throw new Error('backtest.html 不存在，请先运行 node build-cloud.js')
  const have = fs.readFileSync(OUT, 'utf8')
  if (have === want) {
    console.log('  ✓ 云端回测页与 index.html 同步（' + (have.length / 1024).toFixed(0) + ' KB）')
    return true
  }
  console.error('  ✗ 云端回测页已过期：index.html 改过但没重新生成 → 请运行 node build-cloud.js')
  process.exitCode = 1
  return false
}

function build () {
  const out = render()
  fs.writeFileSync(OUT, out, 'utf8')

  /* 顺带复制封板强度映射 */
  let sealNote = '未找到 output/seal-map.json（云端将回退成交额排序）'
  if (fs.existsSync(SEAL_SRC)) {
    fs.mkdirSync(path.dirname(SEAL_DST), { recursive: true })
    fs.copyFileSync(SEAL_SRC, SEAL_DST)
    sealNote = '已复制 → data/seal-map.json（' + (fs.statSync(SEAL_DST).size / 1024).toFixed(0) + ' KB）'
  }

  console.log('  云端回测页已生成：backtest.html（' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB）')
  console.log('    数据集：data/store.json（每日自动追加）')
  console.log('    封板强度：' + sealNote)
  return { file: OUT, size: fs.statSync(OUT).size }
}

if (require.main === module) {
  try {
    if (process.argv.includes('--check')) check()
    else build()
  } catch (e) { console.error('生成失败：' + e.message); process.exit(1) }
}
module.exports = { build, check, render }
