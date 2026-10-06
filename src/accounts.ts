import { Hono } from 'hono'
import { recomputeMoney, round2, docDateToISO } from './db'

const app = new Hono<{ Bindings: Env }>()

const FUND_TYPES = ['receipt', 'payment', 'income', 'expense'] as const

// ===== 结算账户 =====

app.get('/accounts', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM accounts ORDER BY id').all()
  return c.json(res.results ?? [])
})

app.post('/accounts', async (c) => {
  const b = await c.req.json<{ name?: string; opening_balance?: number; note?: string }>()
  const name = (b.name ?? '').trim()
  if (!name) return c.json({ error: '账户名称不能为空' }, 422)
  const opening = Math.max(0, Number(b.opening_balance) || 0)
  const res = await c.env.DB
    .prepare('INSERT INTO accounts (name, opening_balance, balance, note) VALUES (?1, ?2, ?2, ?3)')
    .bind(name, opening, (b.note ?? '').trim())
    .run()
  return c.json({ id: res.meta.last_row_id }, 201)
})

app.put('/accounts/:id', async (c) => {
  const b = await c.req.json<{ name?: string; opening_balance?: number; note?: string }>()
  const name = (b.name ?? '').trim()
  if (!name) return c.json({ error: '账户名称不能为空' }, 422)
  const opening = Math.max(0, Number(b.opening_balance) || 0)
  const res = await c.env.DB
    .prepare('UPDATE accounts SET name = ?1, opening_balance = ?2, note = ?3 WHERE id = ?4')
    .bind(name, opening, (b.note ?? '').trim(), Number(c.req.param('id')))
    .run()
  if (!res.meta.changes) return c.json({ error: '账户不存在' }, 404)
  await recomputeMoney(c.env.DB)
  return c.json({ ok: true })
})

app.delete('/accounts/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const used = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM funds WHERE account_id = ?1) +
        (SELECT COUNT(*) FROM sales WHERE account_id = ?1 AND paid > 0) +
        (SELECT COUNT(*) FROM purchases WHERE account_id = ?1 AND paid > 0) AS n`
    )
    .bind(id)
    .first<{ n: number }>()
  if (used && used.n > 0) return c.json({ error: '该账户已有资金流水，不能删除' }, 422)
  await db.prepare('DELETE FROM accounts WHERE id = ?1').bind(id).run()
  await recomputeMoney(db)
  return c.json({ ok: true })
})

// ===== 收付款 / 其他收支流水 =====

app.get('/funds', async (c) => {
  const db = c.env.DB
  const limit = Math.min(500, Number(c.req.query('limit')) || 200)
  const type = c.req.query('type') || ''
  const from = (c.req.query('from') || '').trim()
  const to = (c.req.query('to') || '').trim()
  // 资金日记账 = funds 流水 + 单据内的收付款与退货退款（便于对账）；支持类型与日期范围筛选
  const res = await db
    .prepare(
      `SELECT * FROM (
         SELECT f.id, f.type, f.party_id, f.party_name, f.account_id, f.amount, f.note, f.created_at, '' AS ref_kind, 0 AS ref_id
           FROM funds f WHERE (?1 = '' OR f.type = ?1)
         UNION ALL
         SELECT s.id, 'sale_paid', s.customer_id, s.customer_name, s.account_id, s.paid, s.note, s.created_at, s.kind, s.id
           FROM sales s WHERE s.kind = 'normal' AND s.paid > 0 AND (?1 = '' OR 'sale_paid' = ?1)
         UNION ALL
         SELECT pu.id, 'purchase_paid', pu.supplier_id, pu.supplier_name, pu.account_id, pu.paid, pu.note, pu.created_at, pu.kind, pu.id
           FROM purchases pu WHERE pu.kind = 'normal' AND pu.paid > 0 AND (?1 = '' OR 'purchase_paid' = ?1)
         UNION ALL
         SELECT r.id, 'repair_paid', r.customer_id, r.customer_name, r.account_id, r.paid, r.note, r.created_at, 'normal', r.id
           FROM repairs r WHERE r.paid > 0 AND (?1 = '' OR 'repair_paid' = ?1)
       ) WHERE (?3 = '' OR created_at >= ?3) AND (?4 = '' OR created_at < ?4)
       ORDER BY created_at DESC LIMIT ?2`
    )
    .bind(type, limit, from, to)
    .all()
  return c.json(res.results ?? [])
})

app.post('/funds', async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{
    type?: string
    party_id?: number | null
    party_name?: string
    account_id?: number
    amount?: number
    note?: string
    doc_date?: string
  }>()
  const type = b.type ?? ''
  if (!FUND_TYPES.includes(type as never)) return c.json({ error: '资金类型不合法' }, 422)
  const amount = Number(b.amount)
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: '金额必须大于 0' }, 422)
  const accountId = Number(b.account_id)
  const account = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(accountId).first()
  if (!account) return c.json({ error: '请选择结算账户' }, 422)

  let partyId: number | null = null
  let partyName = (b.party_name ?? '').trim()
  if (type === 'receipt' || type === 'payment') {
    if (!b.party_id) return c.json({ error: '请选择往来单位' }, 422)
    const party = await db
      .prepare('SELECT id, name, type FROM parties WHERE id = ?1')
      .bind(Number(b.party_id))
      .first<{ id: number; name: string; type: string }>()
    if (!party) return c.json({ error: '往来单位不存在' }, 422)
    const want = type === 'receipt' ? 'customer' : 'supplier'
    if (party.type !== want) return c.json({ error: want === 'customer' ? '收款单请选择客户' : '付款单请选择供应商' }, 422)
    partyId = party.id
    partyName = party.name
  } else if (b.party_id) {
    // 其他收入/支出可选关联往来单位，仅作记录，不影响欠款
    const party = await db
      .prepare('SELECT id, name FROM parties WHERE id = ?1')
      .bind(Number(b.party_id))
      .first<{ id: number; name: string }>()
    if (!party) return c.json({ error: '往来单位不存在' }, 422)
    partyId = party.id
    partyName = party.name
  }

  const createdAt = docDateToISO(b.doc_date)
  const fundInsert = createdAt
    ? db
        .prepare('INSERT INTO funds (type, party_id, party_name, account_id, amount, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(type, partyId, partyName, accountId, round2(amount), (b.note ?? '').trim(), createdAt)
    : db
        .prepare('INSERT INTO funds (type, party_id, party_name, account_id, amount, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(type, partyId, partyName, accountId, round2(amount), (b.note ?? '').trim())

  await db.batch([
    fundInsert,
    db
      .prepare(
        `UPDATE accounts SET balance = balance + ?1 * (CASE WHEN ?2 IN ('receipt','income') THEN 1 ELSE -1 END) WHERE id = ?3`
      )
      .bind(amount, type, accountId),
    ...(partyId && (type === 'receipt' || type === 'payment')
      ? [db.prepare('UPDATE parties SET debt = debt - ?1 WHERE id = ?2').bind(amount, partyId)]
      : []),
  ])
  return c.json({ ok: true }, 201)
})

app.put('/funds/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const b = await c.req.json<{
    type?: string
    party_id?: number | null
    party_name?: string
    account_id?: number
    amount?: number
    note?: string
    doc_date?: string
  }>()
  const row = await db.prepare('SELECT id, type FROM funds WHERE id = ?1').bind(id).first<{ id: number; type: string }>()
  if (!row) return c.json({ error: '流水不存在' }, 404)
  if (!FUND_TYPES.includes(row.type as never)) return c.json({ error: '单据内流水不可单独修改，请调整对应单据' }, 422)
  const type = b.type ?? row.type
  if (!FUND_TYPES.includes(type as never)) return c.json({ error: '资金类型不合法' }, 422)
  const amount = Number(b.amount)
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: '金额必须大于 0' }, 422)
  const accountId = Number(b.account_id)
  const account = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(accountId).first()
  if (!account) return c.json({ error: '请选择结算账户' }, 422)

  let partyId: number | null = null
  let partyName = (b.party_name ?? '').trim()
  if (type === 'receipt' || type === 'payment') {
    if (!b.party_id) return c.json({ error: '请选择往来单位' }, 422)
    const party = await db
      .prepare('SELECT id, name, type FROM parties WHERE id = ?1')
      .bind(Number(b.party_id))
      .first<{ id: number; name: string; type: string }>()
    if (!party) return c.json({ error: '往来单位不存在' }, 422)
    const want = type === 'receipt' ? 'customer' : 'supplier'
    if (party.type !== want) return c.json({ error: want === 'customer' ? '收款单请选择客户' : '付款单请选择供应商' }, 422)
    partyId = party.id
    partyName = party.name
  } else if (b.party_id) {
    const party = await db
      .prepare('SELECT id, name FROM parties WHERE id = ?1')
      .bind(Number(b.party_id))
      .first<{ id: number; name: string }>()
    if (!party) return c.json({ error: '往来单位不存在' }, 422)
    partyId = party.id
    partyName = party.name
  }

  const newDate = docDateToISO(b.doc_date)
  const headVals = [type, partyId, partyName, accountId, round2(amount), (b.note ?? '').trim(), id]
  if (newDate) {
    await db
      .prepare('UPDATE funds SET type = ?1, party_id = ?2, party_name = ?3, account_id = ?4, amount = ?5, note = ?6, created_at = ?8 WHERE id = ?7')
      .bind(...headVals, newDate)
      .run()
  } else {
    await db
      .prepare('UPDATE funds SET type = ?1, party_id = ?2, party_name = ?3, account_id = ?4, amount = ?5, note = ?6 WHERE id = ?7')
      .bind(...headVals)
      .run()
  }
  await recomputeMoney(db)
  return c.json({ ok: true })
})

app.delete('/funds/:id', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const row = await db.prepare('SELECT id FROM funds WHERE id = ?1').bind(id).first()
  if (!row) return c.json({ error: '流水不存在' }, 404)
  await db.prepare('DELETE FROM funds WHERE id = ?1').bind(id).run()
  await recomputeMoney(db)
  return c.json({ ok: true })
})

export default app
