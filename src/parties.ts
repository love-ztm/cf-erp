import { Hono } from 'hono'
import { recomputeMoney } from './db'

const app = new Hono<{ Bindings: Env }>()

app.get('/parties', async (c) => {
  const type = c.req.query('type') === 'supplier' || c.req.query('type') === 'customer' ? c.req.query('type') : null
  const res = type
    ? await c.env.DB.prepare('SELECT * FROM parties WHERE type = ?1 ORDER BY id DESC').bind(type).all()
    : await c.env.DB.prepare('SELECT * FROM parties ORDER BY id DESC').all()
  return c.json(res.results ?? [])
})

app.post('/parties', async (c) => {
  const b = await c.req.json<{
    type?: string
    name?: string
    phone?: string
    address?: string
    contact_man?: string
    note?: string
    opening_debt?: number
  }>()
  const name = (b.name ?? '').trim()
  if (!name) return c.json({ error: '名称不能为空' }, 422)
  if (b.type !== 'supplier' && b.type !== 'customer') return c.json({ error: '类型不合法' }, 422)
  const opening = Math.max(0, Number(b.opening_debt) || 0)
  const res = await c.env.DB
    .prepare('INSERT INTO parties (type, name, phone, address, contact_man, note, opening_debt, debt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)')
    .bind(b.type, name, (b.phone ?? '').trim(), (b.address ?? '').trim(), (b.contact_man ?? '').trim(), (b.note ?? '').trim(), opening)
    .run()
  return c.json({ id: res.meta.last_row_id }, 201)
})

app.put('/parties/:id', async (c) => {
  const b = await c.req.json<{
    name?: string
    phone?: string
    address?: string
    contact_man?: string
    note?: string
    opening_debt?: number
  }>()
  const name = (b.name ?? '').trim()
  if (!name) return c.json({ error: '名称不能为空' }, 422)
  const opening = Math.max(0, Number(b.opening_debt) || 0)
  const res = await c.env.DB
    .prepare('UPDATE parties SET name = ?1, phone = ?2, address = ?3, contact_man = ?4, note = ?5, opening_debt = ?6 WHERE id = ?7')
    .bind(name, (b.phone ?? '').trim(), (b.address ?? '').trim(), (b.contact_man ?? '').trim(), (b.note ?? '').trim(), opening, Number(c.req.param('id')))
    .run()
  if (!res.meta.changes) return c.json({ error: '往来单位不存在' }, 404)
  await recomputeMoney(c.env.DB)
  return c.json({ ok: true })
})

app.delete('/parties/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM parties WHERE id = ?1').bind(Number(c.req.param('id'))).run()
  return c.json({ ok: true })
})

export default app
