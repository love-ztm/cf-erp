# -*- coding: utf-8 -*-
"""解析老 ERP 的 MySQL 备份，输出表结构与行数统计。"""
import re
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

F = r"C:\Users\Administrator\Downloads\202609291030148.sql"
text = open(F, encoding='utf-8', errors='replace').read()


def parse_values(s):
    """解析 MySQL VALUES 元组，正确处理引号与转义。返回行列表。"""
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
    if v is None:
        return None
    if v == 'NULL':
        return None
    if len(v) >= 2 and v[0] == "'" and v[-1] == "'":
        return v[1:-1]
    return v


tables = defaultdict(list)
for m in re.finditer(r'^INSERT INTO `?(\w+)`?\s*\([^)]*\)\s*VALUES\s*(.*?);\s*$', text, re.M | re.S):
    t = m.group(1)
    for row in parse_values(m.group(2)):
        tables[t].append([unquote(v) for v in row])

# CREATE TABLE 的列定义
schemas = {}
for m in re.finditer(r'CREATE TABLE `(\w+)` \((.*?)\)\s*ENGINE', text, re.S):
    cols = re.findall(r'^\s*`(\w+)`', m.group(2), re.M)
    schemas[m.group(1)] = cols

print('=== 行数统计 ===')
for t in sorted(tables, key=lambda x: -len(tables[x])):
    print(f'{t}: {len(tables[t])}')

if 'ci_invoice' in tables:
    idx = {c: i for i, c in enumerate(schemas['ci_invoice'])}
    inv = tables['ci_invoice']
    from collections import Counter
    tt = Counter((r[idx['transTypeName']], r[idx['billType']]) for r in inv if r[idx['isDelete']] in (0, '0'))
    print()
    print('=== ci_invoice 单据类型（未删除）===')
    for (name, bt), n in tt.most_common():
        print(f'{name} ({bt}): {n}')
    dates = sorted(r[idx['billDate']] for r in inv if r[idx['billDate']])
    print('单据日期范围:', dates[0], '→', dates[-1])

if 'ci_contact' in tables:
    idx = {c: i for i, c in enumerate(schemas['ci_contact'])}
    from collections import Counter
    ct = Counter(r[idx['type']] for r in tables['ci_contact'] if r[idx['isDelete']] in (0, '0'))
    print()
    print('=== ci_contact 往来单位 ===', dict(ct))

if 'ci_goods' in tables:
    n = sum(1 for r in tables['ci_goods'] if r[schemas['ci_goods'].index('isDelete')] in (0, '0'))
    print('=== ci_goods 商品（未删除）===', n)

if 'ci_account_info' in tables:
    idx = {c: i for i, c in enumerate(schemas['ci_account_info'])}
    from collections import Counter
    bt = Counter(r[idx['billType']] for r in tables['ci_account_info'] if r[idx['isDelete']] in (0, '0'))
    print('=== ci_account_info 资金流水类型 ===', dict(bt))

if 'ci_account' in tables:
    print('=== ci_account 账户 ===')
    for r in tables['ci_account']:
        print(' ', r)

if 'ci_storage' in tables:
    print('=== ci_storage 仓库 ===')
    for r in tables['ci_storage']:
        print(' ', r[:3])

print()
print('=== 关键表结构 ===')
for t in ['ci_contact', 'ci_goods', 'ci_invoice', 'ci_invoice_info', 'ci_invoice_type',
          'ci_account', 'ci_account_info', 'ci_storage', 'ci_unit', 'ci_category', 'ci_order', 'ci_order_info']:
    if t in schemas:
        print(f'{t}: {schemas[t]}')
