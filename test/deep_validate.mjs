/* 深度校验：组件合计 + 逐商品库存对照真值。进度写 %TEMP%/dv.log */
import fs2 from 'node:fs'
const plog = (m) => fs2.appendFileSync(process.env.TEMP + '/dv.log', new Date().toISOString().slice(11, 19) + ' ' + m + '\n')

const BASE = 'http://127.0.0.1:8787'
let cookie = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie, Connection: 'close' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const sc = res.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

plog('login...')
await req('POST', '/api/login', { password: 'admin123' })
plog('login ok')

async function fetchAll(path, page = 500) {
  let out = [], off = 0
  for (;;) {
    const r = await req('GET', `${path}${path.includes('?') ? '&' : '?'}limit=${page}&offset=${off}`)
    if (!r.data.length) break
    out = out.concat(r.data)
    if (r.data.length < page) break
    off += page
  }
  return out
}

plog('fetch sales...')
const allSales = await fetchAll('/api/sales')
plog('sales ' + allSales.length)
const purchases = await fetchAll('/api/purchases')
plog('purchases ' + purchases.length)
const funds = await fetchAll('/api/funds', 500)
plog('funds ' + funds.length)
const accounts = await req('GET', '/api/accounts')
const products = await req('GET', '/api/products')
plog('products ' + products.data.length)

const sum = (a, f) => a.reduce((s, x) => s + Number(f(x) || 0), 0)
console.log('== 组件合计 ==')
console.log('销售单:', allSales.length, 'Σpaid(normal):', sum(allSales.filter(s => s.kind === 'normal'), s => s.paid).toFixed(2))
console.log('采购单:', purchases.length, 'Σpaid(normal):', sum(purchases.filter(p => p.kind === 'normal'), p => p.paid).toFixed(2), 'Σ(net-paid):', sum(purchases.filter(p => p.kind === 'normal'), p => p.total - p.discount - p.paid).toFixed(2))
const fByType = {}
for (const f of funds) fByType[f.type] = (fByType[f.type] || 0) + Number(f.amount)
console.log('funds:', JSON.stringify(fByType))
console.log('accounts:', accounts.data.map(a => `${a.name}=${a.balance}`).join(', '))
console.log('余额合计:', sum(accounts.data, a => a.balance).toFixed(2), '(期望 499917.44)')

// 逐商品库存对照真值（编号 → id 匹配，与 migrate.py 相同）
const truth = JSON.parse(fs2.readFileSync('C:/Users/Administrator/ZCodeProject/cf-erp/tools/inv_balance_truth.json', 'utf8'))
const pmap = {}
const bySku = {}
for (const p of products.data) {
  pmap[p.id] = p
  if (p.sku) bySku[String(p.sku)] = p
}
const diffs = []
let truthTotal = 0
const matchedIds = new Set()
let unmatchedRows = 0
for (const row of truth) {
  let p = bySku[String(row.invNo)]
  if (!p && /^\d+$/.test(String(row.invNo))) p = pmap[Number(row.invNo)]
  if (!p) { unmatchedRows++; continue }
  matchedIds.add(p.id)
  truthTotal += Number(row.qty_1 || 0)
  const d = Number(p.stock || 0) - Number(row.qty_1 || 0)
  if (Math.abs(d) > 0.001) diffs.push({ id: p.id, name: p.name, truth: row.qty_1, ours: p.stock, diff: d })
}
console.log('\n== 库存对照 ==')
console.log('真值行对齐:', matchedIds.size, '未对齐(已删商品残留):', unmatchedRows, '差异商品:', diffs.length, '真值总量:', truthTotal)
for (const d of diffs.slice(0, 8)) console.log(`  [${d.id}] ${String(d.name).slice(0, 20)} 真=${d.truth} 我=${d.ours} 差=${d.diff.toFixed(2)}`)
const extra = products.data.filter(p => !matchedIds.has(p.id) && Math.abs(Number(p.stock || 0)) > 0.001)
console.log('非真值商品有库存的:', extra.length, '合计:', sum(extra, p => p.stock).toFixed(2))
console.log('库存总量:', sum(products.data, p => p.stock).toFixed(2), '(老系统 1819)')
console.log('库存成本:', sum(products.data, p => p.stock * p.avg_cost).toFixed(2), '(老系统 34193.02)')
