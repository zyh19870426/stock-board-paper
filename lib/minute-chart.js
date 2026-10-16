/* ============================================================
 *  当日分时序列采集（画图用）  stock-board-paper/lib/minute-chart.js
 *
 *  为什么（2026-10-16）：
 *    用户要求「今日操作股票，要显示该股票的今日分时图」。
 *    现有的 minute-log.js 只存「一条汇总关键 bar」（aucO/p0935/vwap0930/...），
 *    是为「9:30–9:35 买入偏离」大样本追踪设计的，**不含逐根序列** ⇒ 画不出图。
 *    ⇒ 新增本模块：把当日「有操作的股票」（今日买入 + 今日卖出 + 持仓 + 明日候选）
 *      的 5 分钟全序列存下来，前端据此画分时。
 *
 *  存什么（每票每天一条序列）：
 *    { date, code, name, lbc, prevC, bars:[{ t:"09:35", o,h,l,c,v }...] }
 *    - bars 覆盖 09:35 … 15:00（新浪 scale=5 每个交易日 48 根）
 *    - prevC = 昨日收盘（画「昨收」水平基准线用；取自前一根 bar 的前一日最后一根 close）
 *
 *  数据源：新浪 getKLineData scale=5（与 minute-log.js 同源，本环境可达）。
 *  铁律：
 *    ① 只增不减，按 code+date 去重（同日重复跑不覆盖）；
 *    ② 只保留最近 KEEP_DAYS 个交易日，防止文件无限膨胀；
 *    ③ 失败绝不影响主流程（采集异常一律吞掉，返回统计）。
 * ============================================================ */
'use strict'
const fs = require('fs')
const https = require('https')

const SCALE = 5
const KEEP_DAYS = 8            /* 只留最近 8 个交易日（每天约 4~10 票 × 48 根，体积可控） */

const symbolOf = code => /^(60|68)/.test(code) ? 'sh' + code : /^(00|30)/.test(code) ? 'sz' + code : null

function httpGet (u, timeout) {
  return new Promise(resolve => {
    const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn' }, timeout: timeout || 15000 }, res => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', d => (b += d))
      res.on('end', () => resolve(b))
    })
    req.on('error', () => resolve(''))
    req.on('timeout', () => { req.destroy(); resolve('') })
  })
}

/** 取一只票的 5 分钟 bars（近约 1 个月），返回 [{day,h,l,o,c,v}] */
async function fetch5m (code) {
  const sym = symbolOf(code)
  if (!sym) return []
  const url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=' +
    sym + '&scale=' + SCALE + '&ma=no&datalen=1023'
  const txt = await httpGet(url)
  try {
    const j = JSON.parse(txt)
    if (!Array.isArray(j)) return []
    return j.map(b => ({ day: b.day, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume }))
  } catch (_) { return [] }
}

/** 从 bars 里抽出某天的 48 根序列 + 昨收 */
function pickSeries (bars, date) {
  const byDay = {}
  bars.forEach(b => {
    const [dd, tt] = String(b.day).split(' ')
    if (!dd || !tt) return
    ;(byDay[dd] || (byDay[dd] = [])).push({ t: tt.slice(0, 5), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })
  })
  const days = Object.keys(byDay).sort()
  const i = days.indexOf(date)
  if (i < 0) return null
  const today = byDay[days[i]].slice().sort((a, b) => a.t < b.t ? -1 : 1)
  if (!today.length) return null
  /* 昨收：上一交易日的最后一根 close；无上一日则用今日开盘（前端退化为以开盘为基准） */
  let prevC = null
  if (i > 0) { const prev = byDay[days[i - 1]]; if (prev && prev.length) prevC = prev[prev.length - 1].c }
  const r2 = x => x == null ? null : +x.toFixed(2)
  return {
    prevC: r2(prevC),
    bars: today.map(b => ({ t: b.t, o: r2(b.o), h: r2(b.h), l: r2(b.l), c: r2(b.c), v: Math.round(b.v || 0) }))
  }
}

/**
 * 采集一批票的当日分时序列，追加进文件。
 * @param file  文件路径（JSON：{ updated, rows:[...] }）
 * @param date  当日 YYYY-MM-DD
 * @param items [{code,name,lbc}]
 * @param opts  { dry, budgetMs }
 * @returns { added, total, failed }
 */
async function collect (file, date, items, opts) {
  const o = opts || {}
  const t0 = Date.now()
  const budget = o.budgetMs || 90000

  let log = { updated: null, rows: [] }
  try { if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && Array.isArray(j.rows)) log = j } } catch (_) {}

  const seen = new Set(log.rows.map(r => r.code + '@' + r.date))
  const uniq = []
  const seenBatch = new Set()
  ;(items || []).forEach(it => {
    if (!it || !it.code || !symbolOf(it.code)) return
    if (seenBatch.has(it.code)) return
    seenBatch.add(it.code)
    if (seen.has(it.code + '@' + date)) return
    uniq.push(it)
  })

  let added = 0
  const failed = []
  for (const it of uniq) {
    if (Date.now() - t0 > budget) { failed.push(it.code + '(超时预算)'); continue }
    const bars = await fetch5m(it.code)
    const s = pickSeries(bars, date)
    if (!s) { failed.push(it.code); continue }
    log.rows.push({
      date, code: it.code, name: it.name || '', lbc: it.lbc != null ? it.lbc : null,
      prevC: s.prevC, bars: s.bars
    })
    added++
  }

  if (added && !o.dry) {
    log.updated = new Date().toISOString()
    /* 只保留最近 KEEP_DAYS 个交易日 */
    const days = [...new Set(log.rows.map(r => r.date))].sort()
    const keep = new Set(days.slice(-KEEP_DAYS))
    log.rows = log.rows.filter(r => keep.has(r.date))
    fs.writeFileSync(file, JSON.stringify(log), 'utf8')
  }

  return { added, total: log.rows.length, failed }
}

module.exports = { collect, fetch5m, pickSeries, symbolOf, KEEP_DAYS }
