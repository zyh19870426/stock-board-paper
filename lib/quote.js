/* ============================================================
 *  实时行情（盘中预览专用）  stock-board-paper/lib/quote.js
 *
 *  数据源 qt.gtimg.cn（腾讯，GBK；实测 2026-10-15 盘中核对）：
 *    v_sh600000="1~浦发银行~600000~现价~昨收~今开~量(手)~...~时间~涨跌~涨跌%~最高~最低~...~成交额(万)"
 *    下标：[1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [6]成交量(手) [30]时间YYYYMMDDHHmmss
 *          [33]最高 [34]最低 [37]成交额(万元)
 *  价格单位：元（浮点）→ 调用方自行 ×100 转分（与数据集口径一致）。
 * ============================================================ */
'use strict'
const https = require('https')

function httpGet (u, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: timeout || 10000 }, res => {
      const buf = []
      res.on('data', d => buf.push(d))
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('http ' + res.statusCode))
        resolve(buf.length === 1 ? buf[0] : Buffer.concat(buf))
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

const symbolOf = code => /^(60|68)/.test(code) ? 'sh' + code : /^(00|30)/.test(code) ? 'sz' + code : null

/** 批量拉实时行情。返回 { q: {code: {...}}, fail: [code...] }，价格单位：元 */
async function fetchQuotes (codes, opts) {
  const o = opts || {}
  const q = {}
  const fail = []
  const list = codes.filter(c => symbolOf(c))
  const BATCH = 50
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH)
    const u = 'https://qt.gtimg.cn/q=' + batch.map(symbolOf).join(',')
    try {
      const txt = new TextDecoder('gbk').decode(await httpGet(u, o.timeout))
      for (const line of txt.trim().split('\n')) {
        const m = line.match(/v_(?:sh|sz|bj)(\d{6})="(.*)"/)
        if (!m || !m[2]) { continue }
        const f = m[2].split('~')
        if (f.length < 38 || !f[3]) { fail.push(m[1]); continue }
        q[m[1]] = {
          name: f[1],
          price: parseFloat(f[3]),          // 现价（元）
          prevClose: parseFloat(f[4]),      // 昨收
          open: parseFloat(f[5]),           // 今开
          vol: parseFloat(f[6]) || 0,       // 成交量（手）
          time: f[30],                      // YYYYMMDDHHmmss
          high: parseFloat(f[33]),          // 最高
          low: parseFloat(f[34]),           // 最低
          amount: (parseFloat(f[37]) || 0) * 1e4   // 成交额（元）
        }
      }
    } catch (e) { fail.push(...batch) }
  }
  return { q, fail }
}

module.exports = { fetchQuotes, symbolOf }
