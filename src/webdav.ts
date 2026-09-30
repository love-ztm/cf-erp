import { Hono } from 'hono'
import { generateBackupPayload, importBackupData, type BackupData } from './backup'
import { requireAdmin } from './auth'

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>()

export type WebDAVConfig = {
  enabled: boolean
  url: string // e.g. https://dav.example.com/dav/
  username: string
  password: string
  remote_dir: string // e.g. /erp-backups/
  keep_days?: number // 只保留最近 N 天的备份（默认 10）
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
    keep_days: parseInt(map.get('webdav_keep_days') || '10', 10) || 10,
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

// 备份后清理：删除远程目录中超过 keepDays 天的旧备份文件（只处理本系统命名的 ERP备份_*.json）
export async function pruneOldBackups(
  baseUrl: string,
  auth: string,
  cleanDir: string,
  keepDays: number
): Promise<{ deleted: string[] }> {
  const deleted: string[] = []
  const dirUrl = new URL(cleanDir, baseUrl).toString()
  try {
    const res = await fetch(dirUrl, {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:getlastmodified/><d:getcontentlength/><d:displayname/></d:prop>
</d:propfind>`,
    })
    if (!res.ok) return { deleted }
    const xml = await res.text()
    const files = parseMultistatus(xml).filter((f) => /^ERP备份_\d{8}_\d{6}\.json$/.test(f.name))
    const cutoff = Date.now() - keepDays * 86400_000
    for (const f of files) {
      // 优先用服务器返回的修改时间；解析失败则回退到文件名里的日期
      let fileTime = f.modified ? new Date(f.modified).getTime() : NaN
      if (Number.isNaN(fileTime)) {
        const m = f.name.match(/^ERP备份_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.json$/)
        if (m) fileTime = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
      }
      if (!Number.isFinite(fileTime) || fileTime >= cutoff) continue
      const fileUrl = new URL(cleanDir + f.name, baseUrl).toString()
      try {
        const dr = await fetch(fileUrl, { method: 'DELETE', headers: { Authorization: auth } })
        if (dr.ok || dr.status === 204 || dr.status === 404) deleted.push(f.name)
      } catch {
        // 单个文件删除失败不影响其他
      }
    }
  } catch {
    // 清理失败不影响本次备份结果
  }
  return { deleted }
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

    // 5. 清理超出保留天数的旧备份
    const pruned = await pruneOldBackups(baseUrl, auth, cleanDir, cfg.keep_days || 10)
    if (pruned.deleted.length) {
      console.log('[WebDAV] 已清理过期备份:', pruned.deleted.join(', '))
    }

    // 6. 记录成功状态
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
    keep_days?: number
    cron_schedule?: string
  }>()

  const cur = await getWebDAVConfig(db)
  const enabled = b.enabled ? '1' : '0'
  const url = (b.url ?? cur.url).trim()
  const username = (b.username ?? cur.username).trim()
  // 如果传来的是占位符 ****** 或空，则保留原密码
  const password = b.password && b.password !== '******' ? b.password : cur.password
  const remote_dir = (b.remote_dir ?? cur.remote_dir).trim() || '/erp-backups'
  const keepDays = Math.min(Math.max(parseInt(String(b.keep_days ?? cur.keep_days ?? 10), 10) || 10, 1), 365)

  await db.batch([
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_enabled', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(enabled),
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_url', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(url),
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_username', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(username),
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_password', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(password),
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_remote_dir', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(remote_dir),
    db.prepare("INSERT INTO sys_config (key, value) VALUES ('webdav_keep_days', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(String(keepDays)),
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

// ===== WebDAV 辅助：URL 与鉴权 =====
function webdavBase(cfg: WebDAVConfig): { baseUrl: string; auth: string; cleanDir: string } {
  let baseUrl = cfg.url.trim()
  if (!baseUrl.endsWith('/')) baseUrl += '/'
  const auth = 'Basic ' + btoa(`${cfg.username}:${cfg.password}`)
  const cleanDir = cfg.remote_dir ? cfg.remote_dir.replace(/^\/+|\/+$/g, '') + '/' : ''
  return { baseUrl, auth, cleanDir }
}

// 解析 PROPFIND 返回的 multistatus XML（用正则提取文件 href / 大小 / 修改时间）
// 注意：1) 标签可带命名空间前缀（如 <d:href> / <D:response>）
//      2) 开始标签可带属性（如 <D:response xmlns:lp1="DAV:">），需容忍属性后再取内容
function parseMultistatus(xml: string): Array<{ name: string; size: number; modified: string }> {
  const items: Array<{ name: string; size: number; modified: string }> = []
  // openTag: 前缀可选 + 名称后允许空白/属性，直到 >
  const openTag = (name: string) => `<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>`
  const closeTag = (name: string) => `</(?:[A-Za-z0-9_-]+:)?${name}>`
  const respRe = new RegExp(openTag('response') + '([\\s\\S]*?)' + closeTag('response'), 'g')
  let m: RegExpExecArray | null
  while ((m = respRe.exec(xml)) !== null) {
    const block = m[1]
    const hrefRe = new RegExp(openTag('href') + '([\\s\\S]*?)' + closeTag('href'))
    const hrefMatch = block.match(hrefRe)
    if (!hrefMatch) continue
    let href = hrefMatch[1].trim()
    if (href.startsWith('<![CDATA[')) href = href.replace(/^<!\[CDATA\[|\]\]>$/g, '')
    // 取最后一段作为文件名，并反转义 %XX（部分服务器 href 是全 URL 或带 URL 编码）
    const rawName = href.split('/').filter(Boolean).pop() || ''
    let name = rawName
    try { name = decodeURIComponent(rawName) } catch { /* 保持原样 */ }
    if (!name || !name.toLowerCase().endsWith('.json')) continue
    const sizeRe = new RegExp(openTag('getcontentlength') + '([\\s\\S]*?)' + closeTag('getcontentlength'))
    const modRe = new RegExp(openTag('getlastmodified') + '([\\s\\S]*?)' + closeTag('getlastmodified'))
    const sizeMatch = block.match(sizeRe)
    const modMatch = block.match(modRe)
    items.push({
      name,
      size: sizeMatch ? parseInt(sizeMatch[1].trim(), 10) || 0 : 0,
      modified: modMatch ? modMatch[1].trim() : '',
    })
  }
  return items
}

// 列出 WebDAV 远程目录中的备份文件（仅管理员）
app.post('/settings/webdav/list', requireAdmin, async (c) => {
  const cfg = await getWebDAVConfig(c.env.DB)
  if (!cfg.url) return c.json({ error: '尚未配置 WebDAV 服务器地址' }, 422)
  const { baseUrl, auth, cleanDir } = webdavBase(cfg)

  const dirUrl = new URL(cleanDir, baseUrl).toString()
  try {
    const res = await fetch(dirUrl, {
      method: 'PROPFIND',
      headers: {
        Authorization: auth,
        Depth: '1',
        'Content-Type': 'application/xml',
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:displayname/>
  </d:prop>
</d:propfind>`,
    })

    if (res.status === 401 || res.status === 403) {
      return c.json({ error: 'WebDAV 认证失败，请检查账号与应用授权码' }, 422)
    }
    if (!res.ok) {
      return c.json({ error: `WebDAV 列出目录失败：HTTP ${res.status} ${res.statusText}`, files: [] }, 200)
    }

    const xml = await res.text()
    const files = parseMultistatus(xml)
      .sort((a, b) => (a.modified < b.modified ? 1 : -1))
    return c.json({
      ok: true,
      files,
      // 调试诊断：原始响应前 3000 字符 + response 节点计数（便于排查服务器返回格式差异）
      xml_sample: xml.slice(0, 3000),
      resp_count: (xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b[^>]*>/g) || []).length,
    })
  } catch (err: any) {
    return c.json({ error: `WebDAV 连接失败：${err?.message || String(err)}`, files: [] }, 200)
  }
})

// 从 WebDAV 下载指定备份并还原（全量覆盖，仅管理员）
app.post('/settings/webdav/restore', requireAdmin, async (c) => {
  const cfg = await getWebDAVConfig(c.env.DB)
  if (!cfg.url) return c.json({ error: '尚未配置 WebDAV 服务器地址' }, 422)
  const b = await c.req.json<{ filename?: string }>().catch(() => null)
  const filename = b?.filename?.trim()
  if (!filename) return c.json({ error: '请指定要恢复的备份文件' }, 422)
  // 防止路径穿越：只允许纯文件名
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return c.json({ error: '非法的文件名' }, 422)
  }

  const { baseUrl, auth, cleanDir } = webdavBase(cfg)
  const fileUrl = new URL(cleanDir + filename, baseUrl).toString()
  try {
    const res = await fetch(fileUrl, { headers: { Authorization: auth } })
    if (res.status === 401 || res.status === 403) {
      return c.json({ error: 'WebDAV 认证失败，请检查账号与应用授权码' }, 422)
    }
    if (!res.ok) {
      return c.json({ error: `下载备份失败：HTTP ${res.status} ${res.statusText}` }, 422)
    }
    const text = await res.text()
    let payload: Partial<BackupData>
    try {
      payload = JSON.parse(text)
    } catch {
      return c.json({ error: '该文件不是有效的 JSON 备份文件' }, 422)
    }
    if (!payload || typeof payload !== 'object' || !payload.tables) {
      return c.json({ error: '该文件不是本系统的备份文件（缺少 tables 字段）' }, 422)
    }

    const imported = await importBackupData(c.env.DB, payload)
    return c.json({ ok: true, imported, filename })
  } catch (err: any) {
    return c.json({ error: `恢复失败：${err?.message || String(err)}` }, 422)
  }
})

export default app
