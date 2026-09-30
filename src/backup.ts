import { Hono } from 'hono'
import { recomputeAll } from './db'
import { requireAdmin } from './auth'

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>()

// 需要备份/还原的所有业务表清单（按外键/关联顺序，包含多用户 users）
export const BACKUP_TABLES = [
  'users',
  'accounts',
  'parties',
  'products',
  'purchases',
  'purchase_items',
  'sales',
  'sale_items',
  'funds',
  'adjustments',
  'sys_config',
] as const

export type BackupData = {
  version: 1
  generator: 'Cloud ERP'
  exported_at: string
  counts: Record<string, number>
  tables: Record<string, Array<Record<string, unknown>>>
}

// 提取公用函数：直接从 D1 提取全量 JSON 备份对象
export async function generateBackupPayload(db: D1Database): Promise<BackupData> {
  const tables: Record<string, Array<Record<string, unknown>>> = {}
  const counts: Record<string, number> = {}

  for (const t of BACKUP_TABLES) {
    const res = await db.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>()
    tables[t] = res.results ?? []
    counts[t] = tables[t].length
  }

  return {
    version: 1,
    generator: 'Cloud ERP',
    exported_at: new Date().toISOString(),
    counts,
    tables,
  }
}

// 导出全库备份（JSON 格式，自包含全部业务表）
app.get('/backup/export', requireAdmin, async (c) => {
  const db = c.env.DB
  const payload = await generateBackupPayload(db)

  const filename = `ERP备份_${new Date().toISOString().slice(0, 10)}.json`
  c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
  return c.json(payload)
})

// 上传并还原备份（全量覆盖，还原后自动按流水重放重算）
// 抽取为公用函数，供 /backup/import 与 WebDAV 远程恢复共用
export async function importBackupData(db: D1Database, body: Partial<BackupData>): Promise<Record<string, number>> {
  const tdata = body.tables ?? {}
  // 1. 清空所有现有业务数据
  const cleanStmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM sale_items'),
    db.prepare('DELETE FROM sales'),
    db.prepare('DELETE FROM purchase_items'),
    db.prepare('DELETE FROM purchases'),
    db.prepare('DELETE FROM adjustments'),
    db.prepare('DELETE FROM funds'),
    db.prepare('DELETE FROM accounts'),
    db.prepare('DELETE FROM parties'),
    db.prepare('DELETE FROM products'),
    db.prepare('DELETE FROM users'),
    db.prepare('DELETE FROM sys_config'),
    db.prepare('DELETE FROM sqlite_sequence'),
  ]
  await db.batch(cleanStmts)

  // 2. 逐表分批插入还原数据（每批最多 100 条避免 D1 限制）
  const insertCounts: Record<string, number> = {}
  for (const t of BACKUP_TABLES) {
    const rows = Array.isArray(tdata[t]) ? tdata[t] : []
    insertCounts[t] = rows.length
    if (!rows.length) continue

    const batchSize = 100
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize)
      const stmts: D1PreparedStatement[] = chunk.map((r) => {
        const keys = Object.keys(r)
        const cols = keys.join(', ')
        const placeholders = keys.map((_, idx) => `?${idx + 1}`).join(', ')
        const vals = keys.map((k) => r[k])
        return db.prepare(`INSERT INTO ${t} (${cols}) VALUES (${placeholders})`).bind(...vals)
      })
      await db.batch(stmts)
    }
  }

  // 3. 自动按流水重算库存、欠款与余额
  await recomputeAll(db)
  return insertCounts
}

app.post('/backup/import', requireAdmin, async (c) => {
  const db = c.env.DB
  const body = await c.req.json<Partial<BackupData>>().catch(() => null)
  if (!body || typeof body !== 'object' || !body.tables) {
    return c.json({ error: '无效的备份文件格式' }, 422)
  }

  const insertCounts = await importBackupData(db, body)
  return c.json({ ok: true, imported: insertCounts })
})

// 危险操作：清空全部业务数据（仅管理员可执行，保留当前用户与空表结构）
app.post('/backup/clear-all', requireAdmin, async (c) => {
  const db = c.env.DB
  const b = await c.req.json<{ confirmation?: string }>()
  if (b.confirmation !== '确认清空全部数据') {
    return c.json({ error: '确认口令不正确，操作已取消' }, 422)
  }

  const cleanStmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM sale_items'),
    db.prepare('DELETE FROM sales'),
    db.prepare('DELETE FROM purchase_items'),
    db.prepare('DELETE FROM purchases'),
    db.prepare('DELETE FROM adjustments'),
    db.prepare('DELETE FROM funds'),
    db.prepare('DELETE FROM accounts'),
    db.prepare('DELETE FROM parties'),
    db.prepare('DELETE FROM products'),
    db.prepare('DELETE FROM sqlite_sequence'),
  ]
  await db.batch(cleanStmts)
  return c.json({ ok: true })
})

export default app
