/* 同步引擎：把上层项目的 lib/*.js 复制到 paper/lib/
 * 用法：node sync-engine.js   （每次改了引擎后跑一次，再提交）
 * 校验：输出两侧哈希，不一致会退出非 0 */
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const FILES = ['strategy.js', 'regime.js']   // regime.js = M2 动态切换规则单一真源
const h = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12)

let ok = true
for (const f of FILES) {
  const SRC = path.join(__dirname, '..', 'lib', f)
  const DST = path.join(__dirname, 'lib', f)
  if (!fs.existsSync(SRC)) { console.error('找不到源引擎：' + SRC); process.exit(1) }
  fs.mkdirSync(path.dirname(DST), { recursive: true })
  fs.copyFileSync(SRC, DST)
  const hs = h(SRC), hd = h(DST)
  console.log('引擎已同步 ' + f + '  src ' + hs + '  →  dst ' + hd + (hs === hd ? '  ✓' : '  ✗ 不一致'))
  if (hs !== hd) ok = false
}
if (!ok) process.exit(1)
