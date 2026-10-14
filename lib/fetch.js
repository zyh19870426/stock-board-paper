/* ============================================================
 *  行情抓取（模拟交易专用）  stock-board-paper/lib/fetch.js
 *
 *  - 股票池：优先在线拉（东财 clist），失败回退本地固化快照 universe.json
 *  - 日线：腾讯 ifzq（不复权，220 根）→ 新浪兜底
 *  口径与 build-dataset.js 完全一致（成交量单位「手」，价格「元」）
 * ============================================================ */
'use strict'
const fs = require('fs')
const path = require('path')
const https = require('https')

const KEEP_DAYS = 220
const CONCURRENCY = 6
const DATA_DIR = path.join(__dirname, '..', 'data')
const UNIVERSE_FILE = path.join(DATA_DIR, 'universe.json')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function httpGet (url, headers, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: headers || { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: timeout || 15000
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)) }
      let b = ''
      res.setEncoding('utf8')
      res.on('data', d => (b += d))
      res.on('end', () => resolve(b))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

/* ---------------- 股票池 ---------------- */
function filterUniverse (rows) {
  const list = [], seen = new Set()
  for (const r of rows) {
    const code = String(r.code || '').replace(/^(sh|sz|bj)/, '')
    const name = String(r.name || '')
    if (!/^\d{6}$/.test(code)) continue
    if (seen.has(code)) continue
    if (!/^(60|00|30)/.test(code)) continue          // 涨停板主战场：沪深主板 + 创业板
    if (name.indexOf('ST') >= 0 || name.indexOf('退') >= 0) continue
    seen.add(code)
    list.push({ code, name })
  }
  return list
}

/* 在线：东财全市场列表（云端 runner 通常可用；失败不抛）
 * ⚠️ clist 单页有上限，必须按 total 分页拉全 */
async function fetchUniverseOnline () {
  const seen = new Set(), list = []
  let pn = 1, total = 0
  while (pn <= 40) {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn + '&pz=500&po=1&np=1&fltt=2&invt=2&fid=f12' +
      '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14'
    const j = JSON.parse(await httpGet(url, { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' }, 12000))
    const diff = (j && j.data && j.data.diff) || []
    const rows = Array.isArray(diff) ? diff : Object.values(diff)
    total = (j && j.data && j.data.total) || total
    if (!rows.length) break
    rows.forEach(r => {
      const code = String(r.f12 || '')
      if (seen.has(code)) return
      seen.add(code)
      list.push({ code, name: String(r.f14 || '') })
    })
    if (seen.size >= total) break
    pn++
  }
  const flt = filterUniverse(list)
  if (flt.length < 3000) throw new Error('东财票池异常：仅 ' + flt.length + ' 只（total=' + total + '）')
  return flt
}

/* 合并票池：以在线为准，保留本地有而在线没有的（防新股漏网/接口抖动） */
function loadUniverse () {
  let local = []
  if (fs.existsSync(UNIVERSE_FILE)) {
    try { local = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8')) } catch (e) { local = [] }
  }
  if (!Array.isArray(local)) local = []
  return { local }
}

async function resolveUniverse () {
  const { local } = loadUniverse()
  let online = null, err = null
  try { online = await fetchUniverseOnline() } catch (e) { err = e.message }
  if (!online) {
    if (!local.length) throw new Error('股票池不可用（在线失败：' + err + '，且无本地快照）')
    return { list: local, source: 'local-snapshot', note: err }
  }
  const map = new Map()
  local.forEach(x => map.set(x.code, x))
  online.forEach(x => map.set(x.code, x))            // 在线覆盖（名称可能更新）
  const merged = [...map.values()]
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(UNIVERSE_FILE, JSON.stringify(merged), 'utf8')
  return { list: merged, source: 'eastmoney+local', added: merged.length - local.length, note: null }
}

/* ---------------- 日线 ---------------- */
async function fetchTx (sym, retry) {
  const left = retry === undefined ? 2 : retry
  const url = 'https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + sym + ',day,,,' + KEEP_DAYS + ','
  try {
    const j = JSON.parse(await httpGet(url))
    const d = j && j.data && j.data[sym]
    const raw = d && (d.day || d.qfqday)
    if (!raw || !raw.length) throw new Error('empty')
    return raw.map(r => {
      const o = r[1], c = r[2], h = r[3], l = r[4], v = r[5]
      if (o == null || c == null) return null
      return [String(r[0]), +o, +c, +h, +l, +v]
    }).filter(Boolean)
  } catch (e) {
    if (left > 0) { await sleep(260); return fetchTx(sym, left - 1) }
    throw e
  }
}

async function fetchSina (sym) {
  const b = await httpGet('https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_x=/CN_MarketDataService.getKLineData?symbol=' +
    sym + '&scale=240&ma=no&datalen=' + KEEP_DAYS, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Referer: 'https://finance.sina.com.cn/'
  })
  const m = b.match(/\[(.*)\]/s)
  if (!m) throw new Error('sina-fmt')
  const arr = JSON.parse('[' + m[1] + ']')
  if (!arr.length) throw new Error('sina-empty')
  return arr.map(r => [String(r.day), +r.open, +r.close, +r.high, +r.low, Math.round(+r.volume / 100)])
}

/* 并发抓全市场（带进度回调） */
async function fetchAll (list, opts) {
  const o = opts || {}
  const onProgress = o.onProgress || (() => {})
  const barsMap = o.seed && typeof o.seed === 'object' ? o.seed : {}
  const todo = list.filter(x => !barsMap[x.code])
  let next = 0, done = 0, fail = 0
  async function worker () {
    while (next < todo.length) {
      const item = todo[next++]
      const sym = (item.code[0] === '6' ? 'sh' : 'sz') + item.code
      let bars = null
      try { bars = await fetchTx(sym) } catch (e) { /* fallback */ }
      if (!bars || !bars.length) { try { bars = await fetchSina(sym) } catch (e) { fail++ } }
      if (bars && bars.length) barsMap[item.code] = bars
      done++
      if (done % 300 === 0) onProgress(done, todo.length, fail)
    }
  }
  await Promise.all(new Array(CONCURRENCY).fill(0).map(worker))
  return { barsMap, fail, total: todo.length }
}

module.exports = { httpGet, resolveUniverse, filterUniverse, fetchTx, fetchSina, fetchAll, UNIVERSE_FILE, DATA_DIR }
