import { Hono } from 'hono'
import { requireAdmin, sha256 } from './auth'

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>()

// 获取用户列表（仅管理员）
app.get('/users', requireAdmin, async (c) => {
  const db = c.env.DB
  const rows = await db
    .prepare('SELECT id, username, name, role, status, permissions, phone, note, created_at FROM users ORDER BY id ASC')
    .all<{ id: number; username: string; name: string; role: UserRole; status: number; permissions: string; phone: string; note: string; created_at: string }>()
  const list = (rows.results ?? []).map(u => {
    let perms: string[] = []
    try { perms = JSON.parse(u.permissions || '[]') } catch { perms = [] }
    return { ...u, permissions: perms }
  })
  return c.json(list)
})

// 新增用户（仅管理员）
app.post('/users', requireAdmin, async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{
    username?: string
    name?: string
    password?: string
    role?: UserRole
    status?: number
    permissions?: string[]
    phone?: string
    note?: string
  }>()

  const username = (b.username ?? '').trim()
  if (!username) return c.json({ error: '用户名不能为空' }, 422)
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]{2,20}$/.test(username)) {
    return c.json({ error: '用户名格式不符合规范（2-20位字符）' }, 422)
  }

  const rawPwd = (b.password ?? '').trim()
  if (!rawPwd || rawPwd.length < 4) {
    return c.json({ error: '密码长度至少 4 位' }, 422)
  }

  const role: UserRole = b.role === 'admin' || b.role === 'sales' ? b.role : 'staff'
  const name = (b.name ?? '').trim() || username
  const phone = (b.phone ?? '').trim()
  const note = (b.note ?? '').trim()
  const perms = Array.isArray(b.permissions) ? JSON.stringify(b.permissions) : '[]'

  const exists = await db.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first()
  if (exists) {
    return c.json({ error: `用户名「${username}」已存在` }, 422)
  }

  const hashed = await sha256(rawPwd)
  const res = await db
    .prepare(
      'INSERT INTO users (username, name, password, role, status, permissions, phone, note) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)'
    )
    .bind(username, name, hashed, role, perms, phone, note)
    .run()

  return c.json({ id: res.meta.last_row_id, ok: true }, 201)
})

// 修改用户信息（角色/状态/权限/备注/姓名/电话）（仅管理员）
app.put('/users/:id', requireAdmin, async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const currentUser = c.get('user')

  const target = await db.prepare('SELECT id, username, role, status FROM users WHERE id = ?1').bind(id).first<{
    id: number
    username: string
    role: UserRole
    status: number
  }>()
  if (!target) return c.json({ error: '用户不存在' }, 404)

  const b = await c.req.json<{
    name?: string
    role?: UserRole
    status?: number
    permissions?: string[]
    phone?: string
    note?: string
    newPassword?: string
  }>()

  // 保护：不能禁用或降级自己
  if (id === currentUser.id) {
    if (b.status === 0) return c.json({ error: '不能禁用当前登录的账号' }, 422)
    if (b.role && b.role !== 'admin') return c.json({ error: '不能降级自己的管理员角色' }, 422)
  }

  const role: UserRole = b.role === 'admin' || b.role === 'sales' ? b.role : 'staff'
  const name = (b.name ?? '').trim()
  const status = b.status === 0 ? 0 : 1
  const phone = (b.phone ?? '').trim()
  const note = (b.note ?? '').trim()
  const perms = Array.isArray(b.permissions) ? JSON.stringify(b.permissions) : '[]'

  const stmts: D1PreparedStatement[] = [
    db
      .prepare('UPDATE users SET name = ?1, role = ?2, status = ?3, permissions = ?4, phone = ?5, note = ?6 WHERE id = ?7')
      .bind(name, role, status, perms, phone, note, id),
  ]

  // 如果传了新密码，同时重置密码
  if (b.newPassword && b.newPassword.trim().length >= 4) {
    const hashed = await sha256(b.newPassword.trim())
    stmts.push(db.prepare('UPDATE users SET password = ?1 WHERE id = ?2').bind(hashed, id))
  }

  await db.batch(stmts)
  return c.json({ ok: true })
})

// 删除用户（仅管理员）
app.delete('/users/:id', requireAdmin, async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const currentUser = c.get('user')

  if (id === currentUser.id) {
    return c.json({ error: '不能删除当前登录的账号' }, 422)
  }

  const userCount = await db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 1").first<{ c: number }>()
  const target = await db.prepare('SELECT role FROM users WHERE id = ?1').bind(id).first<{ role: string }>()
  if (target?.role === 'admin' && (userCount?.c ?? 0) <= 1) {
    return c.json({ error: '系统中至少需要保留一位激活的管理员' }, 422)
  }

  await db.prepare('DELETE FROM users WHERE id = ?1').bind(id).run()
  return c.json({ ok: true })
})

// 用户修改自己的个人资料与密码（普通用户可用）
app.post('/user/profile', async (c) => {
  const db = c.env.DB
  const currentUser = c.get('user')
  const b = await c.req.json<{
    name?: string
    phone?: string
    oldPassword?: string
    newPassword?: string
  }>()

  const u = await db.prepare('SELECT password FROM users WHERE id = ?1').bind(currentUser.id).first<{ password: string }>()
  if (!u) return c.json({ error: '用户不存在' }, 404)

  const stmts: D1PreparedStatement[] = []

  // 如果修改密码，先验证旧密码
  if (b.newPassword && b.newPassword.trim()) {
    const newPwd = b.newPassword.trim()
    if (newPwd.length < 4) return c.json({ error: '新密码长度至少 4 位' }, 422)
    const oldHashed = await sha256(b.oldPassword || '')
    if (oldHashed !== u.password) {
      return c.json({ error: '当前密码不正确' }, 422)
    }
    const newHashed = await sha256(newPwd)
    stmts.push(db.prepare('UPDATE users SET password = ?1 WHERE id = ?2').bind(newHashed, currentUser.id))
  }

  const name = b.name !== undefined ? b.name.trim() : undefined
  const phone = b.phone !== undefined ? b.phone.trim() : undefined

  if (name !== undefined || phone !== undefined) {
    stmts.push(
      db
        .prepare('UPDATE users SET name = COALESCE(?1, name), phone = COALESCE(?2, phone) WHERE id = ?3')
        .bind(name ?? null, phone ?? null, currentUser.id)
    )
  }

  if (stmts.length) await db.batch(stmts)
  return c.json({ ok: true })
})

export default app
