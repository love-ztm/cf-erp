# -*- coding: utf-8 -*-
"""确认映射细节：往来单位、金额字段语义、QTSR 明细。"""
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


tables = defaultdict(list)
for m in re.finditer(r'^INSERT INTO `?(\w+)`?\s*\([^)]*\)\s*VALUES\s*(.*?);\s*$', text, re.M | re.S):
    for row in parse_values(m.group(2)):
        tables[m.group(1)].append([unquote(v) for v in row])

schemas = {}
for m in re.finditer(r'CREATE TABLE `(\w+)` \((.*?)\)\s*ENGINE', text, re.S):
    schemas[m.group(1)] = re.findall(r'^\s*`(\w+)`', m.group(2), re.M)

IX = lambda t: {c: i for i, c in enumerate(schemas[t])}

print('=== ci_contact 全部 ===')
ix = IX('ci_contact')
for r in tables['ci_contact']:
    name = repr(r[ix['name']])
    lm = repr(str(r[ix['linkMans']])[:60])
    print(f"id={r[ix['id']]} type={r[ix['type']]} name={name} amount={r[ix['amount']]} difMoney={r[ix['difMoney']]} periodMoney={r[ix['periodMoney']]} linkMans={lm} isDelete={r[ix['isDelete']]}")

print()
print('=== 各类型单据金额字段样本（未删除）===')
ix = IX('ci_invoice')
for bt in ['SALE', 'PUR', 'QTSR', 'QTZC', 'PAYMENT', 'OI', 'OO']:
    rows = [r for r in tables['ci_invoice'] if r[ix['billType']] == bt and r[ix['isDelete']] in (0, '0')]
    print(f'--- {bt} ({len(rows)} 张) 字段: totalAmount/amount/rpAmount/arrears/disAmount/payment/discount/accId')
    for r in rows[:3]:
        print(f"  {r[ix['billNo']]} total={r[ix['totalAmount']]} amount={r[ix['amount']]} rp={r[ix['rpAmount']]} arrears={r[ix['arrears']]} dis={r[ix['disAmount']]} pay={r[ix['payment']]} disc={r[ix['discount']]} accId={r[ix['accId']]} date={r[ix['billDate']]}")

# 检查 SALE 是否有 arrears>0（赊销）
sales = [r for r in tables['ci_invoice'] if r[ix['billType']] == 'SALE' and r[ix['isDelete']] in (0, '0')]
ar = [r for r in sales if abs(float(r[ix['arrears']] or 0)) > 0.005]
pur = [r for r in tables['ci_invoice'] if r[ix['billType']] == 'PUR' and r[ix['isDelete']] in (0, '0')]
ar_p = [r for r in pur if abs(float(r[ix['arrears']] or 0)) > 0.005]
print(f'SALE 赊销单据: {len(ar)} / {len(sales)}; PUR 欠款单据: {len(ar_p)} / {len(pur)}')
if ar_p:
    tot = sum(float(r[ix['arrears']]) for r in ar_p)
    print(f'PUR 欠款合计: {tot:.2f} (老系统供应商欠款 6529 校验)')

print()
print('=== QTSR/QTZC 是否有明细行 ===')
iix = IX('ci_invoice_info')
info_by_iid = defaultdict(int)
for r in tables['ci_invoice_info']:
    info_by_iid[r[iix['iid']]] += 1
for bt in ['QTSR', 'QTZC', 'PAYMENT', 'OI', 'OO', 'SALE', 'PUR']:
    rows = [r for r in tables['ci_invoice'] if r[ix['billType']] == bt and r[ix['isDelete']] in (0, '0')]
    with_items = sum(1 for r in rows if info_by_iid.get(r[ix['id']], 0) > 0)
    print(f'{bt}: {with_items}/{len(rows)} 张有明细行')

print()
print('=== invoice_info 样本（SALE）===')
bt_sale = [r for r in tables['ci_invoice'] if r[ix['billType']] == 'SALE' and r[ix['isDelete']] in (0, '0')][:1]
for inv in bt_sale:
    print(f'单 {inv[ix["billNo"]]}:')
    for r in tables['ci_invoice_info']:
        if r[iix['iid']] == inv[ix['id']]:
            print(f"  invId={r[iix['invId']]} qty={r[iix['qty']]} price={r[iix['price']]} amount={r[iix['amount']]} deduction={r[iix['deduction']]} discountRate={r[iix['discountRate']]} loc={r[iix['locationId']]} isDel={r[iix['isDelete']]}")

print()
print('=== 商品样本 ===')
gix = IX('ci_goods')
for r in tables['ci_goods'][:5]:
    print(f"id={r[gix['id']]} name={r[gix['name']]!r} qty={r[gix['quantity']]} unit={r[gix['unitName']]!r} pur={r[gix['purPrice']]} sale={r[gix['salePrice']]} unitCost={r[gix['unitCost']]} cat={r[gix['categoryName']]!r} bar={r[gix['barCode']]!r} isDel={r[gix['isDelete']]}")
qty_total = sum(float(r[gix['quantity']] or 0) for r in tables['ci_goods'] if r[gix['isDelete']] in (0, '0'))
print(f'ci_goods.quantity 合计（校验 库存总量1818）: {qty_total}')
stock_value = sum(float(r[gix['quantity']] or 0) * float(r[gix['unitCost']] or 0) for r in tables['ci_goods'] if r[gix['isDelete']] in (0, '0'))
print(f'quantity × unitCost 合计（校验 库存成本34147.99）: {stock_value:.2f}')

print()
print('=== account_info: 每单多账户情况 ===')
aiix = IX('ci_account_info')
per_bill = defaultdict(lambda: defaultdict(float))
for r in tables['ci_account_info']:
    if r[aiix['isDelete']] in (0, '0'):
        per_bill[r[aiix['iid']]][r[aiix['accId']]] += float(r[aiix['payment']] or 0)
multi = sum(1 for iid, accs in per_bill.items() if len([a for a in accs if abs(accs[a]) > 0.005]) > 1)
print(f'资金流水涉及 {len(per_bill)} 张单，其中 {multi} 张用了多个账户')

# 老系统各账户余额（按 accId 汇总）
acc_bal = defaultdict(float)
for r in tables['ci_account_info']:
    if r[aiix['isDelete']] in (0, '0'):
        acc_bal[r[aiix['accId']]] += float(r[aiix['payment']] or 0)
print('账户流水净额:', dict(acc_bal), '（校验 现金+银行 499917.44）')
