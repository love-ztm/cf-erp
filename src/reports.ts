import { Hono } from 'hono'
import { loadLedger, round2 } from './db'

const app = new Hono<{ Bindings: Env }>()

// 时间范围：前端传本地时区换算好的 ISO（UTC）字符串，与 created_at 直接做字符串比较
function range(c: { req: { query: (k: string) => string | undefined } }): { from: string; to: string } {
  const from = c.req.query('from') || '2000-01-01T00:00:00.000Z'
  const to = c.req.query('to') || '9999-12-31T23:59:59.999Z'
  return { from, to }
}

// 毛利报表：按商品汇总（含退货反冲）+ 按日趋势 + 整单优惠 + 维修单汇总
app.get('/reports/profit', async (c) => {
  const db = c.env.DB
  const { from, to } = range(c)
  const [byProduct, daily, discountAgg, repairAgg, manualSaleAgg] = await Promise.all([
    db
      .prepare(
        `SELECT si.product_id, p.name, p.unit,
                SUM(CASE WHEN s.kind = 'normal' THEN si.qty ELSE -si.qty END) AS qty,
                SUM(CASE WHEN s.kind = 'normal' THEN si.qty * si.unit_price ELSE -si.qty * si.unit_price END) AS revenue,
                SUM(CASE WHEN s.kind = 'normal' THEN si.qty * si.unit_cost ELSE -si.qty * si.unit_cost END) AS cost
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         JOIN products p ON p.id = si.product_id
         WHERE s.created_at >= ?1 AND s.created_at < ?2
         GROUP BY si.product_id ORDER BY revenue DESC`
      )
      .bind(from, to)
      .all<{ product_id: number; name: string; unit: string; qty: number; revenue: number; cost: number }>(),
    db
      .prepare(
        `SELECT date(s.created_at) AS d,
                SUM(CASE WHEN s.kind = 'normal' THEN si.qty * si.unit_price ELSE -si.qty * si.unit_price END) AS revenue,
                SUM(CASE WHEN s.kind = 'normal' THEN si.qty * si.unit_cost ELSE -si.qty * si.unit_cost END) AS cost,
                SUM(CASE WHEN s.kind = 'normal' THEN s.discount ELSE -s.discount END) AS discount,
                COUNT(DISTINCT CASE WHEN s.kind = 'normal' THEN s.id END) AS orders
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.created_at >= ?1 AND s.created_at < ?2
         GROUP BY d ORDER BY d`
      )
      .bind(from, to)
      .all<{ d: string; revenue: number; cost: number; discount: number; orders: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'normal' THEN discount ELSE -discount END), 0) AS net_discount
         FROM sales WHERE created_at >= ?1 AND created_at < ?2`
      )
      .bind(from, to)
      .first<{ net_discount: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(r.fee + r.parts_total), 0) AS revenue,
                COALESCE(SUM(r.discount), 0) AS discount,
                COALESCE(SUM((SELECT COALESCE(SUM(ri.qty * ri.unit_cost), 0) FROM repair_items ri WHERE ri.repair_id = r.id)), 0) AS cost
         FROM repairs r WHERE r.created_at >= ?1 AND r.created_at < ?2`
      )
      .bind(from, to)
      .first<{ n: number; revenue: number; discount: number; cost: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN s.kind = 'normal' THEN si.qty * si.unit_price ELSE -si.qty * si.unit_price END), 0) AS revenue,
                COALESCE(SUM(CASE WHEN s.kind = 'normal' THEN si.qty * si.unit_cost ELSE -si.qty * si.unit_cost END), 0) AS cost
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si.product_id = 0 AND s.created_at >= ?1 AND s.created_at < ?2`
      )
      .bind(from, to)
      .first<{ revenue: number; cost: number }>(),
  ])
  const rows = (byProduct.results ?? []).map((r) => ({
    ...r,
    revenue: round2(r.revenue),
    cost: round2(r.cost),
    profit: round2(r.revenue - r.cost),
  }))
  const gross = rows.reduce((acc, r) => ({ revenue: acc.revenue + r.revenue, cost: acc.cost + r.cost }), { revenue: 0, cost: 0 })
  const netDiscount = round2(discountAgg?.net_discount ?? 0)
  const repNet = round2((repairAgg?.revenue ?? 0) - (repairAgg?.discount ?? 0))
  const repCost = round2(repairAgg?.cost ?? 0)
  // 手填项销售（不入库商品/服务）计入毛利总额，但不出现在按商品明细行中
  const manualRevenue = round2(manualSaleAgg?.revenue ?? 0)
  const manualCost = round2(manualSaleAgg?.cost ?? 0)
  return c.json({
    from,
    to,
    rows,
    daily: daily.results ?? [],
    discount: netDiscount,
    manualSale: { revenue: manualRevenue, cost: manualCost, profit: round2(manualRevenue - manualCost) },
    total: {
      revenue: round2(gross.revenue + manualRevenue),
      cost: round2(gross.cost + manualCost),
      profit: round2(gross.revenue + manualRevenue - gross.cost - manualCost - netDiscount),
    },
    repair: {
      n: repairAgg?.n ?? 0,
      revenue: repNet,
      cost: repCost,
      profit: round2(repNet - repCost),
    },
  })
})

// 进销存汇总：期初 / 采购入库 / 采购退货 / 销售出库 / 销售退货 / 维修领用 / 盘盈 / 盘亏 / 期末
app.get('/reports/summary', async (c) => {
  const db = c.env.DB
  const { from, to } = range(c)
  const [products, ledger] = await Promise.all([
    db.prepare('SELECT id, name, unit, initial_stock, avg_cost FROM products ORDER BY name').all<{
      id: number
      name: string
      unit: string
      initial_stock: number
      avg_cost: number
    }>(),
    loadLedger(db),
  ])
  const blank = () => ({ opening: 0, purchase_in: 0, purchase_return: 0, sale_out: 0, sale_return: 0, repair_out: 0, adjust_in: 0, adjust_out: 0, closing: 0 })
  const map = new Map<number, ReturnType<typeof blank> & { avg_cost: number; unit: string }>()
  for (const p of products.results ?? []) {
    map.set(p.id, { ...blank(), opening: p.initial_stock, closing: p.initial_stock, avg_cost: p.avg_cost, unit: p.unit })
  }
  const SIGN: Record<string, number> = {
    'purchase:normal': 1,
    'purchase:return': -1,
    'sale:normal': -1,
    'sale:return': 1,
    'repair:normal': -1,
    'adjust:': 1,
  }
  for (const m of ledger) {
    const s = map.get(m.product_id)
    if (!s) continue
    const sign = SIGN[`${m.type}:${m.kind}`] ?? 1
    const before = m.created_at < from
    if (m.type === 'purchase') {
      if (m.kind === 'normal') { if (!before) s.purchase_in += m.qty }
      else { if (!before) s.purchase_return += m.qty }
    } else if (m.type === 'sale') {
      if (m.kind === 'normal') { if (!before) s.sale_out += m.qty }
      else { if (!before) s.sale_return += m.qty }
    } else if (m.type === 'repair') {
      if (!before) s.repair_out += m.qty
    } else {
      if (before) s.opening += sign * m.qty
      else if (m.qty >= 0) s.adjust_in += m.qty
      else s.adjust_out += -m.qty
    }
    s.closing = s.opening + s.purchase_in - s.purchase_return - s.sale_out + s.sale_return - s.repair_out + s.adjust_in - s.adjust_out
  }
  const rows = [...map.entries()].map(([product_id, s]) => ({ product_id, ...s }))
  return c.json({ from, to, rows })
})

// 其他收支报表：合计 + 按日 + 明细
app.get('/reports/otherfunds', async (c) => {
  const db = c.env.DB
  const { from, to } = range(c)
  const [totals, daily, list] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense,
                COUNT(*) AS n
         FROM funds WHERE type IN ('income','expense') AND created_at >= ?1 AND created_at < ?2`
      )
      .bind(from, to)
      .first<{ income: number; expense: number; n: number }>(),
    db
      .prepare(
        `SELECT date(created_at) AS d,
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense,
                COUNT(*) AS n
         FROM funds WHERE type IN ('income','expense') AND created_at >= ?1 AND created_at < ?2
         GROUP BY d ORDER BY d`
      )
      .bind(from, to)
      .all<{ d: string; income: number; expense: number; n: number }>(),
    db
      .prepare(
        `SELECT f.*, a.name AS account_name FROM funds f
         LEFT JOIN accounts a ON a.id = f.account_id
         WHERE f.type IN ('income','expense') AND f.created_at >= ?1 AND f.created_at < ?2
         ORDER BY f.created_at DESC LIMIT 500`
      )
      .bind(from, to)
      .all(),
  ])
  return c.json({
    income: round2(totals?.income ?? 0),
    expense: round2(totals?.expense ?? 0),
    n: totals?.n ?? 0,
    daily: daily.results ?? [],
    list: list.results ?? [],
  })
})

app.get('/dashboard', async (c) => {
  const db = c.env.DB
  const { from, to } = range(c)
  const [salesAgg, discountAgg, purchaseAgg, money, counts, recentSales, recentPurchases, lowStock] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN s.kind = 'normal' THEN s.id END) AS orders,
                COALESCE(SUM(CASE WHEN s.kind = 'normal' THEN si.qty * si.unit_price ELSE -si.qty * si.unit_price END), 0) AS gross,
                COALESCE(SUM(CASE WHEN s.kind = 'normal' THEN si.qty * si.unit_cost ELSE -si.qty * si.unit_cost END), 0) AS cost
         FROM sales s JOIN sale_items si ON si.sale_id = s.id
         WHERE s.created_at >= ?1 AND s.created_at < ?2`
      )
      .bind(from, to)
      .first<{ orders: number; gross: number; cost: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'normal' THEN discount ELSE -discount END), 0) AS net_discount
         FROM sales WHERE created_at >= ?1 AND created_at < ?2`
      )
      .bind(from, to)
      .first<{ net_discount: number }>(),
    db
      .prepare(
        `SELECT COUNT(CASE WHEN kind = 'normal' THEN 1 END) AS orders,
                COALESCE(SUM(CASE WHEN kind = 'normal' THEN total - discount ELSE -(total - discount) END), 0) AS total
         FROM purchases WHERE created_at >= ?1 AND created_at < ?2`
      )
      .bind(from, to)
      .first<{ orders: number; total: number }>(),
    db
      .prepare(
        `SELECT
          (SELECT COALESCE(SUM(balance), 0) FROM accounts) AS account_total,
          (SELECT COALESCE(SUM(debt), 0) FROM parties WHERE type = 'customer') AS customer_debt,
          (SELECT COALESCE(SUM(debt), 0) FROM parties WHERE type = 'supplier') AS supplier_debt,
          (SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) FROM funds WHERE created_at >= ?1 AND created_at < ?2) AS other_income,
          (SELECT COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) FROM funds WHERE created_at >= ?1 AND created_at < ?2) AS other_expense`
      )
      .bind(from, to)
      .first<{
        account_total: number
        customer_debt: number
        supplier_debt: number
        other_income: number
        other_expense: number
      }>(),
    db
      .prepare('SELECT (SELECT COUNT(*) FROM products WHERE archived = 0) AS products, (SELECT COUNT(*) FROM parties) AS parties, (SELECT COUNT(*) FROM accounts) AS accounts')
      .first<{ products: number; parties: number; accounts: number }>(),
    db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT 5').all(),
    db.prepare('SELECT * FROM purchases ORDER BY id DESC LIMIT 5').all(),
    db
      .prepare('SELECT id, name, unit, stock, low_stock FROM products WHERE low_stock > 0 AND stock <= low_stock AND archived = 0 ORDER BY stock LIMIT 20')
      .all(),
  ])
  const gross = round2(salesAgg?.gross ?? 0)
  const cost = round2(salesAgg?.cost ?? 0)
  const discount = round2(discountAgg?.net_discount ?? 0)
  return c.json({
    sales: { orders: salesAgg?.orders ?? 0, revenue: gross, discount, cost, profit: round2(gross - cost - discount) },
    purchases: { orders: purchaseAgg?.orders ?? 0, total: round2(purchaseAgg?.total ?? 0) },
    money: {
      accountTotal: round2(money?.account_total ?? 0),
      customerDebt: round2(money?.customer_debt ?? 0),
      supplierDebt: round2(money?.supplier_debt ?? 0),
      otherNet: round2((money?.other_income ?? 0) - (money?.other_expense ?? 0)),
    },
    lowStock: lowStock.results ?? [],
    counts: counts ?? { products: 0, parties: 0, accounts: 0 },
    recentSales: recentSales.results ?? [],
    recentPurchases: recentPurchases.results ?? [],
  })
})

export default app
