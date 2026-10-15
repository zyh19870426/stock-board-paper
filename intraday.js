/* ============================================================
 *  盘中实时预览  stock-board-paper/intraday.js
 *
 *  交易日 09:25–15:05 由 GitHub Actions 每 15 分钟触发一次：
 *    1. 载入累积数据集（绝不写入！收盘正式跑由 daily.js 独占）
 *    2. 以「昨日收盘」状态确定今日计划：各策略候选 / M2 今日跟随谁
 *    3. 拉候选股 + 持仓股的实时行情（今开已定 → 今日开盘买入可精确预演；
 *       现价 → 持仓实时浮盈、断板判定预演）
 *    4. 合成「今日快照 bar」喂给同一套引擎（lib/sim.js 单一真源）重放到今天
 *    5. 写 data/intraday.json（线上页面 60s 轮询展示）
 *
 *  ★ 预览与正式的关系：盘中预览是「如果现在收盘」的投影；
 *    账户的正式推进只发生在 daily.js 收盘跑（15:40），两不相扰。
 *
 *  用法：node intraday.js [--dry]      PAPER_NOW 可注入时间（测试用）
 * ============================================================ */
'use strict'
const fs = require('fs')
const path = require('path')

const ST = require('./lib/store.js')
const SIM = require('./lib/sim.js')
const Q = require('./lib/quote.js')

const ROOT = __dirname
const DATA = path.join(ROOT, 'data')
const STORE_FILE = path.join(DATA, 'store.json')
const CONFIG_FILE = path.join(ROOT, 'config.json')
const OUT_FILE = path.join(DATA, 'intraday.json')

const DRY = process.argv.includes('--dry')
const BJ = ST.beijingNow(process.env.PAPER_NOW ? Date.parse(process.env.PAPER_NOW) : null)

const money = c => (c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = v => (v > 0 ? '+' : '') + (v * 100).toFixed(2) + '%'
const hhmm = String(Math.floor(BJ.min / 60)).padStart(2, '0') + ':' + String(BJ.min % 60).padStart(2, '0')
const phaseOf = m => m < 9 * 60 + 25 ? 'pre-open' : (m < ST.CLOSE_MIN ? 'trading' : 'closed')
/* 周末不跑（节假日靠行情日期兜底判定） */
const bjDateNum = BJ.date.replace(/-/g, '')
const dow = new Date(BJ.date + 'T00:00:00+08:00').getUTCDay()

function writeOut (obj) {
  if (DRY) { console.log('  --dry：不写 ' + path.relative(ROOT, OUT_FILE)); return }
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(OUT_FILE, JSON.stringify(obj), 'utf8')
  console.log('  已写 ' + path.relative(ROOT, OUT_FILE) + '（' + fs.statSync(OUT_FILE).size + ' B）')
}

async function main () {
  const t0 = Date.now()
  console.log('== 盘中实时预览 北京时间 ' + BJ.date + ' ' + hhmm + ' ==')
  const phase = phaseOf(BJ.min)

  if (dow === 0 || dow === 6) { console.log('  周末，跳过'); return }
  if (phase === 'pre-open') {
    console.log('  09:25 集合竞价未出今开，无可预演 → 写「开盘前」状态')
    writeOut({ updated: new Date().toISOString(), bjDate: BJ.date, bjTime: hhmm, phase, note: '开盘前，09:25 集合竞价出今开后开始预演' })
    return
  }

  if (!fs.existsSync(STORE_FILE)) throw new Error('缺少数据集 ' + STORE_FILE)
  const store = ST.load(STORE_FILE)
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))

  /* --- 1. 昨日收盘状态：各策略候选 + 持仓（含 M2 今日跟随谁） --- */
  const base = SIM.computeAll(store, cfg)
  const codes = new Set()
  base.results.forEach(r => {
    r.nextCandidates.forEach(c => codes.add(c.code))
    r.positions.forEach(p => codes.add(p.code))
  })
  if (!codes.size) { console.log('  无候选无持仓，无需预演 → 写空快照'); writeOut({ updated: new Date().toISOString(), bjDate: BJ.date, bjTime: hhmm, phase, note: '今日无候选无持仓', strategies: [] }); return }

  /* --- 2. 实时行情 --- */
  const { q, fail } = await Q.fetchQuotes([...codes])
  console.log('  行情：取到 ' + Object.keys(q).length + ' / ' + codes.size + '（失败 ' + fail.join(',') + '）耗时 ' + Math.round((Date.now() - t0) / 1000) + 's')
  /* 行情日期兜底：若腾讯给的是上一个交易日的时间 ⇒ 今天休市（节假日） */
  const sample = q[Object.keys(q)[0]]
  if (sample && String(sample.time).slice(0, 8) !== bjDateNum) {
    console.log('  ⏸ 行情时间 ' + sample.time + ' ≠ 今天 ⇒ 今日休市（节假日），不写盘中快照')
    writeOut({ updated: new Date().toISOString(), bjDate: BJ.date, bjTime: hhmm, phase: 'holiday', note: '今日休市' })
    return
  }

  /* --- 3. 合成「今日快照 bar」：今开=真实今开，收=现价，高/低=盘中真实高低，量=盘中量 --- */
  const synth = { dates: store.dates.concat(BJ.date), warmup: store.warmup, st: {}, meta: store.meta }
  if (store.meta) synth.meta = Object.assign({}, store.meta)
  const ENCODE = b => Math.round(b[1] * 100) + ',' + Math.round(b[2] * 100) + ',' + Math.round(b[3] * 100) + ',' + Math.round(b[4] * 100) + ',' + Math.round(b[5])
  for (const code in store.st) {
    const raw = store.st[code]
    const qt = q[code]
    const seg = qt && qt.open > 0 && qt.price > 0
      ? ENCODE([0, qt.open, qt.price, Math.max(qt.high, qt.price, qt.open), Math.min(qt.low, qt.price, qt.open), qt.vol])
      : '-'
    synth.st[code] = { n: raw.n, d0: raw.d0, k: raw.k + ';' + seg }
  }

  /* --- 4. 同一套引擎重放到今天（纯内存预览，绝不写数据集） --- */
  const sim = SIM.computeAll(synth, cfg)
  const strategies = sim.results.map(r => ({
    id: r.id, name: r.name,
    pickToday: r.m2 ? r.m2.pickToday.name : undefined,
    trace: r.m2 ? r.m2.trace : undefined,
    totalC: r.totalC, dayPnlC: r.dayPnlC, dayRet: r.dayRet, cumRet: r.cumRet,
    todayBuys: r.todayBuys.map(p => ({ code: p.code, name: p.name, lbc: p.lbc, shares: p.shares, buyC: p.buyC })),
    todaySells: r.todayTrades.map(t => ({ code: t.code, name: t.name, sellC: t.sellC, pnlC: t.pnlC, pnlPct: t.pnlPct, reason: t.reason })),
    skippedToday: r.skippedToday.map(s => ({ code: s.code, name: s.name, reason: s.reason })),
    positions: r.positions.map(p => {
      const qt = q[p.code]
      const curC = qt ? Math.round(qt.price * 100) : null
      return {
        code: p.code, name: p.name, lbc: p.lbc, shares: p.shares, buyDate: p.buyDate, buyC: p.buyC, costC: p.costC,
        curC, /* costC = 整笔总成本（分，含费用）⇒ 浮盈 = 现值 − 总成本 */
        curPnlC: curC != null ? curC * p.shares - p.costC : null,
        ztNow: qt ? Math.abs(qt.price * 100 - Math.round(qt.prevClose * 100 * (1 + (/^(30|68)/.test(p.code) ? 0.2 : 0.1)))) < 5 : false
      }
    }),
    nextCandidates: r.nextCandidates.map(c => {
      const qt = q[c.code]
      return { code: c.code, name: c.name, lbc: c.lbc, amount: c.amount || 0,
        curC: qt ? Math.round(qt.price * 100) : null,
        curPct: qt && qt.prevClose > 0 ? qt.price / qt.prevClose - 1 : null }
    })
  }))

  writeOut({
    updated: new Date().toISOString(),
    bjDate: BJ.date, bjTime: hhmm, phase,
    note: phase === 'trading' ? '盘中预演：今开已定 ⇒ 开盘买入为真实成交价；现价随行情跳动，以收盘跑（daily.js）为准'
      : '已收盘预演快照，正式账户以收盘跑为准',
    strategies
  })
  console.log('  预演完成：' + strategies.map(s => s.id + ' ' + pct(s.dayRet)).join(' / ') + '，耗时 ' + Math.round((Date.now() - t0) / 1000) + 's')
}

main().catch(e => { console.error('运行失败：', e); process.exit(1) })
