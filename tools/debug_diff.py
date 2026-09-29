# -*- coding: utf-8 -*-
"""调试导入差异 v2：修正类型与符号约定。"""
import re
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

F = r"C:\Users\Administrator\Downloads\202609291030148.sql"
text = open(F, encoding='utf-8', errors='replace').read()


def parse_values(s):
    rows, cur, buf, in_str = [], None, '', False
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if in_str:
            if c == '\\':
                buf += s[i + 1] if i + 1 < n else ''
                i += 2
                continue
            if c == "'":
                if i + 1 < n and s[i + 1] == "'":
                    buf += "'"
                    i += 2
                    continue
                in_str = False
                i += 1
                continue
            buf += c
            i += 1
            continue
        if c == "'":
            in_str = True
            i += 1
            continue
        if c == '(':
            cur = []
            buf = ''
            i += 1
            continue
        if c == ',':
            cur.append(buf.strip())
            buf = ''
            i += 1
            continue
        if c == ')':
            cur.append(buf.strip())
            rows.append(cur)
            cur = None
            i += 1
            continue
        buf += c
        i += 1
    return rows


def unquote(v):
    if v is None or v == 'NULL':
        return None
    if len(v) >= 2 and v[0] == "'" and v[-1] == "'":
        return v[1:-1]
    return v


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


tables = defaultdict(list)
for m in re.finditer(r'^INSERT INTO `?(\w+)`?\s*\([^)]*\)\s*VALUES\s*(.*?);\s*$', text, re.M | re.S):
    for row in parse_values(m.group(2)):
        tables[m.group(1)].append([unquote(v) for v in row])

schemas = {}
for m in re.finditer(r'CREATE TABLE `(\w+)` \((.*?)\)\s*ENGINE', text, re.S):
    schemas[m.group(1)] = re.findall(r'^\s*`(\w+)`', m.group(2), re.M)

IX = lambda t: {c: i for i, c in enumerate(schemas[t])}
live = lambda v: v in (0, '0')

ix = IX('ci_invoice')
iix = IX('ci_invoice_info')
aix = IX('ci_account_info')
gx = IX('ci_goods')
gids = {int(r[gx['id']]) for r in tables['ci_goods'] if live(r[gx['isDelete']])}

invs = {int(r[ix['id']]): r for r in tables['ci_invoice'] if live(r[ix['isDelete']])}
items_by_iid = defaultdict(list)
for r in tables['ci_invoice_info']:
    if live(r[iix['isDelete']]) and int(r[iix['iid']]) in invs and int(r[iix['invId']] or 0) in gids:
        items_by_iid[int(r[iix['iid']])].append(r)

money_by_iid = defaultdict(float)
for r in tables['ci_account_info']:
    if live(r[aix['isDelete']]):
        money_by_iid[int(r[aix['iid']])] += num(r[aix['payment']])

# ===== 欠款模型验证：债 = Σ 各单 arrears =====
print('=== 欠款 = Σ arrears（快照口径）===')
by_type = defaultdict(float)
for iid, r in invs.items():
    by_type[r[ix['billType']]] += num(r[ix['arrears']])
for k, v in by_type.items():
    print(f'  {k}: {v:.2f}')
print(f'  合计: {sum(by_type.values()):.2f}（期望供应商 6529，客户 0）')
hh = sum(num(r[ix['arrears']]) for r in invs.values() if r[ix['buId']] == 42)
print(f'  宏海(42) arrears 合计: {hh:.2f}')

# ===== 账户流水符号约定 =====
print()
print('=== account_info 各单据类型 payment 符号 ===')
signs = defaultdict(list)
for r in tables['ci_account_info']:
    if live(r[aix['isDelete']]):
        signs[r[aix['billType']]].append(num(r[aix['payment']]))
for k, vals in signs.items():
    pos = sum(1 for v in vals if v > 0)
    neg = sum(1 for v in vals if v < 0)
    print(f'  {k}: 共{len(vals)}行 正{pos}/负{neg} 净额{sum(vals):.2f}')

# ===== PUR 直接付款（负数行）vs arrears 关系 =====
print()
print('=== PUR: paid = amount - arrears 与 account_info 负数行对照 ===')
mismatch = 0
for iid, r in list(invs.items()):
    if r[ix['billType']] != 'PUR':
        continue
    direct = -money_by_iid.get(iid, 0.0)  # 负数行取反=已付
    implied = num(r[ix['amount']]) - num(r[ix['arrears']])
    if abs(direct - implied) > 0.02:
        mismatch += 1
print(f'  direct(-Σai) ≠ amount-arrears 的单据数: {mismatch} / {sum(1 for r in invs.values() if r[ix["billType"]] == "PUR")}')

# ===== 库存重放（符号正确版）=====
print()
print('=== 库存带符号重放 ===')
moves = []
for iid, r in invs.items():
    bt = r[ix['billType']]
    tt = str(r[ix['transType']])
    dt = (r[ix['createTime']] or r[ix['billDate']] or '').replace(' ', 'T')
    for it in items_by_iid.get(iid, []):
        q = num(it[iix['qty']])
        if q == 0:
            continue
        if bt == 'SALE':
            direction = -q if tt == '150601' else abs(q)  # 普通销售出库；销退入库
        elif bt == 'PUR':
            direction = q if tt == '150501' else -abs(q)  # 普通采购入库；采购退货出库
        elif bt == 'OI':
            direction = abs(q)
        elif bt == 'OO':
            direction = -abs(q)
        else:
            continue
        if direction != 0:
            moves.append((dt, direction))
moves.sort(key=lambda m: m[0])
stock = defaultdict(float)
neg_goods = set()
for dt, d in moves:
    pass
# 重放需要商品维度
moves2 = []
for iid, r in invs.items():
    bt = r[ix['billType']]
    tt = str(r[ix['transType']])
    dt = (r[ix['createTime']] or r[ix['billDate']] or '').replace(' ', 'T')
    for it in items_by_iid.get(iid, []):
        q = num(it[iix['qty']])
        if q == 0:
            continue
        if bt == 'SALE':
            direction = -q if tt == '150601' else abs(q)
        elif bt == 'PUR':
            direction = q if tt == '150501' else -abs(q)
        elif bt == 'OI':
            direction = abs(q)
        elif bt == 'OO':
            direction = -abs(q)
        else:
            continue
        if direction != 0:
            moves2.append((dt, int(it[iix['invId']]), direction))
moves2.sort(key=lambda m: m[0])
stock = defaultdict(float)
for dt, gid, d in moves2:
    stock[gid] += d
    if stock[gid] < -0.001:
        neg_goods.add(gid)
total_qty = sum(v for v in stock.values() if v > 0)
print(f'库存总量(正库存合计): {total_qty:.0f} (期望 1818)')
print(f'出现负库存的商品数: {len(neg_goods)}')

# ===== 账户总额验证（我们的模型口径）=====
print()
print('=== 账户总额（我们的口径）===')
sales_paid = sum(max(0.0, money_by_iid.get(iid, 0.0)) for iid, r in invs.items() if r[ix['billType']] == 'SALE')
income = sum(max(0.0, money_by_iid.get(iid, 0.0)) for iid, r in invs.items() if r[ix['billType']] == 'QTSR')
expense = sum(-min(0.0, money_by_iid.get(iid, 0.0)) for iid, r in invs.items() if r[ix['billType']] == 'QTZC')
pur_paid = sum(-min(0.0, money_by_iid.get(iid, 0.0)) for iid, r in invs.items() if r[ix['billType']] == 'PUR')
pay_out = sum(-min(0.0, money_by_iid.get(iid, 0.0)) for iid, r in invs.items() if r[ix['billType']] == 'PAYMENT')
bal = sales_paid + income - pur_paid - expense - pay_out
print(f'销售收 {sales_paid:.2f} + 收入 {income:.2f} - 采购付 {pur_paid:.2f} - 支出 {expense:.2f} - 付款单 {pay_out:.2f} = {bal:.2f} (期望 499917.44)')
