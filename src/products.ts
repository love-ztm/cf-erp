import { Hono } from 'hono'
import { recomputeAll } from './db'

const app = new Hono<{ Bindings: Env }>()

// 商品列表（含流水存在性，用于删除保护）
app.get('/products', async (c) => {
  const db = c.env.DB
  const res = await db
    .prepare(
      `SELECT p.*,
        EXISTS(SELECT 1 FROM purchase_items pi WHERE pi.product_id = p.id) AS has_purchase,
        EXISTS(SELECT 1 FROM sale_items si WHERE si.product_id = p.id) AS has_sale,
        EXISTS(SELECT 1 FROM adjustments a WHERE a.product_id = p.id) AS has_adjust
       FROM products p ORDER BY p.id DESC`
    )
    .all()
  return c.json(res.results ?? [])
})

app.post('/products', async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{
    name?: string
    sku?: string
    barcode?: string
    category?: string
    unit?: string
    initial_stock?: number
    initial_cost?: number
    sale_price?: number
    low_stock?: number
    no_stock?: boolean
  }>()
  const name = (b.name ?? '').trim()
  if (!name) return c.json({ error: '商品名称不能为空' }, 422)
  const n = (v: unknown, d = 0) => {
    const x = Number(v)
    return Number.isFinite(x) && x >= 0 ? x : d
  }
  const noStock = b.no_stock ? 1 : 0
  const initial_stock = noStock ? 0 : n(b.initial_stock)
  const initial_cost = n(b.initial_cost)
  // 编号留空时自动顺排（当前最大数字编号 + 1）
  let sku = (b.sku ?? '').trim()
  if (!sku) {
    const rows = await db.prepare('SELECT sku FROM products').all<{ sku: string | null }>()
    let max = 0
    for (const r of rows.results ?? []) {
      const s = String(r.sku ?? '').trim()
      if (/^\d{1,9}$/.test(s)) max = Math.max(max, parseInt(s, 10))
    }
    sku = String(max + 1)
  }
  const res = await db
    .prepare(
      `INSERT INTO products (name, sku, barcode, category, unit, stock, avg_cost, initial_stock, initial_cost, sale_price, low_stock, no_stock)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?7, ?8, ?9, ?10)`
    )
    .bind(
      name,
      sku,
      (b.barcode ?? '').trim(),
      (b.category ?? '').trim(),
      (b.unit ?? '件').trim() || '件',
      initial_stock,
      initial_cost,
      n(b.sale_price),
      noStock ? 0 : n(b.low_stock),
      noStock
    )
    .run()
  return c.json({ id: res.meta.last_row_id }, 201)
})

// 仅允许编辑展示字段；库存/成本由流水决定
app.put('/products/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const b = await c.req.json<{
    name?: string
    sku?: string
    barcode?: string
    category?: string
    unit?: string
    sale_price?: number
    low_stock?: number
    archived?: boolean
    no_stock?: boolean
    avg_cost?: number
    cost_manual?: boolean
  }>()
  const name = (b.name ?? '').trim()
  if (!name) return c.json({ error: '商品名称不能为空' }, 422)
  const sale_price = Math.max(0, Number(b.sale_price) || 0)
  const low_stock = Math.max(0, Number(b.low_stock) || 0)
  const res = await db
    .prepare(
      'UPDATE products SET name = ?1, sku = ?2, barcode = ?3, category = ?4, unit = ?5, sale_price = ?6, low_stock = ?7, archived = ?8, no_stock = ?9 WHERE id = ?10'
    )
    .bind(
      name,
      (b.sku ?? '').trim(),
      (b.barcode ?? '').trim(),
      (b.category ?? '').trim(),
      (b.unit ?? '件').trim() || '件',
      sale_price,
      low_stock,
      b.archived ? 1 : 0,
      b.no_stock ? 1 : 0,
      id
    )
    .run()
  if (!res.meta.changes) return c.json({ error: '商品不存在' }, 404)

  // 成本均价：显式要求恢复自动 → 按流水重算；填了新价 → 锁定为手定成本
  if (b.cost_manual === false) {
    await db.prepare('UPDATE products SET cost_manual = 0 WHERE id = ?1').bind(id).run()
    await recomputeAll(db)
  } else if (b.avg_cost !== undefined && Number(b.avg_cost) >= 0) {
    await db
      .prepare('UPDATE products SET avg_cost = ?1, cost_manual = 1 WHERE id = ?2')
      .bind(Number(b.avg_cost), id)
      .run()
  }
  return c.json({ ok: true })
})

app.delete('/products/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const row = await db
    .prepare(
      `SELECT
        EXISTS(SELECT 1 FROM purchase_items pi WHERE pi.product_id = ?1) AS hp,
        EXISTS(SELECT 1 FROM sale_items si WHERE si.product_id = ?1) AS hs,
        EXISTS(SELECT 1 FROM repair_items ri WHERE ri.product_id = ?1) AS hr,
        EXISTS(SELECT 1 FROM adjustments a WHERE a.product_id = ?1) AS ha`
    )
    .bind(id)
    .first<{ hp: number; hs: number; hr: number; ha: number }>()
  if (row && (row.hp || row.hs || row.hr || row.ha)) {
    return c.json({ error: '该商品已有进出流水，不能删除；可在编辑中停用' }, 422)
  }
  await db.prepare('DELETE FROM products WHERE id = ?1').bind(id).run()
  return c.json({ ok: true })
})

// 清理重复且库存为 0 的商品：
// - 同名商品（未停用）中，除第一个（最小 id）外，其余库存为 0 的视为多余
// - 无任何进出流水的 → 直接删除；有流水引用的 → 停用归档（保留历史，不再出现在选择列表）
app.post('/products/cleanup-duplicates', async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{ dry?: boolean }>().catch(() => null)
  const dry = !!(b?.dry)
  const cands = await db
    .prepare(
      `SELECT p.id, p.name,
              EXISTS(SELECT 1 FROM purchase_items pi WHERE pi.product_id = p.id) AS hp,
              EXISTS(SELECT 1 FROM sale_items si WHERE si.product_id = p.id) AS hs,
              EXISTS(SELECT 1 FROM repair_items ri WHERE ri.product_id = p.id) AS hr,
              EXISTS(SELECT 1 FROM adjustments a WHERE a.product_id = p.id) AS ha
       FROM products p
       WHERE p.archived = 0 AND p.stock = 0
         AND EXISTS (SELECT 1 FROM products q WHERE q.name = p.name AND q.archived = 0 AND q.id < p.id)
       ORDER BY p.id`
    )
    .all<{ id: number; name: string; hp: number; hs: number; hr: number; ha: number }>()

  const list = cands.results ?? []
  const deleted: Array<{ id: number; name: string }> = []
  const archived: Array<{ id: number; name: string }> = []
  const stmts: D1PreparedStatement[] = []
  for (const p of list) {
    const used = !!(p.hp || p.hs || p.hr || p.ha)
    if (used) {
      archived.push({ id: p.id, name: p.name })
      stmts.push(db.prepare('UPDATE products SET archived = 1 WHERE id = ?1').bind(p.id))
    } else {
      deleted.push({ id: p.id, name: p.name })
      stmts.push(db.prepare('DELETE FROM products WHERE id = ?1').bind(p.id))
    }
  }
  if (!dry && stmts.length) await db.batch(stmts)
  return c.json({ ok: true, deleted, archived, total: list.length, dry })
})

// ===== 库存调整（盘盈 / 盘亏）=====

app.post('/products/:id/adjustments', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const b = await c.req.json<{ qty?: number; reason?: string }>()
  const qty = Number(b.qty)
  if (!Number.isFinite(qty) || qty === 0) return c.json({ error: '调整数量不能为 0' }, 422)
  const p = await db
    .prepare('SELECT id, name, stock, no_stock FROM products WHERE id = ?1')
    .bind(id)
    .first<{ id: number; name: string; stock: number; no_stock: number }>()
  if (!p) return c.json({ error: '商品不存在' }, 404)
  if (p.no_stock) return c.json({ error: '服务类商品不跟踪库存，无需调整' }, 422)
  if (qty < 0 && p.stock + qty < 0) return c.json({ error: `「${p.name}」库存只有 ${p.stock}，不能调整 ${qty}` }, 422)
  await db.batch([
    db.prepare('INSERT INTO adjustments (product_id, qty, reason) VALUES (?1, ?2, ?3)').bind(id, qty, (b.reason ?? '').trim()),
    db.prepare('UPDATE products SET stock = stock + ?1 WHERE id = ?2').bind(qty, id),
  ])
  return c.json({ ok: true }, 201)
})

// 一键把负库存修正为 0：为每个负库存商品补一条盘盈调整记录（不影响资金/均价）
app.post('/products/fix-negative-stock', async (c) => {
  const db = c.env.DB
  const negs = await db
    .prepare('SELECT id, name, stock FROM products WHERE archived = 0 AND no_stock = 0 AND stock < 0 ORDER BY id')
    .all<{ id: number; name: string; stock: number }>()
  const list = negs.results ?? []
  const stmts: D1PreparedStatement[] = []
  for (const p of list) {
    const fixQty = -p.stock // 正数盘盈
    stmts.push(db.prepare('INSERT INTO adjustments (product_id, qty, reason) VALUES (?1, ?2, ?3)').bind(p.id, fixQty, '负库存一键修正为0'))
    stmts.push(db.prepare('UPDATE products SET stock = 0 WHERE id = ?1').bind(p.id))
  }
  if (stmts.length) await db.batch(stmts)
  return c.json({ ok: true, fixed: list.map((p) => ({ id: p.id, name: p.name, before: p.stock })), total: list.length })
})

app.get('/adjustments', async (c) => {
  const limit = Math.min(500, Number(c.req.query('limit')) || 100)
  const res = await c.env.DB
    .prepare(
      `SELECT a.*, p.name AS product_name, p.unit FROM adjustments a
       JOIN products p ON p.id = a.product_id ORDER BY a.id DESC LIMIT ?1`
    )
    .bind(limit)
    .all()
  return c.json(res.results ?? [])
})

// 库存流水（可按商品过滤；服务类商品不产生库存流水）
app.get('/stock/moves', async (c) => {
  const db = c.env.DB
  const limit = Math.min(1000, Number(c.req.query('limit')) || 200)
  const productId = Number(c.req.query('product_id')) || 0
  const res = await db
    .prepare(
      `SELECT * FROM (
         SELECT pi.product_id, 'purchase' AS type, pu.kind, pi.qty, pi.unit_cost AS price,
                pu.created_at, pu.id AS ref_id, pu.supplier_name AS note
           FROM purchase_items pi
           JOIN purchases pu ON pu.id = pi.purchase_id
           JOIN products p2 ON p2.id = pi.product_id
          WHERE p2.no_stock = 0
         UNION ALL
         SELECT si.product_id, 'sale', s.kind, si.qty, si.unit_price AS price,
                s.created_at, s.id, s.customer_name
           FROM sale_items si
           JOIN sales s ON s.id = si.sale_id
           JOIN products p ON p.id = si.product_id
          WHERE p.no_stock = 0
         UNION ALL
         SELECT a.product_id, 'adjust', '', a.qty, NULL, a.created_at, a.id, a.reason
           FROM adjustments a
       )
       WHERE (?1 = 0 OR product_id = ?1)
       ORDER BY created_at DESC LIMIT ?2`
    )
    .bind(productId, limit)
    .all()
  return c.json(res.results ?? [])
})

export default app
