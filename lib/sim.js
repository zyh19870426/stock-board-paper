/* ============================================================
 *  模拟计算核心（单一真源）  stock-board-paper/lib/sim.js
 *
 *  daily.js（收盘正式跑）与 intraday.js（盘中预览）共用：
 *    computeAll(store, cfg) → { date, results }
 *  results[0] 恒为 M2 · 跟随近10日最强者（看板优先展示），其后是 config 里的 S1..S4。
 *
 *  ★ M2 规则单一真源 = lib/regime.js（回测 +307.45%，防未来函数）：
 *    B1 首板1份 / B3 三板2份 / B5 五板2份 三套虚拟账户全程纸上跟踪（零成本不下单），
 *    第 t 日做谁，只由 ≤ t-1 收盘可知的信息决定（昨日收盘时谁近 10 日净值涨幅最大）。
 *    M2 自身的实盘账户从 cfg.startDate 起跑（与其它策略同起点、同本金）。
 * ============================================================ */
'use strict'
const M = require('./strategy.js')
const RG = require('./regime.js')

const M2_NAME = '跟随·近10日最强'
const M2_BRIEF = '动态跟随 · 首板1份/三板2份/五板2份 谁近10日净值最强今天做谁 · 断板即出'
const M2_REF = '回测 +307.45%（2025-11~2026-09，p=0.132，最大回撤 −31.8%）'

/** 把 runBacktest 的原始返回装配成看板/日报用的结果对象（runStrategy 与 runM2 共用尾巴） */
function finalize (r, id, name, initialCash, extra) {
  const eq = r.equity
  const today = eq[eq.length - 1]
  const prev = eq.length > 1 ? eq[eq.length - 2] : null
  const initC = Math.round(initialCash * 100)

  const todayTrades = (r.trades || []).filter(t => t.sellDate === today.date)
  const todayBuys = (r.openPositions || []).filter(p => p.buyDate === today.date)
  const skippedToday = (r.skipped || []).filter(s => s.date === today.date)

  return Object.assign({
    id, name,
    params: r.params,
    date: today.date,
    totalC: today.totalC,
    cashC: today.cashC,
    mvC: today.mvC,
    dayPnlC: prev ? today.totalC - prev.totalC : 0,
    dayRet: prev ? today.totalC / prev.totalC - 1 : 0,
    cumPnlC: today.totalC - initC,
    cumRet: today.totalC / initC - 1,
    equityDays: eq.length,
    tradeCount: r.summary.tradeCount,
    winRate: r.summary.winRate,
    maxDrawdown: r.summary.maxDrawdown,
    positions: r.openPositions || [],
    nextCandidates: r.nextDayCandidates || [],
    todayTrades, todayBuys, skippedToday,
    equityTail: eq.slice(-10),
    /* 全量序列（线上页面用）：每日净值曲线 + 全部成交记录 */
    equityFull: eq.map((e, i) => ({
      d: e.date, tc: e.totalC,
      dp: i > 0 ? e.totalC - eq[i - 1].totalC : 0,
      dr: i > 0 ? e.totalC / eq[i - 1].totalC - 1 : 0,
      cr: e.totalC / initC - 1
    })),
    tradesFull: (r.trades || []).map(t => ({
      code: t.code, name: t.name, lbc: t.lbc, shares: t.shares,
      buyDate: t.buyDate, buyC: t.buyC,
      sellDate: t.sellDate, sellC: t.sellC,
      pnlC: t.pnlC, pnlPct: t.pnlPct, reason: t.reason
    }))
  }, extra || {})
}

/* ---------------- 静态策略（config 里的一套参数从头跑到尾） ---------------- */
function runStrategy (store, strat, startDate, initialCash) {
  const startIdx = store.dates.indexOf(startDate)
  if (startIdx < 0) throw new Error('起点 ' + startDate + ' 不在数据集里（' + store.dates[0] + ' ~ ' + store.dates[store.dates.length - 1] + '）')
  const P = Object.assign({}, strat.params, {
    initialCash, startIdx, endIdx: store.dates.length - 1
  })
  const r = M.runBacktest(store, P)
  if (r.error) throw new Error(r.error)
  /* ★ 人为跟随所需的「风控状态」：闸门今日是否拦下、回撤熔断是否在停手期、止损/回撤线、每份金额 */
  const s = r.summary
  const risk = {
    slots: P.slots,
    stopLossPct: P.stopLossPct,
    trailPct: P.trailPct,
    exitMode: P.exitMode,
    maxHoldDays: P.maxHoldDays,
    gateToday: !!s.gateToday,
    gatedDays: s.gatedDays || 0,
    ddPauseToday: !!s.ddPauseToday,
    ddTriggerCount: s.ddTriggers || 0,
    ddPauseLeft: s.ddPauseLeft || 0
  }
  return finalize(r, strat.id, strat.name, initialCash, { risk })
}

/* ---------------- M2 · 跟随近10日最强者 ---------------- */
function runM2 (store, startDate, initialCash) {
  const startIdx = store.dates.indexOf(startDate)
  if (startIdx < 0) throw new Error('起点 ' + startDate + ' 不在数据集里（' + store.dates[0] + ' ~ ' + store.dates[store.dates.length - 1] + '）')
  /* 虚拟账户从 warmup 全程跑（纸上跟踪），M2 自身账户从 startDate 起跑 */
  const all = RG.buildAll(store, store.warmup, store.dates.length - 1)
  const plan = all.plans.M2
  const r = RG.runPlan(store, plan, startIdx, store.dates.length - 1)
  if (r.error) throw new Error(r.error)

  const tIdx = store.dates.length - 1
  const todayPlan = plan[tIdx] || {}
  /* 决定「今天做谁」的依据 = 昨日（t-1）收盘时三套候选的近10日净值涨幅（与 regime.chase 同口径） */
  const CHASE = ['B1', 'B3', 'B5']
  const trace = CHASE.map(k => {
    const e = all.fixedRes[k].equity
    const i = (tIdx - 1) - all.START
    let ret = null
    if (i >= 1 && e && e.length > i) {
      const back = Math.min(10, i)
      const a = e[i].totalC, b = e[i - back].totalC
      if (b > 0) ret = a / b - 1
    }
    return { k, name: RG.ACTIONS[k].name, ret }
  })
  const best = trace.slice().sort((a, b) => (b.ret == null ? -1 : b.ret) - (a.ret == null ? -1 : a.ret))[0]
  /* 近 30 个交易日的切换轨迹（只留变化点） */
  const switches = []
  for (let t = Math.max(all.START, tIdx - 29); t <= tIdx; t++) {
    const tag = plan[t] ? plan[t].tag : null
    if (!switches.length || switches[switches.length - 1].tag !== tag) {
      switches.push({ date: store.dates[t], tag, name: (RG.ACTIONS[tag] || {}).name || tag })
    }
  }

  /* M2 用的是 BASE 固定参数（跟随档位只改 slots / 连板区间），风控线对所有档位一致 */
  const act = RG.ACTIONS[todayPlan.tag] || null
  const risk = {
    slots: (act && act.slots) || 1,
    stopLossPct: RG.BASE.stopLossPct,
    trailPct: RG.BASE.trailPct,
    exitMode: RG.BASE.exitMode,
    maxHoldDays: RG.BASE.maxHoldDays,
    gateToday: false, gatedDays: 0,
    ddPauseToday: !!todayPlan.pause, ddTriggerCount: 0, ddPauseLeft: 0
  }
  return finalize(r, 'M2', M2_NAME, initialCash, {
    risk,
    m2: {
      pickToday: { tag: todayPlan.tag || 'CASH', name: todayPlan.name || '空仓', pause: !!todayPlan.pause },
      trace, best,
      ref: M2_REF,
      switches
    }
  })
}

/* ---------------- 全区间回放曲线（看板收益曲线的底稿） ----------------
 *  ★ 为什么需要它：模拟账户从 cfg.startDate 起跑，而 startDate 通常就是「上线那天」。
 *    若上线日恰好是数据集的最后一天，equity 只有 1 个点 ⇒ 看板曲线画出来是空白。
 *    这里用【完全相同的参数】从数据集可回测起点（ds.warmup）回放一遍，得到一条有形状的历史曲线，
 *    供看板展示「这套策略在历史上是怎么走的」；页面会明确标注它是「回放」而非真实模拟账户。
 *  ★ 口径：与真实账户严格同参数、同本金、同离场规则，唯一差别是起点提前到 warmup。
 *    因此「回放曲线的末段 = 从上线日往后」与真实账户口径一致，可无缝衔接。
 * ------------------------------------------------------------------- */
function replayCurve (store, cfg) {
  const startIdx = store.warmup
  const initC = Math.round(cfg.initialCash * 100)
  const out = {}
  const pack = (r) => {
    if (!r || r.error || !r.equity) return null
    return r.equity.map((e, i) => ({
      d: e.date, tc: e.totalC,
      dp: i > 0 ? e.totalC - r.equity[i - 1].totalC : 0,
      dr: i > 0 ? e.totalC / r.equity[i - 1].totalC - 1 : 0,
      cr: e.totalC / initC - 1
    }))
  }
  /* M2：虚拟账户全程跑，M2 自身账户从 warmup 起跑（同 runM2 口径，只是起点提前） */
  try {
    const all = RG.buildAll(store, startIdx, store.dates.length - 1)
    out.M2 = pack(RG.runPlan(store, all.plans.M2, startIdx, store.dates.length - 1))
  } catch (e) { console.log('  ✗ M2 回放失败：' + e.message); out.M2 = null }
  /* config 里的静态策略：同参数换起点 */
  for (const s of cfg.strategies) {
    try {
      const P = Object.assign({}, s.params, { initialCash: cfg.initialCash, startIdx, endIdx: store.dates.length - 1 })
      const r = M.runBacktest(store, P)
      out[s.id] = pack(r)
    } catch (e) { console.log('  ✗ ' + s.id + ' 回放失败：' + e.message); out[s.id] = null }
  }
  return out
}

/* ---------------- 总入口 ---------------- */
function computeAll (store, cfg) {
  const results = []
  try { results.push(runM2(store, cfg.startDate, cfg.initialCash)) }
  catch (e) { console.log('  ✗ M2 失败：' + e.message) }
  for (const s of cfg.strategies) {
    try { results.push(runStrategy(store, s, cfg.startDate, cfg.initialCash)) }
    catch (e) { console.log('  ✗ 策略 ' + s.id + ' 失败：' + e.message) }
  }
  if (!results.length) throw new Error('没有任何策略跑成功')
  /* 全区间回放曲线：失败不影响主流程（页面会退回用 daily 短曲线） */
  let curves = {}
  try { curves = replayCurve(store, cfg) } catch (e) { console.log('  ✗ 回放曲线整体失败：' + e.message) }
  return { date: store.dates[store.dates.length - 1], results, curves, replayStart: store.dates[store.warmup] }
}

module.exports = { computeAll, runStrategy, runM2, replayCurve, finalize, M2_NAME, M2_BRIEF, M2_REF }
