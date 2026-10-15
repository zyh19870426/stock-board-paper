/* ============================================================
 *  滚动验证  stock-board-paper/lib/rolling.js
 *
 *  为什么需要（2026-10-15 讨论结论）：
 *    统计显著性检验在打板策略上「不可能达成」——日波动 5.29%、日均超额 0.199%
 *    ⇒ 同效应下需 n≈2831 交易日（11.3 年）。
 *    所以改用「监控制度」替代「一次性证明」：
 *      把「证明它有效」换成「监控它何时失效」——2~3 个月就能有答案。
 *
 *  三项滚动指标（全部只用 ≤ 当日数据，无未来函数）：
 *    ① 近 20 交易日：M2 是否跑赢静态最强（按期输赢，不看累计）
 *    ② 连续跑输天数：连续 20 交易日累计跑输 → 触发降级观察
 *    ③ 多窗口方向：近 60 交易日内，5/10/20 窗口各自是否为正
 *
 *  判定（保守、避免噪声误报）：
 *    green  = 近20日跑赢 且 60日内 ≥2/3 窗口为正
 *    watch  = 近20日跑平/小输（-2% 内）或 只有 1/3 窗口为正
 *    degrade= 连续 ≥20 交易日累计跑输 ≥5% 或 0/3 窗口为正
 * ============================================================ */
'use strict'
const R = require('./regime.js')

const WIN_ROLL = 20      // 输赢判定窗口（交易日）
const WIN_DIR = 60       // 方向检查窗口（交易日）
const DERATE_PCT = -0.05 // 连续跑输阈值
const CHASE = ['B1', 'B3', 'B5']

/** 用任意窗口跑「跟随最强者」的逐日净值（供方向检查用） */
function runChase (store, all, win, slip) {
  const CH = ['B1', 'B3', 'B5']
  const ctx = { START: all.START, fixedRes: {} }
  R.FIXED.forEach(k => {
    const a = R.ACTIONS[k]
    ctx.fixedRes[k] = R.BS.runBacktest(store, Object.assign({}, R.BASE, {
      slots: a.slots, minLbc: a.minLbc, maxLbc: a.maxLbc, startIdx: all.START, endIdx: all.END, slippagePct: slip || 0
    }))
  })
  const eqAt = (k, t) => {
    const e = ctx.fixedRes[k].equity
    const i = t - all.START
    return (i >= 0 && i < e.length) ? e[i].totalC : null
  }
  const fn = t => {
    const vals = CH.map(k => {
      const i = t - all.START
      if (i < 1) return null
      const back = Math.min(win, i)
      const a = eqAt(k, t), b = eqAt(k, t - back)
      return (a != null && b != null && b > 0) ? { k, v: a / b - 1 } : null
    })
    if (vals.some(x => x == null)) return 'CASH'
    return vals.slice().sort((a, b) => b.v - a.v)[0].k
  }
  return R.runPlan(store, R.planOf(fn, store.dates.length, all.START), all.START, all.END, slip || 0)
}

/**
 * 计算滚动验证状态。
 * @param store 累积数据集
 * @param opts  { slip: 滑点假设（默认 0）, wins: 方向窗口（默认 [5,10,20]） }
 * @returns { at, rows, status, note, recent, direction }
 */
function rollingCheck (store, opts) {
  const o = opts || {}
  const slip = o.slip || 0
  const wins = o.wins || [5, 10, 20]
  const END = store.dates.length - 1
  const all = R.buildAll(store, store.warmup, END)
  const START = all.START
  if (END - START + 1 < WIN_ROLL + 2) return { at: store.dates[END], status: 'insufficient', note: '样本不足 ' + WIN_ROLL + ' 交易日', rows: [] }

  /* M2（10日窗口）与静态最强 */
  const m2 = R.runPlan(store, all.plans.M2, START, END, slip)
  const fixedKeys = R.FIXED
  let bestK = fixedKeys[0], bestRet = -Infinity
  fixedKeys.forEach(k => { const v = all.fixedRes[k].summary.returnPct; if (v > bestRet) { bestRet = v; bestK = k } })
  const st = R.BS.runBacktest(store, Object.assign({}, R.BASE, {
    slots: R.ACTIONS[bestK].slots, minLbc: R.ACTIONS[bestK].minLbc, maxLbc: R.ACTIONS[bestK].maxLbc,
    startIdx: START, endIdx: END, slippagePct: slip
  }))

  /* ① 近 20 交易日：按期输赢（用净值比，比日收益累加稳健） */
  const rows = []
  const n = m2.equity.length
  for (let i = WIN_ROLL; i < n; i++) {
    const m = m2.equity[i].totalC / m2.equity[i - WIN_ROLL].totalC - 1
    const s = st.equity[i].totalC / st.equity[i - WIN_ROLL].totalC - 1
    rows.push({ date: m2.equity[i].date, m2: m, static: s, diff: m - s })
  }
  const last = rows[rows.length - 1] || null

  /* ② 连续跑输天数（从最新往前数） */
  let streak = 0
  for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].diff < 0) streak++; else break }
  /* 连续跑输累计幅度（从最新往前累乘） */
  let cumUnder = 1
  for (let i = n - 1; i > n - 1 - streak && i > 0; i--) cumUnder *= (1 + m2.equity[i].totalC / m2.equity[i - 1].totalC - 1) / (1 + st.equity[i].totalC / st.equity[i - 1].totalC - 1)
  cumUnder -= 1

  /* ③ 多窗口方向（近 WIN_DIR 交易日各窗口累计） */
  const direction = wins.map(w => {
    const r = runChase(store, all, w, slip)
    const len = r.equity.length
    const back = Math.min(WIN_DIR, len - 1)
    const ret = r.equity[len - 1].totalC / r.equity[len - 1 - back].totalC - 1
    return { win: w, ret }
  })
  const posWins = direction.filter(x => x.ret > 0).length

  /* 判定 */
  let status = 'green', note = ''
  if (streak >= WIN_ROLL && cumUnder <= DERATE_PCT) {
    status = 'degrade'
    note = '连续 ' + streak + ' 个 20 日窗口跑输静态最强，累计 ' + (cumUnder * 100).toFixed(1) + '% ⇒ 建议降级观察'
  } else if (posWins === 0) {
    status = 'degrade'
    note = '近 ' + WIN_DIR + ' 交易日 ' + wins.length + ' 个窗口无一为正 ⇒ 方向可能已失效'
  } else if (last && last.diff < 0 && posWins <= 1) {
    status = 'watch'
    note = '近 ' + WIN_ROLL + ' 日跑输静态，且仅 ' + posWins + '/' + wins.length + ' 窗口为正 ⇒ 观察'
  } else if (last && last.diff < 0) {
    status = 'watch'
    note = '近 ' + WIN_ROLL + ' 日跑输静态 ' + (last.diff * 100).toFixed(2) + '%（窗口方向仍 ' + posWins + '/' + wins.length + ' 为正）'
  } else {
    status = 'green'
    note = '近 ' + WIN_ROLL + ' 日跑赢静态 ' + (last ? (last.diff * 100).toFixed(2) : '—') + '%，' + posWins + '/' + wins.length + ' 窗口为正'
  }

  return {
    at: m2.equity[n - 1].date,
    slip,
    status, note,
    recent: last ? { m2: last.m2, static: last.static, diff: last.diff } : null,
    streak, cumUnder,
    direction,
    /* 近 12 个 20 日窗口的输赢序列（趋势可视化用） */
    history: rows.slice(-12).map(r => ({ date: r.date, diff: r.diff })),
    staticKey: bestK, staticName: R.ACTIONS[bestK].name
  }
}

module.exports = { rollingCheck, WIN_ROLL, WIN_DIR }
