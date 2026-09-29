import { Hono } from 'hono'
import { generateBackupPayload, type BackupData } from './backup'
import { requireAdmin } from './auth'

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>()

export type WebDAVConfig = {
  enabled: boolean
  url: string // e.g. https://dav.example.com/dav/
  username: string
  password: string
  remote_dir: string // e.g. /erp-backups/
  cron_schedule?: string // e.g. "0 2 * * *" (每天凌晨 2 点)
  last_backup_at?: string
  last_status?: string // 'success' | 'failed'
  last_error?: string
}

// 从 sys_config 获取 WebDAV 配置
export async function getWebDAVConfig(db: D1Database): Promise<WebDAVConfig> {
  const rows = await db
    .prepare("SELECT key, value FROM sys_config WHERE key LIKE 'webdav_%'")
    .all<{ key: string; value: string }>()
  const map = new Map((rows.results ?? []).map((r) => [r.key, r.value]))

  return {
    enabled: map.get('webdav_enabled') === '1',
    url: map.get('webdav_url') || '',
    username: map.get('webdav_username') || '',
    password: map.get('webdav_password') || '',
    remote_dir: map.get('webdav_remote_dir') || '/erp-backups',
    cron_schedule: map.get('webdav_cron_schedule') || '0 2 * * *',
    last_backup_at: map.get('webdav_last_backup_at') || '',
    last_status: map.get('webdav_last_status') || '',
    last_error: map.get('webdav_last_error') || '',
  }
}

// 确保 WebDAV 目录存在（发送 MKCOL）
async function ensureRemoteDir(base: string, dir: string, authHeader: string) {
  const cleanDir = dir.replace(/^\/+|\/+$/g, '')
  if (!cleanDir) return

  const parts = cleanDir.split('/')
  let cur = ''
  for (const p of parts) {
    cur += '/' + p
    const target = new URL(cur.replace(/^\//, '') + '/', base).toString()
    try {
      await fetch(target, {
        method: 'MKCOL',
        headers: { Authorization: authHeader },
      })
    } catch {
      // 忽略目录已存在的错误
    }
  }
}

// 执行一次全量备份并上传至 WebDAV
export async function executeWebDAVBackup(db: D1Database): Promise<{ ok: boolean; filename?: string; error?: string }> {
  const cfg = await getWebDAVConfig(db)
  if (!cfg.enabled || !cfg.url) {
    return { ok: false, error: 'WebDAV 备份未启用或未配置服务地址' }
  }

  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '')
  const filename = `ERP备份_${dateStr}_${timeStr}.json`

  try {
    // 1. 生成全库自包含 JSON 备份
    const payload = await generateBackupPayload(db)
    const jsonStr = JSON.stringify(payload, null, 2)

    // 2. 准备 WebDAV 上传目标地址
    let baseUrl = cfg.url.trim()
    if (!baseUrl.endsWith('/')) baseUrl += '/'

    const auth = 'Basic ' + btoa(`${cfg.username}:${cfg.password}`)

    // 3. 递归建目录
    if (cfg.remote_dir) {
      await ensureRemoteDir(baseUrl, cfg.remote_dir, auth)
    }

    const cleanDir = cfg.remote_dir ? cfg.remote_dir.replace(/^\/+|\/+$/g, '') + '/' : ''
    const targetUrl = new URL(cleanDir + filename, baseUrl).toString()

    // 4. PUT 上传文件
    const res = await fetch(targetUrl, {
      method: 'PUT',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: jsonStr,
    })

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      const msg = `WebDAV 服务器返回 HTTP ${res.status}: ${res.statusText}`
      throw new Error(msg)
    }

    // 5. 记录成功状态
    await db.batch([
      db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_last_backup_at', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(now.toISOString()),
      db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_last_status', 'success') ON CONFLICT(key) DO UPDATE SET value = 'success'"),
      db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_last_error', '') ON CONFLICT(key) DO UPDATE SET value = ''"),
    ])

    return { ok: true, filename }
  } catch (err: any) {
    const errMsg = err?.message || String(err)
    await db.batch([
      db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_last_status', 'failed') ON CONFLICT(key) DO UPDATE SET value = 'failed'"),
      db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_last_error', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(errMsg),
    ])
    return { ok: false, error: errMsg }
  }
}

// ===== API 路由 =====

// 读取 WebDAV 设置（仅管理员）
app.get('/settings/webdav', requireAdmin, async (c) => {
  const cfg = await getWebDAVConfig(c.env.DB)
  // 不返回明文密码，只返回是否已设置
  return c.json({
    ...cfg,
    has_password: !!cfg.password,
    password: cfg.password ? '******' : '',
  })
})

// 保存 WebDAV 设置（仅管理员）
app.post('/settings/webdav', requireAdmin, async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{
    enabled?: boolean
    url?: string
    username?: string
    password?: string
    remote_dir?: string
    cron_schedule?: string
  }>()

  const cur = await getWebDAVConfig(db)
  const enabled = b.enabled ? '1' : '0'
  const url = (b.url ?? cur.url).trim()
  const username = (b.username ?? cur.username).trim()
  // 如果传来的是占位符 ****** 或空，则保留原密码
  const password = b.password && b.password !== '******' ? b.password : cur.password
  const remote_dir = (b.remote_dir ?? cur.remote_dir).trim() || '/erp-backups'

  await db.batch([
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_enabled', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(enabled),
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_url', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(url),
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_username', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(username),
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_password', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(password),
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_remote_dir', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(remote_dir),
  ])

  return c.json({ ok: true })
})

// 手动测试并立即触发一次 WebDAV 备份（仅管理员）
app.post('/settings/webdav/test', requireAdmin, async (c) => {
  const r = await executeWebDAVBackup(c.env.DB)
  if (!r.ok) {
    return c.json({ error: r.error || '备份失败' }, 422)
  }
  return c.json({ ok: true, filename: r.filename })
})

export default app
