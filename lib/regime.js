/* ============================================================
 *  市场情绪信号 + 动态策略切换（单一真源）
 *  stock-board-sim/lib/regime.js
 *
 *  供两个调用方共用，保证「回测脚本」与「未来函数审计脚本」用的是同一套逻辑：
 *    · switch-regime.js        —— 出结果
 *    · check-switch-audit.js   —— 在不含未来数据的「截断数据集」上重算，逐日比对
 *
 *  ★ 防未来函数总原则：第 t 个交易日执行哪套策略，只能由 ≤ t-1 收盘可知的信息决定。
 * ============================================================ */
'use strict'
const BS = require('./strategy.js')

/* ---------------- 候选策略（= 用户自有配置口径：1板1份 / 3板2份 / 5板2份） ---------------- */
const BASE = {
  initialCash: 100000, stopLossPct: 20, trailPct: 20, exitMode: 'break', maxHoldDays: 10,
  sortBy: 'lbc', allocMode: 'dynamic', skipLimitOpen: true, trailIntraday: true,
  topOnly: false, refillOnSkip: false, boardFilter: 'main'
}
const ACTIONS = {
  B1: { name: '首板·1份', slots: 1, minLbc: 0, maxLbc: 2 },
  B2: { name: '首板·2份', slots: 2, minLbc: 0, maxLbc: 2 },
  B3: { name: '三板·2份', slots: 2, minLbc: 2, maxLbc: 4 },
  B33: { name: '三板·3份', slots: 3, minLbc: 2, maxLbc: 4 },
  B5: { name: '五板·2份', slots: 2, minLbc: 4, maxLbc: 6 },
  CASH: { name: '空仓', pause: true }
}
const FIXED = ['B1', 'B2', 'B3', 'B33', 'B5']

/* ---------------- 市场情绪统计量（逐日；只读当日及之前的数据） ---------------- */
function marketStats (ds, st, bd) {
  const n = ds.dates.length
  const zt = new Array(n).fill(null), lb2 = new Array(n).fill(null), maxLb = new Array(n).fill(null)
  const prem = new Array(n).fill(null), promo = new Array(n).fill(null)
  for (let t = 0; t < n; t++) {
    const b = bd[t] || []
    zt[t] = b.length
    let c2 = 0, mx = 0
    for (const x of b) { if (x.lbc >= 2) c2++; if (x.lbc > mx) mx = x.lbc }
    lb2[t] = c2; maxLb[t] = mx
    if (t === 0) continue
    const prev = bd[t - 1] || []
    if (!prev.length) continue
    const cur = new Set(b.map(x => x.code))
    let sum = 0, cnt = 0, pTot = 0, pUp = 0
    for (const x of prev) {
      const s = st[x.code]
      if (!s) continue
      const i0 = s.idxOf[t - 1], i1 = s.idxOf[t]
      if (i0 != null && i1 != null) { sum += s.c[i1] / s.c[i0] - 1; cnt++ }
      pTot++
      if (cur.has(x.code)) pUp++
    }
    prem[t] = cnt ? sum / cnt : null      // 打板次日溢价（赚钱效应）
    promo[t] = pTot ? pUp / pTot : null   // 晋级率
  }
  return { zt, lb2, maxLb, prem, promo }
}

/** 简单均线：arr[t-w+1..t] 的均值；区间内任一为 null 则返回 null（不猜） */
function ma (arr, t, w) {
  if (t - w + 1 < 0) return null
  let s = 0
  for (let i = t - w + 1; i <= t; i++) { if (arr[i] == null) return null; s += arr[i] }
  return s / w
}

/* ---------------- 切换规则 ---------------- */
/* 规则只用两类信息，全部 ≤ t-1 可知，且无自由参数（只使用符号 / 相对自身均线 / 近期净值涨幅）：
 *   A 类「情绪信号」：打板次日溢价、涨停家数、连板家数 与各自 MA5 的比较
 *   B 类「跟随近期表现」：把三套策略各自当作一个虚拟（纸上）账户在跑，
 *        看过去 w 个交易日谁的净值涨得最多 → 明天就做谁。
 *        实盘可实现性：三套虚拟账户只是纸上跟踪（零成本、不下单），真金白银只执行被选中的那套。 */
function mkRules (K, CTX) {
  const START = CTX.START
  const CHASE = ['B1', 'B3', 'B5']

  function eqAt (k, t) {
    const e = CTX.fixedRes[k].equity
    const i = t - START
    return (i >= 0 && i < e.length) ? e[i].totalC : null
  }
  /** 第 t 日收盘看：策略 k 近 w 个交易日的净值涨幅（历史不足 w 日时用扩张窗口，最少 1 日） */
  function trailRet (k, t, w) {
    const i = t - START
    if (i < 1) return null
    const back = Math.min(w, i)
    const a = eqAt(k, t), b = eqAt(k, t - back)
    return (a != null && b != null && b > 0) ? a / b - 1 : null
  }
  function chaseRank (t, w) {
    const vals = CHASE.map(k => ({ k, v: trailRet(k, t, w) }))
    if (vals.some(x => x.v == null)) return null
    return vals.slice().sort((a, b) => b.v - a.v)
  }
  function chase (w, invert, gate) {
    return t => {
      const r = chaseRank(t - 1, w)      // 用「昨日收盘」的近期表现决定今日执行哪套
      if (!r) return 'CASH'
      const pick = invert ? r[r.length - 1] : r[0]
      if (gate && pick.v <= 0) return 'CASH'
      return pick.k
    }
  }

  return [
    {
      key: 'R1', name: '情绪·溢价开关',
      desc: '昨日涨停股今日平均涨幅>0 → 首板1份；否则空仓',
      fn: t => (K.prem[t - 1] == null ? 'CASH' : (K.prem[t - 1] > 0 ? 'B1' : 'CASH'))
    },
    {
      key: 'R2', name: '情绪·溢价+连板扩张',
      desc: '溢价>0 且 连板家数>自身MA5 → 三板2份；溢价>0 → 首板1份；否则空仓',
      fn: t => {
        const p = K.prem[t - 1]
        if (p == null || p <= 0) return 'CASH'
        const m = ma(K.lb2, t - 1, 5)
        return (m != null && K.lb2[t - 1] > m) ? 'B3' : 'B1'
      }
    },
    {
      key: 'R3', name: '情绪·溢价+家数扩张',
      desc: '溢价>0 且 涨停家数>自身MA5 → 三板2份；溢价>0 → 首板1份；否则空仓',
      fn: t => {
        const p = K.prem[t - 1]
        if (p == null || p <= 0) return 'CASH'
        const m = ma(K.zt, t - 1, 5)
        return (m != null && K.zt[t - 1] > m) ? 'B3' : 'B1'
      }
    },
    {
      key: 'M1', name: '跟随·近5日最强者',
      desc: '看 首板1份/三板2份/五板2份 谁近 5 日净值涨幅最大 → 明天做谁',
      fn: chase(5, false, false)
    },
    {
      key: 'M2', name: '跟随·近10日最强者',
      desc: '同上，窗口 10 日',
      fn: chase(10, false, false)
    },
    {
      key: 'M3', name: '跟随·近20日最强者',
      desc: '同上，窗口 20 日',
      fn: chase(20, false, false)
    },
    {
      key: 'M4', name: '跟随·近5日最强者+空仓闸门',
      desc: '近 5 日最强者涨幅>0 才做，否则空仓',
      fn: chase(5, false, true)
    },
    {
      key: 'M5', name: '反转·近5日最弱者',
      desc: '反向对照：专挑近 5 日最差的那套做（检验「跟随」是否只是在追高）',
      fn: chase(5, true, false)
    }
  ]
}

/* ---------------- 运行 ---------------- */
function planOf (fn, N, START) {
  const plan = new Array(N)
  for (let t = 0; t < N; t++) {
    if (t < START) { plan[t] = { pause: true, tag: 'PRE' }; continue }
    const k = fn(t)
    plan[t] = Object.assign({ tag: k }, ACTIONS[k])
  }
  return plan
}
function runFixed (ds, key, START, END) {
  const a = ACTIONS[key]
  return BS.runBacktest(ds, Object.assign({}, BASE, {
    slots: a.slots, minLbc: a.minLbc, maxLbc: a.maxLbc, startIdx: START, endIdx: END
  }))
}
function runPlan (ds, plan, START, END, slippagePct) {
  const extra = slippagePct ? { slippagePct } : {}
  return BS.runBacktest(ds, Object.assign({}, BASE, extra, { startIdx: START, endIdx: END, dayPlan: t => plan[t] }))
}
function dailyRet (r) {
  const out = new Array(r.equity.length).fill(null)
  for (let i = 1; i < r.equity.length; i++) out[i] = r.equity[i].totalC / r.equity[i - 1].totalC - 1
  return out
}

/** 一次性算出：情绪统计量、五套固定策略结果、以及全部规则的逐日决策数组 */
function buildAll (ds, start, end) {
  const N = ds.dates.length
  const stocks = BS.parseDataset(ds)
  const boards = BS.buildBoards(ds, stocks)
  const K = marketStats(ds, stocks, boards)
  const START = start == null ? ds.warmup : start
  const END = end == null ? N - 1 : end
  const fixedRes = {}
  FIXED.forEach(k => { fixedRes[k] = runFixed(ds, k, START, END) })
  const CTX = { fixedRes, START }
  const rules = mkRules(K, CTX)
  const plans = {}
  rules.forEach(r => { plans[r.key] = planOf(r.fn, N, START) })
  return { ds, N, START, END, K, fixedRes, rules, plans }
}

/* ---------------- 数据集截断（审计专用） ----------------
 * 只保留第 0..T 个交易日的数据，其余整段删除。用于回答：
 *   「把未来数据全部拿掉后，同一天做出的决策是否一模一样？」
 * ------------------------------------------------------- */
function truncateDS (ds, T) {
  const out = { dates: ds.dates.slice(0, T + 1), warmup: ds.warmup, st: {} }
  if (ds.meta) out.meta = ds.meta
  for (const code in ds.st) {
    const raw = ds.st[code]
    if (raw.d0 > T) continue
    const keep = String(raw.k).split(';').slice(0, T + 1 - raw.d0)
    if (!keep.length) continue
    out.st[code] = { n: raw.n, d0: raw.d0, k: keep.join(';') }
  }
  return out
}

module.exports = {
  BS, BASE, ACTIONS, FIXED, marketStats, ma, mkRules, planOf, runFixed, runPlan, dailyRet, buildAll, truncateDS
}
