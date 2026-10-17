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
    /* ★ 剔除创业板（300/301，2026-10-17 新增，默认 false = 原行为）
     *   创业板涨跌停幅度 20%，是主板的两倍：涨停时赚得猛，炸板时跌得更狠，
     *   少数几次「次日暴跌」就能吃掉全年利润。开启后只做 10% 涨跌幅的主板票。 */
    excludeGem: false,
    /* ★ 空仓才开新仓（2026-10-17 新增，默认 false = 原行为不变）
     *   flatOnly   : 只要当前还有任何持仓，即使有名额空闲也不开新仓；
     *                持仓全部卖光后，下一次选股把 slots 一次性开满。
     *   flatOnlyWin: 弱化版 —— 仅当「持仓整体处于浮盈」时禁止开新仓；
     *                浮亏时仍可按空余名额开新仓（对照用，非推荐）。 */
    flatOnly: false,
    flatOnlyWin: false,
    /* ★ 退市/数据终止强平（默认 false = 原行为）。线上引擎历史上缺这一步，
     *   会让「已退市票」永久占用一个名额 ⇒ 归因污染。开启后与 hist-mine.js 的
     *   opt.delistExit 完全一致，用于长区间口径校准。 */
    delistExit: false,
    /* ★ 优化版选股（2026-10-17 首板优化版上线新增，默认全关 ⇒ 原行为逐笔不变）
     *   派生因子全部只用「T 日及之前」的 OHLCV，T 日收盘即可知 ⇒ 无未来函数：
     *     amtRatio 量能比 = T 日成交额 / 前 5 日均成交额
     *     amp      振幅   = (最高 − 最低) / 昨收
     *     closePos 收盘强度 = (收 − 低) / (高 − 低)（封死 = 1）
     *   minAmount 为「T 日成交额下限（元）」，与连板数过滤同性质。 */
    minAmtRatio: null,
    maxAmtRatio: null,
    maxAmp: null,
    minClosePos: null,
    minAmount: 0,
    /* ★ 情绪闸门（T 日收盘可得）：昨日涨停股「今日再封率」> 近 win 日 q 分位 ⇒ 当日收盘不选股
     *   { q:0.70, win:250, minN:125 }
     *   · 再封率 = 昨日涨停票中今日仍涨停的占比（打板赚钱效应的直接度量）
     *   · minN = 最少观测数；不足则闸门自动失效（宁可不动，也不误拦）
     *   · 时序：t 日收盘算好 ⇒ 只影响 t 日收盘选股（t+1 开盘买入）⇒ 无未来函数 */
    gateYz: null,
    /* ★ 连续仓位缩放（而非开关式闸门，2026-10-17 新增，默认 null = 原行为）
     *   同一支「再封率」温度计，但不做「超阈值就彻底不买」的硬开关，而是线性减仓：
     *     p = 今日再封率在近 win 日历史中的分位秩（0=最冷，1=最热）
     *     p ≤ cold             → 满仓（scale = 1）
     *     p ≥ hot              → 空仓（scale = 0）
     *     cold < p < hot       → scale = (hot − p) / (hot − cold)  线性递减
     *   { win:500, cold:0.20, hot:0.90, minN:250 }
     *   · scale 作用于「每份买入金额」，总额度 ≈ scale × 可用资金 ⇒ 仓位连续可调
     *   · scale < 0.05 视为 0（不足最小下单单位，等价于不买）
     *   · 时序同 gateYz：t 日收盘算好 ⇒ 只影响 t 日收盘选股（t+1 开盘买入）⇒ 无未来函数 */
    sizeYz: null,
    /* ★ 账户回撤熔断：净值自历史最高回撤 ≥ ddPct ⇒ 停手 pauseDays 个交易日
     *   （不开新仓，持仓仍按原有规则照常卖出）
     *   { ddPct:0.35, pauseDays:60 }
     *   · 触发时把峰值重置为当前净值 ⇒ 停手期满后重新起算，避免「一次触发永久停手」 */
    ddStop: null,
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

  /* ---------------- T 日收盘可得的派生因子 ----------------
   * 与 hist-mine.js 的 enrichBoards 逐字同源（保证「线上 = 回测」可逐笔对照）。
   * 只在需要（用到 amtRatio / amp / closePos 排序或过滤）时计算，默认路径零开销。 */
  function enrichBoards (boards, stocks) {
    let probe = null
    for (let t = 0; t < boards.length; t++) { if (boards[t] && boards[t].length) { probe = boards[t][0]; break } }
    if (!probe) return boards
    if (Object.prototype.hasOwnProperty.call(probe, 'amtRatio')) return boards
    for (let t = 0; t < boards.length; t++) {
      const day = boards[t]
      for (const b of day) {
        const s = stocks[b.code]
        const bi = s ? s.idxOf[t] : null
        if (bi == null) { b.amtRatio = null; b.amp = null; b.closePos = null; b.gapT = null; b.mom5 = null; b.brkT = null; b.px = null; continue }
        const amtNow = s.c[bi] * s.v[bi]
        let sum = 0, cnt = 0
        for (let k = 1; k <= 5; k++) { const j = bi - k; if (j < 0) break; sum += s.c[j] * s.v[j]; cnt++ }
        const avg = cnt ? sum / cnt : 0
        b.amtRatio = avg > 0 ? amtNow / avg : null
        const pc = s.c[bi - 1]
        b.amp = pc > 0 ? (s.h[bi] - s.l[bi]) / pc : null
        b.closePos = s.h[bi] > s.l[bi] ? (s.c[bi] - s.l[bi]) / (s.h[bi] - s.l[bi]) : 1
        b.gapT = pc > 0 ? s.o[bi] / pc - 1 : null
        b.px = s.c[bi] / 100
        const j5 = bi - 5
        b.mom5 = (j5 >= 0 && s.c[j5] > 0) ? s.c[bi] / s.c[j5] - 1 : null
        b.brkT = s.l[bi] < limitUpCents(b.code, pc) ? 1 : 0
      }
    }
    return boards
  }

  /* ---------------- 情绪序列：昨日涨停股「今日再封率」 ----------------
   * 与 hist-regime.js 的 REG[t].yzRelimit 同源：
   *   分母 = 昨日涨停且今日 still 有行情的票；分子 = 其中今日收盘仍封住涨停的票。
   * 全部为 T 日收盘数据 ⇒ 用于决定 T+1 是否建仓，不构成未来函数。 */
  function buildRelimit (boards, stocks, end, fromIdx) {
    const REG = new Array(end + 1).fill(null)
    /* fromIdx：从第几个交易日开始记录（更早的位置留 null = 「不可用」）。
     * 默认 1（有数据就算，正确语义）；传 warmup 可复现旧口径「前 250 日无历史」的版本。 */
    const t0 = Math.max(1, fromIdx == null ? 1 : fromIdx)
    for (let t = t0; t <= end; t++) {
      const P = boards[t - 1] || []
      let hit = 0, tot = 0
      for (const b of P) {
        const s = stocks[b.code]; if (!s) continue
        const bi = s.idxOf[t], bi0 = s.idxOf[t - 1]
        if (bi == null || bi0 == null) continue
        const c0 = s.c[bi0], c1 = s.c[bi]
        if (!(c0 > 0)) continue
        tot++
        if (c1 >= limitUpCents(b.code, c0)) hit++
      }
      REG[t] = tot ? hit / tot : null
    }
    return REG
  }

  /* ---------------- 回测主流程 ---------------- */
  function runBacktest (ds, userParams) {
    const P = Object.assign({}, DEFAULTS, userParams || {})
    const dates = ds.dates
    const N = dates.length
    const stocks = parseDataset(ds)
    const boards = buildBoards(ds, stocks)
    /* ★ 派生因子按需加工：只有用到 amtRatio / amp / closePos 时才计算 */
    const needEnrich = P.minAmtRatio != null || P.maxAmtRatio != null || P.maxAmp != null || P.minClosePos != null ||
      P.sortBy === 'amtRatio' || P.sortBy === 'amtRatioLow' || P.sortBy === 'closePos' || P.sortBy === 'ampLow'
    if (needEnrich) enrichBoards(boards, stocks)

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

    /* ★ 退市强平：每只票在 [start,end] 内的最后一个有行情日 */
    let stockLastT = null
    if (P.delistExit) {
      stockLastT = {}
      for (const code of Object.keys(stocks)) {
        const s = stocks[code]
        let Lt = -1
        for (let t = start; t <= end; t++) if (s.idxOf[t] != null) Lt = t
        stockLastT[code] = Lt
      }
    }
    const lastCloseC = (code, t) => {
      const s = stocks[code]
      for (let t2 = t - 1; t2 >= start; t2--) { const bi = s.idxOf[t2]; if (bi != null) return s.c[bi] }
      return 0
    }

    const passFilter = (code) => {
      if (P.excludeGem && /^(300|301)/.test(code)) return false
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
    const flatIdle = { days: 0, slots: 0 }   // ★ 因「空仓才开仓」而闲置的名额天数（诊断用）
    /* ★ 情绪闸门序列 / 回撤熔断状态（默认不启用，字段不出现在结果里） */
    const REG = (P.gateYz || P.sizeYz) ? buildRelimit(boards, stocks, end, (P.gateYz || P.sizeYz).fromIdx) : null
    let gatedDays = 0
    let ddPeakC = null, ddUntil = -1, ddTriggers = [], ddBlockDays = 0
    /* ★ 末日（= end）的风控状态：供模拟盘/人为跟随展示「明天要不要停手」 */
    let lastGateHit = false, lastDdPause = false
    /* 取「近 win 日」的再封率历史样本（不含当日，避免自比较） */
    const yzHist = (t, win) => {
      const h = []
      for (let k = t - win; k < t; k++) { const v = REG[k]; if (v != null && isFinite(v)) h.push(v) }
      return h
    }
    const gateHit = (t) => {
      if (!REG || !P.gateYz) return false
      const cur = REG[t]
      if (cur == null || !isFinite(cur)) return false
      const g = P.gateYz
      const win = g.win || 250
      const q = g.q == null ? 0.7 : g.q
      const minN = g.minN != null ? g.minN : Math.ceil(win * 0.5)
      const h = yzHist(t, win)
      if (h.length < minN) return false
      h.sort((a, b) => a - b)
      return cur > h[Math.floor(h.length * q)]
    }
    /* ★ 连续仓位系数：返回 0~1 的「仓位比例」，1=满仓，0=空仓 */
    let sizeDays = 0, sizeSum = 0, sizeCnt = 0
    const sizeScaleOf = (t) => {
      if (!P.sizeYz || !REG) return 1
      const cur = REG[t]
      if (cur == null || !isFinite(cur)) return 1
      const g = P.sizeYz
      const win = g.win || 500
      const cold = g.cold == null ? 0.20 : g.cold
      const hot = g.hot == null ? 0.90 : g.hot
      const minN = g.minN != null ? g.minN : Math.ceil(win * 0.5)
      const h = yzHist(t, win)
      if (h.length < minN) return 1
      let below = 0
      for (const v of h) if (v < cur) below++
      const p = below / h.length
      let sc
      if (g.mode === 'u') {
        /* ★ 倒 U 型（实测修正版）：中间温度满仓，两头都减仓。
         *   实测最冷档与最热档都是最差的（各约 +0.26%/笔），中性档最好（+1.61%/笔），
         *   所以「冷清就满仓」是反的 —— 冷清时没有接力资金。
         *   { mode:'u', c1:0.30, c2:0.70, lo:0.00, hi:0.90 } */
        const c1 = g.c1 == null ? 0.30 : g.c1
        const c2 = g.c2 == null ? 0.70 : g.c2
        const lo = g.lo == null ? 0.00 : g.lo
        const hi = g.hi == null ? 0.90 : g.hi
        if (p >= c1 && p <= c2) sc = 1
        else if (p < c1) sc = c1 > lo ? (p - lo) / (c1 - lo) : 1
        else sc = hi > c2 ? (hi - p) / (hi - c2) : 1
      } else if (p <= cold) sc = 1
      else if (p >= hot) sc = 0
      else sc = (hot - p) / (hot - cold)
      if (sc > 1) sc = 1
      if (sc < 0.05) sc = 0            // 不足最小下单单位 ⇒ 等价于不买
      sizeCnt++; sizeSum += sc
      if (sc < 1) sizeDays++
      return sc
    }
    for (let t = start; t <= end; t++) {
      /* ========== 0. 动态策略切换：按日覆盖参数 ========== */
      lastGateHit = false; lastDdPause = false
      let paused = false
      if (hasPlan) {
        const dp = P.dayPlan(t, { date: dates[t], slots: P.slots, minLbc: P.minLbc, maxLbc: P.maxLbc }) || null
        if (dp) {
          if (dp.slots != null) P.slots = dp.slots
          if (dp.minLbc != null) P.minLbc = dp.minLbc
          if (dp.maxLbc != null) P.maxLbc = dp.maxLbc
          if (dp.flatOnly != null) P.flatOnly = dp.flatOnly
          if (dp.flatOnlyWin != null) P.flatOnlyWin = dp.flatOnlyWin
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
        const sc = item.sizeScale == null ? 1 : item.sizeScale   // ★ 连续仓位系数（缺省 1 = 原行为）
        const budget = P.allocMode === 'fixed' ? Math.floor(slotBase * sc) : Math.floor(cash / freeSlots * sc)
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

      /* ========== 2.5 退市/数据终止强平（可选）：按最后可得收盘价平掉、释放名额 ========== */
      if (P.delistExit) {
        for (let pi = positions.length - 1; pi >= 0; pi--) {
          const pos = positions[pi]
          if (t <= pos.entryGIdx) continue
          const sp = stocks[pos.code]
          if (sp && sp.idxOf[t] != null) continue
          if (t <= stockLastT[pos.code]) continue
          const exitC = lastCloseC(pos.code, t)
          if (exitC <= 0) continue
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
            holdDays: t - pos.entryGIdx, reason: '持仓股退市/数据终止，按最后可得收盘价强平', tag: 'delist',
            pickRank: pos.pickRank, plannedSlots: pos.plannedSlots,
            refill: false, seal: pos.seal || null,
            highWaterC: pos.highWaterC, status: 'closed'
          })
          positions.splice(pi, 1)
        }
      }

      /* ========== 2.6 收盘后的两道「不开新仓」闸门 ==========
       * 二者都只拦「t 日收盘选股 → t+1 开盘买入」，不改变卖出逻辑
       * （持仓仍按断板/止损/回撤/最长持有照常离场），因此不会造成「该卖没卖」。 */
      let pausedClose = paused
      /* ① 情绪闸门：今日再封率 > 近 win 日 q 分位 ⇒ 明日不开新仓（T 日收盘可得，无未来函数） */
      if (gateHit(t)) { gatedDays++; pausedClose = true; lastGateHit = true }
      /* ② 账户回撤熔断：净值自最高点回撤 ≥ ddPct ⇒ 停手 pauseDays 个交易日 */
      const DD = P.ddStop
      if (DD) {
        let mvNowC = 0
        for (const pos of positions) {
          const sp = stocks[pos.code], bi = sp ? sp.idxOf[t] : null
          mvNowC += (bi == null ? pos.entryC : sp.c[bi]) * pos.shares
        }
        const eqNow = cash + mvNowC
        if (ddPeakC == null || eqNow > ddPeakC) ddPeakC = eqNow
        const ddNow = ddPeakC > 0 ? (ddPeakC - eqNow) / ddPeakC : 0
        /* 只在「当前不在停手中」时判定：停手期没有交易，回撤不会自行修复，
         * 若每日续期会一次触发即永久停手。触发时把峰值重置为当前净值 ⇒ 期满重新起算。 */
        if (t > ddUntil && ddNow >= DD.ddPct) {
          ddTriggers.push({ date: dates[t], dd: ddNow, from: dates[Math.min(t + 1, N - 1)], to: dates[Math.min(t + (DD.pauseDays || 0), N - 1)] })
          ddUntil = t + (DD.pauseDays || 0)
          ddPeakC = eqNow
        }
        if (t <= ddUntil) { ddBlockDays++; pausedClose = true; lastDdPause = true }
      }

      /* ========== 3. 收盘后：选股 → 生成 T+1 买单 ========== */
      /* 末日在 end 也跑一次：结果不进撮合，只作为「次日待买清单」返回给模拟交易账户 */
      if (t <= end) {
        /* ★ 空仓才开新仓：有持仓时（或「持仓浮盈」时）即使有名额空闲也不开新仓。
         *   清空持仓后，下一次选股把 slots 一次性开满 =「卖出后同时开仓」。 */
        let flatBlock = false
        if (positions.length > 0 && P.flatOnly) {
          flatBlock = true
        } else if (positions.length > 0 && P.flatOnlyWin) {
          let mvC = 0, costSumC = 0
          for (const pos of positions) {
            const sp = stocks[pos.code]
            const bi = sp ? sp.idxOf[t] : null
            mvC += (bi == null ? pos.entryC : sp.c[bi]) * pos.shares
            costSumC += pos.costC
          }
          if (mvC > costSumC) flatBlock = true
        }
        if (flatBlock) {
          const idle = Math.max(0, P.slots - positions.length)
          if (idle > 0) { flatIdle.days++; flatIdle.slots += idle }
        }
        /* ★ 连续仓位系数（默认 1 = 原行为）：按再封率分位线性缩放每份买入金额 */
        const sScale = sizeScaleOf(t)
        const freeSlots = flatBlock ? 0 : (P.slots - positions.length)
        if (freeSlots > 0 && !pausedClose && sScale > 0) {
          const held = new Set(positions.map(p => p.code))
          let cands = boards[t].filter(b => b.lbc > P.minLbc && b.lbc < P.maxLbc && !held.has(b.code) && passFilter(b.code) &&
            (P.minAmount <= 0 || b.amount >= P.minAmount) &&
            (P.minAmtRatio == null || (b.amtRatio != null && b.amtRatio >= P.minAmtRatio)) &&
            (P.maxAmtRatio == null || (b.amtRatio != null && b.amtRatio <= P.maxAmtRatio)) &&
            (P.maxAmp == null || (b.amp != null && b.amp <= P.maxAmp)) &&
            (P.minClosePos == null || (b.closePos != null && b.closePos >= P.minClosePos)))
          const sealVal = b => (b.seal && b.seal.score != null ? b.seal.score : -1)
          if (P.minSealScore != null) cands = cands.filter(b => sealVal(b) >= P.minSealScore)
          /* ★ 排序口径（新增项一律排在原三项之后，默认 'lbc' 路径不变）：
           *   'amtRatio'  量能比降序（T 日成交额 / 前5日均额）
           *   'amtRatioLow' 量能比升序  | 'closePos' 收盘强度降序 | 'ampLow' 振幅升序 */
          const numV = v => (v == null || !isFinite(v)) ? -Infinity : v
          if (P.sortBy === 'amount') cands.sort((a, b) => b.amount - a.amount)
          else if (P.sortBy === 'amountAsc') cands.sort((a, b) => a.amount - b.amount) // 仅用于「成交额大小」有效性检验
          else if (P.sortBy === 'seal') cands.sort((a, b) => (sealVal(b) - sealVal(a)) || (b.lbc - a.lbc) || (b.amount - a.amount))
          else if (P.sortBy === 'amtRatio') cands.sort((a, b) => numV(b.amtRatio) - numV(a.amtRatio) || b.amount - a.amount)
          else if (P.sortBy === 'amtRatioLow') cands.sort((a, b) => numV(a.amtRatio) - numV(b.amtRatio) || b.amount - a.amount)
          else if (P.sortBy === 'closePos') cands.sort((a, b) => numV(b.closePos) - numV(a.closePos) || b.amount - a.amount)
          else if (P.sortBy === 'ampLow') cands.sort((a, b) => numV(a.amp) - numV(b.amp) || b.amount - a.amount)
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
              sizeScale: sScale,
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
    if (P.flatOnly || P.flatOnlyWin) { summary.flatIdleDays = flatIdle.days; summary.flatIdleSlots = flatIdle.slots }
    if (P.gateYz) { summary.gatedDays = gatedDays; summary.gateToday = lastGateHit }
    if (P.sizeYz) {
      summary.sizeDays = sizeDays                                     // 未满仓的交易日数
      summary.sizeAvg = sizeCnt ? sizeSum / sizeCnt : 1               // 平均仓位系数
      summary.sizeScaleToday = sizeScaleOf(end)                       // 末日系数 ⇒ 明日应以几成仓买入
      summary.gateToday = summary.gateToday || summary.sizeScaleToday === 0
    }
    if (P.ddStop) {
      summary.ddTriggers = ddTriggers.length
      summary.ddBlockDays = ddBlockDays
      summary.ddPauseToday = lastDdPause
      summary.ddPauseLeft = Math.max(0, ddUntil - end)   // 从末日起，还要停手几个交易日
    }

    const result = { params: P, summary, trades: closed, openPositions: positions.map(p => ({
      code: p.code, name: p.name, lbc: p.lbc, shares: p.shares,
      buyDate: p.entryDate, buyC: p.entryC, costC: p.costC,
      highWaterC: p.highWaterC, holdDays: p.holdDays, status: 'open'
    })), nextDayCandidates: lastPick.slice(), equity, skipped }
    if (hasPlan) result.dayLog = dayLog
    if (P.ddStop) result.ddStop = { triggers: ddTriggers, blockDays: ddBlockDays }
    return result
  }

  return { limitPct, limitUpCents, limitDownCents, sealTimeTier, sealScore, parseDataset, buildBoards, runBacktest, DEFAULTS, feeOf }
})
