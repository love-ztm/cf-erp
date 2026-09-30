import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context, Next } from 'hono'

const enc = new TextEncoder()
const COOKIE = 'erp_session'
const DAYS = 7

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str))
  return b64url(buf)
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}

// 确保默认 admin 用户存在（如果 users 表为空，自动根据 sys_config 或默认 admin123 迁移建立）
export async function ensureDefaultAdmin(db: D1Database, envPwd?: string) {
  try {
    const userCount = await db.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>()
    if (!userCount || userCount.c === 0) {
      // 查看是否有老版本的 sys_config 密码
      const oldCfg = await db.prepare("SELECT key, value FROM sys_config WHERE key IN ('admin_username', 'admin_password')").all<{ key: string; value: string }>()
      const map = new Map((oldCfg.results ?? []).map((r) => [r.key, r.value]))
      const username = map.get('admin_username') || 'admin'
      const rawPwd = map.get('admin_password') || envPwd || 'admin123'
      const hashed = await sha256(rawPwd)
      await db.prepare(
        "INSERT INTO users (username, name, password, role, status, note) VALUES (?1, '超级管理员', ?2, 'admin', 1, '系统默认超级管理员')"
      ).bind(username, hashed).run()
    }
  } catch (e) {
    console.error('ensureDefaultAdmin error:', e)
  }
}

function parsePerms(raw?: string | null): string[] {
  try {
    const arr = JSON.parse(raw || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// 登录验证用户
export async function authenticateUser(db: D1Database, username: string, rawPassword: string): Promise<AuthUser | null> {
  await ensureDefaultAdmin(db)
  const hashed = await sha256(rawPassword)
  const u = await db
    .prepare('SELECT id, username, name, password, role, status, permissions FROM users WHERE username = ?1')
    .bind(username.trim())
    .first<{ id: number; username: string; name: string; password: string; role: UserRole; status: number; permissions?: string }>()

  if (!u) return null
  // 密码匹配（比对 sha256 hash）
  if (u.password !== hashed) return null
  // 检查账号是否被禁用
  if (u.status !== 1) return null

  return { id: u.id, username: u.username, name: u.name, role: u.role, status: u.status, permissions: parsePerms(u.permissions) }
}

// Session Token Payload 格式：<userId>.<exp>.<HMAC(userId + exp + passwordHash)>
export async function makeUserToken(u: { id: number; passwordHash: string }): Promise<string> {
  const exp = Date.now() + DAYS * 864e5
  const msg = `${u.id}:${exp}:${u.passwordHash}`
  const sig = await hmac(u.passwordHash, `${u.id}:${exp}`)
  return `${u.id}.${exp}.${sig}`
}

// 验证 Cookie Token 并返回当前用户身份
export async function verifyUserSession(db: D1Database, token: string): Promise<AuthUser | null> {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [userIdStr, expStr, sig] = parts
  const userId = Number(userIdStr)
  const exp = Number(expStr)
  if (!userId || !exp || exp < Date.now()) return null

  const u = await db
    .prepare('SELECT id, username, name, password, role, status, permissions FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ id: number; username: string; name: string; password: string; role: UserRole; status: number; permissions?: string }>()

  if (!u || u.status !== 1) return null
  const expectedSig = await hmac(u.password, `${u.id}:${exp}`)
  if (sig !== expectedSig) return null

  return { id: u.id, username: u.username, name: u.name, role: u.role, status: u.status, permissions: parsePerms(u.permissions) }
}

export function setSession(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    path: '/',
    sameSite: 'Lax',
    maxAge: DAYS * 86400,
  })
}

export function clearSession(c: Context) {
  deleteCookie(c, COOKIE, { path: '/' })
}

export function readSession(c: Context): string {
  return getCookie(c, COOKIE) ?? ''
}

// 登录中间件：解析并注入 `c.set('user', user)`
export async function requireAuth(c: Context<{ Bindings: Env; Variables: { user: AuthUser } }>, next: Next) {
  const path = c.req.path
  // 公开接口放行：登录、健康检查、公司配置（登录页也要显示公司名称）
  if (path === '/api/login' || path === '/api/health' || path === '/api/settings/company') return next()

  const user = await verifyUserSession(c.env.DB, readSession(c))
  if (!user) {
    return c.json({ error: '未登录或登录已过期' }, 401)
  }
  c.set('user', user)
  await next()
}

// 角色权限中间件：限制只有 admin 才能执行敏感操作
export async function requireAdmin(c: Context<{ Bindings: Env; Variables: { user: AuthUser } }>, next: Next) {
  const user = c.get('user')
  if (!user || user.role !== 'admin') {
    return c.json({ error: '权限不足：该操作仅限管理员执行' }, 403)
  }
  await next()
}
