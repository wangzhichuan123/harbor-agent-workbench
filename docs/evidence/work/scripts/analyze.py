#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""8-10 月经营复盘计算脚本。数据来源：uploads/sales.csv（会议纪要仅作定性补充）。"""
import csv, os
from collections import OrderedDict
from decimal import Decimal

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV = os.path.join(BASE, "uploads", "sales.csv")
OUT_CSV = os.path.join(BASE, "artifacts", "summary.csv")


def D(x):
    return Decimal(str(x))


rows = []
with open(CSV, encoding="utf-8") as f:
    for r in csv.DictReader(f):
        rows.append({
            "month": r["month"].strip(),
            "channel": r["channel"].strip(),
            "revenue": D(r["revenue"]),
            "orders": int(r["orders"]),
            "refunds": D(r["refunds"]),
            "cost": D(r["cost"]),
        })

months = sorted({r["month"] for r in rows})
channels = sorted({r["channel"] for r in rows})

# ---- 月度汇总 ----
monthly = OrderedDict()
for m in months:
    rs = [r for r in rows if r["month"] == m]
    rev = sum((r["revenue"] for r in rs), Decimal(0))
    cost = sum((r["cost"] for r in rs), Decimal(0))
    ref = sum((r["refunds"] for r in rs), Decimal(0))
    ord_ = sum(r["orders"] for r in rs)
    monthly[m] = {
        "revenue": rev, "cost": cost, "refunds": ref, "orders": ord_,
        "gross_profit": rev - cost,
        "refund_rate": (ref / rev * 100).quantize(Decimal("0.01")),
        "gross_margin": ((rev - cost) / rev * 100).quantize(Decimal("0.01")),
        "aov": (rev / ord_).quantize(Decimal("0.01")),
    }

# ---- 渠道汇总（全期）----
channel_tot = OrderedDict()
for c in channels:
    rs = [r for r in rows if r["channel"] == c]
    rev = sum((r["revenue"] for r in rs), Decimal(0))
    cost = sum((r["cost"] for r in rs), Decimal(0))
    ref = sum((r["refunds"] for r in rs), Decimal(0))
    channel_tot[c] = {
        "revenue": rev, "cost": cost, "refunds": ref,
        "orders": sum(r["orders"] for r in rs),
        "gross_profit": rev - cost,
        "refund_rate": (ref / rev * 100).quantize(Decimal("0.01")),
        "gross_margin": ((rev - cost) / rev * 100).quantize(Decimal("0.01")),
    }

# ---- 渠道×月矩阵（收入趋势）----
matrix = {(m, c): Decimal(0) for m in months for c in channels}
for r in rows:
    matrix[(r["month"], r["channel"])] += r["revenue"]

# ---- 总计 ----
tot_rev = sum((r["revenue"] for r in rows), Decimal(0))
tot_cost = sum((r["cost"] for r in rows), Decimal(0))
tot_ref = sum((r["refunds"] for r in rows), Decimal(0))
tot_ord = sum(r["orders"] for r in rows)
tot_gp = tot_rev - tot_cost

# ---- 交叉核验 ----
checks = []
def chk(name, a, b):
    ok = a == b
    checks.append((name, a, b, ok))
    return ok

chk("月度收入之和 == 总收入", sum((monthly[m]["revenue"] for m in months), Decimal(0)), tot_rev)
chk("渠道收入之和 == 总收入", sum((channel_tot[c]["revenue"] for c in channels), Decimal(0)), tot_rev)
chk("渠道×月矩阵之和 == 总收入", sum(matrix.values(), Decimal(0)), tot_rev)
chk("CSV 原始行收入之和 == 总收入", sum((r["revenue"] for r in rows), Decimal(0)), tot_rev)
chk("月度成本之和 == 总成本", sum((monthly[m]["cost"] for m in months), Decimal(0)), tot_cost)
chk("月度毛利之和 == 总毛利", sum((monthly[m]["gross_profit"] for m in months), Decimal(0)), tot_gp)
chk("渠道毛利之和 == 总毛利", sum((channel_tot[c]["gross_profit"] for c in channels), Decimal(0)), tot_gp)
chk("总计毛利 == 总收入-总成本", tot_gp, tot_rev - tot_cost)
chk("总退款 == 各月退款之和", tot_ref, sum((monthly[m]["refunds"] for m in months), Decimal(0)))
chk("总订单 == 各月订单之和", tot_ord, sum(monthly[m]["orders"] for m in months))
# 加法闭合性（Decimal 精确性）
chk("官网+渠道(10月) == 10月收入",
    matrix[("2026-10", "官网")] + matrix[("2026-10", "渠道")], monthly["2026-10"]["revenue"])

# ---- 写 summary.csv ----
os.makedirs(os.path.dirname(OUT_CSV), exist_ok=True)
with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["month", "revenue", "cost", "gross_profit", "gross_margin_pct",
                "refunds", "refund_rate_pct", "orders", "aov"])
    for m in months:
        d = monthly[m]
        w.writerow([m, d["revenue"], d["cost"], d["gross_profit"], d["gross_margin"],
                    d["refunds"], d["refund_rate"], d["orders"], d["aov"]])
    w.writerow(["TOTAL", tot_rev, tot_cost, tot_gp,
                ((tot_gp / tot_rev) * 100).quantize(Decimal("0.01")),
                tot_ref, ((tot_ref / tot_rev) * 100).quantize(Decimal("0.01")),
                tot_ord, (tot_rev / tot_ord).quantize(Decimal("0.01"))])
    w.writerow([])
    w.writerow(["channel", "revenue", "cost", "gross_profit", "gross_margin_pct",
                "refunds", "refund_rate_pct", "orders"])
    for c in channels:
        d = channel_tot[c]
        w.writerow([c, d["revenue"], d["cost"], d["gross_profit"], d["gross_margin"],
                    d["refunds"], d["refund_rate"], d["orders"]])
    w.writerow([])
    w.writerow(["month", "channel", "revenue"])
    for m in months:
        for c in channels:
            w.writerow([m, c, matrix[(m, c)]])

# ---- 控制台报告 ----
def money(x):
    return f"{x:,.0f}"

print("=== 月度 ===")
for m in months:
    d = monthly[m]
    print(f"{m} 收入={money(d['revenue'])} 成本={money(d['cost'])} "
          f"毛利={money(d['gross_profit'])}({d['gross_margin']}%) "
          f"退款={money(d['refunds'])}({d['refund_rate']}%) 订单={d['orders']} AOV={d['aov']}")
print(f"TOTAL 收入={money(tot_rev)} 成本={money(tot_cost)} 毛利={money(tot_gp)} "
      f"({(tot_gp/tot_rev*100).quantize(Decimal('0.01'))}%) 退款={money(tot_ref)} "
      f"({(tot_ref/tot_rev*100).quantize(Decimal('0.01'))}%) 订单={tot_ord} "
      f"AOV={(tot_rev/tot_ord).quantize(Decimal('0.01'))}")

print("\n=== 渠道（全期）===")
for c in channels:
    d = channel_tot[c]
    print(f"{c} 收入={money(d['revenue'])} 毛利={money(d['gross_profit'])}"
          f"({d['gross_margin']}%) 退款率={d['refund_rate']}% 订单={d['orders']}")

print("\n=== 渠道×月收入矩阵 ===")
print("月份   " + "  ".join(f"{c:>8}" for c in channels) + "   合计")
for m in months:
    print(f"{m} " + "  ".join(f"{money(matrix[(m,c)]):>8}" for c in channels)
          + f"   {money(monthly[m]['revenue'])}")
for c in channels:
    print(f"{c}合计 " + "  ".join(f"{money(channel_tot[c]['revenue']):>8}" for c in channels)
          + f"   {money(tot_rev)}")

print("\n=== 环比 ===")
for i in range(1, len(months)):
    p, c_ = months[i-1], months[i]
    dr = (monthly[c_]["revenue"] / monthly[p]["revenue"] - 1) * 100
    print(f"{c_} vs {p} 收入环比 {dr.quantize(Decimal('0.1'))}%")

print("\n=== 交叉核验 ===")
allok = True
for name, a, b, ok in checks:
    allok &= ok
    print(f"[{'OK ' if ok else 'FAIL'}] {name}: {a} vs {b}")
print("全部通过" if allok else "存在不一致")
print("\n已写出:", OUT_CSV)
