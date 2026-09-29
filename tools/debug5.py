# -*- coding: utf-8 -*-
"""调试 v5：goods 标志（库存品/非库存品）对库存重放的影响。"""
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
gx = IX('ci_goods')

goods = {}
for r in tables['ci_goods']:
    if live(r[gx['isDelete']]):
        goods[int(r[gx['id']])] = r

print('=== goods 字段取值分布 ===')
print('goods:', dict(defaultctl := defaultdict(int, ((str(r[gx['goods']]), sum(1 for x in goods.values() if str(x[gx['goods']]) == str(r[gx['goods']]))) for r in list(goods.values())[:0]))))
c = defaultdict(int)
for r in goods.values():
    c[str(r[gx['goods']])] += 1
print('goods:', dict(c))
c2 = defaultdict(int)
for r in goods.values():
    c2[str(r[gx['status']])] += 1
print('status:', dict(c2))

print()
print('=== goods=0 的商品样本 ===')
n = 0
for gid, r in goods.items():
    if str(r[gx['goods']]) == '0' and n < 8:
        print(f"  {gid} {r[gx['name']]!r} cat={r[gx['categoryName']]!r}")
        n += 1

# 分组重放
invs = {int(r[ix['id']]): r for r in tables['ci_invoice'] if live(r[ix['isDelete']])}
moves = []
for r in tables['ci_invoice_info']:
    if not live(r[iix['isDelete']]):
        continue
    gid = int(r[iix['invId']] or 0)
    if gid not in goods:
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
    flag = str(goods[gid][gx['goods']])
    price = num(r[iix['price']])
    moves.append((dt, gid, d, price, flag))

moves.sort(key=lambda m: m[0])

def replay(only_flag=None):
    stock = defaultdict(float)
    avg = defaultdict(float)
    for dt, gid, d, price, flag in moves:
        if only_flag is not None and flag != only_flag:
            continue
        if d > 0 and price > 0:
            total = stock[gid] + d
            avg[gid] = (stock[gid] * avg[gid] + d * price) / total if total > 0 else price
        stock[gid] += d
    tot = sum(v for v in stock.values() if v > 0)
    val = sum(v * avg.get(g, 0) for g, v in stock.items() if v > 0)
    return tot, val

for label, flag in [('全部', None), ('仅 goods=1(库存品)', '1'), ('仅 goods=0', '0')]:
    tot, val = replay(flag)
    print(f'{label}: 数量 {tot:.0f} 成本 {val:.2f}')
print('期望: 1818 / 34147.99')
