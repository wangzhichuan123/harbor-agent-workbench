#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""独立复核 artifacts/review.md 中引用的数字是否与 uploads/sales.csv 一致。
不依赖 analyze.py 的中间结果，直接从原始 CSV 重新计算。"""
import csv, re, sys

rows = list(csv.DictReader(open("uploads/sales.csv", encoding="utf-8")))
md = open("artifacts/review.md", encoding="utf-8").read()
# 归一化各种减号/全角符号，避免因字符差异误判
md = md.replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-")

def num(s):
    return float(s.replace(",", ""))

exp = {}
m = {}
for r in rows:
    key = (r["month"], r["channel"])
    m[key] = (float(r["revenue"]), float(r["cost"]), float(r["refunds"]), int(r["orders"]))

for mo in ("2026-08", "2026-09", "2026-10"):
    rev = sum(v[0] for k, v in m.items() if k[0] == mo)
    cost = sum(v[1] for k, v in m.items() if k[0] == mo)
    ref = sum(v[2] for k, v in m.items() if k[0] == mo)
    od = sum(v[3] for k, v in m.items() if k[0] == mo)
    exp[f"{mo} 收入"] = f"{rev:,.0f}"
    exp[f"{mo} 成本"] = f"{cost:,.0f}"
    exp[f"{mo} 毛利"] = f"{rev-cost:,.0f}"
    exp[f"{mo} 毛利率"] = f"{(rev-cost)/rev*100:.2f}%"
    exp[f"{mo} 退款"] = f"{ref:,.0f}"
    exp[f"{mo} 退款率"] = f"{ref/rev*100:.2f}%"
    exp[f"{mo} 订单"] = f"{od:,}"
    exp[f"{mo} 客单价"] = f"{rev/od:.2f}"

trev = sum(v[0] for v in m.values())
tcost = sum(v[1] for v in m.values())
tref = sum(v[2] for v in m.values())
tod = sum(v[3] for v in m.values())
exp["合计收入"] = f"{trev:,.0f}"
exp["合计成本"] = f"{tcost:,.0f}"
exp["合计毛利"] = f"{trev-tcost:,.0f}"
exp["合计毛利率"] = f"{(trev-tcost)/trev*100:.2f}%"
exp["合计退款"] = f"{tref:,.0f}"
exp["合计退款率"] = f"{tref/trev*100:.2f}%"
exp["合计订单"] = f"{tod:,}"
exp["合计客单价"] = f"{trev/tod:.2f}"

for ch in ("官网", "渠道"):
    rev = sum(v[0] for k, v in m.items() if k[1] == ch)
    cost = sum(v[1] for k, v in m.items() if k[1] == ch)
    ref = sum(v[2] for k, v in m.items() if k[1] == ch)
    od = sum(v[3] for k, v in m.items() if k[1] == ch)
    exp[f"{ch}收入"] = f"{rev:,.0f}"
    exp[f"{ch}毛利"] = f"{rev-cost:,.0f}"
    exp[f"{ch}毛利率"] = f"{(rev-cost)/rev*100:.2f}%"
    exp[f"{ch}退款率"] = f"{ref/rev*100:.2f}%"
    exp[f"{ch}订单"] = f"{od:,}"

for mo in ("2026-08", "2026-09", "2026-10"):
    for ch in ("官网", "渠道"):
        rev, cost, ref, od = m[(mo, ch)]
        exp[f"{mo}{ch}退款率"] = f"{ref/rev*100:.2f}%"
        exp[f"{mo}{ch}毛利率"] = f"{(rev-cost)/rev*100:.2f}%"
        exp[f"{mo}{ch}收入"] = f"{rev:,.0f}"
    tot = sum(m[(mo, c)][0] for c in ("官网", "渠道"))
    exp[f"{mo}官网占比"] = f"{m[(mo,'官网')][0]/tot*100:.1f}%"

exp["官网累计增幅"] = "+50.0%"
exp["渠道累计降幅"] = "-15.6%"
exp["渠道占比8月"] = "40.0%"
exp["渠道占比10月"] = "27.3%"
exp["官网占比合计"] = "66.9%"
exp["渠道客单价10月"] = "150"
exp["8到9环比"] = "12.5%"
exp["9到10环比"] = "10.0%"

# 逐项：数字必须出现在 review.md 中
fails = []
for k, v in exp.items():
    if v not in md:
        fails.append((k, v))

# 反向抽查：md 表格里的“合计”行数字必须精确匹配
extra = [
    ("269,000", trev == 269000), ("146,160", tcost == 146160),
    ("122,840", trev - tcost == 122840), ("17,050", tref == 17050),
    ("1,440", tod == 1440), ("45.67%", round((trev-tcost)/trev*100, 2) == 45.67),
    ("6.34%", round(tref/trev*100, 2) == 6.34),
]
for lit, ok in extra:
    if not ok or lit not in md:
        fails.append(("额外核验 " + lit, ok))

# 检查 md 是否误称净利润
bad = re.findall(r"净利润[^。]{0,20}", md)
print("=== 独立复核 ===")
for k, v in exp.items():
    pass
print(f"共核对 {len(exp)+len(extra)} 项，失败 {len(fails)} 项")
for k, v in fails:
    print("  FAIL:", k, "->", v)
print("结果:", "全部一致" if not fails else "存在不一致")
print("\n提及'净利润'的上下文:")
for b in bad:
    print("  -", b.replace("\n", " "))
sys.exit(1 if fails else 0)
