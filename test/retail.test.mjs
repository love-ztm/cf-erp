/* 零售场景测试：服务类商品 + 其他收入关联客户（自清理，可对运行中的库执行）
   node test/retail.test.mjs */
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

let r = await req('POST', '/api/login', { password: 'admin123' })
check('登录', r.status === 200)

// 记录测试前状态
r = await req('GET', '/api/parties')
const customer = r.data.find((p) => p.type === 'customer')
check('存在客户可用于测试', !!customer)
const debtBefore = customer ? Number(customer.debt) : 0
r = await req('GET', '/api/accounts')
const account = r.data[0]
check('存在账户可用于测试', !!account)
const balBefore = account ? Number(account.balance) : 0

// 服务类商品
r = await req('POST', '/api/products', { name: '__测试_维修服务', category: '服务', unit: '次', sale_price: 100, no_stock: true })
const pid = r.data.id
check('创建服务商品', r.status === 201, r)
r = await req('POST', '/api/sales', {
  customer_id: customer?.id ?? null, customer_name: customer?.name || '测试客户',
  note: '__测试', paid: 100, account_id: account.id,
  items: [{ product_id: pid, qty: 1, unit_price: 100 }],
})
const saleId = r.data.id
check('服务商品可销售（无需库存）', r.status === 201 && near(r.data.total, 100), r)
r = await req('GET', '/api/products')
const svc = r.data.find((p) => p.id === pid)
check('服务商品库存保持 0', svc && svc.stock === 0 && Number(svc.no_stock) === 1, svc)
r = await req('GET', '/api/parties')
check('全额收款不产生欠款', near(r.data.find((p) => p.id === customer.id).debt, debtBefore))
r = await req('GET', '/api/accounts')
check('收款入账户', near(r.data.find((a) => a.id === account.id).balance, balBefore + 100))
r = await req('POST', '/api/purchases', { supplier_name: '__测试', items: [{ product_id: pid, qty: 1, unit_cost: 1 }] })
check('服务商品禁止采购 422', r.status === 422)
r = await req('POST', `/api/products/${pid}/adjustments`, { qty: 1, reason: '__测试' })
check('服务商品禁止库存调整 422', r.status === 422)

// 其他收入关联客户（不动欠款）
r = await req('POST', '/api/funds', { type: 'income', party_id: customer.id, account_id: account.id, amount: 100, note: '__测试维修收入' })
const fundId = r.data?.ok ? (await req('GET', '/api/funds')).data.find((f) => f.note === '__测试维修收入')?.id : null
check('其他收入可关联客户', r.status === 201 && !!fundId, r)
r = await req('GET', '/api/parties')
check('关联收入不影响欠款', near(r.data.find((p) => p.id === customer.id).debt, debtBefore))
r = await req('GET', '/api/accounts')
check('收入进账户余额', near(r.data.find((a) => a.id === account.id).balance, balBefore + 200))

// ===== 清理测试数据 =====
r = await req('DELETE', '/api/sales/' + saleId)
check('清理：删除测试销售单', r.status === 200)
if (fundId) {
  r = await req('DELETE', '/api/funds/' + fundId)
  check('清理：删除测试收入', r.status === 200)
}
r = await req('DELETE', '/api/products/' + pid)
check('清理：删除测试商品', r.status === 200)
r = await req('GET', '/api/parties')
check('清理后欠款复原', near(r.data.find((p) => p.id === customer.id).debt, debtBefore))
r = await req('GET', '/api/accounts')
check('清理后余额复原', near(r.data.find((a) => a.id === account.id).balance, balBefore))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
