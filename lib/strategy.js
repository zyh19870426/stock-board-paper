/* ============================================================
 *  打板策略模拟 · 策略引擎（前后端共用 UMD）
 *  stock-board-sim/lib/strategy.js
 *  ★ 全程用「整数分」运算，避免浮点误差导致涨停误判
 * ============================================================ */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.BoardSim = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  /* ---------------- 涨跌停 ---------------- */
  function limitPct (code) {
    code = String(code)
    if (/^(300|301)/.test(code)) return 0.20      // 创业板
    if (/^(688|689)/.test(code)) return 0.20      // 科创板
    if (/^(8|4)/.test(code)) return 0.30          // 北交所
    return 0.10
  }
  // 输入输出均为「分」
  function limitUpCents (code, prevCloseCents) {
    return Math.round(prevCloseCents * (1 + limitPct(code)))
  }
  function limitDownCents (code, prevCloseCents) {
    return Math.round(prevCloseCents * (1 - limitPct(code)))
  }

  /* ---------------- 封板强度评分（固定规则，无自由参数） ----------------
   * 输入：首封时间（'09:40' / '093044' / 93044 均可）+ 当日炸板次数
   * 时间档位：开盘即封(≤09:40)=4 → 早盘(≤10:30)=3 → 午前(≤13:00)=2 → 午后(≤14:00)=1 → 尾盘=0
   * 炸板惩罚：0 次=0 → 1 次=-1 → 2 次=-2 → ≥3 次=-3
   * 强度分 = max(0, 时间档 - 炸板次数)
   * ------------------------------------------------------------- */
  function sealTimeTier (firstTm) {
    let s = String(firstTm == null ? '' : firstTm).replace(/[^0-9]/g, '')
    if (!s) return null
    // 兼容 4 位 HHMM（0930）、6 位 HHMMSS（093044）、5 位 HMMSS（93044）、3 位 HMM（930）
    s = s.length > 4 ? s.padStart(6, '0') : s.padStart(4, '0')
    const hh = +s.slice(0, 2), mm = +s.slice(2, 4)
    if (!isFinite(hh) || !isFinite(mm) || hh > 23 || mm > 59) return null
    const t = hh * 60 + mm                        // 距 00:00 的分钟数
    if (t <= 9 * 60 + 40) return 4                // 开盘即封（含量价齐升的一字/秒板）
    if (t <= 10 * 60 + 30) return 3
    if (t <= 13 * 60) return 2
    if (t <= 14 * 60) return 1
    return 0
  }
  function sealScore (firstTm, openCnt) {
    const tier = sealTimeTier(firstTm)
    if (tier == null) return null
    const oc = Math.max(0, Number(openCnt) || 0)
    const penalty = Math.min(3, oc)
    return Math.max(0, tier - penalty)
  }

  /* ---------------- dataset 解析 ---------------- */
  // ds.st[code] = { n:名称, d0:起始全局日期索引, k:"o,c,h,l,v;o,c,h,l,v;..." }（价格单位：分）
  function parseDataset (ds) {
    if (ds._parsed) return ds._parsed
    const stocks = {}
    for (const code in ds.st) {
      const raw = ds.st[code]
      const segs = String(raw.k).split(';')
      const di = [], o = [], c = [], h = [], l = [], v = []
      const idxOf = Object.create(null)
      let gi = raw.d0
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]
        if (s === '' || s === '-') { gi++; continue }   // 停牌/缺失
        const f = s.split(',')
        di.push(gi)
        o.push(+f[0]); c.push(+f[1]); h.push(+f[2]); l.push(+f[3]); v.push(+f[4])
        idxOf[gi] = o.length - 1
        gi++
      }
      stocks[code] = { code, name: raw.n, di, o, c, h, l, v, idxOf, n: o.length }
    }
    Object.defineProperty(ds, '_parsed', { value: stocks, enumerable: false })
    return stocks
  }

  /* ---------------- 每日连板表（与参数无关，缓存） ---------------- */
  // boards[t] = [{ code, name, lbc, close, amount, turnoverPct }]
  function buildBoards (ds, stocks) {
    if (ds._boards) return ds._boards
    // 防御：漏传 stocks 时自动解析数据集（parseDataset 自带 _parsed 缓存，重复调用零成本）。
    // 否则 stocks 为 undefined → for..in 遍历为空 → 构建出「空板」并缓存到 ds._boards，
    // 之后所有 runBacktest(ds) 都会静默返回 0 笔且不报错（极难排查）。
    if (!stocks) stocks = parseDataset(ds)
    const N = ds.dates.length
    const boards = new Array(N)
    for (let t = 0; t < N; t++) boards[t] = []
    for (const code in stocks) {
      const s = stocks[code]
      let run = 0
      for (let i = 1; i < s.n; i++) {
        if (s.di[i] - s.di[i - 1] !== 1) run = 0          // 中间停牌 → 连板中断
        const pctLim = limitPct(code)
        const ratio = s.c[i] / s.c[i - 1] - 1
        const lu = limitUpCents(code, s.c[i - 1])
        // 收盘恰好等于涨停价，且实际涨幅未超限（排除新股无涨跌幅日等异常）
        const isZt = Math.abs(s.c[i] - lu) <= 5 && ratio <= pctLim + 0.006
        run = isZt ? run + 1 : 0
        if (run >= 1) {
          const dstr = ds.dates[s.di[i]]
          const sm = ds.seal && ds.seal[dstr]
          const seal = sm && sm[code] ? sm[code] : null
          boards[s.di[i]].push({
            code, name: s.name, lbc: run, close: s.c[i],
            prevClose: s.c[i - 1], open: s.o[i], high: s.h[i], low: s.l[i],
            // 成交额（元）：c 单位为分、v 单位为手 → (c/100 元) × (v×100 股) = c×v 元
            amount: Math.round(s.c[i] * s.v[i]),
            seal: seal ? { firstTm: seal.firstTm, openCnt: seal.openCnt, score: seal.score } : null
          })
        }
      }
    }
    Object.defineProperty(ds, '_boards', { value: boards, enumerable: false })
    return boards
  }

  /* ---------------- 默认参数 ---------------- */
  const DEFAULTS = {
    initialCash: 100000,     // 初始资金
    slots: 2,                // 资金份数（同时最大持仓数）
    minLbc: 2,               // 连板数 下限（不含）→ 2 < N < 4 = 只买 3 板
    maxLbc: 4,               // 连板数 上限（不含）
    skipLimitOpen: true,     // T+1 一字涨停开盘 → 买不进，弃买
    stopLossPct: 20,         // 亏 20% 止损（相对买入价）
    trailPct: 20,            // 最高价回撤 20% 止损
    trailIntraday: true,     // 回撤线允许用「当日最高」计算（含先涨后跌的乐观假设）
    exitMode: 'break',       // 'break'=断板即出 | 'days'=持有 N 日 | 'open'=次日开盘无条件卖出
    holdDays: 5,             // exitMode='days' 时的持有交易日数
    maxHoldDays: 10,         // 强制离场上限（防无限持有）
    sortBy: 'lbc',           // 'lbc' 连板优先 | 'amount' 成交额优先 | 'seal' 封板强度优先
    allocMode: 'dynamic',    // 'dynamic' 按当前资金分配 | 'fixed' 固定等分初始资金
    refillOnSkip: false,     // 弃买是否用下一名候选补位（false=名额空过）
    minSealScore: null,      // 封板强度最低分过滤（null=不过滤；仅在 sortBy='seal' 或显式开启时生效）
    boardFilter: 'main',     // 'main' 60/00/30 | 'all' 含 688/8/4
    excludeOneWord: false,   // 是否排除「T 日一字板」（显示用，非成交约束）
    commRate: 0.00025,       // 佣金 万2.5
    minComm: 5,              // 最低佣金
    stampRate: 0.0005,       // 印花税（仅卖出）千0.5
    transferRate: 0.00001    // 过户费 十万分之1（双边）
  }

  function feeOf (amount, side, P) {
    const comm = Math.max(amount * P.commRate, P.minComm)
    const stamp = side === 'sell' ? amount * P.stampRate : 0
    const transfer = amount * P.transferRate
    return comm + stamp + transfer
  }

  /* ---------------- 滑点（成本敏感性测试用，默认 0 = 原行为不变） ----------------
   * slippagePct: 0.005 = 0.5%。买入价上浮、卖出价下调（分单位四舍五入，最小 1 分）。
   * 买卖同滑是「不利方向」的保守假设：打板策略对滑点极敏感，这是必须压的测。
   * slippageMode: 'pct'（按价格比例，默认）| 'tick'（固定跳数 × 0.01 元） */
  function slipC (priceC, side, P) {
    const sp = P.slippagePct || 0
    if (!sp) return priceC
    const d = Math.max(1, Math.round(priceC * sp))
    return side === 'buy' ? priceC + d : Math.max(1, priceC - d)
  }

  /* ---------------- 回测主流程 ---------------- */
  function runBacktest (ds, userParams) {
    const P = Object.assign({}, DEFAULTS, userParams || {})
    const dates = ds.dates
    const N = dates.length
    const stocks = parseDataset(ds)
    const boards = buildBoards(ds, stocks)

    const start = Math.max(ds.warmup, P.startIdx == null ? ds.warmup : P.startIdx)
    const end = P.endIdx == null ? N - 1 : Math.min(P.endIdx, N - 1)
    // start === end：单日模式（只选股不撮合，供模拟账户的「起点日」使用）
    if (end < start) return { error: '回测区间太短' }

    let cash = Math.round(P.initialCash * 100)          // 单位：分
    const cash0 = cash
    const slotBase = Math.round(P.initialCash * 100 / P.slots)
    const positions = []
    const trades = []
    const equity = []
    const skipped = []            // 弃买记录
    const pending = []            // 待买（T 日收盘选出，T+1 开盘执行）
    const lastPick = []           // 最后一个交易日收盘选出的候选（「次日待买」，回测本身不执行它）

    const passFilter = (code) => {
      if (P.boardFilter === 'main') return /^(60|00|30)/.test(code)
      return true
    }

    /* ★ 动态策略切换（可选）：dayPlan(t) 返回当日生效的 slots / 连板区间 / 是否暂停开新仓。
     *   约定：dayPlan 必须只使用「第 t 日开盘之前已经确定」的信息（即 ≤ t-1 收盘数据），
     *   否则会引入未来函数。不传 dayPlan 时 hasPlan=false，全程走固定参数 P，
     *   行为与旧版完全一致（result 不多出任何字段）。
     * ------------------------------------------------------------- */
    const hasPlan = typeof P.dayPlan === 'function'
    const dayLog = []

    let seq = 0
    for (let t = start; t <= end; t++) {
      /* ========== 0. 动态策略切换：按日覆盖参数 ========== */
      let paused = false
      if (hasPlan) {
        const dp = P.dayPlan(t, { date: dates[t], slots: P.slots, minLbc: P.minLbc, maxLbc: P.maxLbc }) || null
        if (dp) {
          if (dp.slots != null) P.slots = dp.slots
          if (dp.minLbc != null) P.minLbc = dp.minLbc
          if (dp.maxLbc != null) P.maxLbc = dp.maxLbc
          paused = !!dp.pause
        }
        dayLog.push({ t, date: dates[t], slots: P.slots, minLbc: P.minLbc, maxLbc: P.maxLbc, pause: paused, tag: dp && dp.tag || null })
      }

      /* ========== 1. 开盘：执行 T-1 收盘给出的买单 ========== */
      for (const item of pending) {
        if (positions.length >= P.slots) break               // 名额已满：本轮不再尝试（补位模式下队列已用完）
        const s = stocks[item.code]
        if (!s) { skipped.push({ date: dates[t], code: item.code, name: item.name, lbc: item.lbc, pickRank: item.pickRank, plannedSlots: item.plannedSlots, reason: '无行情数据' }); continue }
        const bi = s.idxOf[t]
        if (bi == null || bi < 1) { skipped.push({ date: dates[t], code: item.code, name: item.name, lbc: item.lbc, pickRank: item.pickRank, plannedSlots: item.plannedSlots, reason: '停牌' }); continue }
        const openC = slipC(s.o[bi], 'buy', P)      // ★ 滑点：买入价上浮（默认 0 → 原行为）
        const luC = limitUpCents(item.code, s.c[bi - 1])
        if (P.skipLimitOpen && openC >= luC) {
          skipped.push({ date: dates[t], code: item.code, name: item.name, lbc: item.lbc, pickRank: item.pickRank, plannedSlots: item.plannedSlots, reason: '一字涨停开盘，无法成交' }); continue
        }
        const freeSlots = P.slots - positions.length
        const budget = P.allocMode === 'fixed' ? slotBase : Math.floor(cash / freeSlots)
        const use = Math.min(budget, cash)
        let shares = Math.floor(use / (openC * 100)) * 100
        if (shares < 100) { skipped.push({ date: dates[t], code: item.code, name: item.name, lbc: item.lbc, pickRank: item.pickRank, plannedSlots: item.plannedSlots, reason: '资金不足100股' }); continue }
        const amountC = openC * shares
        const feeC = Math.round(feeOf(amountC / 100, 'buy', P) * 100)
        if (amountC + feeC > cash) { shares -= 100; if (shares < 100) { skipped.push({ date: dates[t], code: item.code, name: item.name, lbc: item.lbc, pickRank: item.pickRank, plannedSlots: item.plannedSlots, reason: '资金不足' }); continue } }
        const amountC2 = openC * shares
        const feeC2 = Math.round(feeOf(amountC2 / 100, 'buy', P) * 100)
        cash -= (amountC2 + feeC2)
        positions.push({
          code: item.code, name: item.name, lbc: item.lbc, shares,
          entryC: openC, entryGIdx: t, entryDate: dates[t],
          costC: amountC2 + feeC2, entryFeeC: feeC2,
          highWaterC: openC, holdDays: 0, seq: ++seq,
          pickRank: item.pickRank, plannedSlots: item.plannedSlots, seal: item.seal || null
        })
      }
      pending.length = 0

      /* ========== 2. 盘中 / 收盘：持仓卖出（★A股 T+1：买入当日不可卖出） ========== */
      for (let pi = positions.length - 1; pi >= 0; pi--) {
        const pos = positions[pi]
        if (t === pos.entryGIdx) {
          // 买入当日：T+1 不可卖出，但需记录当日最高价水位（供后续回撤止损使用）
          const s0 = stocks[pos.code]
          const bi0 = s0.idxOf[t]
          if (bi0 != null && s0.h[bi0] > pos.highWaterC) pos.highWaterC = s0.h[bi0]
          continue
        }
        const s = stocks[pos.code]
        const bi = s.idxOf[t]
        if (bi == null) continue                              // 停牌，无法交易
        const o = s.o[bi], h = s.h[bi], l = s.l[bi], c = s.c[bi]
        const prevC = bi > 0 ? s.c[bi - 1] : pos.entryC
        const ldC = limitDownCents(pos.code, prevC)
        const entryC = pos.entryC
        const stopC = Math.round(entryC * (1 - P.stopLossPct / 100))
        const trailC0 = Math.round(pos.highWaterC * (1 - P.trailPct / 100))

        let exitC = null, reason = null, exitTag = null

        const lockedDown = o <= ldC                          // 开盘即跌停 → 卖不出
        if (!lockedDown && P.exitMode === 'open') {
          // 次日开盘无条件卖出：不看止损线、不看是否断板，以开盘第一笔成交价直接离场。
          // 唯一例外是开盘一字跌停（lockedDown）——现实中挂单卖不出，顺延到下一交易日。
          const gapDays = t - pos.entryGIdx
          exitC = o
          reason = gapDays === 1 ? '次日开盘卖出' : '开盘卖出（前一日跌停封死，顺延 ' + gapDays + ' 日）'
          exitTag = 'open'
        } else if (!lockedDown) {
          if (o <= stopC) { exitC = o; reason = '开盘跳空跌破止损-' + P.stopLossPct + '%'; exitTag = 'stop' }
          else if (o <= trailC0) { exitC = o; reason = '开盘跳空跌破回撤线-' + P.trailPct + '%'; exitTag = 'trail' }
          else {
            const hitStop = l <= stopC
            const hitTrail = l <= trailC0
            if (hitStop || hitTrail) {
              if (hitStop && hitTrail) { exitC = Math.min(stopC, trailC0); reason = '止损与回撤同时触发'; exitTag = 'stop' }
              else if (hitStop) { exitC = stopC; reason = '盘中跌破止损-' + P.stopLossPct + '%'; exitTag = 'stop' }
              else { exitC = trailC0; reason = '盘中跌破回撤线-' + P.trailPct + '%'; exitTag = 'trail' }
            } else if (P.trailIntraday) {
              // 当日创出新高 → 以当日最高价重算回撤线。
              // 同一交易日内 h 与 l 的价差达 trailPct，说明盘中确实发生了该幅度回落，
              // 与「先高后低」的顺序无关，因此不构成前视偏差（等价于日内移动止损单）。
              if (h > pos.highWaterC) {
                const trailC1 = Math.round(h * (1 - P.trailPct / 100))
                if (l <= trailC1 && trailC1 > trailC0) { exitC = trailC1; reason = '日内冲高回落触发回撤止损'; exitTag = 'trail' }
              }
            }
          }
        }

        // 离场规则（未触发止损时）
        const heldDays = t - pos.entryGIdx
        if (exitC == null && heldDays >= 1 && c > ldC) {      // 收盘跌停封死 → 卖不出，顺延
          if (P.exitMode === 'break') {
            const luC = limitUpCents(pos.code, prevC)
            // 断板即出：14:56~14:57 看最后状态，未封涨停 → 14:57 挂收盘集合竞价卖单
            // （14:57–15:00 集合竞价期间不可撤单，成交价＝当日收盘价，故此处按收盘价结算）
            if (c < luC) { exitC = c; reason = '断板离场（尾盘集合竞价成交）'; exitTag = 'break' }
          }
          if (exitC == null && P.exitMode === 'days' && heldDays >= P.holdDays) {
            exitC = c; reason = P.holdDays + '个交易日到期'; exitTag = 'time'
          }
          if (exitC == null && heldDays >= P.maxHoldDays) {
            exitC = c; reason = '超过最大持有' + P.maxHoldDays + '日'; exitTag = 'time'
          }
        }

        if (exitC != null) {
          exitC = slipC(exitC, 'sell', P)              // ★ 滑点：卖出价下调（默认 0 → 原行为）
          const amountC = exitC * pos.shares
          const feeC = Math.round(feeOf(amountC / 100, 'sell', P) * 100)
          cash += (amountC - feeC)
          const pnlC = amountC - feeC - pos.costC
          trades.push({
            seq: pos.seq, code: pos.code, name: pos.name, lbc: pos.lbc,
            buyDate: pos.entryDate, buyC: pos.entryC, shares: pos.shares,
            buyAmountC: pos.entryC * pos.shares, buyFeeC: pos.entryFeeC,
            sellDate: dates[t], sellC: exitC,
            sellAmountC: amountC, sellFeeC: feeC,
            pnlC, pnlPct: pos.costC > 0 ? pnlC / pos.costC : 0,
            holdDays: heldDays, reason, tag: exitTag,
            pickRank: pos.pickRank, plannedSlots: pos.plannedSlots,
            refill: pos.pickRank != null && pos.plannedSlots != null && pos.pickRank > pos.plannedSlots,
            seal: pos.seal || null,
            highWaterC: pos.highWaterC, status: 'closed'
          })
          positions.splice(pi, 1)
        } else {
          // 未卖出：更新最高价水位与持有天数
          if (h > pos.highWaterC) pos.highWaterC = h
          pos.holdDays = t - pos.entryGIdx
        }
      }

      /* ========== 3. 收盘后：选股 → 生成 T+1 买单 ========== */
      /* 末日在 end 也跑一次：结果不进撮合，只作为「次日待买清单」返回给模拟交易账户 */
      if (t <= end) {
        const freeSlots = P.slots - positions.length
        if (freeSlots > 0 && !paused) {
          const held = new Set(positions.map(p => p.code))
          let cands = boards[t].filter(b => b.lbc > P.minLbc && b.lbc < P.maxLbc && !held.has(b.code) && passFilter(b.code))
          const sealVal = b => (b.seal && b.seal.score != null ? b.seal.score : -1)
          if (P.minSealScore != null) cands = cands.filter(b => sealVal(b) >= P.minSealScore)
          if (P.sortBy === 'amount') cands.sort((a, b) => b.amount - a.amount)
          else if (P.sortBy === 'amountAsc') cands.sort((a, b) => a.amount - b.amount) // 仅用于「成交额大小」有效性检验
          else if (P.sortBy === 'seal') cands.sort((a, b) => (sealVal(b) - sealVal(a)) || (b.lbc - a.lbc) || (b.amount - a.amount))
          else cands.sort((a, b) => (b.lbc - a.lbc) || (b.amount - a.amount))
          // ★ 抓最高标：可选只取当日连板最高的一档
          if (P.topOnly && cands.length) {
            const top = cands[0].lbc
            cands = cands.filter(b => b.lbc === top)
            cands.sort((a, b) => b.amount - a.amount)
          }
          // ★ 弃买补位：关闭时只挂前 freeSlots 名（买不进就空过）；
          //    开启时把当日全部候选按序入队，前面买不进的用后面的顶替（名额仍受 slots 限制）
          const queue = P.refillOnSkip ? cands : cands.slice(0, freeSlots)
          queue.forEach((cd, idx) => {
            const item = {
              code: cd.code, name: cd.name, lbc: cd.lbc, amount: cd.amount,
              pickRank: idx + 1, plannedSlots: freeSlots,
              seal: cd.seal || null
            }
            pending.push(item)
            if (t === end) lastPick.push(item)
          })
        }
      }

      /* ========== 4. 收盘净值 ========== */
      let mv = 0
      for (const pos of positions) {
        const s = stocks[pos.code]
        const bi = s.idxOf[t]
        const px = bi == null ? pos.entryC : s.c[bi]
        mv += px * pos.shares
      }
      equity.push({ date: dates[t], cashC: cash, mvC: mv, totalC: cash + mv, pos: positions.length })
    }

    /* ========== 汇总 ========== */
    const closed = trades.slice().sort((a, b) => a.seq - b.seq)
    const wins = closed.filter(x => x.pnlC > 0)
    const losses = closed.filter(x => x.pnlC <= 0)
    const sumWin = wins.reduce((s, x) => s + x.pnlC, 0)
    const sumLoss = Math.abs(losses.reduce((s, x) => s + x.pnlC, 0))
    let peak = -Infinity, maxDD = 0
    for (const e of equity) {
      if (e.totalC > peak) peak = e.totalC
      const dd = peak > 0 ? (peak - e.totalC) / peak : 0
      if (dd > maxDD) maxDD = dd
    }
    const finalTotal = equity.length ? equity[equity.length - 1].totalC : cash0
    const summary = {
      initialC: cash0,
      finalC: finalTotal,
      returnPct: finalTotal / cash0 - 1,
      tradeCount: closed.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      avgWinPct: wins.length ? wins.reduce((s, x) => s + x.pnlPct, 0) / wins.length : 0,
      avgLossPct: losses.length ? losses.reduce((s, x) => s + x.pnlPct, 0) / losses.length : 0,
      avgPnlPct: closed.length ? closed.reduce((s, x) => s + x.pnlPct, 0) / closed.length : 0,
      profitFactor: sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0),
      maxWinPct: closed.length ? Math.max.apply(null, closed.map(x => x.pnlPct)) : 0,
      maxLossPct: closed.length ? Math.min.apply(null, closed.map(x => x.pnlPct)) : 0,
      maxDrawdown: maxDD,
      avgHoldDays: closed.length ? closed.reduce((s, x) => s + x.holdDays, 0) / closed.length : 0,
      openPositions: positions.length,
      skippedCount: skipped.length,
      failOpenCount: skipped.filter(x => x.reason.indexOf('一字') >= 0).length,
      startDate: dates[start], endDate: dates[end],
      days: equity.length
    }
    if (hasPlan) summary.pausedDays = dayLog.filter(x => x.pause).length

    const result = { params: P, summary, trades: closed, openPositions: positions.map(p => ({
      code: p.code, name: p.name, lbc: p.lbc, shares: p.shares,
      buyDate: p.entryDate, buyC: p.entryC, costC: p.costC,
      highWaterC: p.highWaterC, holdDays: p.holdDays, status: 'open'
    })), nextDayCandidates: lastPick.slice(), equity, skipped }
    if (hasPlan) result.dayLog = dayLog
    return result
  }

  return { limitPct, limitUpCents, limitDownCents, sealTimeTier, sealScore, parseDataset, buildBoards, runBacktest, DEFAULTS, feeOf }
})
