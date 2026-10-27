'use strict'
/* ============================================================
 *  看门狗：判断公开看板是否滞后。
 *
 *  三级判据（从强到弱，任一成立即报警）：
 *   ① 零网络主判据（最可靠）：公开仓 data/qmt-live.json 的 bjDate == 北京今天
 *      → 本机今天确实在采数（说明今天是交易日且这台机器活着）
 *      → 看板 date 必须也是今天，否则说明「机器活着但收盘定稿没跑」→ 报警。
 *      覆盖本次事故的真实形态：QMT 快照每 10 分钟在更新，唯独 dashboard 卡在 22 号。
 *   ② 交易日历判据：拉上证指数日线（东财，失败换腾讯）取真实最近交易日
 *      → 看板 date 必须 ≥ 该交易日，否则报警。长假不会误报（那几天本就没有 K 线）。
 *   ③ 兜底判据（两个数据源都不可达）：只剔除周末，并放宽 9 个日历日，
 *      宁可晚报，也不在长假里每天刷红色告警。
 *
 *  历史教训：旧版只用「周末回退」推算交易日，且只给 1 个交易日宽限，
 *  在国庆/春节长假会连续误报；同时它完全无法识别「机器活着、看板停了」。
 * ============================================================ */
const fs = require('fs')
const https = require('https')

const ROOT = process.cwd()

function readJson (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}

function bjToday () {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10)
}
function shift (d, n) {
  const x = new Date(d + 'T00:00:00Z')
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}
function isWeekend (d) {
  const w = new Date(d + 'T00:00:00Z').getUTCDay()
  return w === 0 || w === 6
}
function weekdayTradingDay (today) {
  let d = today
  while (isWeekend(d)) d = shift(d, -1)
  return d
}

function httpGetText (url, timeoutMs) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'pages-watchdog' }, agent: false }, res => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', d => (b += d))
      res.on('end', () => resolve(b))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/* 源1：东财 上证指数日线（最后一条 K 线日期 = 最近交易日） */
async function fromEastmoney () {
  const txt = await httpGetText('https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=1.000001&fields1=f1&fields2=f51&klt=101&fqt=0&end=20500101&lmt=5', 8000)
  if (!txt) return null
  try {
    const j = JSON.parse(txt)
    const ks = (j && j.data && j.data.klines) || []
    const dates = ks.map(s => String(s).split(',')[0]).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort()
    return dates.length ? dates[dates.length - 1] : null
  } catch (e) { return null }
}

/* 源2：腾讯 上证指数日线（param 需 6 段：代码,周期,起,止,条数,复权） */
async function fromTencent () {
  const txt = await httpGetText('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,10,qfq', 8000)
  if (!txt) return null
  try {
    const j = JSON.parse(txt)
    const d = j && j.data && j.data.sh000001
    const arr = (d && (d.qfqday || d.day)) || []
    const dates = arr.map(r => String(r[0]).slice(0, 10)).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort()
    return dates.length ? dates[dates.length - 1] : null
  } catch (e) { return null }
}

async function fetchLastTradingDay () {
  /* 东财对连续请求会断连（socket hang up）→ 重试一次再换源 */
  for (let i = 0; i < 2; i++) {
    const a = await fromEastmoney()
    if (a) return { date: a, source: '东财上证指数日线' }
    await new Promise(r => setTimeout(r, 1200))
  }
  const b = await fromTencent()
  if (b) return { date: b, source: '腾讯上证指数日线' }
  return null
}

function notify (text) {
  const hook = process.env.WECOM_WEBHOOK
  const pp = process.env.PUSHPLUS_TOKEN
  const jobs = []
  if (hook) jobs.push(post(hook, { msgtype: 'markdown', markdown: { content: text } }))
  if (pp) jobs.push(post('https://www.pushplus.plus/send', { token: pp, title: '看板滞后预警', content: text, template: 'markdown' }))
  if (!jobs.length) { console.log('（未配置 WECOM_WEBHOOK / PUSHPLUS_TOKEN，仅以工作流标红提醒）'); return Promise.resolve() }
  return Promise.all(jobs).catch(e => console.log('通知发送失败：' + e.message))
}
function post (u, body) {
  return new Promise((resolve, reject) => {
    const pu = new URL(u)
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: pu.hostname, path: pu.pathname + pu.search, method: 'POST', timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve(b)) })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data); req.end()
  })
}

async function main () {
  const today = bjToday()
  const dash = readJson(ROOT + '/data/dashboard.json')
  const live = readJson(ROOT + '/data/qmt-live.json')

  if (!dash || !dash.date) {
    console.error('✗ 读取 data/dashboard.json 失败或缺 date 字段 → 视为异常')
    return 1
  }
  const dashDate = String(dash.date).slice(0, 10)
  const qmtDate = live && live.bjDate ? String(live.bjDate).slice(0, 10) : null

  console.log('北京今天=' + today)
  console.log('看板 date=' + dashDate + '（updated=' + (dash.updated || '-') + '）')
  console.log('QMT 快照 bjDate=' + (qmtDate || '无') + '（bjTime=' + ((live && live.bjTime) || '-') + '）')

  /* ① 零网络主判据：只看本机 QMT 快照日期（这台机器今天真的在采数吗） */
  if (qmtDate && qmtDate >= today) {
    if (dashDate >= qmtDate) {
      console.log('✅ 判据①：本机今日在采数且看板已跟上（' + dashDate + '），新鲜。')
      return 0
    }
    console.error('✗ 判据①：本机今日（' + qmtDate + '）在采数，但看板停在 ' + dashDate + ' → 收盘定稿没跑成功')
    await notify('⚠️ **看板滞后（本机活着但收盘定稿没跑）**\n\n' +
      '- 看板日期：' + dashDate + '\n' +
      '- 本机 QMT 快照日期：' + qmtDate + '（今天 ' + today + '）\n\n' +
      '说明本机在采数、数据源没问题，问题在收盘定稿环节：\n' +
      '请查 `paper/daily-close.log`（会写明是 daily.js 抓取/重放失败，还是 sync-pages 推送失败）。')
    return 1
  }
  /* ①b 同一判据的放宽版：本机最后一次采数晚于看板 → 那几天确实开市但看板没跟上 */
  if (qmtDate && qmtDate > dashDate) {
    console.error('✗ 判据①b：本机最后采数 ' + qmtDate + '，看板停在 ' + dashDate + ' → 看板落后于本机实况')
    await notify('⚠️ **看板落后于本机实况**\n\n' +
      '- 看板日期：' + dashDate + '\n' +
      '- 本机最后采数：' + qmtDate + '\n\n' +
      '本机在那一天是开市在采数的，但看板没跟上。请查 `paper/daily-close.log` 与公开仓推送记录。')
    return 1
  }

  /* ② 交易日历判据 */
  const cal = await fetchLastTradingDay()
  let expected, grace, source
  if (cal) {
    source = cal.source
    expected = cal.date
    grace = expected                     /* 当日收盘账应在 21:00 前产出 */
  } else {
    source = '兜底：只剔周末+放宽9日（两个数据源均不可达）'
    expected = weekdayTradingDay(today)
    grace = shift(expected, -9)
  }
  console.log('最近交易日=' + expected + '（来源：' + source + '），允许下限=' + grace)

  if (dashDate >= grace) {
    console.log('✅ 判据②：看板 ' + dashDate + ' ≥ 下限 ' + grace + '，新鲜。')
    return 0
  }

  console.error('✗ 判据②：看板 ' + dashDate + ' < 下限 ' + grace + ' → 滞后')
  await notify('⚠️ **模拟收益看板已滞后**\n\n' +
    '- 看板日期：' + dashDate + '\n' +
    '- 允许下限：' + grace + '（最近交易日 ' + expected + '，今天 ' + today + '）\n' +
    '- 交易日来源：' + source + '\n' +
    '- QMT 快照日期：' + (qmtDate || '无') + '\n\n' +
    '请依次检查：① 本机计划任务 **PaperDailyClose**（`paper/daily-close.log`）；' +
    '② 云端 `daily.yml` 运行记录；③ 本机当天是否开机联网。')
  return 1
}

main().then(code => process.exit(code)).catch(e => { console.error('看门狗自身异常：' + e.message); process.exit(1) })
