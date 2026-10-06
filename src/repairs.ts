import { Hono } from 'hono'
import { recomputeAll, round2, docDateToISO } from './db'

const app = new Hono<{ Bindings: Env }>()

type ItemInput = { product_id?: number; name?: string; qty?: number; unit_price?: number; unit_cost?: number }

// 列表：支持日期范围与状态筛选（日期为 UTC ISO 边界，created_at 定宽文本直接比较）
app.get('/repairs', async (c) => {
  const from = (c.req.query('from') || '').trim()
  const to = (c.req.query('to') || '').trim()
  const status = (c.req.query('status') || '').trim()
  const conds: string[] = []
  const binds: unknown[] = []
  if (status) { conds.push(`r.status = ?${binds.length + 1}`); binds.push(status) }
  if (from) { conds.push(`r.created_at >= ?${binds.length + 1}`); binds.push(from) }
  if (to) { conds.push(`r.created_at < ?${binds.length + 1}`); binds.push(to) }
  binds.push(500)
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const res = await c.env.DB
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM repair_items ri WHERE ri.repair_id = r.id) AS item_count
       FROM repairs r ${where} ORDER BY r.id DESC LIMIT ?${binds.length}`
    )
    .bind(...binds)
    .all()
  return c.json(res.results ?? [])
})

app.get('/repairs/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const repair = await db.prepare('SELECT * FROM repairs WHERE id = ?1').bind(id).first()
  if (!repair) return c.json({ error: '维修单不存在' }, 404)
  const items = await db
    .prepare(
      `SELECT ri.*, CASE WHEN ri.product_id = 0 THEN ri.name ELSE p.name END AS product_name FROM repair_items ri
       LEFT JOIN products p ON p.id = ri.product_id WHERE ri.repair_id = ?1 ORDER BY ri.id`
    )
    .bind(id)
    .all()
  return c.json({ ...repair, items: items.results ?? [] })
})

// 新建维修单：配件领用扣库存（快照成本），已收款进账户，未收款挂客户欠款
app.post('/repairs', async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{
    customer_id?: number | null
    customer_name?: string
    phone?: string
    device?: string
    fault?: string
    fee?: number
    discount?: number
    paid?: number
    account_id?: number | null
    note?: string
    doc_date?: string
    items?: ItemInput[]
  }>()
  const allItems = (b.items ?? []).filter((it) => Number(it.qty) > 0)
  // 手填件：无 product_id 但有名称（未入库商品/拆机件，不动库存）
  const manualItems = allItems.filter((it) => !Number(it.product_id))
  const stockItems = allItems.filter((it) => Number(it.product_id))
  for (const it of manualItems) {
    if (!(it.name ?? '').trim()) return c.json({ error: '手填配件需要填写名称' }, 422)
    const price = Number(it.unit_price)
    if (!Number.isFinite(price) || price < 0) return c.json({ error: '配件单价不能为负数' }, 422)
    const cost = Number(it.unit_cost)
    if (Number.isFinite(cost) && cost < 0) return c.json({ error: '配件成本不能为负数' }, 422)
  }
  const ids = [...new Set(stockItems.map((it) => Number(it.product_id)))]
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) return c.json({ error: '维修配件不合法' }, 422)

  let map = new Map<number, { id: number; stock: number; avg_cost: number; sale_price: number; no_stock: number; name: string }>()
  if (ids.length) {
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
    const found = await db
      .prepare(`SELECT id, name, stock, avg_cost, sale_price, no_stock FROM products WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<{ id: number; name: string; stock: number; avg_cost: number; sale_price: number; no_stock: number }>()
    map = new Map((found.results ?? []).map((p) => [p.id, p]))
  }
  for (const it of stockItems) {
    const p = map.get(Number(it.product_id))
    if (!p) return c.json({ error: '明细中存在不存在的商品' }, 422)
    const price = Number(it.unit_price)
    if (!Number.isFinite(price) || price < 0) return c.json({ error: '配件单价不能为负数' }, 422)
    if (!p.no_stock && p.stock < Number(it.qty)) {
      return c.json({ error: `「${p.name}」库存不足：现有 ${p.stock}，需领用 ${Number(it.qty)}` }, 422)
    }
  }
  const items = allItems

  const fee = Math.max(0, Number(b.fee) || 0)
  const partsTotal = round2(items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_price), 0))
  const net = round2(fee + partsTotal)
  const discount = Math.min(Math.max(0, Number(b.discount) || 0), net)
  const paid = Math.min(Math.max(0, Number(b.paid) || 0), round2(net - discount))
  if (paid > 0 && !b.account_id) return c.json({ error: '已收款需选择结算账户' }, 422)
  if (paid > 0) {
    const acc = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(Number(b.account_id)).first()
    if (!acc) return c.json({ error: '结算账户不存在' }, 422)
  }

  const createdAt = docDateToISO(b.doc_date)
  const repairInsert = createdAt
    ? db
        .prepare(
          `INSERT INTO repairs (status, customer_id, customer_name, phone, device, fault, fee, parts_total, discount, paid, account_id, note, created_at)
           VALUES ('repairing', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
        )
        .bind(
          b.customer_id ?? null,
          (b.customer_name ?? '').trim(),
          (b.phone ?? '').trim(),
          (b.device ?? '').trim(),
          (b.fault ?? '').trim(),
          fee,
          partsTotal,
          discount,
          paid,
          b.account_id ?? null,
          (b.note ?? '').trim(),
          createdAt
        )
    : db
        .prepare(
          `INSERT INTO repairs (status, customer_id, customer_name, phone, device, fault, fee, parts_total, discount, paid, account_id, note)
           VALUES ('repairing', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
        )
        .bind(
          b.customer_id ?? null,
          (b.customer_name ?? '').trim(),
          (b.phone ?? '').trim(),
          (b.device ?? '').trim(),
          (b.fault ?? '').trim(),
          fee,
          partsTotal,
          discount,
          paid,
          b.account_id ?? null,
          (b.note ?? '').trim()
        )

  const stmts: D1PreparedStatement[] = [
    repairInsert,
    ...items.map((it) => {
      if (!Number(it.product_id)) {
        return db
          .prepare(
            `INSERT INTO repair_items (repair_id, product_id, name, qty, unit_price, unit_cost)
             VALUES ((SELECT MAX(id) FROM repairs), 0, ?1, ?2, ?3, ?4)`
          )
          .bind((it.name ?? '').trim(), Number(it.qty), Number(it.unit_price), Math.max(0, Number(it.unit_cost) || 0))
      }
      const p = map.get(Number(it.product_id))!
      return db
        .prepare(
          `INSERT INTO repair_items (repair_id, product_id, name, qty, unit_price, unit_cost)
           VALUES ((SELECT MAX(id) FROM repairs), ?1, '', ?2, ?3, ?4)`
        )
        .bind(Number(it.product_id), Number(it.qty), Number(it.unit_price), p.avg_cost)
    }),
    ...stockItems
      .filter((it) => !map.get(Number(it.product_id))!.no_stock)
      .map((it) =>
        db
          .prepare(`UPDATE products SET stock = stock - ?1 WHERE id = ?2`)
          .bind(Number(it.qty), Number(it.product_id))
      ),
  ]
  if (paid > 0 && b.account_id) {
    stmts.push(db.prepare('UPDATE accounts SET balance = balance + ?1 WHERE id = ?2').bind(paid, Number(b.account_id)))
  }
  if (b.customer_id) {
    stmts.push(db.prepare('UPDATE parties SET debt = debt + ?1 WHERE id = ?2').bind(round2(net - discount - paid), Number(b.customer_id)))
  }
  await db.batch(stmts)
  const created = await db.prepare('SELECT * FROM repairs WHERE id = (SELECT MAX(id) FROM repairs)').first()
  return c.json(created, 201)
})

// 修改维修单：表头与明细整体替换，库存/欠款/余额按全部流水重算
app.put('/repairs/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const exists = await db.prepare('SELECT id FROM repairs WHERE id = ?1').bind(id).first()
  if (!exists) return c.json({ error: '维修单不存在' }, 404)

  const b = await c.req.json<{
    customer_id?: number | null
    customer_name?: string
    phone?: string
    device?: string
    fault?: string
    fee?: number
    discount?: number
    paid?: number
    account_id?: number | null
    note?: string
    doc_date?: string
    items?: ItemInput[]
  }>()
  const allItems = (b.items ?? []).filter((it) => Number(it.qty) > 0)
  const manualItems = allItems.filter((it) => !Number(it.product_id))
  const stockItems = allItems.filter((it) => Number(it.product_id))
  for (const it of manualItems) {
    if (!(it.name ?? '').trim()) return c.json({ error: '手填配件需要填写名称' }, 422)
    const price = Number(it.unit_price)
    if (!Number.isFinite(price) || price < 0) return c.json({ error: '配件单价不能为负数' }, 422)
    const cost = Number(it.unit_cost)
    if (Number.isFinite(cost) && cost < 0) return c.json({ error: '配件成本不能为负数' }, 422)
  }
  const ids = [...new Set(stockItems.map((it) => Number(it.product_id)))]
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) return c.json({ error: '维修配件不合法' }, 422)

  let map = new Map<number, { id: number; avg_cost: number; no_stock: number; name: string }>()
  if (ids.length) {
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(',')
    const found = await db
      .prepare(`SELECT id, name, avg_cost, no_stock FROM products WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<{ id: number; name: string; avg_cost: number; no_stock: number }>()
    map = new Map((found.results ?? []).map((p) => [p.id, p]))
  }
  for (const it of stockItems) {
    const p = map.get(Number(it.product_id))
    if (!p) return c.json({ error: '明细中存在不存在的商品' }, 422)
    const price = Number(it.unit_price)
    if (!Number.isFinite(price) || price < 0) return c.json({ error: '配件单价不能为负数' }, 422)
  }
  const items = allItems

  const fee = Math.max(0, Number(b.fee) || 0)
  const partsTotal = round2(items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_price), 0))
  const net = round2(fee + partsTotal)
  const discount = Math.min(Math.max(0, Number(b.discount) || 0), net)
  const paid = Math.min(Math.max(0, Number(b.paid) || 0), round2(net - discount))
  if (paid > 0 && !b.account_id) return c.json({ error: '已收款需选择结算账户' }, 422)

  const newDate = docDateToISO(b.doc_date)
  const headVals = [
    b.customer_id ?? null,
    (b.customer_name ?? '').trim(),
    (b.phone ?? '').trim(),
    (b.device ?? '').trim(),
    (b.fault ?? '').trim(),
    fee,
    partsTotal,
    discount,
    paid,
    b.account_id ?? null,
    (b.note ?? '').trim(),
    id,
  ]
  const repairUpdate = db
    .prepare(
      `UPDATE repairs SET customer_id = ?1, customer_name = ?2, phone = ?3, device = ?4, fault = ?5,
       fee = ?6, parts_total = ?7, discount = ?8, paid = ?9, account_id = ?10, note = ?11${newDate ? ', created_at = ?13' : ''} WHERE id = ?12`
    )
    .bind(...(newDate ? [...headVals, newDate] : headVals))

  const stmts: D1PreparedStatement[] = [
    repairUpdate,
    db.prepare('DELETE FROM repair_items WHERE repair_id = ?1').bind(id),
    ...items.map((it) => {
      if (!Number(it.product_id)) {
        return db
          .prepare(
            `INSERT INTO repair_items (repair_id, product_id, name, qty, unit_price, unit_cost)
             VALUES (?1, 0, ?2, ?3, ?4, ?5)`
          )
          .bind(id, (it.name ?? '').trim(), Number(it.qty), Number(it.unit_price), Math.max(0, Number(it.unit_cost) || 0))
      }
      const p = map.get(Number(it.product_id))!
      return db
        .prepare(
          `INSERT INTO repair_items (repair_id, product_id, name, qty, unit_price, unit_cost)
           VALUES (?1, ?2, '', ?3, ?4, ?5)`
        )
        .bind(id, Number(it.product_id), Number(it.qty), Number(it.unit_price), p.avg_cost)
    }),
  ]
  await db.batch(stmts)
  await recomputeAll(db)
  const updated = await db.prepare('SELECT * FROM repairs WHERE id = ?1').bind(id).first()
  return c.json(updated)
})

// 状态流转：repairing 维修中 → done 已完成 → closed 已取机（不影响金额与库存）
app.post('/repairs/:id/status', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const b = await c.req.json<{ status?: string }>()
  const status = b.status ?? ''
  if (!['repairing', 'done', 'closed'].includes(status)) return c.json({ error: '无效的状态' }, 422)
  const res = await db.prepare('UPDATE repairs SET status = ?1 WHERE id = ?2').bind(status, id).run()
  if (!res.success) return c.json({ error: '更新失败' }, 500)
  return c.json({ ok: true })
})

app.delete('/repairs/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const exists = await db.prepare('SELECT 1 AS x FROM repairs WHERE id = ?1').bind(id).first()
  if (!exists) return c.json({ error: '维修单不存在' }, 404)
  await db.batch([
    db.prepare('DELETE FROM repair_items WHERE repair_id = ?1').bind(id),
    db.prepare('DELETE FROM repairs WHERE id = ?1').bind(id),
  ])
  await recomputeAll(db)
  return c.json({ ok: true })
})

export default app
