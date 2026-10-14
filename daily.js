/* ============================================================
 *  模拟跟进交易 · 每日推进  stock-board-paper/daily.js
 *
 *  每个交易日收盘后跑一次：
 *    1. 拉全市场日线 → 追加到累积数据集（票池只增不减）
 *    2. 对 config 里的每套策略，从固定起点重放到今天
 *       （复用 lib/strategy.js，零二次实现 → 与页面回测口径 100% 一致）
 *    3. 出日报：当日盈亏 / 当日收益率 / 累计收益率 / 持仓 / 次日候选
 *    4. 可选推送到微信
 *
 *  用法：
 *    node daily.js                 # 正常跑（会写文件、会推送）
 *    node daily.js --dry           # 只打印，不写文件不推送
 *    node daily.js --no-fetch      # 跳过抓取（用已有数据集重算，验证用）
 *    node daily.js --reseed        # 从本地 output/dataset.json 重新播种
 * ============================================================ */
'use strict'
const fs = require('fs')
const path = require('path')
const https = require('https')
const url = require('url')

const M = require('./lib/strategy.js')
const ST = require('./lib/store.js')
const F = require('./lib/fetch.js')

const ROOT = __dirname
const DATA = path.join(ROOT, 'data')
const REPORTS = path.join(ROOT, 'reports')
const STORE_FILE = path.join(DATA, 'store.json')
const CONFIG_FILE = path.join(ROOT, 'config.json')
const LOCAL_DATASET = path.join(ROOT, '..', 'output', 'dataset.json')

const ARGV = process.argv.slice(2)
const DRY = ARGV.includes('--dry')
const NO_FETCH = ARGV.includes('--no-fetch')
const RESEED = ARGV.includes('--reseed')

const money = c => (c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = v => (v > 0 ? '+' : '') + (v * 100).toFixed(2) + '%'
const yuan = c => (c > 0 ? '+' : '') + money(c)
const ts = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

/* ---------------- 推送 ---------------- */
function post (u, body, headers) {
  return new Promise((resolve, reject) => {
    const p = url.parse(u)
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const req = https.request({
      hostname: p.hostname, path: p.path, method: 'POST', timeout: 15000,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {})
    }, res => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', d => (b += d))
      res.on('end', () => resolve(b))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data)
    req.end()
  })
}

async function notify (title, content) {
  const out = []
  const PP = process.env.PUSHPLUS_TOKEN
  const SC = process.env.SENDKEY
  const WC = process.env.WECOM_WEBHOOK
  if (PP) {
    try { await post('https://www.pushplus.plus/send', { token: PP, title, content, template: 'markdown' }); out.push('pushplus ok') } catch (e) { out.push('pushplus 失败: ' + e.message) }
  }
  if (SC) {
    try { await post('https://sctapi.ftqq.com/' + SC + '.send', { title, desp: content }); out.push('serverchan ok') } catch (e) { out.push('serverchan 失败: ' + e.message) }
  }
  if (WC) {
    try { await post(WC, { msgtype: 'markdown', markdown: { content: content.slice(0, 4000) } }); out.push('wecom ok') } catch (e) { out.push('wecom 失败: ' + e.message) }
  }
  if (!PP && !SC && !WC) out.push('未配置推送渠道（跳过）')
  return out
}

/* ---------------- 单套策略：从起点重放到最新 ---------------- */
function runStrategy (store, strat, startDate, initialCash) {
  const startIdx = store.dates.indexOf(startDate)
  if (startIdx < 0) throw new Error('起点 ' + startDate + ' 不在数据集里（' + store.dates[0] + ' ~ ' + store.dates[store.dates.length - 1] + '）')
  const P = Object.assign({}, strat.params, {
    initialCash, startIdx, endIdx: store.dates.length - 1
  })
  const r = M.runBacktest(store, P)
  if (r.error) throw new Error(r.error)

  const eq = r.equity
  const today = eq[eq.length - 1]
  const prev = eq.length > 1 ? eq[eq.length - 2] : null
  const initC = Math.round(initialCash * 100)

  const todayTrades = (r.trades || []).filter(t => t.sellDate === today.date)
  const todayBuys = (r.openPositions || []).filter(p => p.buyDate === today.date)
  const skippedToday = (r.skipped || []).filter(s => s.date === today.date)

  return {
    id: strat.id, name: strat.name, params: P,
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
  }
}

/* ---------------- 日报 ---------------- */
function buildReport (date, results, meta) {
  const L = []
  L.push('# 打板模拟跟进 · ' + date)
  L.push('')
  L.push('> 数据截至 **' + date + ' 收盘** · 每套策略独立 **' + money(meta.initialCash * 100) + ' 元**本金')
  L.push('> 起点 ' + meta.startDate + '（当日收盘选股，次日开盘为第一笔买入）· 累计 ' + meta.equityDays + ' 个交易日')
  L.push('> 数据集：' + meta.storeRange + '（' + meta.storeDays + ' 个交易日 / ' + meta.storeStocks + ' 只票，滚动累积）')
  L.push('> 生成时间 ' + ts())
  L.push('')

  L.push('## 一、收益一览')
  L.push('')
  L.push('| 策略 | 当日盈亏 | 当日收益率 | 累计收益率 | 总资产 | 持仓 | 累计笔数 |')
  L.push('|---|---|---|---|---|---|---|')
  results.forEach(r => {
    L.push('| ' + r.id + ' · ' + r.name + ' | ' + yuan(r.dayPnlC) + ' | ' + pct(r.dayRet) +
      ' | **' + pct(r.cumRet) + '** | ' + money(r.totalC) + ' | ' + r.positions.length + '/' + r.params.slots + ' | ' + r.tradeCount + ' |')
  })
  L.push('')

  results.forEach(r => {
    L.push('## ' + r.id + ' · ' + r.name)
    L.push('')
    L.push('- 当日：**' + yuan(r.dayPnlC) + ' 元**（' + pct(r.dayRet) + '）　累计：**' + yuan(r.cumPnlC) + ' 元**（' + pct(r.cumRet) + '）')
    L.push('- 总资产 ' + money(r.totalC) + ' 元 = 现金 ' + money(r.cashC) + ' + 市值 ' + money(r.mvC))
    L.push('- 累计胜率 ' + (r.tradeCount ? (r.winRate * 100).toFixed(1) + '%' : '—') + '　最大回撤 ' + (r.maxDrawdown * 100).toFixed(2) + '%')
    L.push('')
    if (r.todayBuys.length) {
      L.push('**今日买入（开盘价成交）**')
      L.push('')
      L.push('| 代码 | 名称 | 板 | 股数 | 买入价 | 成本 |')
      L.push('|---|---|---|---|---|---|')
      r.todayBuys.forEach(p => L.push('| ' + p.code + ' | ' + p.name + ' | ' + p.lbc + ' | ' + p.shares + ' | ' + (p.buyC / 100).toFixed(2) + ' | ' + money(p.costC) + ' |'))
      L.push('')
    }
    if (r.todayTrades.length) {
      L.push('**今日卖出**')
      L.push('')
      L.push('| 代码 | 名称 | 卖出价 | 净盈亏 | 收益率 | 原因 |')
      L.push('|---|---|---|---|---|---|')
      r.todayTrades.forEach(t => L.push('| ' + t.code + ' | ' + t.name + ' | ' + (t.sellC / 100).toFixed(2) + ' | ' + yuan(t.pnlC) + ' | ' + pct(t.pnlPct) + ' | ' + t.reason + ' |'))
      L.push('')
    }
    if (r.skippedToday.length) {
      L.push('**今日弃买**：' + r.skippedToday.map(s => s.code + ' ' + s.name + '（' + s.reason + '）').join('、'))
      L.push('')
    }
    L.push('**当前持仓**')
    L.push('')
    if (r.positions.length) {
      L.push('| 代码 | 名称 | 板 | 股数 | 买入日 | 买入价 | 成本 |')
      L.push('|---|---|---|---|---|---|---|')
      r.positions.forEach(p => L.push('| ' + p.code + ' | ' + p.name + ' | ' + p.lbc + ' | ' + p.shares + ' | ' + p.buyDate + ' | ' + (p.buyC / 100).toFixed(2) + ' | ' + money(p.costC) + ' |'))
    } else {
      L.push('_空仓_')
    }
    L.push('')
    L.push('**次日待买（' + date + ' 收盘选出，下一交易日开盘执行）**')
    L.push('')
    if (r.nextCandidates.length) {
      L.push('| 名次 | 代码 | 名称 | 板 | 成交额（亿元） |')
      L.push('|---|---|---|---|---|')
      r.nextCandidates.forEach((c, i) => L.push('| ' + (i + 1) + ' | ' + c.code + ' | ' + c.name + ' | ' + c.lbc + ' | ' + ((c.amount || 0) / 1e8).toFixed(2) + ' |'))
    } else {
      L.push('_无候选（当日没有符合板数区间的票，或名额已满）_')
    }
    L.push('')
  })

  L.push('---')
  L.push('')
  L.push('口径：T 日收盘选股 → T+1 开盘价买入（一字涨停开盘弃买）→ **买入当日不可卖出（A 股 T+1）**，断板判定从买入**次日**起 → 断板即出（**14:57 判定，未封则在收盘集合竞价卖出，成交价＝收盘价**）/ 亏损 ' +
    results.map(r => r.params.stopLossPct + '%').join('、') + ' 止损 / 回撤 ' + results.map(r => r.params.trailPct + '%').join('、') +
    ' 止损 / 最长持有 ' + results.map(r => r.params.maxHoldDays).join('、') + ' 个交易日。')
  L.push('')
  L.push('> T+1 说明：买入当天（T+1）无论是否封板都**不能卖**，所以「断板即出」实际执行是——**T+2 起**每个交易日 14:57 看是否封住涨停，没封才挂单卖出。')
  L.push('')
  L.push('> 卖出时点说明：A 股 14:57–15:00 为收盘集合竞价，**该阶段成交的统一价就是当日收盘价**，且期间不可撤单。' +
    '所以「14:57 看未封板 → 挂单卖出」的成交价与回测用的收盘价一致；这是唯一真实可执行的做法（15:00 收盘价产生时已无法下单）。' +
    '收盘跌停封死 / 开盘一字跌停 → 卖不出，顺延到下一交易日。')
  L.push('')
  L.push('⚠️ 模拟盘按开盘价 / 触发价理想成交，**未计滑点与冲击成本**；不构成投资建议。')
  return L.join('\n')
}

/* ---------------- 推送用短文本 ---------------- */
function buildPush (date, results) {
  const L = ['### 打板模拟跟进 · ' + date, '']
  results.forEach(r => {
    L.push('**' + r.id + ' · ' + r.name + '**')
    L.push('当日 ' + yuan(r.dayPnlC) + ' 元（' + pct(r.dayRet) + '）｜累计 ' + pct(r.cumRet) + '｜总资产 ' + money(r.totalC))
    if (r.todayBuys.length) L.push('买入：' + r.todayBuys.map(p => p.name + ' ' + p.shares + '股').join('、'))
    if (r.todayTrades.length) L.push('卖出：' + r.todayTrades.map(t => t.name + ' ' + pct(t.pnlPct)).join('、'))
    if (r.nextCandidates.length) L.push('次日候选：' + r.nextCandidates.map(c => c.name + '(' + c.lbc + '板)').join('、'))
    L.push('')
  })
  return L.join('\n')
}

/* ---------------- 主流程 ---------------- */
async function main () {
  const t0 = Date.now()
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  console.log('== 打板模拟跟进 ' + ts() + ' ==')
  console.log('  策略 ' + cfg.strategies.map(s => s.id + '·' + s.name).join(' / '))
  console.log('  起点 ' + cfg.startDate + '，本金 ' + money(cfg.initialCash * 100) + ' 元/套')

  /* --- 1. 数据集 --- */
  let store
  if (RESEED || !fs.existsSync(STORE_FILE)) {
    if (!fs.existsSync(LOCAL_DATASET)) throw new Error('缺少种子数据集：' + LOCAL_DATASET + '（请在开发机先跑 build-dataset.js，或提交一份 data/store.json）')
    store = ST.initFromDataset(LOCAL_DATASET, 90)
    console.log('  数据集：从 ' + LOCAL_DATASET + ' 播种 ' + store.dates.length + ' 天 / ' + Object.keys(store.st).length + ' 只票')
  } else {
    store = ST.load(STORE_FILE)
    console.log('  数据集：载入 ' + store.dates.length + ' 天 / ' + Object.keys(store.st).length + ' 只票（至 ' + store.dates[store.dates.length - 1] + '）')
  }

  if (!NO_FETCH) {
    const u = await F.resolveUniverse()
    console.log('  票池 ' + u.list.length + ' 只（' + u.source + (u.added ? '，较上次 +' + u.added : '') + '）' + (u.note ? ' ⚠️ ' + u.note : ''))
    console.log('  抓取全市场日线…')
    const nameOf = {}
    u.list.forEach(x => { nameOf[x.code] = x.name })
    const fr = await F.fetchAll(u.list, {
      onProgress: (d, n, f) => console.log('    ' + d + '/' + n + '（失败 ' + f + '）')
    })
    console.log('  抓取完成：' + Object.keys(fr.barsMap).length + ' 只，失败 ' + fr.fail + '，耗时 ' + Math.round((Date.now() - t0) / 1000) + 's')
    const ap = ST.appendDays(store, fr.barsMap, nameOf)
    console.log('  数据集新增 ' + ap.added + ' 个交易日' + (ap.newDays.length ? '（' + ap.newDays.join('、') + '）' : '') + '，新纳入 ' + ap.newStocks + ' 只票')
    if (ap.added === 0) {
      console.log('  ⚠️ 没有新交易日（非交易日 / 数据源未更新）→ 本次不改动账户')
      if (!DRY) {
        const last = store.dates[store.dates.length - 1]
        const note = '# 休市 / 无新数据 · ' + last + '\n\n本次运行未取到 ' + last + ' 之后的新交易日数据，账户保持不动。\n'
        fs.mkdirSync(REPORTS, { recursive: true })
        fs.writeFileSync(path.join(REPORTS, 'last-run.txt'), note, 'utf8')
      }
      return
    }
  } else {
    console.log('  --no-fetch：跳过抓取，直接用现有数据集重算')
  }

  if (!DRY) ST.save(STORE_FILE, store)

  /* --- 2. 两套策略重放 --- */
  const date = store.dates[store.dates.length - 1]
  const results = cfg.strategies.map(s => {
    try { return runStrategy(store, s, cfg.startDate, cfg.initialCash) }
    catch (e) { console.log('  ✗ 策略 ' + s.id + ' 失败：' + e.message); return null }
  }).filter(Boolean)
  if (!results.length) throw new Error('没有任何策略跑成功')

  results.forEach(r => {
    console.log('  [' + r.id + '] ' + date + ' 当日 ' + yuan(r.dayPnlC) + '（' + pct(r.dayRet) + '）累计 ' + pct(r.cumRet) +
      ' 总资产 ' + money(r.totalC) + ' 持仓 ' + r.positions.length + ' 笔数 ' + r.tradeCount)
  })

  const meta = {
    initialCash: cfg.initialCash,
    startDate: cfg.startDate,
    equityDays: results[0].equityDays,
    storeRange: store.dates[0] + ' ~ ' + date,
    storeDays: store.dates.length,
    storeStocks: Object.keys(store.st).length
  }

  /* --- 3. 落盘 --- */
  const report = buildReport(date, results, meta)
  const push = buildPush(date, results)
  if (!DRY) {
    fs.mkdirSync(REPORTS, { recursive: true })
    fs.writeFileSync(path.join(REPORTS, date + '.md'), report, 'utf8')
    fs.writeFileSync(path.join(REPORTS, 'latest.md'), report, 'utf8')
    fs.writeFileSync(path.join(REPORTS, 'last-run.txt'), report.split('\n').slice(0, 3).join('\n') + '\n', 'utf8')
    /* 线上页面数据：全量净值曲线 + 成交明细（GitHub Pages 的 index.html 读取） */
    fs.writeFileSync(path.join(DATA, 'dashboard.json'), JSON.stringify({
      updated: new Date().toISOString(), date,
      startDate: cfg.startDate, initialCash: cfg.initialCash,
      strategies: results.map(r => ({
        id: r.id, name: r.name,
        brief: '连板 ' + r.params.minLbc + '<N<' + r.params.maxLbc + ' · 止损 ' + r.params.stopLossPct + '% · 回撤 ' + r.params.trailPct + '% · 断板即出（T+1：次日起 14:57 判定 / 集合竞价成交）',
        date: r.date,
        totalC: r.totalC, cashC: r.cashC, mvC: r.mvC,
        dayPnlC: r.dayPnlC, dayRet: r.dayRet,
        cumPnlC: r.cumPnlC, cumRet: r.cumRet,
        tradeCount: r.tradeCount, winRate: r.winRate, maxDrawdown: r.maxDrawdown,
        daily: r.equityFull,
        trades: r.tradesFull,
        positions: r.positions.map(p => ({ code: p.code, name: p.name, lbc: p.lbc, shares: p.shares, buyDate: p.buyDate, buyC: p.buyC, costC: p.costC })),
        nextCandidates: r.nextCandidates.map(c => ({ code: c.code, name: c.name, lbc: c.lbc, amount: c.amount || 0 })),
        todayBuys: r.todayBuys.map(p => ({ code: p.code, name: p.name, lbc: p.lbc, shares: p.shares, buyC: p.buyC })),
        todaySells: r.todayTrades.map(t => ({ code: t.code, name: t.name, sellC: t.sellC, pnlC: t.pnlC, pnlPct: t.pnlPct, reason: t.reason }))
      }))
    }), 'utf8')
    fs.writeFileSync(path.join(REPORTS, 'summary.json'), JSON.stringify({
      updated: new Date().toISOString(), date,
      strategies: results.map(r => ({
        id: r.id, name: r.name, date: r.date, totalC: r.totalC,
        dayPnlC: r.dayPnlC, dayRet: r.dayRet, cumPnlC: r.cumPnlC, cumRet: r.cumRet,
        tradeCount: r.tradeCount, winRate: r.winRate, maxDrawdown: r.maxDrawdown,
        positions: r.positions.map(p => ({ code: p.code, name: p.name, lbc: p.lbc, shares: p.shares, buyDate: p.buyDate, buyC: p.buyC })),
        nextCandidates: r.nextCandidates.map(c => ({ code: c.code, name: c.name, lbc: c.lbc })),
        equityDates: r.equityTail.map(e => e.date),
        equityTotalC: r.equityTail.map(e => e.totalC)
      }))
    }, null, 1), 'utf8')
    console.log('  报告已写：reports/' + date + '.md')
  } else {
    console.log('  --dry：不写文件')
  }

  /* --- 4. 推送 --- */
  if (!DRY) {
    const nr = await notify('打板模拟跟进 · ' + date, push)
    console.log('  推送：' + nr.join('；'))
  }

  console.log('\n' + report)
  console.log('  总耗时 ' + Math.round((Date.now() - t0) / 1000) + 's')
}

main().catch(e => { console.error('运行失败：', e); process.exit(1) })
