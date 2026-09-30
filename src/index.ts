import { Hono } from 'hono'
import { ensureSchema } from './db'
import { requireAuth, requireAdmin, makeUserToken, setSession, clearSession, authenticateUser, ensureDefaultAdmin } from './auth'
import { recomputeAll } from './db'
import products from './products'
import purchases from './purchases'
import sales from './sales'
import parties from './parties'
import accounts from './accounts'
import reports from './reports'
import backup from './backup'
import webdav, { executeWebDAVBackup } from './webdav'
import users from './users'

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>()

// 所有 API 请求前确保表结构存在（幂等）
app.use('/api/*', async (c, next) => {
  await ensureSchema(c.env.DB)
  await ensureDefaultAdmin(c.env.DB, c.env.ADMIN_PASSWORD)
  return next()
})

app.use('/api/*', requireAuth)

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }))

// 多用户登录
app.post('/api/login', async (c) => {
  const b = await c.req.json<{ username?: string; password?: string }>()
  const username = (b.username ?? '').trim() || 'admin'
  const password = b.password ?? ''

  const user = await authenticateUser(c.env.DB, username, password)
  if (!user) {
    return c.json({ error: '用户名或密码错误，或账号已被禁用' }, 401)
  }

  const u = await c.env.DB.prepare('SELECT password FROM users WHERE id = ?1').bind(user.id).first<{ password: string }>()
  setSession(c, await makeUserToken({ id: user.id, passwordHash: u?.password || '' }))
  return c.json({ ok: true, user })
})

app.post('/api/logout', (c) => {
  clearSession(c)
  return c.json({ ok: true })
})

// 获取当前登录用户完整信息
app.get('/api/me', (c) => {
  const user = c.get('user')
  return user ? c.json({ ok: true, user: { id: user.id, username: user.username, name: user.name, role: user.role, status: user.status, permissions: user.permissions } }) : c.json({ ok: false }, 401)
})

app.post('/api/admin/recompute', requireAdmin, async (c) => {
  const r = await recomputeAll(c.env.DB)
  return c.json({ ok: true, ...r })
})

app.route('/api', products)
app.route('/api', purchases)
app.route('/api', sales)
app.route('/api', parties)
app.route('/api', accounts)
app.route('/api', reports)
app.route('/api', backup)
app.route('/api', webdav)
app.route('/api', users)

// 读取公司基础信息配置（系统名、公司名、电话、地址等，公开接口无需登录）
app.get('/api/settings/company', async (c) => {
  const db = c.env.DB
  const rows = await db
    .prepare("SELECT key, value FROM sys_config WHERE key LIKE 'company_%' OR key = 'app_title'")
    .all<{ key: string; value: string }>()
  const map = new Map((rows.results ?? []).map((r) => [r.key, r.value]))
  return c.json({
    app_title: map.get('app_title') || 'Cloud ERP 进销存',
    company_name: map.get('company_name') || '我的企业/店铺',
    company_phone: map.get('company_phone') || '',
    company_address: map.get('company_address') || '',
    company_contact: map.get('company_contact') || '',
    print_footer_note: map.get('print_footer_note') || '诚信服务 · 品质保证',
  })
})

// 保存公司基础信息配置（仅管理员）
app.post('/api/settings/company', requireAdmin, async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{
    app_title?: string
    company_name?: string
    company_phone?: string
    company_address?: string
    company_contact?: string
    print_footer_note?: string
  }>()

  const stmts: D1PreparedStatement[] = []
  if (b.app_title !== undefined) {
    stmts.push(db.prepare("INSERT INTO sys_config (key, value) VALUES ('app_title', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(b.app_title.trim() || 'Cloud ERP 进销存'))
  }
  if (b.company_name !== undefined) {
    stmts.push(db.prepare("INSERT INTO sys_config (key, value) VALUES ('company_name', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(b.company_name.trim()))
  }
  if (b.company_phone !== undefined) {
    stmts.push(db.prepare("INSERT INTO sys_config (key, value) VALUES ('company_phone', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(b.company_phone.trim()))
  }
  if (b.company_address !== undefined) {
    stmts.push(db.prepare("INSERT INTO sys_config (key, value) VALUES ('company_address', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(b.company_address.trim()))
  }
  if (b.company_contact !== undefined) {
    stmts.push(db.prepare("INSERT INTO sys_config (key, value) VALUES ('company_contact', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(b.company_contact.trim()))
  }
  if (b.print_footer_note !== undefined) {
    stmts.push(db.prepare("INSERT INTO sys_config (key, value) VALUES ('print_footer_note', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(b.print_footer_note.trim()))
  }

  if (stmts.length) await db.batch(stmts)
  return c.json({ ok: true })
})

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: '服务器内部错误：' + (err?.message || String(err)) }, 500)
})

export default {
  fetch: app.fetch,
  // Cloudflare Workers 原生 Cron 触发入口（每天凌晨自动定时备份到 WebDAV）
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchema(env.DB)
          const res = await executeWebDAVBackup(env.DB)
          console.log('[WebDAV Cron] 定时备份结果:', JSON.stringify(res))
        } catch (e) {
          console.error('[WebDAV Cron] 定时备份异常:', e)
        }
      })()
    )
  },
}
