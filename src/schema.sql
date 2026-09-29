-- 进销存数据模型（SQLite / D1）
-- 库存与成本：products.stock 为当前库存（每次入库/出库/盘点原子更新），
-- products.avg_cost 为移动加权平均成本；sale_items.unit_cost 在出库时快照，
-- 保证历史毛利不受后续采购成本波动影响。
-- 删除单据或怀疑漂移时，POST /api/admin/recompute 按全部流水重放
-- （重算库存、均价、往来欠款、账户余额）。

-- 系统配置表（存储动态修改的配置，如 WebDAV、系统标题等）
CREATE TABLE IF NOT EXISTS sys_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 多用户表（支持管理员 admin、普通员工/次级用户 staff、收银员/销售 sales 等）
-- status: 1=正常, 0=禁用
-- permissions: JSON 数组字符串，例如 '["products","sales","stock"]'
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  password    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff', 'sales')),
  status      INTEGER NOT NULL DEFAULT 1,
  permissions TEXT NOT NULL DEFAULT '[]',
  phone       TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  sku           TEXT DEFAULT '',
  barcode       TEXT DEFAULT '',
  category      TEXT DEFAULT '',
  unit          TEXT NOT NULL DEFAULT '件',
  stock         REAL NOT NULL DEFAULT 0,
  avg_cost      REAL NOT NULL DEFAULT 0,   -- 移动加权平均成本
  initial_stock REAL NOT NULL DEFAULT 0,   -- 期初库存
  initial_cost  REAL NOT NULL DEFAULT 0,   -- 期初库存单价（成本基准）
  sale_price    REAL NOT NULL DEFAULT 0,
  low_stock     REAL NOT NULL DEFAULT 0,   -- 低库存预警阈值
  no_stock      INTEGER NOT NULL DEFAULT 0, -- 1=服务类商品，不跟踪库存（维修、服务费等）
  cost_manual   INTEGER NOT NULL DEFAULT 0, -- 1=成本手动指定，不随采购自动重算
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS parties (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL CHECK (type IN ('supplier','customer')),
  name          TEXT NOT NULL,
  phone         TEXT DEFAULT '',
  address       TEXT DEFAULT '',
  contact_man   TEXT DEFAULT '',
  note          TEXT DEFAULT '',
  opening_debt  REAL NOT NULL DEFAULT 0,   -- 期初欠款（客户：客户欠我；供应商：我欠供应商）
  debt          REAL NOT NULL DEFAULT 0,   -- 当前欠款（重算维护）
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 结算账户（现金 / 微信 / 支付宝 / 银行卡等）
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  opening_balance REAL NOT NULL DEFAULT 0,  -- 期初余额
  balance        REAL NOT NULL DEFAULT 0,   -- 当前余额（重算维护）
  note           TEXT DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 资金流水：receipt 收款 / payment 付款 / income 其他收入 / expense 其他支出
-- sale_return 销售退款 / purchase_return 采购退款
CREATE TABLE IF NOT EXISTS funds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  party_id   INTEGER,
  party_name TEXT DEFAULT '',
  account_id INTEGER NOT NULL,
  amount     REAL NOT NULL,
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_funds_account ON funds(account_id);
CREATE INDEX IF NOT EXISTS idx_funds_party   ON funds(party_id);

CREATE TABLE IF NOT EXISTS purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'normal',  -- normal 采购 / return 采购退货
  supplier_id   INTEGER,
  supplier_name TEXT NOT NULL DEFAULT '',
  total         REAL NOT NULL DEFAULT 0,
  discount      REAL NOT NULL DEFAULT 0,         -- 整单优惠金额
  paid          REAL NOT NULL DEFAULT 0,         -- 本次已付款
  account_id    INTEGER,                         -- 结算账户
  refund_way    TEXT DEFAULT '',                 -- 退货退款方式：debt 冲欠款 / account 退回账户
  note          TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  product_id  INTEGER NOT NULL,
  qty         REAL NOT NULL,
  unit_cost   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pitems_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_pitems_product  ON purchase_items(product_id);

CREATE TABLE IF NOT EXISTS sales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'normal',  -- normal 销售 / return 销售退货
  customer_id   INTEGER,
  customer_name TEXT NOT NULL DEFAULT '',
  total         REAL NOT NULL DEFAULT 0,
  discount      REAL NOT NULL DEFAULT 0,         -- 整单优惠金额
  paid          REAL NOT NULL DEFAULT 0,         -- 本次已收款
  account_id    INTEGER,                         -- 结算账户
  refund_way    TEXT DEFAULT '',                 -- 退货退款方式：debt 冲欠款 / account 退回账户
  note          TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty        REAL NOT NULL,
  unit_price REAL NOT NULL,
  unit_cost  REAL NOT NULL   -- 出库时的加权平均成本快照
);
CREATE INDEX IF NOT EXISTS idx_sitems_sale    ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sitems_product ON sale_items(product_id);

CREATE TABLE IF NOT EXISTS adjustments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  qty        REAL NOT NULL,  -- 正数盘盈 / 负数盘亏
  reason     TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_adjust_product ON adjustments(product_id);

CREATE INDEX IF NOT EXISTS idx_sales_time     ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_time ON purchases(created_at);
