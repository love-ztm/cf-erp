# -*- coding: utf-8 -*-
"""调试 v3：明细行符号分布、FKD 往来、多种方向约定试算。"""
import re
import sys
from collections import defaultdict, Counter

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

# ===== 明细行符号分布 =====
print('=== 明细行 qty 符号分布（billType×transType）===')
signs = defaultdict(Counter)
for r in tables['ci_invoice_info']:
    if not live(r[iix['isDelete']]) or int(r[iix['invId']] or 0) not in gids:
        continue
    iid = int(r[iix['iid']])
    if iid not in invs:
        continue
    inv = invs[iid]
    key = (inv[ix['billType']], str(inv[ix['transType']]))
    q = num(r[iix['qty']])
    signs[key]['pos' if q > 0 else 'neg' if q < 0 else 'zero'] += 1
for k, v in sorted(signs.items()):
    print(f'  {k}: {dict(v)}')

# ===== 多种方向约定试算库存总量 =====
print()
print('=== 各约定下的库存总量（正库存合计）===')
moves_by_type = defaultdict(list)  # (date, gid, raw_q)
for r in tables['ci_invoice_info']:
    if not live(r[iix['isDelete']]) or int(r[iix['invId']] or 0) not in gids:
        continue
    iid = int(r[iix['iid']])
    if iid not in invs:
        continue
    inv = invs[iid]
    bt, tt = inv[ix['billType']], str(inv[ix['transType']])
    dt = (inv[ix['createTime']] or inv[ix['billDate']] or '').replace(' ', 'T')
    q = num(r[iix['qty']])
    if q == 0:
        continue
    moves_by_type[(bt, tt)].append((dt, int(r[iix['invId']]), q))

def replay(direction_fn):
    moves = []
    for (bt, tt), lst in moves_by_type.items():
        for dt, gid, q in lst:
            d = direction_fn(bt, tt, q)
            if d:
                moves.append((dt, gid, d))
    moves.sort(key=lambda m: m[0])
    stock = defaultdict(float)
    for dt, gid, d in moves:
        stock[gid] += d
    return sum(v for v in stock.values() if v > 0), sum(1 for v in stock.values() if v < -0.001)

convs = {
    'A: SALE=-q, PUR=+q, OI=+abs, OO=-abs': lambda bt, tt, q: (-q if q else 0) if bt == 'SALE' else (q if bt == 'PUR' else (abs(q) if bt == 'OI' else -abs(q) if bt == 'OO' else 0)),
    'B: SALE=-q, PUR=+abs, OI=+abs, OO=-abs': lambda bt, tt, q: (-q) if bt == 'SALE' else (abs(q) if bt == 'PUR' else (abs(q) if bt == 'OI' else -abs(q) if bt == 'OO' else 0)),
    'C: SALE=+abs, PUR=+q, OI=+abs, OO=-abs': lambda bt, tt, q: (abs(q) if bt == 'SALE' else (q if bt == 'PUR' else (abs(q) if bt == 'OI' else -abs(q) if bt == 'OO' else 0))),
    'D: SALE=-q, PUR=-q, OI=+abs, OO=-abs': lambda bt, tt, q: (-q) if bt == 'SALE' else (-q if bt == 'PUR' else (abs(q) if bt == 'OI' else -abs(q) if bt == 'OO' else 0)),
}
for name, fn in convs.items():
    total, negs = replay(fn)
    print(f'  {name}: 总量 {total:.0f}, 负库存商品 {negs}')

# ===== FKD 付款单的往来单位 =====
print()
print('=== PAYMENT(FKD) buId 分布 ===')
c = Counter(int(r[ix['buId']] or 0) for r in invs.values() if r[ix['billType']] == 'PAYMENT')
print(' ', dict(c))
print('=== QTSR/QTZC buId 分布（前5）===')
c2 = Counter(int(r[ix['buId']] or 0) for r in invs.values() if r[ix['billType']] in ('QTSR', 'QTZC'))
print(' ', dict(list(c2.items())[:5]))

# ===== 余额精确口径：Σ 带符号 account_info =====
print()
print('=== 余额映射（逐单带符号）===')
money_by_iid = defaultdict(float)
for r in tables['ci_account_info']:
    if live(r[aix['isDelete']]):
        money_by_iid[int(r[aix['iid']])] += num(r[aix['payment']])
total = sum(money_by_iid.values())
print(f'Σ account_info 带符号净额 = {total:.2f} (期望 499917.44)')
# 各类型贡献
per = defaultdict(float)
for iid, r in invs.items():
    per[r[ix['billType']]] += money_by_iid.get(iid, 0.0)
for k, v in per.items():
    print(f'  {k}: {v:.2f}')
neg_sales = [(iid, v) for iid, r in invs.items() if r[ix['billType']] == 'SALE' and money_by_iid.get(iid, 0) < 0]
print('  负数销售行:', neg_sales)
