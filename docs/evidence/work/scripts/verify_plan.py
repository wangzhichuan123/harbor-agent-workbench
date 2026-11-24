#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""精确核验 artifacts/action-plan.md：
 1) 文档中的数值断言全部能在 uploads/sales.csv 中找到对应，且出现在文中；
 2) 负责人只允许 林青 / 周明；
 3) 文中标注为「周五/周二」的日期确为该星期；
 4) 所有截止日期为工作日；
 5) 不把毛利/收入称为净利润。
"""
import csv, re, sys, datetime
from decimal import Decimal as D

md = open("artifacts/action-plan.md", encoding="utf-8").read()
notes = open("uploads/meeting-notes.txt", encoding="utf-8").read()
rows = list(csv.DictReader(open("uploads/sales.csv", encoding="utf-8")))
nmd = md.replace("\u2212", "-")
fails = []

def cell(mo, ch, col):
    return D([r[col] for r in rows if r["month"] == mo and r["channel"] == ch][0])

# ===== 1. 断言：名称 -> (期望字符串, 是否计算得出) =====
claims = []   # (label, 期望字面量, 实际计算值)
def add(label, literal, computed):
    claims.append((label, literal, computed))

for ch, rev, od, aov, rr, gm in [
    ("官网", "72,000", "320", "225.00", "5.00%", "52.00%"),
    ("渠道", "27,000", "180", "150.00", "15.00%", "30.00%"),
]:
    c = cell("2026-10", ch, "revenue"); o = cell("2026-10", ch, "orders")
    k = cell("2026-10", ch, "cost"); f = cell("2026-10", ch, "refunds")
    add(f"10月{ch}收入", rev, f"{c:,.0f}")
    add(f"10月{ch}订单", od, f"{int(o)}")
    add(f"10月{ch}客单价", aov, f"{c/o:.2f}")
    add(f"10月{ch}退款率", rr, f"{f/c*100:.2f}%")
    add(f"10月{ch}毛利率", gm, f"{(c-k)/c*100:.2f}%")

tot10 = cell("2026-10", "官网", "revenue") + cell("2026-10", "渠道", "revenue")
add("10月官网占比", "72.7%", f"{cell('2026-10','官网','revenue')/tot10*100:.1f}%")
add("10月渠道占比", "27.3%", f"{cell('2026-10','渠道','revenue')/tot10*100:.1f}%")

cr = [cell(m, "渠道", "revenue") for m in ("2026-08", "2026-09", "2026-10")]
add("渠道8->9环比", "-6.25%", f"{cr[1]/cr[0]*100-100:.2f}%")
add("渠道9->10环比", "-10.0%", f"{cr[2]/cr[1]*100-100:.1f}%")
w8, w10 = cell("2026-08","官网","revenue"), cell("2026-10","官网","revenue")
add("官网累计增幅", "+50.0%", f"{(w10/w8-1)*100:+.1f}%")
for mo, rr, gm in [("2026-09","8%","35%"), ("2026-10","15%","30%")]:
    c = cell(mo,"渠道","revenue"); k = cell(mo,"渠道","cost"); f = cell(mo,"渠道","refunds")
    add(f"{mo}渠道退款率", rr, f"{f/c*100:.2f}%")
    add(f"{mo}渠道毛利率", gm, f"{(c-k)/c*100:.2f}%")

add("官网退款率三月恒定5.00%", "5.00%",
    "5.00%" if all(f"{cell(m,'官网','refunds')/cell(m,'官网','revenue')*100:.2f}%" == "5.00%"
        for m in ("2026-08","2026-09","2026-10")) else "不一致")
add("渠道订单200->180", "200", "200" if cell("2026-09","渠道","orders")==200 else "不一致")
add("渠道订单200->180(末)", "180", "180" if cell("2026-10","渠道","orders")==180 else "不一致")

trev = sum(D(r["revenue"]) for r in rows); tcost = sum(D(r["cost"]) for r in rows)
add("合计毛利", "122,840", f"{trev-tcost:,}")
c10 = cell("2026-10","渠道","revenue"); f10 = cell("2026-10","渠道","refunds")
add("渠道10月退款额", "4,050", f"{f10:,}")
add("渠道10月扣退款净收入", "22,950", f"{c10-f10:,}")
add("渠道10月退款率", "15%", f"{f10/c10*100:.0f}%")
add("渠道9月退款率", "8%", f"{cell('2026-09','渠道','refunds')/cell('2026-09','渠道','revenue')*100:.0f}%")

# 逐项：期望值 == 计算值（百分比按数值比较，允许文档用取整写法），且期望字面量出现在文档中
def pct_eq(a, b):
    try:
        return abs(float(a.rstrip("%")) - float(b.rstrip("%"))) < 0.005
    except ValueError:
        return a == b

for label, literal, computed in claims:
    if literal.endswith("%") and computed.endswith("%"):
        if not pct_eq(literal, computed):
            fails.append(f"断言与数据不符 {label}: 文档 '{literal}' vs 计算 '{computed}'")
    elif literal != computed:
        fails.append(f"断言与数据不符 {label}: 文档 '{literal}' vs 计算 '{computed}'")
    if literal not in nmd:
        fails.append(f"文档中未找到字面量 {literal} ({label})")

# ===== 2. 负责人白名单 =====
# 直接检查每个「负责人」取值位置：`- **负责人**：X` 与汇总表「负责人」列
allowed = {"林青", "周明"}
if "林青" not in notes or "周明" not in notes:
    fails.append("材料中未找到 林青/周明")

def check_names(cellvals, where):
    """cellvals: 负责人栏中出现的姓名片段列表"""
    for nm in cellvals:
        nm = nm.strip()
        if nm in allowed:
            continue
        if nm in ("林青 + 周明", "林青、周明", "林青/周明", "林青（官网侧）+ 周明（渠道侧）",
                  "林青（官网侧）+ 周明（渠道侧），各负责本渠道",
                  "周明（渠道退款问题相关）", "林青（官网侧）+ 周明（渠道侧）"):
            continue
        fails.append(f"负责人含非白名单名字 '{nm}' @ {where}")

for line in nmd.splitlines():
    mm = re.match(r"^- \*\*(?:建议)?负责人\*\*：(.+)$", line.strip())
    if mm:
        val = mm.group(1).strip()
        # 去掉括号内的范围/说明注释，只校验姓名主体
        core = re.sub(r"（[^）]*）", "", val)
        core = re.sub(r"\(.*?\)", "", core).strip()
        # 主体按 、 / + 分隔，每个 token 必须是白名单姓名
        toks = [t.strip() for t in re.split(r"[、/＋+]| and ", core) if t.strip()]
        for t in toks:
            if t not in allowed:
                fails.append(f"负责人主体含非白名单姓名 '{t}': {line.strip()[:60]}")
        if not toks:
            fails.append(f"负责人字段为空: {line.strip()[:60]}")
        # 括号注释里若出现人名（非白名单）也判失败：
        # 先剥掉已知非人名词，剩余连续中文串即为潜在人名
        note_text = "".join(re.findall(r"（([^）]*)）", val))
        for nm in re.findall(r"[\u4e00-\u9fa5]{2,3}", note_text):
            if nm in allowed or nm.startswith(("林青", "周明")):
                continue
            if nm in ("渠道", "官网", "侧", "各负", "负责", "本渠", "道侧", "数据", "退款",
                      "问题", "相关", "建议", "运营", "待核", "各负责", "本渠道", "渠道退",
                      "款问题", "问题相", "关", "官网侧", "渠道侧"):
                continue
            fails.append(f"负责人注释含非白名单词 '{nm}': {line.strip()[:60]}")
        # 反向：注释中去掉上述已知词与白名单后不应残留中文串
        residual = note_text
        for w in list(allowed) + ["渠道", "退款", "问题", "相关", "官网", "侧", "各负责",
                                  "本渠道", "数据", "运营", "建议", "待核"]:
            residual = residual.replace(w, "")
        if re.search(r"[\u4e00-\u9fa5]{2,}", residual):
            fails.append(f"负责人注释残留未知中文: '{residual}' @ {line.strip()[:50]}")

# 汇总表：定位「| 编号 | 任务 | 负责人 | ...」表并校验负责人列
lines = nmd.splitlines()
for i, line in enumerate(lines):
    if line.strip().startswith("| 编号") and "负责人" in line:
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        ci = cols.index("负责人")
        for j in range(i+2, len(lines)):
            rline = lines[j].strip()
            if not rline.startswith("|"):
                break
            cells = [c.strip() for c in rline.strip("|").split("|")]
            if len(cells) > ci:
                val = cells[ci]
                if val not in allowed and val != "林青 + 周明":
                    fails.append(f"汇总表负责人列含非白名单值 '{val}'")
        break

# ===== 3. 星期标注核验 =====
seg = nmd.split("已避开周末")[1].split("）")[0] if "已避开周末" in nmd else ""
# 形如 "11-06/13/20/27、12-04/11/18 为周五，11-03、12-01 为周二"
def expand(spec):
    out = []
    for part in re.split(r"[、,，]", spec):
        part = part.strip()
        if not part: continue
        mm = re.match(r"(\d{2})-(/[\d/]+)?$", part)
        if mm:
            mon = mm.group(1); days = (mm.group(2) or "").strip("/").split("/")
            for d in days:
                if d: out.append(f"2026-{mon}-{int(d):02d}")
        else:
            mm2 = re.match(r"(\d{2})-(\d{2})$", part)
            if mm2: out.append(f"2026-{mm2.group(1)}-{mm2.group(2)}")
    return out
wk_cn = {"周一":0,"周二":1,"周三":2,"周四":3,"周五":4,"周六":5,"周日":6}
for chunk, wname in re.findall(r"([^，。]+?)\s*为(周[一二三四五六日])", seg):
    for ds in expand(chunk):
        dt = datetime.date(*map(int, ds.split("-")))
        if dt.weekday() != wk_cn[wname]:
            fails.append(f"文中称 {ds} 为{wname}，实为 {dt.strftime('%A')}")

# ===== 4. 所有截止日期为工作日 =====
for ds in sorted(set(re.findall(r"2026-\d{2}-\d{2}", nmd))):
    dt = datetime.date(*map(int, ds.split("-")))
    if dt.weekday() >= 5:
        fails.append(f"截止日期落在周末: {ds} ({dt.strftime('%A')})")

# ===== 5. 净利润不得作为指标 =====
for line in nmd.splitlines():
    if "净利润" in line and re.search(r"[≥≤]|目标值", line):
        if not any(w in line for w in ("不能","不得","前提","缺","无")):
            fails.append(f"疑似把净利润设为目标: {line.strip()[:70]}")

# ===== 6. 必备结构 =====
for must in ["待验证假设", "建议截止日期", "日期全部为建议值", "材料未给", "建议值", "限制", "指标"]:
    if must not in nmd:
        fails.append(f"缺少必备内容: {must}")

all_dates = set(re.findall(r"2026-\d{2}-\d{2}", nmd))
print("=== 行动清单核验（精确版）===")
print(f"断言 {len(claims)} 项；截止日期 {len(all_dates)} 个")
print(f"失败 {len(fails)} 项")
for f in fails:
    print("  FAIL:", f)
print("结果:", "全部通过" if not fails else "存在问题")
sys.exit(1 if fails else 0)
