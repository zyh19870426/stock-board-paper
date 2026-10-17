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
const SIM = require('./lib/sim.js')
const RL = require('./lib/rolling.js')
const ML = require('./lib/minute-log.js')
const MC = require('./lib/minute-chart.js')

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

const BJ = ST.beijingNow(process.env.PAPER_NOW ? Date.parse(process.env.PAPER_NOW) : null)
const MARKET_CLOSED = ST.isMarketClosed(BJ)

const money = c => (c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = v => (v > 0 ? '+' : '') + (v * 100).toFixed(2) + '%'
const yuan = c => (c > 0 ? '+' : '') + money(c)
const ts = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
/* 多套策略参数一致时只显示一次（避免出现「亏损 20%、20% 止损」这类冗余） */
const same = a => { const u = [...new Set(a.map(String))]; return u.length === 1 ? u[0] : a.join('、') }

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

/* 单套策略重放已迁至 lib/sim.js（daily 与 intraday 共用单一真源；M2 也在这里） */

/* ---------------- 日报 ---------------- */
/* 看板副标题：把 config 里实际生效的规则如实写出来（新增字段缺省不影响旧策略文案） */
function briefOf (p) {
  if (!p || p.slots == null) return ''
  const sortTxt = p.sortBy === 'amtRatio'
    ? ' · 量能比' + (p.minAmtRatio != null ? '≥' + p.minAmtRatio : '') + '降序'
    : (p.sortBy === 'amount' ? ' · 成交额降序' : '')
  const gateTxt = p.gateYz ? ' · 再封率' + Math.round((p.gateYz.q == null ? 0.7 : p.gateYz.q) * 100) + '分位闸门' : ''
  const ddTxt = p.ddStop ? ' · 回撤' + Math.round(p.ddStop.ddPct * 100) + '%停' + p.ddStop.pauseDays + '日' : ''
  const gemTxt = p.maxGem != null ? ' · 创业板最多' + p.maxGem + '只' : ''
  return p.slots + ' 份 · 连板 ' + p.minLbc + '<N<' + p.maxLbc + sortTxt + gemTxt +
    ' · 止损 ' + p.stopLossPct + '% · 回撤线 ' + p.trailPct + '% · 断板即出（T+1：次日起 14:57 判定 / 集合竞价成交）' + gateTxt + ddTxt
}

function buildReport (date, results, meta) {
  const L = []
  L.push('# 打板模拟跟进 · ' + date)
  L.push('')
  L.push('> 数据截至 **' + date + ' 收盘** · 每套策略独立 **' + money(meta.initialCash * 100) + ' 元**本金')
  L.push('> 起点 ' + meta.startDate + '（当日收盘选股，次日开盘为第一笔买入）· 累计 ' + meta.equityDays + ' 个交易日')
  L.push('> 数据集：' + meta.storeRange + '（' + meta.storeDays + ' 个交易日 / ' + meta.storeStocks + ' 只票，滚动累积）')
  L.push('> 生成时间 ' + ts())
  L.push('')
  if (meta.rolling) {
    const rr = meta.rolling
    const badge = rr.status === 'green' ? '🟢 方向成立' : rr.status === 'watch' ? '🟡 观察中' : rr.status === 'degrade' ? '🔴 建议降级' : '⚪ 样本不足'
    L.push('## 〇、滚动验证（每 20 交易日复检）')
    L.push('')
    L.push('> ' + badge + ' —— ' + rr.note)
    L.push('>')
    L.push('> 为什么不是「显著性检验」：日波动 5.29%、日均超额 0.199% ⇒ 同效应需 n≈2831 交易日（11.3 年）才可能显著，' +
      '打板策略上这个检验**不可能达成**。所以改用「监控何时失效」替代「一次性证明有效」——2~3 个月就能有答案。')
    L.push('>')
    if (rr.recent) {
      L.push('> 近 20 交易日：M2 ' + pct(rr.recent.m2) + ' vs 静态最强（' + rr.staticName + '）' + pct(rr.recent.static) +
        ' ⇒ 超额 **' + pct(rr.recent.diff) + '**')
    }
    L.push('> 连续跑输：' + rr.streak + ' 个窗口（累计 ' + pct(rr.cumUnder) + '）　多窗口方向：' +
      rr.direction.map(d => d.win + '日 ' + pct(d.ret)).join(' / ') + '（' + rr.direction.filter(d => d.ret > 0).length + '/' + rr.direction.length + ' 为正）')
    L.push('')
  }
  L.push('## 一、收益一览')
  L.push('')
  L.push('| 策略 | 当日盈亏 | 当日收益率 | 累计收益率 | 总资产 | 持仓 | 累计笔数 |')
  L.push('|---|---|---|---|---|---|---|')
  results.forEach(r => {
    const slotTxt = r.params.slots != null ? r.positions.length + '/' + r.params.slots : String(r.positions.length)
    L.push('| ' + r.id + ' · ' + r.name + ' | ' + yuan(r.dayPnlC) + ' | ' + pct(r.dayRet) +
      ' | **' + pct(r.cumRet) + '** | ' + money(r.totalC) + ' | ' + slotTxt + ' | ' + r.tradeCount + ' |')
  })
  L.push('')

  results.forEach(r => {
    L.push('## ' + r.id + ' · ' + r.name)
    L.push('')
    /* M2 专属：今天跟随谁、依据、切换轨迹 */
    if (r.m2) {
      const m = r.m2
      L.push('- **今日跟随：' + m.pickToday.name + '**（依据：昨日收盘时，' +
        m.trace.map(x => x.name + ' 近10日 ' + (x.ret == null ? '—' : pct(x.ret))).join('，') + '，取最强）')
      L.push('- 近30个交易日切换：' + m.switches.map(s => s.date.slice(5) + '→' + s.name).join(' · '))
      L.push('- ' + m.ref)
      L.push('')
    }
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
    same(results.map(r => r.params.stopLossPct + '%')) + ' 止损 / 回撤 ' + same(results.map(r => r.params.trailPct + '%')) +
    ' 止损 / 最长持有 ' + same(results.map(r => r.params.maxHoldDays)) + ' 个交易日。')
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

/* ---------------- 推送用短文本 ----------------
 * ★ 2026-10-15 改造：以 M2 为「实盘执行清单」口径 ——
 *   明确告诉用户「今天做什么板 / 买哪几只 / 卖哪几只 / 各占多少资金」，
 *   让人可以照着在券商 App / QMT 里手动下单（半自动模式）。
 *   收益与口径提醒放在末尾，避免误导按回测数字定预期。 */
function buildPush (date, results, rolling) {
  const L = []
  const m2 = results.filter(r => r.m2)[0]
  const others = results.filter(r => !r.m2)

  L.push('### 打板模拟跟进 · ' + date)
  L.push('')
  if (rolling) {
    const badge = rolling.status === 'green' ? '🟢 方向成立' : rolling.status === 'watch' ? '🟡 观察中' : rolling.status === 'degrade' ? '🔴 建议降级' : '⚪ 样本不足'
    L.push('**滚动验证：' + badge + '** —— ' + rolling.note)
    L.push('')
  }

  if (m2) {
    const pick = m2.m2.pickToday
    L.push('## ★ M2 执行清单（跟随·近10日最强）')
    L.push('')
    L.push('**今日做：' + pick.name + '**' + (pick.pause ? '（空仓）' : ''))
    L.push('依据：' + m2.m2.trace.map(x => x.name + ' 近10日 ' + (x.ret == null ? '—' : pct(x.ret))).join('，') + ' → 取最强')
    L.push('')
    /* 今日实际动作（收盘跑口径：已执行/待执行） */
    if (m2.todayBuys.length) {
      L.push('**今日已买入**（开盘价成交）')
      m2.todayBuys.forEach(p => L.push('- ' + p.code + ' ' + p.name + '　' + p.lbc + '板　' + p.shares + '股 @ ' + (p.buyC / 100).toFixed(2) + '　约 ' + money(p.costC) + ' 元'))
      L.push('')
    }
    if (m2.todayTrades.length) {
      L.push('**今日卖出**（14:57 集合竞价）')
      m2.todayTrades.forEach(t => L.push('- ' + t.code + ' ' + t.name + '　' + t.shares + '股 @ ' + (t.sellC / 100).toFixed(2) + '　' + yuan(t.pnlC) + '（' + pct(t.pnlPct) + '）　' + t.reason))
      L.push('')
    }
    if (m2.skippedToday.length) {
      L.push('**今日弃买**：' + m2.skippedToday.map(s => s.code + ' ' + s.name + '（' + s.reason + '）').join('、'))
      L.push('')
    }
    /* 明天要下的单 —— 这才是半自动模式真正要看的部分 */
    L.push('**次日买入清单**（' + date + ' 收盘选出，下一交易日开盘执行）')
    if (m2.nextCandidates.length) {
      const budget = m2.params.allocMode === 'dynamic' ? '按次账资金动态分配' : '固定等分'
      m2.nextCandidates.forEach((c, i) => {
        L.push('- 第 ' + (i + 1) + ' 顺位　' + c.code + ' ' + c.name + '　' + c.lbc + '板　成交额 ' + ((c.amount || 0) / 1e8).toFixed(2) + ' 亿')
      })
      L.push('')
      L.push('> 共 ' + m2.params.slots + ' 个名额（' + budget + '）；' +
        (m2.params.skipLimitOpen ? '一字涨停开盘买不进则弃买' : '') +
        '；已持仓 ' + m2.positions.length + ' 笔')
      L.push('> ⏱ **挂单时点建议：09:30–09:33**（越早越接近竞价开盘价）。实测 09:30–9:35 买入相对开盘价平均仅 +0.35%、双向对称，但越晚单笔波动越大（±5~10%）⇒ 尽早挂、别追价。')
    } else {
      L.push('- _无候选（当日无符合板数区间的票，或名额已满）_')
    }
    L.push('')
    L.push('**持仓**')
    if (m2.positions.length) m2.positions.forEach(p => L.push('- ' + p.code + ' ' + p.name + '　' + p.lbc + '板　' + p.shares + '股　成本 ' + (p.buyC / 100).toFixed(2) + '（' + p.buyDate + '）'))
    else L.push('- 空仓')
    L.push('')
    L.push('> 卖出规则：买入次日起，每交易日 14:57 看是否封住涨停，未封则挂收盘集合竞价卖出（成交价＝收盘价）')
    L.push('')
  }

  if (others.length) {
    L.push('---')
    L.push('**参考：静态策略对照**')
    others.forEach(r => {
      L.push(r.id + ' ' + r.name + '　当日 ' + yuan(r.dayPnlC) + '（' + pct(r.dayRet) + '）累计 ' + pct(r.cumRet) + '　持仓 ' + r.positions.length + '/' + r.params.slots)
    })
    L.push('')
  }

  L.push('---')
  L.push('⚠️ **预期校准**：回测 +307% 为零成本样本内上界；稳健性审计显示单边 0.5% 滑点即衰减至 +133%、单边 1% 仅 +11.8%，且剔掉最好的 10 个交易日收益降至 35%。请按保守口径看待，模拟盘非投资建议。')
  return L.join('\n')
}

/* ---------------- 主流程 ---------------- */
async function main () {
  const t0 = Date.now()
  let noNewDay = false          // 本次是否「没有新交易日」（true 时只重放看板，不写日报、不推送）
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  console.log('== 打板模拟跟进 ' + ts() + ' ==')
  console.log('  策略 ' + cfg.strategies.map(s => s.id + '·' + s.name).join(' / '))
  console.log('  起点 ' + cfg.startDate + '，本金 ' + money(cfg.initialCash * 100) + ' 元/套')

  /* --- 1. 数据集 --- */
  let store
  let repaired = false       // 本次是否做了「自愈」（剔除已入库的盘中半截日线）
  if (RESEED || !fs.existsSync(STORE_FILE)) {
    if (!fs.existsSync(LOCAL_DATASET)) throw new Error('缺少种子数据集：' + LOCAL_DATASET + '（请在开发机先跑 build-dataset.js，或提交一份 data/store.json）')
    store = ST.initFromDataset(LOCAL_DATASET, 0)   // 0 = 保留全部历史（云端回测要跑长窗口）
    console.log('  数据集：从 ' + LOCAL_DATASET + ' 播种 ' + store.dates.length + ' 天 / ' + Object.keys(store.st).length + ' 只票')
  } else {
    store = ST.load(STORE_FILE)
    console.log('  数据集：载入 ' + store.dates.length + ' 天 / ' + Object.keys(store.st).length + ' 只票（至 ' + store.dates[store.dates.length - 1] + '）')
  }

  /* ★ 自愈：不只堵源头（dropUnfinishedToday），还要能修已污染的历史。
   *   末位日期 >= 今天且尚未收盘 ⇒ 那根日线不可能是最终值，整根删掉。
   *   必须放在抓取/追加之前 —— 否则 appendDays 看到「今天已存在」就不再追加，
   *   收盘后真正的日线永远进不来。 */
  const rep = ST.trimTrailingUnfinished(store, BJ.date, MARKET_CLOSED)
  if (rep.dropped != null) {
    repaired = true
    console.log('  🔧 自愈：剔除已入库的盘中半截日线 ' + rep.dropped + '（' + rep.stocks + ' 只票截断/移除），收盘后重跑会补回最终值')
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
    /* ★ 盘中护栏：未收盘前，绝不把「今天」这根还在走的日线当成收盘写进数据集。
     *   本工作流会被页面上「加入模拟 / 移出模拟」随时手动触发，任何时间点都可能中招；
     *   一旦写入就永久留在历史里且无法自愈（收盘后重跑时该日期已存在，不会再追加）。详见 lib/store.js。 */
    if (!MARKET_CLOSED) {
      const dz = ST.dropUnfinishedToday(fr.barsMap, BJ.date, MARKET_CLOSED)
      if (dz.dropped) {
        const hhmm = String(Math.floor(BJ.min / 60)).padStart(2, '0') + ':' + String(BJ.min % 60).padStart(2, '0')
        console.log('  ⏸ 北京时间 ' + BJ.date + ' ' + hhmm + ' 尚未收盘（15:05 前）→ 剔掉 ' + dz.days.join('、') + ' 的盘中日线 ' + dz.dropped + ' 根，本次不写入数据集')
      }
    }
    const ap = ST.appendDays(store, fr.barsMap, nameOf)
    console.log('  数据集新增 ' + ap.added + ' 个交易日' + (ap.newDays.length ? '（' + ap.newDays.join('、') + '）' : '') + '，新纳入 ' + ap.newStocks + ' 只票')
    if (ap.added === 0) {
      /* ★ 这里绝不能 return。
       *   手动触发（页面上点「加入模拟」「移出模拟」触发的正是这个）时，当天通常已经跑过一次，
       *   抓取自然「没有新交易日」——但 config 变了，线上看板数据必须跟着重算。
       *   原来在这里 return 的后果：新加的策略永远不出现在每日收益看板上，
       *   必须等到下一个真正的新交易日才连带更新（用户看到的就是这个）。
       *   所以现在只标记「账户不动、日报不写、不推送」，重放与写 dashboard.json 照常执行。 */
      noNewDay = true
      console.log('  ⚠️ 没有新交易日（休市 / 数据源未更新 / 今天已跑过）→ 账户不变，但仍按当前配置重放并刷新看板数据')
      if (!DRY) {
        const last = store.dates[store.dates.length - 1]
        const note = '# 无新交易日 · ' + last + '\n\n本次未取到 ' + last + ' 之后的新交易日数据，账户保持不动（线上看板数据仍按当前 config 重算）。\n'
        fs.mkdirSync(REPORTS, { recursive: true })
        fs.writeFileSync(path.join(REPORTS, 'last-run.txt'), note, 'utf8')
      }
    }
  } else {
    console.log('  --no-fetch：跳过抓取，直接用现有数据集重算（账户按当前 config 重放）')
  }

  if (!DRY && (!noNewDay || repaired)) ST.save(STORE_FILE, store)

  /* --- 2. 策略重放（M2 在前，见 lib/sim.js） --- */
  const date = store.dates[store.dates.length - 1]
  const computed = SIM.computeAll(store, cfg)
  const results = computed.results
  const curves = computed.curves || {}

  results.forEach(r => {
    console.log('  [' + r.id + '] ' + date + ' 当日 ' + yuan(r.dayPnlC) + '（' + pct(r.dayRet) + '）累计 ' + pct(r.cumRet) +
      ' 总资产 ' + money(r.totalC) + ' 持仓 ' + r.positions.length + ' 笔数 ' + r.tradeCount)
  })

  /* ★ 滚动验证（每 20 交易日复检）：把「证明有效」换成「监控何时失效」。
   *   统计显著性在打板策略上不可达（同效应需 ~2831 交易日），故用制度监控替代。
   *   结果随 meta 进日报 + 写入 dashboard.json 顶部常驻状态 + data/rolling.json 留痕。 */
  let rolling = null
  try {
    rolling = RL.rollingCheck(store, { slip: 0 })
    console.log('  滚动验证：' + rolling.status.toUpperCase() + ' —— ' + rolling.note)
  } catch (e) { console.log('  ⚠️ 滚动验证失败（不影响主流程）：' + e.message) }

  /* ★ 当日分时增量采集：为「09:30–9:35 买入偏离」长期积累大样本。
   *   数据源分钟线只回溯约 1 个月 ⇒ 只有每天顺手存，几个月后才有 n=200+。
   *   只增不减、按 code+date 去重；失败绝不影响主流程。 */
  let minuteLog = null
  let minuteChart = null
  if (!DRY && !noNewDay) {
    const items = []
    results.forEach(r => {
      const seen = new Set()
      r.nextCandidates.forEach(c => { if (!seen.has(c.code)) { seen.add(c.code); items.push({ code: c.code, name: c.name, lbc: c.lbc }) } })
      r.todayBuys.forEach(p => { if (!seen.has(p.code)) { seen.add(p.code); items.push({ code: p.code, name: p.name, lbc: p.lbc }) } })
      r.positions.forEach(p => { if (!seen.has(p.code)) { seen.add(p.code); items.push({ code: p.code, name: p.name, lbc: p.lbc }) } })
    })
    try {
      minuteLog = await ML.collect(path.join(DATA, 'minute-history.json'), date, items, { budgetMs: 90 * 1000 })
      console.log('  分时采集：+' + minuteLog.added + ' 条（库内共 ' + minuteLog.total + ' 条）' +
        (minuteLog.failed.length ? '，失败 ' + minuteLog.failed.length + ' 只' : ''))
    } catch (e) { console.log('  ⚠️ 分时采集失败（不影响主流程）：' + e.message) }
    /* ★ 分时图序列采集（画「今日操作股票」的当日分时图）：
     *   与上面的汇总采集同源（新浪 scale=5），但存整条 48 根序列。只留最近 8 个交易日。 */
    try {
      minuteChart = await MC.collect(path.join(DATA, 'minute-chart.json'), date, items, { budgetMs: 60 * 1000 })
      console.log('  分时图采集：+' + minuteChart.added + ' 只（库内共 ' + minuteChart.total + ' 条）' +
        (minuteChart.failed.length ? '，失败 ' + minuteChart.failed.length + ' 只' : ''))
    } catch (e) { console.log('  ⚠️ 分时图采集失败（不影响主流程）：' + e.message) }
    /* ★ 成交明细专用分时回填（2026-10-17）：
     *   成交明细里每一笔都要能点开看「买入日 / 卖出日」的当日分时 + B/S 点位与时间。
     *   做法：把各策略已平仓交易的 (code, buyDate, sellDate) 全收集，按票回填近 20 个交易日。
     *   幂等（code@date 去重），所以每天跑都安全。 */
    try {
      const allTrades = []
      results.forEach(r => (r.trades || []).forEach(t => allTrades.push(t)))
      const mt = await MC.collectTrades(path.join(DATA, 'minute-trade.json'), allTrades, { budgetMs: 120 * 1000 })
      if (mt.added) console.log('  成交分时回填：+' + mt.added + ' 条（库内共 ' + mt.total + ' 条，' + mt.codes + ' 只票）')
    } catch (e) { console.log('  ⚠️ 成交分时回填失败（不影响主流程）：' + e.message) }
  }

  const meta = {
    initialCash: cfg.initialCash,
    startDate: cfg.startDate,
    equityDays: results[0].equityDays,
    storeRange: store.dates[0] + ' ~ ' + date,
    storeDays: store.dates.length,
    storeStocks: Object.keys(store.st).length,
    rolling,
    minuteLog,
    minuteChart
  }

  /* --- 3. 落盘 --- */
  const report = buildReport(date, results, meta)
  const push = buildPush(date, results, rolling)
  if (!DRY) {
    fs.mkdirSync(REPORTS, { recursive: true })
    if (!noNewDay) {
      fs.writeFileSync(path.join(REPORTS, date + '.md'), report, 'utf8')
      fs.writeFileSync(path.join(REPORTS, 'latest.md'), report, 'utf8')
      fs.writeFileSync(path.join(REPORTS, 'last-run.txt'), report.split('\n').slice(0, 3).join('\n') + '\n', 'utf8')
      console.log('  报告已写：reports/' + date + '.md')
    } else {
      console.log('  无新交易日：日报不改写（线上看板数据已按当前配置刷新）')
    }
    /* ★ 线上看板数据（dashboard.json / summary.json）：无论有没有新交易日都重写。
       否则「手动新增/移出策略」时（手动触发的这次通常正好没有新交易日）
       看板会一直停在旧策略列表上，要等下一个新交易日才生效。
       全量净值曲线 + 成交明细（GitHub Pages 的 index.html 读取） */
    fs.writeFileSync(path.join(DATA, 'dashboard.json'), JSON.stringify({
      updated: new Date().toISOString(), date,
      startDate: cfg.startDate, initialCash: cfg.initialCash,
      mainId: computed.mainId || cfg.mainStrategy || 'S3',   // ★ 主策略（置顶 + 页面默认选中）
      replayStart: computed.replayStart || undefined,
      rolling: rolling || undefined,
      strategies: results.map(r => ({
        id: r.id, name: r.name,
        isRef: !!r.isRef,                  // ★ 非主策略 = 对照组（看板弱化显示）
        brief: r.m2 ? SIM.M2_BRIEF : briefOf(r.params),
        slots: r.params.slots,
        risk: r.risk || undefined,        // ★ 风控状态 + 止损/回撤线（人为跟随用）
        lbcRange: r.params.slots != null ? (r.params.minLbc + '<N<' + r.params.maxLbc) : '动态（跟随切换）',
        m2: r.m2 || undefined,
        date: r.date,
        totalC: r.totalC, cashC: r.cashC, mvC: r.mvC,
        dayPnlC: r.dayPnlC, dayRet: r.dayRet,
        cumPnlC: r.cumPnlC, cumRet: r.cumRet,
        tradeCount: r.tradeCount, winRate: r.winRate, maxDrawdown: r.maxDrawdown,
        daily: r.equityFull,
        /* ★ 全区间回放曲线（从数据集可回测起点 warmup 起跑，同参数）：
             模拟账户 startDate 常＝上线日（可能就是数据集最后一天）⇒ daily 只有 1 个点、曲线空白。
             这里给一条有形状的历史曲线供看板绘制。页面注明「回放」，与真实账户区分。 */
        curve: curves[r.id] || undefined,
        trades: r.tradesFull,
        positions: r.positions.map(p => ({ code: p.code, name: p.name, lbc: p.lbc, shares: p.shares, buyDate: p.buyDate, buyC: p.buyC, costC: p.costC })),
        nextCandidates: r.nextCandidates.map(c => ({ code: c.code, name: c.name, lbc: c.lbc, amount: c.amount || 0 })),
        todayBuys: r.todayBuys.map(p => ({ code: p.code, name: p.name, lbc: p.lbc, shares: p.shares, buyC: p.buyC })),
        todaySells: r.todayTrades.map(t => ({ code: t.code, name: t.name, sellC: t.sellC, pnlC: t.pnlC, pnlPct: t.pnlPct, reason: t.reason }))
      }))
    }), 'utf8')
    /* ★ 滚动验证独立落盘：便于外部脚本 / 历史趋势追踪（dashboard.json 只保最新一次） */
    if (rolling) {
      const RF = path.join(DATA, 'rolling.json')
      let hist = []
      try { hist = JSON.parse(fs.readFileSync(RF, 'utf8')).history || [] } catch (e) { hist = [] }
      const snap = {
        at: rolling.at, status: rolling.status, note: rolling.note,
        slip: rolling.slip, recent: rolling.recent, streak: rolling.streak, cumUnder: rolling.cumUnder,
        direction: rolling.direction, staticKey: rolling.staticKey, staticName: rolling.staticName
      }
      const i = hist.findIndex(h => h.at === snap.at)
      if (i >= 0) hist[i] = snap; else hist.push(snap)
      fs.writeFileSync(RF, JSON.stringify({
        updated: new Date().toISOString(),
        latest: snap,
        history: hist.slice(-120),
        historyDiff: rolling.history
      }, null, 1), 'utf8')
    }
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
  } else {
    console.log('  --dry：不写文件')
  }

  /* --- 4. 推送（只有真的新增了交易日才推，避免休市日/手动重跑刷屏） --- */
  if (!DRY && !noNewDay) {
    const nr = await notify('打板模拟跟进 · ' + date, push)
    console.log('  推送：' + nr.join('；'))
  }

  console.log('\n' + report)
  console.log('  总耗时 ' + Math.round((Date.now() - t0) / 1000) + 's')
}

main().catch(e => { console.error('运行失败：', e); process.exit(1) })
