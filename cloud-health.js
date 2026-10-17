/* ============================================================================
 *  云端轻量体检（cloud-lite health check）
 *  为什么存在：
 *    本地 s3-health.js 依赖 hist/dataset.json（154MB / 2020 起 6 年全历史），
 *    只能在本机跑 —— 电脑关机当天就没有体检信号。
 *    本脚本跑在 GitHub Actions（daily.yml 每日收盘后），只用云端已有的
 *    data/store.json（滚动累积，约 223 个交易日）做「能做的部分」：
 *      ① 数据新鲜度  ② 配置 vs 方案基线  ③ 近 20 / 60 日单笔均值 + t 值
 *      ④ 近 60 日连板率（S3 全部利润来源）  ⑤ 当前回撤  ⑥ 闸门/熔断停手状态
 *    做不了的（全历史风格分档、条件期望、滚动分位）留给本地深度体检。
 *
 *  ⚠️ 阈值必须与根目录 s3-health.js 的 TH / BASELINE 保持一致。
 *     改一处就要改两处，否则两套体检会给出互相矛盾的结论。
 *
 *  输出：data/health-cloud.json（供 health.html 运行时拉取展示）
 *  推送：watch / red 时走 daily.js 同一套渠道（pushplus / serverchan / 企业微信）
 * ==========================================================================*/
const fs = require('fs')
const path = require('path')
const https = require('https')
const BS = require('./lib/strategy.js')

const ROOT = __dirname
const STORE_PATH = path.join(ROOT, 'data/store.json')
const CFG_PATH = path.join(ROOT, 'config.json')
const DASH_PATH = path.join(ROOT, 'data/dashboard.json')
const OUT_PATH = path.join(ROOT, 'data/health-cloud.json')

/* ---------------- 判定阈值（与 s3-health.js 的 TH 同步） ---------------- */
const TH = {
  dataLagWatch: 3,
  dataLagAlert: 8,
  m20WatchN: 12,
  m20Watch: 0,
  m60AlertT: -2.0,
  m60WatchRatio: 0.5,
  ddWatch: 0.25,
  ddAlert: 0.35,
  chainWatch: 0.09,
  chainAlert: 0.05
}

/* 方案基线（= 打板策略-改版方案-v20261017.md 定稿参数），与 s3-health.js 同步 */
const BASELINE = {
  slots: 2, minLbc: 0, maxLbc: 2, sortBy: 'amtRatio', minAmtRatio: 1.5,
  delistExit: true, trailPct: 25, stopLossPct: 20, exitMode: 'break',
  maxHoldDays: 10, allocMode: 'dynamic', boardFilter: 'main', maxGem: 1,
  gateYz: { q: 0.80, win: 250 }, ddStop: { ddPct: 0.35, pauseDays: 60 }
}

/* ---------------- 小工具 ---------------- */
const pct = (v, n) => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(n == null ? 2 : n) + '%'
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0
const sd = a => {
  if (a.length < 2) return 0
  const m = mean(a)
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))
}
const tstat = a => a.length < 2 ? 0 : mean(a) / (sd(a) / Math.sqrt(a.length))
function workdaysBetween (a, b) {
  const d0 = new Date(a + 'T00:00:00')
  const d1 = new Date(b + 'T00:00:00')
  let n = 0
  for (let d = new Date(d0); d < d1; d.setDate(d.getDate() + 1)) {
    const w = d.getDay()
    if (w !== 0 && w !== 6) n++
  }
  return n
}
const today = (() => {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
})()

/* ---------------- 读数据 ---------------- */
if (!fs.existsSync(STORE_PATH)) {
  console.error('✗ 缺少 data/store.json，云端体检跳过')
  process.exit(0)
}
const ds = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
const S3 = (cfg.strategies || []).find(s => s.id === 'S3')
if (!S3) { console.error('✗ config.json 里找不到 S3'); process.exit(1) }
const P = S3.params

const DATES = ds.dates
const END = DATES.length - 1
const START = ds.warmup
const di = {}
DATES.forEach((d, i) => { di[d] = i })

/* ---------------- 跑当前线上参数 ---------------- */
const r = BS.runBacktest(ds, Object.assign({}, P, { startIdx: START, endIdx: END }))
const TR = r.trades || []
const EQ = r.equity || []
const S = r.summary || {}

/* 持有期最高板（判「连板率」用：S3 的利润全部来自连板）。
 * 注意 buildBoards 返回的是「按日索引的涨停股对象数组」：boards[t] = [{code,name,lbc,...}, ...]，
 * 不是 {code: lbc} 映射（本地 s3-health.js 自己转了一层 boardByDate，口径与此等价）。 */
const stocks = BS.parseDataset(ds)
const boards = BS.buildBoards(ds, stocks)
const boardByDate = {}
for (let t = 0; t < DATES.length; t++) {
  const m = {}
  for (const b of (boards[t] || [])) m[b.code] = b.lbc
  boardByDate[t] = m
}
function maxLbcOf (code, buyDate, sellDate) {
  const i0 = di[buyDate]
  const i1 = di[sellDate]
  if (i0 == null || i1 == null) return 1
  let m = 1                                   /* 买入时本身就是首板 ⇒ 下限 1，与本地版一致 */
  for (let t = i0; t <= i1 && t < DATES.length; t++) {
    const v = boardByDate[t][code]
    if (v && v > m) m = v
  }
  return m
}
TR.forEach(t => { t._maxLbc = maxLbcOf(t.code, t.buyDate, t.sellDate) })

/* ---------------- 判定 ---------------- */
const checks = []
function add (level, id, name, actual, standard, hint) {
  checks.push({ level, id, name, actual, standard, hint: hint || '' })
}

/* ① 数据新鲜度 */
const lag = workdaysBetween(DATES[END], today)
add(lag > TH.dataLagAlert ? 'red' : (lag > TH.dataLagWatch ? 'watch' : 'ok'),
  'dataLag', '云端数据新鲜度', '落后 ' + lag + ' 个工作日（至 ' + DATES[END] + '）',
  '≤ ' + TH.dataLagWatch + ' 个工作日',
  lag > TH.dataLagWatch ? '云端 store 由 daily.js 每交易日追加；连日不更新说明上游抓取失败，需查 Actions 日志' : '')

/* ② 配置 vs 方案基线（先怀疑误改，而不是策略失效） */
const cfgDiff = []
for (const k of Object.keys(BASELINE)) {
  const a = JSON.stringify(P[k] === undefined ? null : P[k])
  const b = JSON.stringify(BASELINE[k])
  if (a !== b) cfgDiff.push(k + '=' + a + '（基线 ' + b + '）')
}
add(cfgDiff.length ? 'watch' : 'ok', 'config', '配置 vs 方案基线',
  cfgDiff.length ? cfgDiff.join('；') : '完全一致',
  '与改版方案定稿一致',
  cfgDiff.length ? '若是有意改动请同步更新 BASELINE；否则先恢复，再谈绩效' : '')

/* ③ 近 20 / 60 日单笔均值 */
function windowStats (days) {
  const from = Math.max(START, END - days + 1)
  const t0 = DATES[from], t1 = DATES[END]
  const tr = TR.filter(t => t.sellDate >= t0 && t.sellDate <= t1)
  const arr = tr.map(t => t.pnlPct)
  const n = tr.length
  return {
    n,
    mean: n ? mean(arr) : null,
    t: n >= 3 ? tstat(arr) : null,
    winRate: n ? tr.filter(t => t.pnlC > 0).length / n : null,
    chainRate: n ? tr.filter(t => t._maxLbc >= 2).length / n : null,
    activeDays: new Set(tr.map(t => t.buyDate)).size,
    from: t0, to: t1, windowDays: END - from + 1
  }
}
const w20 = windowStats(20)
const w60 = windowStats(60)
const fullArr = TR.map(t => t.pnlPct)
const full = { n: TR.length, mean: TR.length ? mean(fullArr) : null, t: TR.length >= 3 ? tstat(fullArr) : null }

/* 近 20 日：只有开仓天数够多才判（否则是闸门停手，不是失效） */
const m20Bad = w20.n >= TH.m20WatchN && w20.mean != null && w20.mean < TH.m20Watch
add(m20Bad ? 'watch' : 'ok', 'm20', '近 20 日单笔均值',
  pct(w20.mean) + '（' + w20.n + ' 笔 / ' + w20.activeDays + ' 个开仓日）', '≥ 0',
  m20Bad ? (w20.activeDays <= 8 ? '开仓日只有 ' + w20.activeDays + ' 天 ⇒ 多半是闸门/熔断在停手，先看风控状态' : '观察；连续 2 次为负再排查') : '')

/* 近 60 日：t 值才是硬指标 */
let m60Level = 'ok'
let m60Hint = ''
if (w60.t != null && w60.t <= TH.m60AlertT) { m60Level = 'red'; m60Hint = '近 60 日显著为负，建议立即做深度排查' }
else if (w60.mean != null && full.mean != null && w60.mean < full.mean * TH.m60WatchRatio) { m60Level = 'watch'; m60Hint = '近 60 日单笔不及全区间一半，先观察并核对风格' }
add(m60Level, 'm60', '近 60 日单笔均值',
  pct(w60.mean) + '（t=' + (w60.t == null ? '—' : w60.t.toFixed(2)) + '，' + w60.n + ' 笔）',
  't > ' + TH.m60AlertT + ' 且 ≥ 全区间 ' + pct(full.mean, 0) + ' 的一半', m60Hint)

/* ④ 近 60 日连板率 */
const chainLevel = w60.chainRate == null ? 'na'
  : (w60.chainRate < TH.chainAlert ? 'red' : (w60.chainRate < TH.chainWatch ? 'watch' : 'ok'))
add(chainLevel, 'chain60', '近 60 日连板率（右尾）',
  pct(w60.chainRate) + '（' + w60.n + ' 笔中 ' + (w60.chainRate == null ? 0 : Math.round(w60.chainRate * w60.n)) + ' 笔再封板）',
  '≥ ' + pct(TH.chainWatch, 0),
  chainLevel === 'red' ? '连板率极低 ⇒ 收益右尾断了，必查（题材/涨停生态变化）' : (chainLevel === 'watch' ? '连板率偏低，先观察' : ''))

/* ⑤ 当前回撤 */
let peak = 0, ddNow = 0
for (const e of EQ) {
  if (e.totalC > peak) peak = e.totalC
  if (peak > 0) ddNow = Math.max(ddNow, 1 - e.totalC / peak)
}
const ddLevel = ddNow >= TH.ddAlert ? 'red' : (ddNow >= TH.ddWatch ? 'watch' : 'ok')
add(ddLevel, 'dd', '当前回撤（自有数据峰值起算）', pct(ddNow),
  '< ' + pct(TH.ddWatch, 0) + '（' + pct(TH.ddAlert, 0) + ' 触发熔断）',
  ddLevel === 'red' ? '已到熔断线，确认 ddStop 是否已停手' : '')

/* ⑥ 风控状态（信息项，不单独判定，用来解释「为什么近 20 日没赚钱」） */
const risk = {
  gatedDays: S.gatedDays || 0,
  gateToday: !!S.gateToday,
  ddPauseLeft: S.ddPauseLeft || 0,
  ddTriggers: S.ddTriggers || 0,
  ddBlockDays: S.ddBlockDays || 0,
  activeDays60: w60.activeDays,
  windowDays60: w60.windowDays
}
add('na', 'risk', '风控状态（参考）',
  '近 60 日开仓 ' + risk.activeDays60 + '/' + risk.windowDays60 + ' 天'
  + (risk.ddPauseLeft > 0 ? '　·　熔断停手中，还剩 ' + risk.ddPauseLeft + ' 个交易日' : '')
  + (risk.gateToday ? '　·　今日闸门关闭（不开新仓）' : ''),
  '—', '停手是设计内行为，不算异常；但会拉低短期笔数')

/* ---------------- 汇总 ---------------- */
const reds = checks.filter(c => c.level === 'red')
const watches = checks.filter(c => c.level === 'watch')
const status = reds.length ? 'red' : (watches.length ? 'watch' : 'green')
const statusText = status === 'red' ? '异常 · 建议立即排查' : status === 'watch' ? '观察 · 暂不改参数' : '正常 · 无需动作'

/* 留痕：滚动保留最近 120 条 */
const histPath = path.join(ROOT, 'data/health-cloud-history.json')
let hist = []
try { hist = JSON.parse(fs.readFileSync(histPath, 'utf8')) } catch (e) { hist = [] }
if (!Array.isArray(hist)) hist = []
hist = hist.filter(x => x && x.date !== DATES[END])
hist.push({
  date: DATES[END], at: new Date().toISOString(), status,
  m20: w20.mean, m60: w60.mean, m60t: w60.t, chain60: w60.chainRate, dd: ddNow
})
hist = hist.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-120)
fs.writeFileSync(histPath, JSON.stringify(hist))

const out = {
  at: new Date().toISOString(),
  date: DATES[END],
  mode: 'cloud-lite',
  status,
  statusText,
  counts: { red: reds.length, watch: watches.length, ok: checks.filter(c => c.level === 'ok').length, na: checks.filter(c => c.level === 'na').length },
  data: {
    lastDate: DATES[END],
    firstDate: DATES[0],
    lagWorkdays: lag,
    tradingDays: DATES.length,
    usableDays: END - START + 1,
    stockCount: Object.keys(ds.st).length,
    warmup: START,
    ok: lag <= TH.dataLagWatch
  },
  config: { match: cfgDiff.length === 0, diff: cfgDiff, params: P },
  perf: {
    full: { n: full.n, mean: full.mean, t: full.t },
    m20: { n: w20.n, mean: w20.mean, t: w20.t, activeDays: w20.activeDays, from: w20.from, to: w20.to },
    m60: { n: w60.n, mean: w60.mean, t: w60.t, chainRate: w60.chainRate, activeDays: w60.activeDays, from: w60.from, to: w60.to },
    ddNow, trades: TR.length
  },
  risk,
  checks,
  note: '云端轻量体检：只用滚动 store（约 ' + DATES.length + ' 个交易日，不复权），覆盖数据新鲜度/配置/近 20·60 日绩效/连板率/回撤。全历史风格分档、条件期望、参数邻域请在本机跑 s3-health.js。'
}
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))

/* ---------------- 控制台输出 ---------------- */
const icon = { red: '🔴', watch: '🟡', green: '🟢', ok: '✅', na: 'ℹ️' }
console.log('=== 云端轻量体检 ' + out.date + ' ===')
console.log('状态：' + icon[status] + ' ' + statusText + '　（红 ' + out.counts.red + ' / 黄 ' + out.counts.watch + '）')
for (const c of checks) console.log('  ' + (icon[c.level] || '·') + ' ' + c.name + '：' + c.actual)
console.log('已写出 ' + path.relative(ROOT, OUT_PATH))

/* ---------------- 异常推送（复用 daily.js 的渠道） ---------------- */
function post (url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', timeout: 15000,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {})
    }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', d => (b += d)); res.on('end', () => resolve(b)) })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data); req.end()
  })
}
async function notify (title, content) {
  const out2 = []
  const PP = process.env.PUSHPLUS_TOKEN, SC = process.env.SENDKEY, WC = process.env.WECOM_WEBHOOK
  if (PP) { try { await post('https://www.pushplus.plus/send', { token: PP, title, content, template: 'markdown' }); out2.push('pushplus ok') } catch (e) { out2.push('pushplus 失败: ' + e.message) } }
  if (SC) { try { await post('https://sctapi.ftqq.com/' + SC + '.send', { title, desp: content }); out2.push('serverchan ok') } catch (e) { out2.push('serverchan 失败: ' + e.message) } }
  if (WC) { try { await post(WC, { msgtype: 'markdown', markdown: { content: content.slice(0, 4000) } }); out2.push('wecom ok') } catch (e) { out2.push('wecom 失败: ' + e.message) } }
  if (!PP && !SC && !WC) out2.push('未配置推送渠道（跳过）')
  return out2
}

;(async () => {
  if (status !== 'green') {
    const lines = ['**S3 云端体检：' + statusText + '**（' + out.date + '）', '']
    for (const c of checks) if (c.level === 'red' || c.level === 'watch') lines.push('- ' + (icon[c.level] || '') + ' ' + c.name + '：' + c.actual + '（标准 ' + c.standard + '）' + (c.hint ? '｜' + c.hint : ''))
    lines.push('', '**是否做深度排查？**回复确认后运行：')
    lines.push('1. `node s3-health.js`（全历史 6 年体检，需本机）')
    lines.push('2. `node hist-oos-check.js`（前后半段样本外）')
    lines.push('3. `node hist-gate-grid.js`（参数邻域）')
    lines.push('4. `node hist-ladder-capture.js`（连板归因）')
    lines.push('', '在确认之前不会改动任何参数。')
    const res = await notify('S3 云端体检：' + statusText, lines.join('\n'))
    console.log('推送：' + res.join(' / '))
  } else {
    console.log('推送：状态正常，不打扰')
  }
})()
