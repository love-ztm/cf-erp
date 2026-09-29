# -*- coding: utf-8 -*-
"""老 ERP MySQL 备份 → cf-erp D1 导入 SQL 转换器（最终版）。

用法：python tools/migrate.py
输出：tools/import.sql

导入后调用 POST /api/admin/recompute 重放流水，结果对齐老系统当前状态：
- 账户余额 = Σ ci_account_info（公账民生银行 499917.44）
- 往来欠款 = 联系人快照 contact.amount（宏海 6529 等）
- 商品库存 = invBalance 真值（约 1818 件 / 34193 元），通过"历史库存校准"盘点调整对齐
"""
import json
import re
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

F = r"C:\Users\Administrator\Downloads\202609291030148.sql"
TRUTH = r"C:\Users\Administrator\ZCodeProject\cf-erp\tools\inv_balance_truth.json"
OUT = r"C:\Users\Administrator\ZCodeProject\cf-erp\tools\import.sql"

DEFAULT_ACCOUNT_ID = 7  # 公账民生银行
NOW = '2026-09-29T10:30:00.000Z'  # 校准调整的入账时间（排在所有历史单据之后）


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


def num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def round2(x):
    return round(x + 1e-9, 2)


def round3(x):
    return round(x + 1e-9, 3)


def q(v):
    if v is None:
        return 'NULL'
    return "'" + str(v).replace("'", "''") + "'"


def n2(v):
    return ('%.2f' % v).rstrip('0').rstrip('.')


def n3(v):
    return ('%.3f' % v).rstrip('0').rstrip('.')


def iso_dt(v, date=None):
    if v:
        s = v.replace(' ', 'T')
        return s + ('.000Z' if '.' not in s else '')
    if date:
        return date + 'T00:00:00.000Z'
    return None


text = open(F, encoding='utf-8', errors='replace').read()

tables = defaultdict(list)
for m in re.finditer(r'^INSERT INTO `?(\w+)`?\s*\([^)]*\)\s*VALUES\s*(.*?);\s*$', text, re.M | re.S):
    for row in parse_values(m.group(2)):
        tables[m.group(1)].append([unquote(v) for v in row])

schemas = {}
for m in re.finditer(r'CREATE TABLE `(\w+)` \((.*?)\)\s*ENGINE', text, re.S):
    schemas[m.group(1)] = re.findall(r'^\s*`(\w+)`', m.group(2), re.M)

IX = lambda t: {c: i for i, c in enumerate(schemas[t])}
live = lambda v: v in (0, '0')

warnings = []

# ===== 账户 =====
ax = IX('ci_account')
accounts = []
for r in tables['ci_account']:
    if not live(r[ax['isDelete']]):
        continue
    accounts.append({'id': int(r[ax['id']]), 'name': r[ax['name']], 'opening_balance': 0, 'note': ''})

# ===== 往来单位 =====
px = IX('ci_contact')
ix = IX('ci_invoice')

invs = {int(r[ix['id']]): r for r in tables['ci_invoice'] if live(r[ix['isDelete']])}

contact_amount = {}
parties = []
for r in tables['ci_contact']:
    if not live(r[px['isDelete']]):
        continue
    t = 'customer' if str(r[px['type']]) == '-10' else 'supplier'
    pid = int(r[px['id']])
    contact_amount[pid] = num(r[px['amount']])
    phone = ''
    try:
        mans = json.loads(r[px['linkMans']] or '[]')
        if mans:
            phone = mans[0].get('linkMobile') or ''
    except Exception:
        pass
    parties.append({
        'id': pid, 'type': t, 'name': r[px['name']], 'phone': phone,
        'note': r[px['remark']] or '', 'opening_debt': 0,
    })
party_names = {p['id']: p['name'] for p in parties}
party_name = lambda pid: party_names.get(int(pid), '') if pid else ''

# ===== 商品 =====
gx = IX('ci_goods')
products = []
for r in tables['ci_goods']:
    if not live(r[gx['isDelete']]):
        continue
    products.append({
        'id': int(r[gx['id']]), 'name': r[gx['name']], 'sku': r[gx['number']] or '',
        'barcode': r[gx['barCode']] or '', 'category': r[gx['categoryName']] or '',
        'unit': (r[gx['unitName']] or '件').strip() or '件',
        'initial_stock': 0, 'initial_cost': 0,
        'sale_price': round2(num(r[gx['salePrice']])), 'low_stock': 0,
        'no_stock': 0, 'archived': 1 if str(r[gx['disable']]) == '1' else 0,
    })
pids = {p['id'] for p in products}

# ===== 单据 =====
iix = IX('ci_invoice_info')
aix = IX('ci_account_info')

items_by_iid = defaultdict(list)
for r in tables['ci_invoice_info']:
    if live(r[iix['isDelete']]) and int(r[iix['iid']] or 0) in invs and int(r[iix['invId']] or 0) in pids:
        items_by_iid[int(r[iix['iid']])].append(r)

# 资金：按单据汇总（带符号）与按账户分列
signed_by_iid = defaultdict(float)
byacct_by_iid = defaultdict(lambda: defaultdict(float))
for r in tables['ci_account_info']:
    if live(r[aix['isDelete']]):
        v = num(r[aix['payment']])
        signed_by_iid[int(r[aix['iid']])] += v
        byacct_by_iid[int(r[aix['iid']])][int(r[aix['accId']] or 0)] += v


def dominant_account(iid, fallback=0):
    accs = {a: v for a, v in byacct_by_iid.get(iid, {}).items() if abs(v) > 0.005}
    if accs:
        return max(accs, key=lambda a: abs(accs[a]))
    return fallback


# 单据 arrears 合计（按往来单位），用于推期初欠款
arrears_by_party = defaultdict(float)   # 正常单据 arrears 净额
retdebt_by_party = defaultdict(float)   # 走"冲减欠款"的退货单净额
TYPE_RETURN_SALE = {'150602'}
TYPE_RETURN_PUR = {'150502'}
for iid, r in invs.items():
    if r[ix['billType']] in ('PUR', 'SALE') and int(r[ix['buId']] or 0):
        tt2 = str(r[ix['transType']])
        if (r[ix['billType']] == 'PUR' and tt2 in TYPE_RETURN_PUR) or (r[ix['billType']] == 'SALE' and tt2 in TYPE_RETURN_SALE):
            retdebt_by_party[int(r[ix['buId']])] += abs(num(r[ix['amount']]))
        else:
            arrears_by_party[int(r[ix['buId']])] += num(r[ix['arrears']])

TYPE_RETURN_SALE = {'150602'}
TYPE_RETURN_PUR = {'150502'}

purchases, purchase_items = [], []
sales, sale_items = [], []
funds, adjustments = [], []
skipped_lines = 0

for iid, r in invs.items():
    bt = r[ix['billType']]
    tt = str(r[ix['transType']])
    created = iso_dt(r[ix['createTime']], r[ix['billDate']])
    desc = ((r[ix['billNo']] or '') + ' ' + (r[ix['description']] or '')).strip()
    bu = int(r[ix['buId']] or 0)
    # 退货单在老系统里金额为负数，统一取绝对值
    total = round2(abs(num(r[ix['amount']])))
    discount = min(round2(num(r[ix['disAmount']]) + num(r[ix['discount']])), total)
    net = round2(total - discount)

    if bt == 'PUR':
        kind = 'return' if tt in TYPE_RETURN_PUR else 'normal'
        if kind == 'normal':
            # 老系统资金流水按总额口径：direct = amount - arrears（325/325 验证无误差）
            paid = round2(num(r[ix['amount']]) - num(r[ix['arrears']]))
            account = dominant_account(iid) if paid != 0 else 0
            refund_way = ''
        else:
            paid = 0
            account = dominant_account(iid, DEFAULT_ACCOUNT_ID)
            refund_way = 'account' if abs(signed_by_iid.get(iid, 0)) > 0.005 else 'debt'
        purchases.append({
            'id': iid, 'kind': kind, 'supplier_id': bu or None, 'supplier_name': party_name(bu),
            'total': total, 'discount': discount, 'paid': paid,
            'account_id': account or None, 'refund_way': refund_way,
            'note': desc, 'created_at': created,
        })
        for it in items_by_iid.get(iid, []):
            qty = round3(abs(num(it[iix['qty']])))
            if qty <= 0:
                skipped_lines += 1
                continue
            amt = round2(num(it[iix['amount']]))
            purchase_items.append({'purchase_id': iid, 'product_id': int(it[iix['invId']]),
                                   'qty': qty, 'unit_cost': round2(amt / qty)})
    elif bt == 'SALE':
        kind = 'return' if tt in TYPE_RETURN_SALE else 'normal'
        if kind == 'normal':
            raw = round2(signed_by_iid.get(iid, 0))
            paid = min(max(0.0, raw), net)
            account = dominant_account(iid) if paid > 0 else 0
            refund_way = ''
            # 老板把部分非单据收入也记在销售收款里：超出单据净额的部分补一笔收入校准
            excess = round2(raw - paid)
            if excess > 0.005:
                funds.append({
                    'id': 5000000 + iid, 'type': 'income', 'party_id': bu or None, 'party_name': party_name(bu),
                    'account_id': dominant_account(iid, DEFAULT_ACCOUNT_ID), 'amount': excess,
                    'note': (desc + ' 多收校准').strip(), 'created_at': created,
                })
        else:
            paid = 0
            account = dominant_account(iid, DEFAULT_ACCOUNT_ID)
            refund_way = 'account' if abs(signed_by_iid.get(iid, 0)) > 0.005 else 'debt'
        sales.append({
            'id': iid, 'kind': kind, 'customer_id': bu or None, 'customer_name': party_name(bu),
            'total': total, 'discount': discount, 'paid': paid,
            'account_id': account or None, 'refund_way': refund_way,
            'note': desc, 'created_at': created,
        })
        for it in items_by_iid.get(iid, []):
            qty = round3(abs(num(it[iix['qty']])))
            if qty <= 0:
                skipped_lines += 1
                continue
            amt = round2(num(it[iix['amount']]))
            sale_items.append({'sale_id': iid, 'product_id': int(it[iix['invId']]),
                               'qty': qty, 'unit_price': round2(amt / qty)})
    elif bt == 'QTSR':
        funds.append({
            'id': iid, 'type': 'income', 'party_id': bu or None, 'party_name': party_name(bu),
            'account_id': dominant_account(iid, DEFAULT_ACCOUNT_ID),
            'amount': round2(abs(signed_by_iid.get(iid, 0))) or round2(num(r[ix['totalAmount']])),
            'note': desc, 'created_at': created,
        })
    elif bt == 'QTZC':
        funds.append({
            'id': iid, 'type': 'expense', 'party_id': bu or None, 'party_name': party_name(bu),
            'account_id': dominant_account(iid, DEFAULT_ACCOUNT_ID),
            'amount': round2(abs(signed_by_iid.get(iid, 0))) or round2(num(r[ix['totalAmount']])),
            'note': desc, 'created_at': created,
        })
    elif bt == 'PAYMENT':
        # 供应商付款：老系统的联系人欠款与单据核销脱节，这里只记资金流出，不挂往来
        funds.append({
            'id': iid, 'type': 'payment', 'party_id': None, 'party_name': party_name(bu),
            'account_id': dominant_account(iid, DEFAULT_ACCOUNT_ID),
            'amount': round2(abs(signed_by_iid.get(iid, 0))),
            'note': ('付款 ' + (party_name(bu) or '')).strip(), 'created_at': created,
        })
    elif bt in ('OI', 'OO'):
        sign = 1 if bt == 'OI' else -1
        label = '其他入库' if bt == 'OI' else '其他出库'
        for it in items_by_iid.get(iid, []):
            qty = round3(abs(num(it[iix['qty']])))
            if qty <= 0:
                continue
            adjustments.append({
                'id': int(it[iix['id']]), 'product_id': int(it[iix['invId']]),
                'qty': round2(sign * qty), 'reason': f'{label} {r[ix["billNo"]] or ""}'.strip(),
                'created_at': created,
            })

# 期初欠款：用重放贡献反推，保证重放后 debt 恰好等于老系统「往来欠款表」显示值
# （contact.amount 是过时快照，老系统实际显示 = 期初 + 单据净额，以 contactDebt_detail 接口为准）
debt_target = {}
try:
    debt_truth = json.load(open(r"C:\Users\Administrator\ZCodeProject\cf-erp\tools\contact_debt_truth.json", encoding='utf-8'))
    for row in debt_truth['rows']:
        # 客户取应收余额，供应商取应付余额（与 debt 的正负号约定一致）
        debt_target[int(row['buId'])] = num(row['payable']) if row['type'] == 'supplier' else num(row['receivable'])
except FileNotFoundError:
    for pid, amt in contact_amount.items():
        debt_target[pid] = amt
    warnings.append('缺少 contact_debt_truth.json，欠款目标退化为 contact.amount 快照（可能与老系统显示有差）')

# 重放贡献 = Σ(正常销售 net-paid) + Σ(正常采购 net-paid) - Σ(冲欠款退货 net)
contribution = defaultdict(float)
for o in sales:
    if o['kind'] == 'normal' and o['customer_id']:
        contribution[o['customer_id']] += (o['total'] - o['discount'] - o['paid'])
    elif o['kind'] == 'return' and o['refund_way'] == 'debt' and o['customer_id']:
        contribution[o['customer_id']] -= (o['total'] - o['discount'])
for o in purchases:
    if o['kind'] == 'normal' and o['supplier_id']:
        contribution[o['supplier_id']] += (o['total'] - o['discount'] - o['paid'])
    elif o['kind'] == 'return' and o['refund_way'] == 'debt' and o['supplier_id']:
        contribution[o['supplier_id']] -= (o['total'] - o['discount'])
for p in parties:
    p['opening_debt'] = round2(debt_target.get(p['id'], 0) - contribution.get(p['id'], 0))

# ===== 库存真值对齐 =====
truth = json.load(open(TRUTH, encoding='utf-8'))
goods_number = {str(p['sku']): p['id'] for p in products if p['sku']}
goods_id = {p['id']: p for p in products}
goods_name = {(p['name'], ''): p['id'] for p in products}

truth_qty = {}
unmatched = []
for row in truth:
    gid = goods_number.get(str(row['invNo']))
    if gid is None and str(row['invNo']).isdigit() and int(row['invNo']) in goods_id:
        gid = int(row['invNo'])
    if gid is None:
        gid = goods_name.get((row['invName'], row['spec'] or ''))
    if gid is None:
        unmatched.append(row)
        continue
    truth_qty[gid] = (num(row['qty_1']), num(row['cost_1']))

# 期初成本单价 = 老系统单位成本（无采购历史的商品重放均价即它；有采购历史的自然用真实均价）
for gid, (tq, tc) in truth_qty.items():
    if tq > 0:
        goods_id[gid]['initial_cost'] = round2(tc / tq)
for p in products:
    if p['initial_cost'] == 0:
        pass  # 无真值的保持 0

# 重放（与 src/db.ts 同算法）得到当前库存，再生成校准调整
pi_by_bill = defaultdict(list)
for it in purchase_items:
    pi_by_bill[it['purchase_id']].append(it)
si_by_bill = defaultdict(list)
for it in sale_items:
    si_by_bill[it['sale_id']].append(it)

moves = []
for o in purchases:
    for it in pi_by_bill.get(o['id'], []):
        moves.append((o['created_at'], 'purchase', o['kind'], it))
for o in sales:
    for it in si_by_bill.get(o['id'], []):
        moves.append((o['created_at'], 'sale', o['kind'], it))
for a in adjustments:
    moves.append((a['created_at'], 'adjust', '', a))
moves.sort(key=lambda m: (m[0] or '', m[1]))

state = {}
for created, typ, kind, it in moves:
    s = state.setdefault(it['product_id'], {'stock': 0.0, 'avg': 0.0})
    if typ == 'purchase':
        if kind == 'normal':
            t2 = s['stock'] + it['qty']
            s['avg'] = (s['stock'] * s['avg'] + it['qty'] * it['unit_cost']) / t2 if t2 > 0 else it['unit_cost']
            s['stock'] += it['qty']
        else:
            s['stock'] -= it['qty']
    elif typ == 'sale':
        it['unit_cost'] = round2(s['avg'])
        s['stock'] += it['qty'] if kind == 'return' else -it['qty']
    else:
        s['stock'] += it['qty']

# 校准调整：把重放库存精确对齐到真值
adj_id = 900000
calib_count = 0
for gid, (tq, tc) in sorted(truth_qty.items()):
    rq = round(state.get(gid, {}).get('stock', 0), 3)
    if abs(rq - tq) < 0.001:
        continue
    adj_id += 1
    adjustments.append({
        'id': adj_id, 'product_id': gid, 'qty': round2(tq - rq),
        'reason': '历史库存校准', 'created_at': NOW,
    })
    calib_count += 1

# 真值里有但商品表没有的：无编号无名称的是已删除商品残留，跳过
next_pid = max(pids) + 1 if pids else 1
for row in unmatched:
    tq = num(row['qty_1'])
    if abs(tq) < 0.001 or (not row.get('invName') and not row.get('invNo')):
        continue
    pid = next_pid
    next_pid += 1
    unit_cost = round2(num(row['cost_1']) / tq) if tq > 0 else 0
    products.append({
        'id': pid, 'name': row['invName'], 'sku': str(row['invNo'] or ''),
        'barcode': '', 'category': '历史导入', 'unit': row['unit'] or '件',
        'initial_stock': 0, 'initial_cost': unit_cost,
        'sale_price': 0, 'low_stock': 0, 'no_stock': 0, 'archived': 0,
    })
    pids.add(pid)
    goods_id[pid] = products[-1]
    truth_qty[pid] = (tq, num(row['cost_1']))
    if tq != 0:
        adj_id += 1
        adjustments.append({
            'id': adj_id, 'product_id': pid, 'qty': round2(tq),
            'reason': '历史库存校准', 'created_at': NOW,
        })
        calib_count += 1
    warnings.append(f"真值中存在商品表缺失的商品：{row['invName']!r}（qty={tq}），已补建 id={pid}")

# ===== 生成 SQL =====
out = []
out.append('-- cf-erp 历史数据导入（来自老 ERP MySQL 备份 202609291030148.sql）')
out.append('-- 导入后调用 POST /api/admin/recompute 重放流水')
out.append('DELETE FROM sale_items; DELETE FROM sales; DELETE FROM purchase_items; DELETE FROM purchases;')
out.append('DELETE FROM adjustments; DELETE FROM funds; DELETE FROM accounts; DELETE FROM parties; DELETE FROM products;')
out.append('DELETE FROM sqlite_sequence;')

for a in accounts:
    out.append(f"INSERT INTO accounts (id, name, opening_balance, balance, note) VALUES ({a['id']}, {q(a['name'])}, 0, 0, {q(a['note'])});")
for p in parties:
    out.append(f"INSERT INTO parties (id, type, name, phone, note, opening_debt, debt) VALUES ({p['id']}, {q(p['type'])}, {q(p['name'])}, {q(p['phone'])}, {q(p['note'])}, {n2(p['opening_debt'])}, 0);")
for p in products:
    out.append(
        f"INSERT INTO products (id, name, sku, barcode, category, unit, stock, avg_cost, initial_stock, initial_cost, sale_price, low_stock, no_stock, archived) "
        f"VALUES ({p['id']}, {q(p['name'])}, {q(p['sku'])}, {q(p['barcode'])}, {q(p['category'])}, {q(p['unit'])}, 0, 0, 0, {n2(p['initial_cost'])}, {n2(p['sale_price'])}, 0, {p['no_stock']}, {p['archived']});"
    )
for o in purchases:
    out.append(
        f"INSERT INTO purchases (id, kind, supplier_id, supplier_name, total, discount, paid, account_id, refund_way, note, created_at) "
        f"VALUES ({o['id']}, {q(o['kind'])}, {o['supplier_id'] or 'NULL'}, {q(o['supplier_name'])}, {n2(o['total'])}, {n2(o['discount'])}, {n2(o['paid'])}, {o['account_id'] or 'NULL'}, {q(o['refund_way'])}, {q(o['note'])}, {q(o['created_at'])});"
    )
for it in purchase_items:
    out.append(f"INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost) VALUES ({it['purchase_id']}, {it['product_id']}, {n3(it['qty'])}, {n2(it['unit_cost'])});")
for o in sales:
    out.append(
        f"INSERT INTO sales (id, kind, customer_id, customer_name, total, discount, paid, account_id, refund_way, note, created_at) "
        f"VALUES ({o['id']}, {q(o['kind'])}, {o['customer_id'] or 'NULL'}, {q(o['customer_name'])}, {n2(o['total'])}, {n2(o['discount'])}, {n2(o['paid'])}, {o['account_id'] or 'NULL'}, {q(o['refund_way'])}, {q(o['note'])}, {q(o['created_at'])});"
    )
for it in sale_items:
    out.append(f"INSERT INTO sale_items (sale_id, product_id, qty, unit_price, unit_cost) VALUES ({it['sale_id']}, {it['product_id']}, {n3(it['qty'])}, {n2(it['unit_price'])}, {n2(it.get('unit_cost', 0))});")
for f in funds:
    out.append(
        f"INSERT INTO funds (id, type, party_id, party_name, account_id, amount, note, created_at) "
        f"VALUES ({f['id']}, {q(f['type'])}, {f['party_id'] or 'NULL'}, {q(f['party_name'])}, {f['account_id']}, {n2(f['amount'])}, {q(f['note'])}, {q(f['created_at'])});"
    )
for a in adjustments:
    out.append(
        f"INSERT INTO adjustments (id, product_id, qty, reason, created_at) "
        f"VALUES ({a['id']}, {a['product_id']}, {n2(a['qty'])}, {q(a['reason'])}, {q(a['created_at'])});"
    )

open(OUT, 'w', encoding='utf-8').write('\n'.join(out))

print(f"账户 {len(accounts)}，往来 {len(parties)}，商品 {len(products)}（含补建 {len(unmatched)} 中有库存的）")
print(f"采购 {len(purchases)}（明细 {len(purchase_items)}），销售 {len(sales)}（明细 {len(sale_items)}）")
print(f"资金 {len(funds)}，调整 {len(adjustments)}（其中校准 {calib_count}）")
print(f"SQL {len(out)} 行 → {OUT}")
for w in warnings[:8]:
    print('警告:', w)
