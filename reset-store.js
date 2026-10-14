/* ============================================================
 *  把累积数据集(data/store.json)升级为「全量历史」一次性修复脚本
 *
 *  背景：早期播种用了 keepDays=90，导致 store.json 只覆盖最近 90 个交易日
 *        → 云端回测页最多只能跑 90 天窗口。
 *  做法：以本地 output/dataset.json（全量历史，至 2026-10-13）为基座，
 *        把现有 store.json 里比它更新的交易日（2026-10-14）与新纳入的票补上，
 *        结果仍是「只增不减」的累积数据集，但覆盖全部历史。
 *
 *  node reset-store.js [--dry]
 * ============================================================ */
'use strict'
const fs = require('fs')
const path = require('path')
const ST = require('./lib/store.js')

const DATA = path.join(__dirname, 'data')
const STORE_FILE = path.join(DATA, 'store.json')
const LOCAL_DATASET = path.join(__dirname, '..', 'output', 'dataset.json')
const DRY = process.argv.includes('--dry')

/* 把 {n,d0,k} 解码成 [date, o, c, h, l, v]（o~l 单位「分」→ 元，v 单位「手」） */
function decode (raw, dates) {
  const segs = String(raw.k).split(';')
  const out = []
  let gi = raw.d0
  for (const s of segs) {
    if (s === '' || s === '-') { gi++; continue }
    const f = s.split(',')
    out.push([dates[gi], +f[0] / 100, +f[1] / 100, +f[2] / 100, +f[3] / 100, +f[4]])
    gi++
  }
  return out
}

function main () {
  if (!fs.existsSync(LOCAL_DATASET)) throw new Error('缺少本地全量数据集：' + LOCAL_DATASET)
  if (!fs.existsSync(STORE_FILE)) throw new Error('缺少累积数据集：' + STORE_FILE)

  const cur = ST.load(STORE_FILE)
  console.log('现有 store.json：' + cur.dates.length + ' 天（' + cur.dates[0] + ' ~ ' + cur.dates[cur.dates.length - 1] + '）／' + Object.keys(cur.st).length + ' 只票')

  /* 1. 以全量 dataset.json 为基座（keepDays = 0 → 全量） */
  const base = ST.initFromDataset(LOCAL_DATASET, 0)
  console.log('基座 dataset.json：' + base.dates.length + ' 天（' + base.dates[0] + ' ~ ' + base.dates[base.dates.length - 1] + '）／' + Object.keys(base.st).length + ' 只票')

  /* 2. 把现有 store 的全部日线解码成 barsMap（用于补齐比基座更新的交易日 + 新票） */
  const barsMap = {}
  const nameOf = {}
  for (const code in cur.st) {
    barsMap[code] = decode(cur.st[code], cur.dates)
    nameOf[code] = cur.st[code].n
  }

  /* 3. 增量合并 */
  const ap = ST.appendDays(base, barsMap, nameOf)
  console.log('合并：新增 ' + ap.added + ' 个交易日' + (ap.newDays.length ? '（' + ap.newDays.join('、') + '）' : '') +
    '，新纳入 ' + ap.newStocks + ' 只票')

  const merged = base
  console.log('合并后：' + merged.dates.length + ' 天（' + merged.dates[0] + ' ~ ' + merged.dates[merged.dates.length - 1] + '）／' +
    Object.keys(merged.st).length + ' 只票，warmup=' + merged.warmup)

  /* 4. 自检：可回测窗口长度（warmup 之后 / 倒推 175 天仍够） */
  const usable = merged.dates.length - merged.warmup
  console.log('可回测区间：' + merged.dates[merged.warmup] + ' ~ ' + merged.dates[merged.dates.length - 1] + '（' + usable + ' 个交易日）')
  if (usable < 120) console.log('  ⚠️ 可用窗口偏短，检查 dataset.json 是否完整')

  /* 5. 抽查：合并后的票在重叠区间的日线应与基座完全一致（基座即 dataset.json，等价性由构造保证） */
  let checked = 0, bad = 0
  for (const code in merged.st) {
    if (!cur.st[code]) continue
    if (checked >= 80) break
    const segs = String(merged.st[code].k).split(';')
    const d0 = merged.st[code].d0
    const gLast = merged.dates.length - 1
    const lastSeg = segs[gLast - d0]
    const curBars = barsMap[code]
    const curLast = curBars[curBars.length - 1]
    checked++
    if (!curLast || curLast[0] !== merged.dates[gLast]) { bad++; continue }
    const expect = Math.round(curLast[1] * 100) + ',' + Math.round(curLast[2] * 100) + ',' + Math.round(curLast[3] * 100) + ',' + Math.round(curLast[4] * 100) + ',' + curLast[5]
    if (lastSeg !== expect) bad++
  }
  console.log('抽查 ' + checked + ' 只票的最后一个交易日 → 不一致 ' + bad + ' 只')

  if (DRY) { console.log('--dry：未写盘'); return }

  fs.copyFileSync(STORE_FILE, STORE_FILE + '.bak-before-fullhistory')
  const size = ST.save(STORE_FILE, merged)
  console.log('已写回 ' + STORE_FILE + '（' + (size / 1048576).toFixed(2) + ' MB），备份 ' + path.basename(STORE_FILE) + '.bak-before-fullhistory')
}

main()
