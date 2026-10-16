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
const RL = require('./lib/rolling.js')

const ROOT = __dirname
const DATA = path.join(ROOT, 'data')
const STORE_FILE = path.join(DATA, 'store.json')
const CONFIG_FILE = path.join(ROOT, 'config.json')
const OUT_FILE = path.join(DATA, 'intraday.json')

const DRY = process.argv.includes('--dry')
const BJ = ST.beijingNow(process.env.PAPER_NOW ? Date.parse(process.env.PAPER_NOW) : null)

/* ★ 早盘执行清单推送（半自动模式）：只在「开盘第一帧」推一次，
 *   告诉用户今天实际该在券商 App / QMT 里怎么下单。
 *   去重：同一交易日只推一次（结果落盘 paper/data/.morning-push.json 由工作流提交）。 */
const PUSH_STATE = path.join(ROOT, 'data', '.morning-push.json')

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

/* ---------------- 早盘执行清单（半自动下单用） ---------------- */
function post (u, body, headers) {
  return new Promise((resolve, reject) => {
    const url = require('url').parse(u)
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const req = require('https').request({
      hostname: url.hostname, path: url.path, method: 'POST', timeout: 15000,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {})
    }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', d => (b += d)); res.on('end', () => resolve(b)) })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data); req.end()
  })
}
function buildMorning (bjDate, hhmm, strategies) {
  const m2 = strategies.filter(s => s.id === 'M2')[0]
  const L = ['### 🔔 M2 今日执行清单', '> ' + bjDate + ' ' + hhmm + '（开盘前，请人工下单价）', '']
  if (!m2) return L.join('\n')
  L.push('**今日做：' + m2.pickToday + '**')
  if (m2.trace) L.push('依据：' + m2.trace.map(x => x.name + ' 近10日 ' + (x.ret == null ? '—' : pct(x.ret))).join('，') + ' → 取最强')
  L.push('')
  if (m2.todayBuys && m2.todayBuys.length) {
    L.push('**买入（09:30–09:33 挂单，越早越接近竞价开盘价）**')
    m2.todayBuys.forEach(b => L.push('- ' + b.code + ' ' + b.name + '　' + b.lbc + '板　' + b.shares + '股　参考价 ' + (b.buyC / 100).toFixed(2)))
    L.push('')
    L.push('> ⏱ 别追价：实测 09:30–9:35 相对开盘价平均仅 +0.35%（双向对称），但越晚单笔波动越大（±5~10%）。')
    L.push('')
  } else {
    L.push('**买入：今日无（候选 ' + ((m2.nextCandidates || []).length) + ' 只，见昨日清单）**')
    L.push('')
  }
  if (m2.todaySells && m2.todaySells.length) {
    L.push('**待卖出（14:57 前确认未封板才挂单，未到 14:57 一律不卖）**')
    m2.todaySells.forEach(t => L.push('- ' + t.code + ' ' + t.name + '　' + t.reason))
    L.push('')
  }
  if (m2.positions && m2.positions.length) {
    L.push('**持仓盯板（14:57 判定）**')
    m2.positions.forEach(p => L.push('- ' + p.code + ' ' + p.name + '　现价 ' + (p.curC != null ? (p.curC / 100).toFixed(2) : '—') + (p.ztNow ? '　🔒涨停中' : '')))
    L.push('')
  }
  L.push('> 未封板才卖，成交价≈收盘价；一字涨停开盘买不进则弃买。模拟盘非投资建议。')
  return L.join('\n')
}
async function morningPush (bjDate, hhmm, strategies) {
  const PP = process.env.PUSHPLUS_TOKEN, SC = process.env.SENDKEY, WC = process.env.WECOM_WEBHOOK
  if (!PP && !SC && !WC) { console.log('  早盘推送：未配置渠道（跳过）'); return }
  if (!DRY) {
    let st = null
    try { st = JSON.parse(fs.readFileSync(PUSH_STATE, 'utf8')) } catch (_) {}
    if (st && st.date === bjDate) { console.log('  早盘推送：今日已推过（' + bjDate + '），跳过'); return }
  }
  const md = buildMorning(bjDate, hhmm, strategies)
  const out = []
  if (PP) { try { await post('https://www.pushplus.plus/send', { token: PP, title: 'M2 今日执行清单 · ' + bjDate, content: md, template: 'markdown' }); out.push('pushplus ok') } catch (e) { out.push('pushplus 失败:' + e.message) } }
  if (SC) { try { await post('https://sctapi.ftqq.com/' + SC + '.send', { title: 'M2 今日执行清单 · ' + bjDate, desp: md }); out.push('serverchan ok') } catch (e) { out.push('serverchan 失败:' + e.message) } }
  if (WC) { try { await post(WC, { msgtype: 'markdown', markdown: { content: md.slice(0, 4000) } }); out.push('wecom ok') } catch (e) { out.push('wecom 失败:' + e.message) } }
  console.log('  早盘推送：' + out.join('；'))
  if (!DRY) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PUSH_STATE, JSON.stringify({ date: bjDate, at: new Date().toISOString() }), 'utf8') }
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

  /* --- 4. 同一套引擎重放到今天（纯内存预览，绝不写数据集） ---
   * ★ 2026-10-16：盘中阶段的「卖出/买入」是【预演】而非已成交 —— 引擎把「现价」当「今收」
   *   跑出的投影。若不标注，用户会误以为已经卖出（尤其盘中现价低于涨停价时，
   *   断板判定立即成立，看起来像"开盘就卖了"）。故此处：
   *   ① 盘中（trading）给 reason 加【预演】前缀 + 明细里带现价/涨停价对比
   *   ② 加 preview:true 字段供前端改用预演样式
   *   ③ 收盘后（closed）保持原文案（此时"预演"≡真实结果，无需前缀） */
  const isTrading = phase === 'trading'
  const previewReason = (t) => {
    if (!isTrading) return t.reason
    /* 断板类：补上「现价 vs 涨停价」的对比，让用户一眼看出是按哪个价判的
     * ★ 单位：quote.js 的 price/prevClose 都是「元」，直接 toFixed(2)，不要再 /100 */
    if (t.tag === 'break' || /断板/.test(t.reason || '')) {
      const qt = q[t.code]
      if (qt && qt.price > 0 && qt.prevClose > 0) {
        const cur = qt.price.toFixed(2)
        const zt = (qt.prevClose * (1 + (/^(30|68)/.test(t.code) ? 0.2 : 0.1))).toFixed(2)
        return '【预演·未成交】现价 ' + cur + ' < 涨停 ' + zt + ' ⇒ 若 14:57 仍如此则在尾盘集合竞价卖出（成交价＝当日收盘价）'
      }
    }
    return '【预演·未成交】' + (t.reason || '')
  }
  const sim = SIM.computeAll(synth, cfg)
  const strategies = sim.results.map(r => ({
    id: r.id, name: r.name,
    pickToday: r.m2 ? r.m2.pickToday.name : undefined,
    trace: r.m2 ? r.m2.trace : undefined,
    totalC: r.totalC, dayPnlC: r.dayPnlC, dayRet: r.dayRet, cumRet: r.cumRet,
    todayBuys: r.todayBuys.map(p => ({ code: p.code, name: p.name, lbc: p.lbc, shares: p.shares, buyC: p.buyC, preview: isTrading })),
    todaySells: r.todayTrades.map(t => ({ code: t.code, name: t.name, sellC: t.sellC, pnlC: t.pnlC, pnlPct: t.pnlPct, reason: previewReason(t), preview: isTrading })),
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

  /* --- 5. 滚动验证（同一 synth 数据集 ⇒ 状态也随盘中最新价更新） --- */
  let rolling = null
  try { rolling = RL.rollingCheck(synth, { slip: 0 }) } catch (e) { console.log('  ⚠️ 滚动验证失败（不影响主流程）：' + e.message) }

  writeOut({
    updated: new Date().toISOString(),
    bjDate: BJ.date, bjTime: hhmm, phase,
    note: phase === 'trading'
      ? '盘中预演（不是真实成交）：今开已定 ⇒ 开盘买入为真实成交价；现价随行情跳动，「卖出」是按【当前现价】预先推算出来的结果，未到 14:57 一律不卖，以收盘跑（daily.js）为准'
      : '已收盘预演快照，正式账户以收盘跑为准',
    rolling: rolling || undefined,
    strategies
  })
  /* ★ 开盘首帧（09:25–09:45）推一次「今日执行清单」——半自动下单用，同日去重 */
  if (phase === 'trading' && BJ.min <= 9 * 60 + 45) {
    await morningPush(BJ.date, hhmm, strategies)
  }
  console.log('  预演完成：' + strategies.map(s => s.id + ' ' + pct(s.dayRet)).join(' / ') + '，耗时 ' + Math.round((Date.now() - t0) / 1000) + 's')
}

main().catch(e => { console.error('运行失败：', e); process.exit(1) })
