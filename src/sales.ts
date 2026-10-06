import { Hono } from 'hono'
import { recomputeAll, round2 } from './db'

const app = new Hono<{ Bindings: Env }>()

type ItemInput = { product_id?: number; qty?: number; unit_price?: number }

// 修改销售单：更新表头与明细，库存/欠款/余额按全部流水重算
app.put('/sales/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const sale = await db.prepare('SELECT id, kind FROM sales WHERE id = ?1').bind(id).first<{ id: number; kind: string }>()
  if (!sale) return c.json({ error: '销售单不存在' }, 404)
  if (sale.kind === 'return') return c.json({ error: '退货单不支持修改，可删除后重新开具' }, 422)

  const b = await c.req.json<{
    customer_id?: number | null
    customer_name?: string
    note?: string
    discount?: number
    paid?: number
    account_id?: number | null
    items?: ItemInput[]
  }>()
  const items = (b.items ?? []).filter((it) => Number(it.qty) > 0)
  if (!items.length) return c.json({ error: '至少需要一条明细' }, 422)

  const ids = [...new Set(items.map((it) => Number(it.product_id)))]
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) return c.json({ error: '明细中商品不合法' }, 422)
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
  const found = await db
    .prepare(`SELECT id, name, stock, no_stock FROM products WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: number; name: string; stock: number; no_stock: number }>()
  const map = new Map((found.results ?? []).map((p) => [p.id, p]))

  // 库存校验：本单原有出库量先"还回"，新数量不能超过剩余可用
  const old = await db.prepare('SELECT product_id, qty FROM sale_items WHERE sale_id = ?1').bind(id).all<{ product_id: number; qty: number }>()
  const oldQty = new Map<number, number>()
  for (const it of old.results ?? []) oldQty.set(it.product_id, (oldQty.get(it.product_id) || 0) + Number(it.qty))

  const costMap = await db
    .prepare(`SELECT id, avg_cost FROM products WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: number; avg_cost: number }>()
  const costOf = new Map((costMap.results ?? []).map((p) => [p.id, p.avg_cost]))

  for (const it of items) {
    const p = map.get(Number(it.product_id))
    if (!p) return c.json({ error: '明细中存在不存在的商品' }, 422)
    const price = Number(it.unit_price)
    if (!Number.isFinite(price) || price < 0) return c.json({ error: '销售单价不能为负数' }, 422)
    if (!p.no_stock) {
      const available = p.stock + (oldQty.get(Number(it.product_id)) || 0)
      if (available < Number(it.qty)) {
        return c.json({ error: `「${p.name}」库存不足：现有 ${p.stock}（含本单已出 ${oldQty.get(Number(it.product_id)) || 0}），需出库 ${Number(it.qty)}` }, 422)
      }
    }
  }

  const total = round2(items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_price), 0))
  const discount = Math.min(Math.max(0, Number(b.discount) || 0), total)
  const net = round2(total - discount)
  let paid = 0
  if (Number(b.paid) > 0) {
    if (!b.account_id) return c.json({ error: '已收款需选择结算账户' }, 422)
    const acc = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(Number(b.account_id)).first()
    if (!acc) return c.json({ error: '结算账户不存在' }, 422)
    paid = Math.min(Math.max(0, Number(b.paid)), net)
  }

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE sales SET customer_id = ?1, customer_name = ?2, total = ?3, discount = ?4, paid = ?5, account_id = ?6, note = ?7 WHERE id = ?8`
      )
      .bind(
        b.customer_id ?? null,
        (b.customer_name ?? '').trim(),
        total,
        discount,
        paid,
        b.account_id ?? null,
        (b.note ?? '').trim(),
        id
      ),
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?1').bind(id),
    ...items.map((it) =>
      db
        .prepare(
          `INSERT INTO sale_items (sale_id, product_id, qty, unit_price, unit_cost) VALUES (?1, ?2, ?3, ?4, ?5)`
        )
        .bind(id, Number(it.product_id), Number(it.qty), Number(it.unit_price), costOf.get(Number(it.product_id)) ?? 0)
    ),
  ]
  await db.batch(stmts)
  await recomputeAll(db)
  const updated = await db.prepare('SELECT * FROM sales WHERE id = ?1').bind(id).first()
  return c.json(updated)
})

app.get('/sales', async (c) => {
  const limit = Math.min(500, Number(c.req.query('limit')) || 100)
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)
  const kind = c.req.query('kind') === 'return' ? 'return' : c.req.query('kind') === 'normal' ? 'normal' : ''
  const from = (c.req.query('from') || '').trim()
  const to = (c.req.query('to') || '').trim()
  const conds: string[] = []
  const binds: unknown[] = []
  if (kind) { conds.push(`s.kind = ?${binds.length + 1}`); binds.push(kind) }
  // created_at 为定宽 ISO 文本，字符串比较即时间比较
  if (from) { conds.push(`s.created_at >= ?${binds.length + 1}`); binds.push(from) }
  if (to) { conds.push(`s.created_at < ?${binds.length + 1}`); binds.push(to) }
  binds.push(limit, offset)
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const res = await c.env.DB
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
       FROM sales s ${where} ORDER BY s.id DESC LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`
    )
    .bind(...binds)
    .all()
  return c.json(res.results ?? [])
})

app.get('/sales/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const sale = await db
    .prepare(
      `SELECT s.*, p.phone AS customer_phone, p.address AS customer_address, p.contact_man AS customer_contact_man
       FROM sales s
       LEFT JOIN parties p ON p.id = s.customer_id
       WHERE s.id = ?1`
    )
    .bind(id)
    .first()
  if (!sale) return c.json({ error: '销售单不存在' }, 404)
  const items = await db
    .prepare(
      `SELECT si.*, p.name AS product_name, p.sku, p.unit
       FROM sale_items si JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = ?1 ORDER BY si.id`
    )
    .bind(id)
    .all()
  return c.json({ ...sale, items: items.results ?? [] })
})

// kind=normal 销售出库；kind=return 销售退货（库存回仓，负收入，冲欠款或退账户）
app.post('/sales', async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{
    kind?: string
    customer_id?: number | null
    customer_name?: string
    note?: string
    discount?: number
    paid?: number
    account_id?: number | null
    refund_way?: string
    items?: ItemInput[]
  }>()
  const kind = b.kind === 'return' ? 'return' : 'normal'
  const items = (b.items ?? []).filter((it) => Number(it.qty) > 0)
  if (!items.length) return c.json({ error: '至少需要一条明细' }, 422)

  const ids = [...new Set(items.map((it) => Number(it.product_id)))]
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) return c.json({ error: '明细中商品不合法' }, 422)
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
  const found = await db
    .prepare(`SELECT id, name, stock, avg_cost, sale_price, no_stock FROM products WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: number; name: string; stock: number; avg_cost: number; sale_price: number; no_stock: number }>()
  const map = new Map((found.results ?? []).map((p) => [p.id, p]))
  for (const it of items) {
    const p = map.get(Number(it.product_id))
    if (!p) return c.json({ error: '明细中存在不存在的商品' }, 422)
    const price = Number(it.unit_price)
    if (!Number.isFinite(price) || price < 0) return c.json({ error: '销售单价不能为负数' }, 422)
    if (kind === 'normal' && !p.no_stock && p.stock < Number(it.qty)) {
      return c.json({ error: `「${p.name}」库存不足：现有 ${p.stock}，需出库 ${Number(it.qty)}` }, 422)
    }
  }

  const total = round2(items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_price), 0))
  const discount = Math.min(Math.max(0, Number(b.discount) || 0), total)
  const net = round2(total - discount)
  let paid = 0
  let refundWay = ''
  if (kind === 'normal') {
    paid = Math.min(Math.max(0, Number(b.paid) || 0), net)
    if (paid > 0) {
      if (!b.account_id) return c.json({ error: '已收款需选择结算账户' }, 422)
      const acc = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(Number(b.account_id)).first()
      if (!acc) return c.json({ error: '结算账户不存在' }, 422)
    }
  } else {
    refundWay = b.refund_way === 'account' ? 'account' : 'debt'
    if (refundWay === 'account') {
      if (!b.account_id) return c.json({ error: '退款需选择结算账户' }, 422)
      const acc = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(Number(b.account_id)).first()
      if (!acc) return c.json({ error: '结算账户不存在' }, 422)
    }
  }

  // 单据内的资金变动直接增量更新（删除单据时走全量重算）
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO sales (kind, customer_id, customer_name, total, discount, paid, account_id, refund_way, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        kind,
        b.customer_id ?? null,
        (b.customer_name ?? '').trim(),
        total,
        discount,
        paid,
        b.account_id ?? null,
        refundWay,
        (b.note ?? '').trim()
      ),
    ...items.map((it) => {
      const p = map.get(Number(it.product_id))!
      return db
        .prepare(
          `INSERT INTO sale_items (sale_id, product_id, qty, unit_price, unit_cost)
           VALUES ((SELECT MAX(id) FROM sales), ?1, ?2, ?3, ?4)`
        )
        .bind(Number(it.product_id), Number(it.qty), Number(it.unit_price), p.avg_cost)
    }),
    ...items
      .filter((it) => !map.get(Number(it.product_id))!.no_stock)
      .map((it) =>
        db
          .prepare(`UPDATE products SET stock = stock + ?1 WHERE id = ?2`)
          .bind(kind === 'return' ? Number(it.qty) : -Number(it.qty), Number(it.product_id))
      ),
  ]
  if (kind === 'normal' && paid > 0) {
    stmts.push(db.prepare('UPDATE accounts SET balance = balance + ?1 WHERE id = ?2').bind(paid, Number(b.account_id)))
  }
  if (kind === 'return' && refundWay === 'account') {
    stmts.push(db.prepare('UPDATE accounts SET balance = balance - ?1 WHERE id = ?2').bind(net, Number(b.account_id)))
  }
  if (b.customer_id) {
    if (kind === 'normal') {
      stmts.push(db.prepare('UPDATE parties SET debt = debt + ?1 WHERE id = ?2').bind(net - paid, Number(b.customer_id)))
    } else if (refundWay === 'debt') {
      stmts.push(db.prepare('UPDATE parties SET debt = debt - ?1 WHERE id = ?2').bind(net, Number(b.customer_id)))
    }
  }
  await db.batch(stmts)
  const created = await db.prepare('SELECT * FROM sales WHERE id = (SELECT MAX(id) FROM sales)').first()
  return c.json(created, 201)
})

app.delete('/sales/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const exists = await db.prepare('SELECT 1 AS x FROM sales WHERE id = ?1').bind(id).first()
  if (!exists) return c.json({ error: '销售单不存在' }, 404)
  await db.batch([
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?1').bind(id),
    db.prepare('DELETE FROM sales WHERE id = ?1').bind(id),
  ])
  await recomputeAll(db)
  return c.json({ ok: true })
})

export default app
