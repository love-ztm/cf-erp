# -*- coding: utf-8 -*-
"""逐商品对比 D1 products.stock 与 invBalance 真值。"""
import json
import subprocess
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

truth = json.load(open(r"C:\Users\Administrator\ZCodeProject\cf-erp\tools\inv_balance_truth.json", encoding='utf-8'))

r = subprocess.run(
    ["npx", "wrangler", "d1", "execute", "cf-erp", "--local", "-y", "--json",
     "--command", "SELECT id, name, sku, stock, avg_cost FROM products"],
    cwd=r"C:\Users\Administrator\ZCodeProject\cf-erp",
    capture_output=True, text=True, encoding='utf-8', shell=True,
)
d = json.loads(r.stdout)
prods = d[0]['results']

by_sku = {}
by_id = {}
for p in prods:
    by_id[p['id']] = p
    if p['sku']:
        by_sku[str(p['sku'])] = p

matched, unmatched = {}, []
for row in truth:
    p = by_sku.get(str(row['invNo']))
    if p is None and str(row['invNo']).isdigit():
        p = by_id.get(int(row['invNo']))
    if p is None:
        unmatched.append(row)
        continue
    matched[p['id']] = (row['qty_1'], row['cost_1'], p)

print(f'对齐 {len(matched)} / 真值 {len(truth)}，未对齐 {len(unmatched)}（已删商品残留，跳过）')
diffs = []
tot_truth = tot_ours = 0.0
for pid, (tq, tc, p) in matched.items():
    tot_truth += tq
    tot_ours += p['stock']
    d = p['stock'] - tq
    if abs(d) > 0.001:
        diffs.append((pid, p['name'], tq, p['stock'], d, p['avg_cost'], (tc / tq if tq else 0)))

print(f'真值总量 {tot_truth:.0f}  我们总量 {tot_ours:.0f}  差 {tot_ours - tot_truth:.0f}')
print(f'有差异商品 {len(diffs)} 个')
print('\n差异最大 12 个:')
for pid, name, tq, ours, d, avg, tuc in sorted(diffs, key=lambda x: -abs(x[4]))[:12]:
    print(f'  [{pid}] {str(name)[:22]!r} 真={tq} 我={ours} 差={d:.0f} 我均价={avg:.2f} 真单价={tuc:.2f}')

# 差异的符号分布
pos = sum(1 for x in diffs if x[4] > 0)
neg = sum(1 for x in diffs if x[4] < 0)
print(f'\n我比真值多 {pos} 个商品，少 {neg} 个')
print('差异绝对值合计:', sum(abs(x[4]) for x in diffs))
