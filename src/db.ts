import schemaSql from './schema.sql'

// 每个 isolate 只初始化一次（幂等）
let initPromise: Promise<unknown> | null = null

// D1 的 exec() 对注释与多行语句支持不佳，自己按分号切分后用 batch 执行
const statements = schemaSql
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)

// 旧库补列（CREATE TABLE IF NOT EXISTS 不会更新已存在的表）
const MIGRATIONS: Array<[string, Record<string, string>]> = [
  ['products', { barcode: "TEXT DEFAULT ''", category: "TEXT DEFAULT ''", no_stock: 'INTEGER NOT NULL DEFAULT 0', cost_manual: 'INTEGER NOT NULL DEFAULT 0' }],
  ['parties', { opening_debt: 'REAL NOT NULL DEFAULT 0', debt: 'REAL NOT NULL DEFAULT 0', address: "TEXT DEFAULT ''", contact_man: "TEXT DEFAULT ''" }],
  [
    'sales',
    {
      kind: "TEXT NOT NULL DEFAULT 'normal'",
      discount: 'REAL NOT NULL DEFAULT 0',
      paid: 'REAL NOT NULL DEFAULT 0',
      account_id: 'INTEGER',
      refund_way: "TEXT DEFAULT ''",
      user_id: 'INTEGER',
      user_name: "TEXT DEFAULT ''",
    },
  ],
  [
    'purchases',
    {
      kind: "TEXT NOT NULL DEFAULT 'normal'",
      discount: 'REAL NOT NULL DEFAULT 0',
      paid: 'REAL NOT NULL DEFAULT 0',
      account_id: 'INTEGER',
      refund_way: "TEXT DEFAULT ''",
      user_id: 'INTEGER',
      user_name: "TEXT DEFAULT ''",
    },
  ],
  [
    'funds',
    {
      user_id: 'INTEGER',
      user_name: "TEXT DEFAULT ''",
    },
  ],
  [
    'users',
    {
      permissions: "TEXT NOT NULL DEFAULT '[]'",
    },
  ],
  // 手填配件（未入库商品/拆机件）：product_id = 0，名称存 name
  ['repair_items', { name: "TEXT DEFAULT ''" }],
  ['repairs', { solution: "TEXT DEFAULT ''" }],
  ['sale_items', { name: "TEXT DEFAULT ''" }],
]

async function ensureColumns(db: D1Database, table: string, cols: Record<string, string>) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
  const have = new Set((info.results ?? []).map((r) => r.name))
  const missing = Object.entries(cols).filter(([c]) => !have.has(c))
  if (missing.length) {
    await db.batch(missing.map(([c, ddl]) => db.prepare(`ALTER TABLE ${table} ADD COLUMN ${c} ${ddl}`)))
  }
}

export function ensureSchema(db: D1Database) {
  if (!initPromise) {
    initPromise = (async () => {
      await db.batch(statements.map((sql) => db.prepare(sql)))
      for (const [table, cols] of MIGRATIONS) await ensureColumns(db, table, cols)
    })().catch((e) => {
      initPromise = null
      throw e
    })
  }
  return initPromise
}

export function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// 单据日期（本地 YYYY-MM-DD）→ 存库 ISO（UTC）。取当地中午 12 点，确保落在所选日期内；非法输入返回 null（用当前时间）
export function docDateToISO(d?: string): string | null {
  const s = (d ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const dt = new Date(s + 'T12:00:00')
  return isNaN(dt.getTime()) ? null : dt.toISOString()
}

export type LedgerRow = {
  product_id: number
  type: 'purchase' | 'sale' | 'repair' | 'adjust'
  kind: 'normal' | 'return' | ''
  qty: number
  unit_cost: number | null
  created_at: string
}

// 库存流水方向：采购+ 采购退货- 销售- 销售退货+ 维修领用- 盘点±
export const MOVE_SIGN: Record<string, number> = {
  'purchase:normal': 1,
  'purchase:return': -1,
  'sale:normal': -1,
  'sale:return': 1,
  'repair:normal': -1,
  'adjust:': 1,
}

// 全部库存流水，按（时间, 类型）排序，供报表与重算使用；服务类商品（不跟踪库存）不参与
export async function loadLedger(db: D1Database, before?: string) {
  const res = await db
    .prepare(
      `SELECT product_id, type, kind, qty, unit_cost, created_at FROM (
         SELECT pi.product_id AS product_id, 'purchase' AS type, pu.kind AS kind,
                pi.qty AS qty, pi.unit_cost AS unit_cost, pu.created_at AS created_at
           FROM purchase_items pi
           JOIN purchases pu ON pu.id = pi.purchase_id
           JOIN products p2 ON p2.id = pi.product_id
          WHERE p2.no_stock = 0
         UNION ALL
         SELECT si.product_id, 'sale', s.kind, si.qty, si.unit_cost, s.created_at
           FROM sale_items si
           JOIN sales s ON s.id = si.sale_id
           JOIN products p ON p.id = si.product_id
          WHERE p.no_stock = 0
         UNION ALL
         SELECT ri.product_id, 'repair', 'normal', ri.qty, ri.unit_cost, r.created_at
           FROM repair_items ri
           JOIN repairs r ON r.id = ri.repair_id
           JOIN products p ON p.id = ri.product_id
          WHERE p.no_stock = 0
         UNION ALL
         SELECT product_id, 'adjust', '', qty, NULL, created_at FROM adjustments
       )
       WHERE (?1 = '' OR created_at < ?1)
       ORDER BY created_at, type`
    )
    .bind(before ?? '')
    .all<LedgerRow>()
  return res.results ?? []
}

// 按流水重放（重算）所有商品的库存与移动加权平均成本
async function recomputeStock(db: D1Database, ledger: LedgerRow[]) {
  const products = await db
    .prepare('SELECT id, initial_stock, initial_cost, cost_manual, avg_cost FROM products')
    .all<{ id: number; initial_stock: number; initial_cost: number; cost_manual: number; avg_cost: number }>()
  const state = new Map<number, { stock: number; avg: number; manual: boolean }>()
  for (const p of products.results ?? []) {
    // 手动锁定成本的商品以其当前 avg_cost 为基准；自动商品从期初成本开始重放
    state.set(p.id, { stock: p.initial_stock, avg: p.cost_manual ? p.avg_cost : p.initial_cost, manual: !!p.cost_manual })
  }
  for (const m of ledger) {
    const s = state.get(m.product_id)
    if (!s) continue
    const sign = MOVE_SIGN[`${m.type}:${m.kind}`] ?? 1
    if (m.type === 'purchase' && m.kind === 'normal') {
      const total = s.stock + m.qty
      if (!s.manual) {
        // 手动锁定成本的商品跳过均价重算
        s.avg = total > 0 ? (s.stock * s.avg + m.qty * (m.unit_cost ?? 0)) / total : m.unit_cost ?? 0
      }
    }
    s.stock += sign * m.qty
  }
  const stmts: D1PreparedStatement[] = []
  for (const [id, s] of state) {
    stmts.push(
      db.prepare('UPDATE products SET stock = ?1, avg_cost = ?2 WHERE id = ?3').bind(s.stock, s.avg, id)
    )
  }
  if (stmts.length) await db.batch(stmts)
  return state.size
}

// 重算往来欠款与账户余额（期初值 + 单据 + 收付款流水）
export async function recomputeMoney(db: D1Database) {
  const [parties, accounts, sales, purchases, funds, repairs] = await Promise.all([
    db.prepare('SELECT id, type, opening_debt FROM parties').all<{ id: number; type: string; opening_debt: number }>(),
    db.prepare('SELECT id, opening_balance FROM accounts').all<{ id: number; opening_balance: number }>(),
    db.prepare('SELECT customer_id, kind, total, discount, paid, account_id, refund_way FROM sales').all<{
      customer_id: number | null
      kind: string
      total: number
      discount: number
      paid: number
      account_id: number | null
      refund_way: string
    }>(),
    db.prepare('SELECT supplier_id, kind, total, discount, paid, account_id, refund_way FROM purchases').all<{
      supplier_id: number | null
      kind: string
      total: number
      discount: number
      paid: number
      account_id: number | null
      refund_way: string
    }>(),
    db.prepare('SELECT type, party_id, account_id, amount FROM funds').all<{
      type: string
      party_id: number | null
      account_id: number
      amount: number
    }>(),
    db.prepare('SELECT customer_id, fee, parts_total, discount, paid, account_id FROM repairs').all<{
      customer_id: number | null
      fee: number
      parts_total: number
      discount: number
      paid: number
      account_id: number | null
    }>(),
  ])

  const debt = new Map<number, number>()
  for (const p of parties.results ?? []) debt.set(p.id, p.opening_debt)
  const balance = new Map<number, number>()
  for (const a of accounts.results ?? []) balance.set(a.id, a.opening_balance)

  // 欠款变动：销售/采购单欠款（净额-已收付）、退货冲欠款、收付款单
  for (const s of sales.results ?? []) {
    const net = (s.total ?? 0) - (s.discount ?? 0)
    if (s.kind === 'return') {
      if (s.refund_way === 'debt' && s.customer_id) debt.set(s.customer_id, (debt.get(s.customer_id) ?? 0) - net)
      if (s.refund_way === 'account' && s.account_id) balance.set(s.account_id, (balance.get(s.account_id) ?? 0) - net)
    } else {
      if (s.customer_id) debt.set(s.customer_id, (debt.get(s.customer_id) ?? 0) + net - (s.paid ?? 0))
      if (s.account_id && s.paid) balance.set(s.account_id, (balance.get(s.account_id) ?? 0) + s.paid)
    }
  }
  for (const pu of purchases.results ?? []) {
    const net = (pu.total ?? 0) - (pu.discount ?? 0)
    if (pu.kind === 'return') {
      if (pu.refund_way === 'debt' && pu.supplier_id) debt.set(pu.supplier_id, (debt.get(pu.supplier_id) ?? 0) - net)
      if (pu.refund_way === 'account' && pu.account_id) balance.set(pu.account_id, (balance.get(pu.account_id) ?? 0) + net)
    } else {
      if (pu.supplier_id) debt.set(pu.supplier_id, (debt.get(pu.supplier_id) ?? 0) + net - (pu.paid ?? 0))
      if (pu.account_id && pu.paid) balance.set(pu.account_id, (balance.get(pu.account_id) ?? 0) - pu.paid)
    }
  }
  for (const f of funds.results ?? []) {
    const dir = f.type === 'receipt' || f.type === 'income' || f.type === 'purchase_return' ? 1 : -1
    if (f.account_id) balance.set(f.account_id, (balance.get(f.account_id) ?? 0) + dir * f.amount)
    if ((f.type === 'receipt' || f.type === 'payment') && f.party_id) {
      debt.set(f.party_id, (debt.get(f.party_id) ?? 0) - f.amount)
    }
  }
  // 维修单：应收 = 维修费 + 配件费 - 优惠；已收进账户，未收挂客户欠款
  for (const r of repairs.results ?? []) {
    const net = (r.fee ?? 0) + (r.parts_total ?? 0) - (r.discount ?? 0)
    if (r.customer_id) debt.set(r.customer_id, (debt.get(r.customer_id) ?? 0) + net - (r.paid ?? 0))
    if (r.account_id && r.paid) balance.set(r.account_id, (balance.get(r.account_id) ?? 0) + r.paid)
  }

  const stmts: D1PreparedStatement[] = []
  for (const [id, d] of debt) stmts.push(db.prepare('UPDATE parties SET debt = ?1 WHERE id = ?2').bind(d, id))
  for (const [id, b] of balance)
    stmts.push(db.prepare('UPDATE accounts SET balance = ?1 WHERE id = ?2').bind(b, id))
  if (stmts.length) await db.batch(stmts)
}

export async function recomputeAll(db: D1Database) {
  const ledger = await loadLedger(db)
  const products = await recomputeStock(db, ledger)
  await recomputeMoney(db)
  return { products, moves: ledger.length }
}
