import { Hono } from 'hono'
import { recomputeAll, round2 } from './db'

const app = new Hono<{ Bindings: Env }>()

type ItemInput = { product_id?: number; qty?: number; unit_cost?: number }

// 修改采购单：更新表头与明细，库存/均价/欠款/余额按全部流水重算
app.put('/purchases/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const pu = await db.prepare('SELECT id, kind FROM purchases WHERE id = ?1').bind(id).first<{ id: number; kind: string }>()
  if (!pu) return c.json({ error: '采购单不存在' }, 404)
  if (pu.kind === 'return') return c.json({ error: '退货单不支持修改，可删除后重新开具' }, 422)

  const b = await c.req.json<{
    supplier_id?: number | null
    supplier_name?: string
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
    .prepare(`SELECT id, name, no_stock FROM products WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: number; name: string; no_stock: number }>()
  const map = new Map((found.results ?? []).map((p) => [p.id, p]))
  for (const it of items) {
    const p = map.get(Number(it.product_id))
    if (!p) return c.json({ error: '明细中存在不存在的商品' }, 422)
    if (p.no_stock) return c.json({ error: `「${p.name}」是服务类商品，不参与采购入库` }, 422)
    const cost = Number(it.unit_cost)
    if (!Number.isFinite(cost) || cost < 0) return c.json({ error: '采购单价不能为负数' }, 422)
  }

  const total = round2(items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_cost), 0))
  const discount = Math.min(Math.max(0, Number(b.discount) || 0), total)
  const net = round2(total - discount)
  let paid = 0
  if (Number(b.paid) > 0) {
    if (!b.account_id) return c.json({ error: '已付款需选择结算账户' }, 422)
    const acc = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(Number(b.account_id)).first()
    if (!acc) return c.json({ error: '结算账户不存在' }, 422)
    paid = Math.min(Math.max(0, Number(b.paid)), net)
  }

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE purchases SET supplier_id = ?1, supplier_name = ?2, total = ?3, discount = ?4, paid = ?5, account_id = ?6, note = ?7 WHERE id = ?8`
      )
      .bind(
        b.supplier_id ?? null,
        (b.supplier_name ?? '').trim(),
        total,
        discount,
        paid,
        b.account_id ?? null,
        (b.note ?? '').trim(),
        id
      ),
    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?1').bind(id),
    ...items.map((it) =>
      db
        .prepare(`INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost) VALUES (?1, ?2, ?3, ?4)`)
        .bind(id, Number(it.product_id), Number(it.qty), Number(it.unit_cost))
    ),
  ]
  await db.batch(stmts)
  await recomputeAll(db)
  const updated = await db.prepare('SELECT * FROM purchases WHERE id = ?1').bind(id).first()
  return c.json(updated)
})

app.get('/purchases', async (c) => {
  const limit = Math.min(500, Number(c.req.query('limit')) || 100)
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)
  const kind = c.req.query('kind') === 'return' ? 'return' : c.req.query('kind') === 'normal' ? 'normal' : ''
  const where = kind ? 'WHERE pu.kind = ?3' : ''
  const binds = kind ? [limit, offset, kind] : [limit, offset]
  const res = await c.env.DB
    .prepare(
      `SELECT pu.*, (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS item_count
       FROM purchases pu ${where} ORDER BY pu.id DESC LIMIT ?1 OFFSET ?2`
    )
    .bind(...binds)
    .all()
  return c.json(res.results ?? [])
})

app.get('/purchases/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const purchase = await db
    .prepare(
      `SELECT pu.*, p.phone AS supplier_phone, p.address AS supplier_address, p.contact_man AS supplier_contact_man
       FROM purchases pu
       LEFT JOIN parties p ON p.id = pu.supplier_id
       WHERE pu.id = ?1`
    )
    .bind(id)
    .first()
  if (!purchase) return c.json({ error: '采购单不存在' }, 404)
  const items = await db
    .prepare(
      `SELECT pi.*, p.name AS product_name, p.sku, p.unit
       FROM purchase_items pi JOIN products p ON p.id = pi.product_id
       WHERE pi.purchase_id = ?1 ORDER BY pi.id`
    )
    .bind(id)
    .all()
  return c.json({ ...purchase, items: items.results ?? [] })
})

// kind=normal 采购入库；kind=return 采购退货（库存退出，冲供应商欠款或退回账户）
app.post('/purchases', async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{
    kind?: string
    supplier_id?: number | null
    supplier_name?: string
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
    .prepare(`SELECT id, name, stock, avg_cost, no_stock FROM products WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: number; name: string; stock: number; avg_cost: number; no_stock: number }>()
  const map = new Map((found.results ?? []).map((p) => [p.id, p]))
  for (const it of items) {
    const p = map.get(Number(it.product_id))
    if (!p) return c.json({ error: '明细中存在不存在的商品' }, 422)
    if (p.no_stock) return c.json({ error: `「${p.name}」是服务类商品，不参与采购入库；服务支出请用「资金 → 其他支出」` }, 422)
    const cost = Number(it.unit_cost)
    if (!Number.isFinite(cost) || cost < 0) return c.json({ error: '采购单价不能为负数' }, 422)
    if (kind === 'return' && p.stock < Number(it.qty)) {
      return c.json({ error: `「${p.name}」库存不足：现有 ${p.stock}，需退回 ${Number(it.qty)}` }, 422)
    }
  }

  const total = round2(items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_cost), 0))
  const discount = Math.min(Math.max(0, Number(b.discount) || 0), total)
  const net = round2(total - discount)
  let paid = 0
  let refundWay = ''
  if (kind === 'normal') {
    paid = Math.min(Math.max(0, Number(b.paid) || 0), net)
    if (paid > 0) {
      if (!b.account_id) return c.json({ error: '已付款需选择结算账户' }, 422)
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

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO purchases (kind, supplier_id, supplier_name, total, discount, paid, account_id, refund_way, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        kind,
        b.supplier_id ?? null,
        (b.supplier_name ?? '').trim(),
        total,
        discount,
        paid,
        b.account_id ?? null,
        refundWay,
        (b.note ?? '').trim()
      ),
    ...items.map((it) =>
      db
        .prepare(
          `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost)
           VALUES ((SELECT MAX(id) FROM purchases), ?1, ?2, ?3)`
        )
        .bind(Number(it.product_id), Number(it.qty), Number(it.unit_cost))
    ),
    ...items.map((it) =>
      kind === 'normal'
        ? // 单条语句内同时加库存与重算均价（右侧取旧值）；手动锁定成本的商品只加库存
          db
            .prepare(
              `UPDATE products SET stock = stock + ?1,
                 avg_cost = CASE WHEN cost_manual = 1 THEN avg_cost
                                 ELSE (stock * avg_cost + ?1 * ?2) / (stock + ?1) END
               WHERE id = ?3`
            )
            .bind(Number(it.qty), Number(it.unit_cost), Number(it.product_id))
        : db
            .prepare('UPDATE products SET stock = stock - ?1 WHERE id = ?2')
            .bind(Number(it.qty), Number(it.product_id))
    ),
  ]
  if (kind === 'normal' && paid > 0) {
    stmts.push(db.prepare('UPDATE accounts SET balance = balance - ?1 WHERE id = ?2').bind(paid, Number(b.account_id)))
  }
  if (kind === 'return' && refundWay === 'account') {
    stmts.push(db.prepare('UPDATE accounts SET balance = balance + ?1 WHERE id = ?2').bind(net, Number(b.account_id)))
  }
  if (b.supplier_id) {
    if (kind === 'normal') {
      stmts.push(db.prepare('UPDATE parties SET debt = debt + ?1 WHERE id = ?2').bind(net - paid, Number(b.supplier_id)))
    } else if (refundWay === 'debt') {
      stmts.push(db.prepare('UPDATE parties SET debt = debt - ?1 WHERE id = ?2').bind(net, Number(b.supplier_id)))
    }
  }
  await db.batch(stmts)
  const created = await db.prepare('SELECT * FROM purchases WHERE id = (SELECT MAX(id) FROM purchases)').first()
  return c.json(created, 201)
})

app.delete('/purchases/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const exists = await db.prepare('SELECT 1 AS x FROM purchases WHERE id = ?1').bind(id).first()
  if (!exists) return c.json({ error: '采购单不存在' }, 404)
  await db.batch([
    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?1').bind(id),
    db.prepare('DELETE FROM purchases WHERE id = ?1').bind(id),
  ])
  await recomputeAll(db)
  return c.json({ ok: true })
})

export default app
