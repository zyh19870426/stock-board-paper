/* ============================================================
 *  累积数据集（策略池）  stock-board-paper/lib/store.js
 *
 *  ★ 与 build-dataset.js 的滚动窗口不同：这里的数据集**只增不减**
 *    —— 交易日只追加、票池只增（新出现的「曾连板 ≥2」票自动纳入），
 *    这样模拟账户的起点永远不会被滚动窗口吃掉，历史可随时重放验证。
 *
 *  格式与 dataset.json 同构（dates / warmup / st{code:{n,d0,k}}），
 *  可直接喂给 lib/strategy.js 的 runBacktest。
 * ============================================================ */
'use strict'
const fs = require('fs')
const M = require('./strategy.js')

const encodeOne = b => Math.round(b[1] * 100) + ',' + Math.round(b[2] * 100) + ',' +
  Math.round(b[3] * 100) + ',' + Math.round(b[4] * 100) + ',' + Math.round(b[5])

function encodeBars (bars, dateIdx) {
  const parts = []
  let cur = -1
  for (const b of bars) {
    const gi = dateIdx.get(b[0])
    if (gi === undefined) continue
    while (cur >= 0 && cur < gi - 1) { parts.push('-'); cur++ }
    parts.push(encodeOne(b))
    cur = gi
  }
  return parts.join(';')
}

/* 该票 k 目前覆盖到的全局索引（段数 = lastGi - d0 + 1） */
const lastGiOf = raw => raw.d0 + String(raw.k).split(';').length - 1

/* 是否「曾出现连板 ≥2」——决定是否纳入票池（与 build-dataset 同规则） */
function everBoarded (code, bars, dateIdx) {
  let run = 0, maxRun = 0
  for (let i = 1; i < bars.length; i++) {
    if (dateIdx.get(bars[i][0]) - dateIdx.get(bars[i - 1][0]) !== 1) run = 0
    const luC = M.limitUpCents(code, Math.round(bars[i - 1][2] * 100))
    const cC = Math.round(bars[i][2] * 100)
    const ratio = bars[i][2] / bars[i - 1][2] - 1
    const isZt = Math.abs(cC - luC) <= 5 && ratio <= (M.limitPct(code) + 0.006)
    run = isZt ? run + 1 : 0
    if (run > maxRun) maxRun = run
  }
  return maxRun
}

/* 从某只票的 220 根日线里，裁出「>= fromDate」的部分 */
function cutFrom (bars, fromDate) {
  const out = bars.filter(b => b[0] >= fromDate)
  return out
}

/* ---------------- 初始化：从本地 dataset.json 播种 ----------------
 *  keepDays：>0 只保留最近 N 个交易日（早期为省体积用的 90）；
 *            <=0 或显式传 0 → **保留全部历史**（云端回测需要长窗口，如 175 日）。 */
function initFromDataset (datasetPath, keepDays) {
  const ds = JSON.parse(fs.readFileSync(datasetPath, 'utf8'))
  const keep = keepDays == null ? 90 : keepDays
  const from = keep <= 0 ? 0 : Math.max(0, ds.dates.length - keep)
  const dates = ds.dates.slice(from)
  const st = {}
  let kept = 0
  for (const code in ds.st) {
    const raw = ds.st[code]
    const segs = String(raw.k).split(';')
    const cut = from - raw.d0
    if (cut >= segs.length) continue                 // 该票在窗口内完全没有数据
    let d0, k
    if (cut <= 0) { d0 = raw.d0 - from; k = segs.join(';') } else { d0 = 0; k = segs.slice(cut).join(';') }
    if (String(k).split(';').every(x => x === '-' || x === '')) continue
    st[code] = { n: raw.n, d0, k }
    kept++
  }
  const store = {
    meta: {
      seededFrom: datasetPath,
      seedThrough: ds.dates[ds.dates.length - 1],
      built: new Date().toISOString(),
      kept, startDate: dates[0], lastDate: dates[dates.length - 1],
      through: dates[dates.length - 1],
      note: '累积数据集：交易日只追加、票池只增。价格单位「分」，不复权。'
    },
    dates,
    warmup: 45,
    st
  }
  return store
}

/* ---------------- 每日增量：追加新交易日 + 纳入新票 ---------------- */
/* ---------------- 盘中护栏：决定「今天」这根日线能不能落库 ----------------
 * 为什么必须有：appendDays 只按「日期 > 末日」追加，
 * 一旦把**盘中尚未走完的半截日线**当成收盘写进去，它会永久留在历史里且无法自愈
 * ——收盘后重跑时那天的日期已存在，不会再追加，坏数据就永远留在数据集里。
 *
 * 而本工作流会被「页面上点加入模拟 / 移出模拟」随时手动触发 ⇒ 任何时间点都可能中招。
 * （2026-10-15 09:48 实测踩到：手动触发把当天 10:51 的盘中快照写成了「收盘」，
 *   成交量只有正常交易日的 23%~27%，且当晚 15:40 定时任务不会纠正它。）
 *
 * 规则：北京时间 **15:05**（收盘 15:00 + 5 分钟缓冲）之前，一律不接受「今天」这一天。
 * 非交易日不受影响（那天本来就没有日线）。
 * -------------------------------------------------------------------------- */
const CLOSE_MIN = 15 * 60 + 5          // 15:05 → 距零点的分钟数
const BJ_OFFSET_MS = 8 * 3600 * 1000   // 中国无夏令时，固定 +8

/** 北京时间。nowMs 可注入（测试用），不传取当前时刻 */
function beijingNow (nowMs) {
  const t = new Date((nowMs == null ? Date.now() : nowMs) + BJ_OFFSET_MS)
  return { date: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes() }
}
const isMarketClosed = bjm => bjm.min >= CLOSE_MIN

/** 未收盘时，把 barsMap 里「今天及以后」的日线整根剔掉。就地修改并返回剔掉了什么 */
function dropUnfinishedToday (barsMap, today, closed) {
  if (closed) return { dropped: 0, days: [] }
  let dropped = 0
  const days = new Set()
  for (const code in barsMap) {
    const bars = barsMap[code]
    const kept = bars.filter(x => x[0] < today)
    if (kept.length !== bars.length) {
      dropped += bars.length - kept.length
      bars.filter(x => x[0] >= today).forEach(x => days.add(x[0]))
    }
    barsMap[code] = kept
  }
  return { dropped, days: [...days].sort() }
}

/* ---------------- 自愈：把已经躺进数据集里的「盘中半截日线」删掉 ----------------
 * dropUnfinishedToday 只能挡住**新写入**；对已经被写进去的坏数据无能为力
 * —— appendDays 只按「日期 > 末日」追加，收盘后重跑时那个日期已存在 ⇒ 永远不纠正。
 * 所以还要能反悔：末位日期 >= 今天且尚未收盘 ⇒ 这根日线不可能是最终值，整根删掉。
 * 删除后各票 k 段数按「新日期数 − d0」截断；截空的票从票池移除。
 * （2026-10-15 10:0x 用于修复云端被 09:51 手动触发污染的 10-15 日线。） */
function trimTrailingUnfinished (store, today, closed) {
  if (closed) return { dropped: null, days: [], stocks: 0 }
  const bad = store.dates.filter(d => d >= today)
  if (!bad.length) return { dropped: null, days: [], stocks: 0 }

  const keep = store.dates.length - bad.length
  const removedStocks = []
  for (const code in store.st) {
    const raw = store.st[code]
    const need = keep - raw.d0                 // 该票在新窗口里应有几段
    if (need <= 0) { removedStocks.push(code); delete store.st[code]; continue }
    const segs = String(raw.k).split(';')
    if (segs.length > need) raw.k = segs.slice(0, need).join(';')
    if (!String(raw.k).split(';').some(x => x !== '-' && x !== '')) { removedStocks.push(code); delete store.st[code] }
  }
  store.dates = store.dates.slice(0, keep)
  if (store.meta) {
    store.meta.lastDate = store.dates[store.dates.length - 1]
    store.meta.through = store.dates[store.dates.length - 1]
    store.meta.kept = Object.keys(store.st).length
    store.meta.repairedAt = new Date().toISOString()
    store.meta.repairedNote = '剔除盘中半截日线 ' + bad.join('、')
  }
  delete store._parsed
  delete store._boards
  return { dropped: bad.join('、'), days: bad, stocks: removedStocks.length }
}

function appendDays (store, barsMap, nameOf) {
  const lastKnown = store.dates[store.dates.length - 1]
  const nd = new Set()
  for (const code in barsMap) {
    const bars = barsMap[code]
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i][0] <= lastKnown) break
      nd.add(bars[i][0])
    }
  }
  const newDays = [...nd].sort()
  if (!newDays.length) return { added: 0, newStocks: 0, newDays: [] }

  const baseIdx = store.dates.length                   // 首个新日期的全局索引
  const newDates = store.dates.concat(newDays)
  const dateIdx = new Map(newDates.map((d, i) => [d, i]))

  /* 1) 存量票：按占位补齐后追加 */
  let appended = 0
  for (const code in store.st) {
    const raw = store.st[code]
    const bars = barsMap[code]
    const map = bars ? new Map(bars.map(b => [b[0], b])) : null
    let add = '', lastGi = lastGiOf(raw)
    for (let i = 0; i < newDays.length; i++) {
      const gi = baseIdx + i
      while (lastGi < gi - 1) { add += ';-'; lastGi++ }
      const b = map && map.get(newDays[i])
      add += ';' + (b ? encodeOne(b) : '-')
      lastGi = gi
    }
    raw.k += add
    appended++
  }

  /* 2) 新票：不在池中、但这 220 天窗口里曾连板 ≥2 → 纳入（票池只增） */
  let newStocks = 0
  for (const code in barsMap) {
    if (store.st[code]) continue
    if (!/^(60|00|30)/.test(code)) continue
    const bars = barsMap[code].filter(b => dateIdx.has(b[0]))
    if (bars.length < 20) continue
    if (everBoarded(code, bars, dateIdx) < 2) continue
    store.st[code] = { n: (nameOf && nameOf[code]) || code, d0: dateIdx.get(bars[0][0]), k: encodeBars(bars, dateIdx) }
    newStocks++
  }

  store.dates = newDates
  store.meta.lastDate = newDates[newDates.length - 1]
  store.meta.through = newDates[newDates.length - 1]
  store.meta.kept = Object.keys(store.st).length
  store.meta.built = new Date().toISOString()
  delete store._parsed
  delete store._boards
  return { added: newDays.length, newStocks, newDays, appended }
}

/* ---------------- 读写 ---------------- */
function load (file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (j.meta && !j.meta.through) j.meta.through = j.dates[j.dates.length - 1]
  return j
}
function save (file, store) {
  if (store.meta) store.meta.through = store.dates[store.dates.length - 1]
  fs.mkdirSync(require('path').dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(store), 'utf8')
  return fs.statSync(file).size
}

module.exports = { initFromDataset, appendDays, encodeBars, encodeOne, everBoarded, lastGiOf, cutFrom, load, save,
  CLOSE_MIN, beijingNow, isMarketClosed, dropUnfinishedToday, trimTrailingUnfinished }
