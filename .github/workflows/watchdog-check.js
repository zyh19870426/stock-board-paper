'use strict'
/* 看门狗检查逻辑：读取 data/dashboard.json 的 date，判断是否滞后。 */
const fs = require('fs')
const https = require('https')

const ROOT = process.cwd()
let dash
try {
  dash = JSON.parse(fs.readFileSync(ROOT + '/data/dashboard.json', 'utf8'))
} catch (e) {
  console.error('✗ 读取 data/dashboard.json 失败：' + e.message)
  process.exit(1)
}
const dashDate = String(dash.date || '').slice(0, 10)

function bjToday () {
  // 北京时间今天（runner 默认 UTC，强制按 Asia/Shanghai 取 YYYY-MM-DD）
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
function latestTradingDay (today) {
  let d = today
  while (isWeekend(d)) d = shift(d, -1)
  return d
}
function prevTradingDay (d) {
  let x = shift(d, -1)
  while (isWeekend(x)) x = shift(x, -1)
  return x
}

const today = bjToday()
const expected = latestTradingDay(today)
const grace = prevTradingDay(expected)

console.log('北京时间今天=' + today + '，期望最新交易日=' + expected + '，允许下限(前一交易日)=' + grace)
console.log('当前看板 date=' + dashDate + '（updated=' + (dash.updated || '-') + '）')

if (!dashDate) {
  console.error('✗ 看板无 date 字段，视为异常')
  process.exit(1)
}

if (dashDate < grace) {
  const msg = '⚠️ **模拟收益看板已滞后**\n\n' +
    '- 看板日期：' + dashDate + '\n' +
    '- 应有下限：' + grace + '（今天 ' + today + '，期望最新交易日 ' + expected + '）\n\n' +
    '请检查：① 本地 Windows 计划任务 **PaperDailyClose** 是否运行（看 `paper/daily-close.log`）；' +
    '② 云端 `daily.yml` 是否失败；③ 本机是否当天开机并联网。'
  console.error(msg)
  notify(msg).then(() => process.exit(1))
} else {
  console.log('✅ 看板新鲜（' + dashDate + '），无需处理。')
  process.exit(0)
}

function notify (text) {
  const hook = process.env.WECOM_WEBHOOK
  const pp = process.env.PUSHPLUS_TOKEN
  const jobs = []
  if (hook) jobs.push(post(hook, { msgtype: 'markdown', markdown: { content: text } }))
  if (pp) jobs.push(post('https://www.pushplus.plus/send', { token: pp, title: '看板滞后预警', content: text, template: 'markdown' }))
  if (!jobs.length) console.log('（公开仓未配置 WECOM_WEBHOOK / PUSHPLUS_TOKEN，仅以工作流标红提醒）')
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
