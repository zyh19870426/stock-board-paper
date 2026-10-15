/* ============================================================
 *  当日分时增量采集  stock-board-paper/lib/minute-log.js
 *
 *  为什么（2026-10-15）：
 *    分钟级历史数据源都只回溯约 1 个月（新浪 scale=5 → 22 交易日；
 *    腾讯 m5 → 7.5 天；东财本环境不通）。
 *    ⇒ 「09:30–9:35 买入相对开盘价的偏离」只能测到 12 笔，样本太小。
 *    解法：每天收盘后顺手把「当日候选 + 持仓」的开盘/早盘关键 bar 存下来，
 *    只增不减，几个月后自然积累成大样本（n=200+），可长期追踪这个偏差。
 *
 *  存什么（每票每天一条）：
 *    date / code / name / lbc(打板当日的板数，用于分层)
 *    aucO  09:25 集合竞价开盘价（= 当日首根 5min bar 的 open）
 *    p0935 09:30–09:35 那根 bar 的 close（「9:35 前买完」的近似成交价）
 *    vwap0930 09:30–09:35 成交量加权均价（更接近分散挂单的均价）
 *    p0940 09:35–09:40 那根 bar 的 close（延后一根的情形）
 *    hi/lo  09:30–09:35 区间高低（衡量该 5 分钟的波动幅度）
 *
 *  数据源：新浪 getKLineData scale=5（与 analyze-open-buy.js 同源）。
 *  铁律：① 只追加、按 code+date 去重（同日重复跑不重复写）；② 失败绝不影响主流程。
 * ============================================================ */
'use strict'
const fs = require('fs')
const https = require('https')

const SCALE = 5

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

/** 取一只票的 5 分钟 bars，返回 [{day,h,l,o,c,v,a}]（失败返回 []） */
async function fetch5m (code) {
  const sym = symbolOf(code)
  if (!sym) return []
  const url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=' +
    sym + '&scale=' + SCALE + '&ma=no&datalen=1023'
  const txt = await httpGet(url)
  try {
    const j = JSON.parse(txt)
    if (!Array.isArray(j)) return []
    return j.map(b => ({ day: b.day, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume, a: +b.amount }))
  } catch (_) { return [] }
}

/** 从 bars 里抽某天的关键 bar */
function pickDay (bars, date) {
  const d = {}
  bars.forEach(b => {
    const [dd, tt] = String(b.day).split(' ')
    if (dd !== date) return
    d[tt.slice(0, 5)] = b
  })
  const b0 = d['09:35']   // 09:30:00–09:35:00
  const b1 = d['09:40']   // 09:35:00–09:40:00
  if (!b0) return null
  return {
    aucO: +b0.o.toFixed(2),
    p0935: +b0.c.toFixed(2),
    vwap0930: b0.v > 0 ? +(b0.a / b0.v).toFixed(3) : null,
    p0940: b1 ? +b1.c.toFixed(2) : null,
    hi: +Math.max(b0.h, b0.o).toFixed(2),
    lo: +Math.min(b0.l, b0.o).toFixed(2)
  }
}

/**
 * 采集一批票的当日分时，追加进 log 文件。
 * @param file  日志文件路径（JSON：{ updated, rows: [...] }）
 * @param date  当日 YYYY-MM-DD
 * @param items [{code, name, lbc}]  —— 含重复会自动去重
 * @param opts  { dry: true 时不写盘, budgetMs: 总时间预算（默认 90s） }
 * @returns { added, skipped, total, failed }
 */
async function collect (file, date, items, opts) {
  const o = opts || {}
  const t0 = Date.now()
  const budget = o.budgetMs || 90000

  /* 读已有（容错：文件损坏则从空开始，绝不抛） */
  let log = { updated: null, rows: [] }
  try { if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && Array.isArray(j.rows)) log = j } } catch (_) {}

  const seen = new Set(log.rows.map(r => r.code + '@' + r.date))
  /* 去重 + 只保留有 6 位代码的 */
  const uniq = []
  const seenBatch = new Set()
  ;(items || []).forEach(it => {
    if (!it || !it.code || !symbolOf(it.code)) return
    const k = it.code
    if (seenBatch.has(k)) return
    seenBatch.add(k)
    if (seen.has(it.code + '@' + date)) return
    uniq.push(it)
  })

  let added = 0
  const failed = []
  for (const it of uniq) {
    if (Date.now() - t0 > budget) { failed.push(it.code + '(超时预算)'); continue }
    const bars = await fetch5m(it.code)
    const p = pickDay(bars, date)
    if (!p) { failed.push(it.code); continue }
    log.rows.push({
      date, code: it.code, name: it.name || '', lbc: it.lbc != null ? it.lbc : null,
      aucO: p.aucO, p0935: p.p0935, vwap0930: p.vwap0930, p0940: p.p0940, hi: p.hi, lo: p.lo
    })
    added++
  }

  if (added && !o.dry) {
    log.updated = new Date().toISOString()
    /* 只保留最近 400 个交易日的数据，防止无限膨胀（约 1.5 年） */
    const days = [...new Set(log.rows.map(r => r.date))].sort()
    const keep = new Set(days.slice(-400))
    log.rows = log.rows.filter(r => keep.has(r.date))
    fs.writeFileSync(file, JSON.stringify(log), 'utf8')
  }

  return { added, skipped: seenBatch.size - uniq.length, total: log.rows.length, failed }
}

module.exports = { collect, fetch5m, pickDay, symbolOf }
