# -*- coding: utf-8 -*-
"""调试 v4：iid 1567 之谜、FKD 样本、商品 quantity、分仓库存。"""
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

invs = {int(r[ix['id']]): r for r in tables['ci_invoice'] if live(r[ix['isDelete']])}

print('=== invoice 1567 ===')
r = invs.get(1567)
if r:
    print(f"billNo={r[ix['billNo']]} billType={r[ix['billType']]} transType={r[ix['transType']]} transName={r[ix['transTypeName']]} date={r[ix['billDate']]} total={r[ix['totalAmount']]} amount={r[ix['amount']]} rp={r[ix['rpAmount']]} arrears={r[ix['arrears']]} disc={r[ix['disAmount']]} accId={r[ix['accId']]} desc={r[ix['description']]!r}")
print('它的 account_info 行:')
for a in tables['ci_account_info']:
    if int(a[aix['iid']] or 0) == 1567:
        print(f"  id={a[aix['id']]} billType={a[aix['billType']]} accId={a[aix['accId']]} payment={a[aix['payment']]} wayId={a[aix['wayId']]} remark={a[aix['remark']]!r}")

print()
print('=== account_info 中 billType=SALE 且 payment<0 的行 ===')
for a in tables['ci_account_info']:
    if a[aix['billType']] == 'SALE' and num(a[aix['payment']]) < 0:
        iid = int(a[aix['iid']] or 0)
        inv = invs.get(iid)
        print(f"  row_id={a[aix['id']]} iid={iid} inv_billNo={inv[ix['billNo']] if inv else '?'} inv_type={inv[ix['billType']] if inv else '?'} payment={a[aix['payment']]} remark={a[aix['remark']]!r}")

print()
print('=== FKD 付款单样本 ===')
n = 0
for r in invs.values():
    if r[ix['billType']] == 'PAYMENT' and n < 5:
        print(f"{r[ix['billNo']]} buId={r[ix['buId']]} date={r[ix['billDate']]} pay={r[ix['payment']]} rp={r[ix['rpAmount']]} arrears={r[ix['arrears']]} accId={r[ix['accId']]} desc={r[ix['description']]!r}")
        n += 1

print()
print('=== ci_goods.quantity 非零统计 ===')
nz = [(int(r[gx['id']]), r[gx['name']], r[gx['quantity']]) for r in tables['ci_goods'] if live(r[gx['isDelete']]) and num(r[gx['quantity']]) != 0]
print(f'非零数量商品: {len(nz)} 个')
for t in nz[:10]:
    print(' ', t)

print()
print('=== 分仓库库存重放（约定 A）===')
moves = []
for r in tables['ci_invoice_info']:
    if not live(r[iix['isDelete']]) or int(r[iix['invId']] or 0) not in {int(x[gx['id']]) for x in tables['ci_goods'] if live(x[gx['isDelete']])}:
        continue
    iid = int(r[iix['iid']] or 0)
    if iid not in invs:
        continue
    inv = invs[iid]
    bt, tt = inv[ix['billType']], str(inv[ix['transType']])
    dt = (inv[ix['createTime']] or inv[ix['billDate']] or '').replace(' ', 'T')
    q = num(r[iix['qty']])
    if q == 0:
        continue
    if bt == 'SALE':
        d = -q if tt == '150601' else abs(q)
    elif bt == 'PUR':
        d = q if tt == '150501' else -abs(q)
    elif bt == 'OI':
        d = abs(q)
    elif bt == 'OO':
        d = -abs(q)
    else:
        continue
    moves.append((dt, int(r[iix['locationId']] or 0), int(r[iix['invId']]), d, num(r[iix['price']])))

moves.sort(key=lambda m: m[0])
stock_all = defaultdict(float)
stock_by_loc = defaultdict(lambda: defaultdict(float))
for dt, loc, gid, d, price in moves:
    stock_all[gid] += d
    stock_by_loc[loc][gid] += d

# 成本：按采购价重放均价（入库行为正且 price>0 时更新均价）
avg = defaultdict(float)
stock2 = defaultdict(float)
for dt, loc, gid, d, price in moves:
    if d > 0 and price > 0:
        total = stock2[gid] + d
        avg[gid] = (stock2[gid] * avg[gid] + d * price) / total if total > 0 else price
    stock2[gid] += d

print('各仓库库存总量（正库存合计）:')
for loc in sorted(stock_by_loc):
    tot = sum(v for v in stock_by_loc[loc].values() if v > 0)
    val = sum(v * avg.get(g, 0) for g, v in stock_by_loc[loc].items() if v > 0)
    print(f'  仓库 {loc}: 数量 {tot:.0f}  成本 {val:.2f}')
tot_all = sum(v for v in stock_all.values() if v > 0)
val_all = sum(v * avg.get(g, 0) for g, v in stock_all.items() if v > 0)
print(f'全部仓库: 数量 {tot_all:.0f}  成本 {val_all:.2f} (期望 1818 / 34147.99)')
