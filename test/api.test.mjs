/* cf-erp API 端到端测试：node test/api.test.mjs（需先启动 npm run dev） */
const BASE = process.env.ERP_BASE || 'http://127.0.0.1:8787'
let cookie = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const sc = res.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}
let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : '') }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005
const Q = '?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z'

let r = await req('POST', '/api/login', { password: 'admin123' })
check('登录', r.status === 200)

// 商品（含类别/条码）
r = await req('POST', '/api/products', { name: '可乐', sku: 'KL01', barcode: '69012345', category: '饮料', unit: '瓶', initial_stock: 10, initial_cost: 5, sale_price: 12, low_stock: 5 })
const pa = r.data.id; check('创建商品A(类别/条码)', r.status === 201)
r = await req('GET', '/api/products')
let A = r.data.find(p => p.id === pa)
check('A 类别/条码字段', A.category === '饮料' && A.barcode === '69012345', A)

// 账户
r = await req('POST', '/api/accounts', { name: '现金', opening_balance: 100 })
const accCash = r.data.id; check('创建账户-现金', r.status === 201)
r = await req('POST', '/api/accounts', { name: '微信', opening_balance: 0 })
const accWx = r.data.id; check('创建账户-微信', r.status === 201)
r = await req('GET', '/api/accounts')
check('现金余额 100', near(r.data.find(a => a.id === accCash).balance, 100))

// 往来单位（期初欠款）
r = await req('POST', '/api/parties', { type: 'supplier', name: '供应商S', opening_debt: 100 })
const sup = r.data.id; check('创建供应商(期初欠100)', r.status === 201)
r = await req('POST', '/api/parties', { type: 'customer', name: '客户C', opening_debt: 50 })
const cus = r.data.id; check('创建客户(期初欠50)', r.status === 201)
r = await req('GET', '/api/parties')
check('S.debt=100', near(r.data.find(p => p.id === sup).debt, 100))
check('C.debt=50', near(r.data.find(p => p.id === cus).debt, 50))

// 采购入库：A +10 @6，付款 40（现金）→ S.debt=180, 现金=60, A 均价 5.5
r = await req('POST', '/api/purchases', { supplier_id: sup, supplier_name: '供应商S', note: '进货', discount: 0, paid: 40, account_id: accCash, items: [{ product_id: pa, qty: 10, unit_cost: 6 }] })
const pu1 = r.data.id; check('采购单创建', r.status === 201 && near(r.data.total, 60), r)
r = await req('GET', '/api/products')
A = r.data.find(p => p.id === pa)
check('A 库存 20 均价 5.5', A.stock === 20 && near(A.avg_cost, 5.5), A)
r = await req('GET', '/api/parties')
check('S.debt=120', near(r.data.find(p => p.id === sup).debt, 120))
r = await req('GET', '/api/accounts')
check('现金=60', near(r.data.find(a => a.id === accCash).balance, 60))

// 销售出库：A -5 @12 优惠2 收款20（微信）→ C.debt=88, 微信=20, A 库存 15
r = await req('POST', '/api/sales', { customer_id: cus, customer_name: '客户C', note: '售卖', discount: 2, paid: 20, account_id: accWx, items: [{ product_id: pa, qty: 5, unit_price: 12 }] })
const so1 = r.data.id; check('销售单创建 net=58', r.status === 201 && near(r.data.total - r.data.discount, 58), r)
r = await req('GET', '/api/sales/' + so1)
check('成本快照 5.5', near(r.data.items[0].unit_cost, 5.5))
r = await req('GET', '/api/products')
A = r.data.find(p => p.id === pa)
check('A 库存 15', A.stock === 15)
r = await req('GET', '/api/parties')
check('C.debt=88', near(r.data.find(p => p.id === cus).debt, 88))
r = await req('GET', '/api/accounts')
check('微信=20', near(r.data.find(a => a.id === accWx).balance, 20))

// 销售退货 2 @12 冲欠款 → A 库存 17, C.debt=64
r = await req('POST', '/api/sales', { kind: 'return', customer_id: cus, customer_name: '客户C', refund_way: 'debt', note: '退2瓶', items: [{ product_id: pa, qty: 2, unit_price: 12 }] })
check('销售退货单创建', r.status === 201 && near(r.data.total, 24), r)
r = await req('GET', '/api/products')
A = r.data.find(p => p.id === pa)
check('退货后 A 库存 17', A.stock === 17, A.stock)
r = await req('GET', '/api/parties')
check('退货冲欠款 C.debt=64', near(r.data.find(p => p.id === cus).debt, 64))

// 采购退货 3 @6 退回账户（现金）→ A 库存 14, S.debt 不变 180, 现金=78
r = await req('POST', '/api/purchases', { kind: 'return', supplier_id: sup, supplier_name: '供应商S', refund_way: 'account', account_id: accCash, note: '退3瓶', items: [{ product_id: pa, qty: 3, unit_cost: 6 }] })
check('采购退货单创建', r.status === 201 && near(r.data.total, 18), r)
r = await req('GET', '/api/products')
A = r.data.find(p => p.id === pa)
check('采购退货后 A 库存 14', A.stock === 14, A.stock)
r = await req('GET', '/api/parties')
check('S.debt 仍 120', near(r.data.find(p => p.id === sup).debt, 120))
r = await req('GET', '/api/accounts')
check('现金=78', near(r.data.find(a => a.id === accCash).balance, 78))

// 校验分支
r = await req('POST', '/api/purchases', { kind: 'return', supplier_name: 'X', refund_way: 'debt', items: [{ product_id: pa, qty: 999, unit_cost: 1 }] })
check('采购退货超库存 422', r.status === 422)
r = await req('POST', '/api/purchases', { supplier_name: 'X', paid: 5, items: [{ product_id: pa, qty: 1, unit_cost: 1 }] })
check('付款未选账户 422', r.status === 422)
r = await req('POST', '/api/funds', { type: 'receipt', party_id: sup, account_id: accWx, amount: 10 })
check('收款选供应商 422', r.status === 422)
r = await req('POST', '/api/funds', { type: 'steal', account_id: accWx, amount: 10 })
check('资金类型不合法 422', r.status === 422)

// 收付款与收支
r = await req('POST', '/api/funds', { type: 'receipt', party_id: cus, account_id: accWx, amount: 30, note: '还欠款' })
check('收款单', r.status === 201)
r = await req('POST', '/api/funds', { type: 'payment', party_id: sup, account_id: accCash, amount: 60 })
check('付款单', r.status === 201)
await req('POST', '/api/funds', { type: 'income', account_id: accWx, amount: 100, note: '运费补收' })
await req('POST', '/api/funds', { type: 'expense', account_id: accWx, amount: 20, note: '午餐' })
r = await req('GET', '/api/parties')
check('C.debt=34', near(r.data.find(p => p.id === cus).debt, 34))
check('S.debt=60', near(r.data.find(p => p.id === sup).debt, 60))
r = await req('GET', '/api/accounts')
check('现金=18', near(r.data.find(a => a.id === accCash).balance, 18), r.data)
check('微信=130', near(r.data.find(a => a.id === accWx).balance, 130), r.data)
r = await req('GET', '/api/funds')
check('资金日记账含单据收付', r.data.some(f => f.type === 'sale_paid') && r.data.some(f => f.type === 'purchase_paid'), r.data.map(f => f.type))

// 报表：毛利 = (60-24) - (27.5-11) - 2 = 17.5
r = await req('GET', '/api/reports/profit' + Q)
check('毛利-净销售额 36', near(r.data.total.revenue, 36), r.data.total)
check('毛利-净成本 16.5', near(r.data.total.cost, 16.5))
check('毛利-优惠 2', near(r.data.discount, 2))
check('毛利-净毛利 17.5', near(r.data.total.profit, 17.5), r.data.total)
r = await req('GET', '/api/reports/summary' + Q)
let sa = r.data.rows.find(x => x.product_id === pa)
check('汇总-采购退货3', sa.purchase_return === 3, sa)
check('汇总-销售退货2', sa.sale_return === 2, sa)
check('汇总-期末 14', sa.closing === 14, sa)
r = await req('GET', '/api/dashboard' + Q)
check('仪表盘-账户总额 148', near(r.data.money.accountTotal, 148), r.data.money)
check('仪表盘-客户欠款 34', near(r.data.money.customerDebt, 34))
check('仪表盘-供应商欠款 60', near(r.data.money.supplierDebt, 60))
check('仪表盘-毛利 17.5', near(r.data.sales.profit, 17.5))

// 库存流水
r = await req('GET', '/api/stock/moves?product_id=' + pa)
check('A 流水 4 条', r.data.length === 4, r.data.length)
check('流水含销售退货类型', r.data.some(m => m.type === 'sale' && m.kind === 'return'))

// 期初欠款修改 → 自动重算
r = await req('PUT', '/api/parties/' + cus, { name: '客户C', phone: '', note: '', opening_debt: 0 })
check('改客户期初欠款', r.status === 200)
r = await req('GET', '/api/parties')
check('C.debt 重算=-16', near(r.data.find(p => p.id === cus).debt, -16))
await req('PUT', '/api/parties/' + cus, { name: '客户C', phone: '', note: '', opening_debt: 50 })

// 账户删除保护（微信有流水）
r = await req('DELETE', '/api/accounts/' + accWx)
check('有流水账户禁删 422', r.status === 422)

// 删除采购单 → 全量重算：A 库存 4 均价 5；S.debt=40；现金=58
r = await req('DELETE', '/api/purchases/' + pu1)
check('删除采购单', r.status === 200)
r = await req('GET', '/api/products')
A = r.data.find(p => p.id === pa)
check('重算后 A 库存 4', A.stock === 4, A.stock)
check('重算后 A 均价 5', near(A.avg_cost, 5), A.avg_cost)
r = await req('GET', '/api/parties')
check('重算后 S.debt=40', near(r.data.find(p => p.id === sup).debt, 40))
r = await req('GET', '/api/accounts')
check('重算后 现金=58', near(r.data.find(a => a.id === accCash).balance, 58), r.data)

// 删除付款流水 → 重算
r = await req('GET', '/api/funds')
const payFlow = r.data.find(f => f.type === 'payment')
r = await req('DELETE', '/api/funds/' + payFlow.id)
check('删除付款流水', r.status === 200)
r = await req('GET', '/api/accounts')
check('删付款后 现金=118', near(r.data.find(a => a.id === accCash).balance, 118), r.data)
r = await req('GET', '/api/parties')
check('删付款后 S.debt=100', near(r.data.find(p => p.id === sup).debt, 100))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
