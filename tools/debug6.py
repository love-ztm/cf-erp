# -*- coding: utf-8 -*-
"""逐商品对账：真值 invBalance vs 本地重放，找差异规律。"""
import json
import re
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

F = r"C:\Users\Administrator\Downloads\202609291030148.sql"
TRUTH = r"C:\Users\Administrator\ZCodeProject\cf-erp\tools\inv_balance_truth.json"
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
goods_by_number = {}
goods_by_name = {}
for r in tables['ci_goods']:
    if not live(r[gx['isDelete']]):
        continue
    gid = int(r[gx['id']])
    goods[gid] = r
    if r[gx['number']]:
        goods_by_number[str(r[gx['number']])] = gid
    goods_by_name[(r[gx['name']], r[gx['spec']] or '')] = gid

truth = json.load(open(TRUTH, encoding='utf-8'))

# 真值按 goods id 对齐（invNo = 商品编号或 id）
truth_qty = {}
matched = 0
unmatched = []
for row in truth:
    gid = goods_by_number.get(str(row['invNo']))
    if gid is None and str(row['invNo']).isdigit() and int(row['invNo']) in goods:
        gid = int(row['invNo'])
    if gid is None:
        gid = goods_by_name.get((row['invName'], row['spec'] or ''))
    if gid is None:
        unmatched.append((row['invNo'], row['invName']))
        continue
    matched += 1
    truth_qty[gid] = (float(row['qty_1']), float(row['cost_1']))

print(f'真值 {len(truth)} 行，对齐 {matched}，未对齐 {len(unmatched)}: {unmatched[:5]}')

# 重放（约定 A，成本用入库 price 重放均价）
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
    moves.append((dt, gid, d, num(r[iix['price']])))
moves.sort(key=lambda m: m[0])

stock = defaultdict(float)
avg = defaultdict(float)
for dt, gid, d, price in moves:
    if d > 0 and price > 0:
        total = stock[gid] + d
        avg[gid] = (stock[gid] * avg[gid] + d * price) / total if total > 0 else price
    stock[gid] += d

# 对账
diffs = []
for gid, (tq, tc) in truth_qty.items():
    rq = round(stock.get(gid, 0), 3)
    if abs(rq - tq) > 0.001:
        diffs.append((gid, goods[gid][gx['name']], tq, rq, tq - rq))
print(f'有差异商品: {len(diffs)} / {len(truth_qty)}')
diff_total = sum(d for _, _, _, _, d in diffs)
print(f'差异合计(真值-重放): {diff_total:.0f}')
print()
print('差异最大的 15 个商品（真值数量 | 重放数量 | 差）:')
for gid, name, tq, rq, d in sorted(diffs, key=lambda x: -abs(x[4]))[:15]:
    print(f'  [{gid}] {str(name)[:24]!r}: 真 {tq} | 放 {rq} | 差 {d:.0f}')

# 打印一个差异最大商品的全部流水，找规律
gid0 = sorted(diffs, key=lambda x: -abs(x[4]))[0][0]
print()
print(f'=== 商品 {gid0} {str(goods[gid0][gx["name"]])!r} 的全部流水 ===')
for dt, g, d, price in moves:
    if g == gid0:
        print(f'  {dt} {d:+.0f} @ {price}')
