import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const base =
  process.env.WORKBENCH_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const evidence = path.resolve("docs/evidence");
await fs.mkdir(evidence, { recursive: true });
async function call(url, options) {
  const r = await fetch(base + "/api" + url, options);
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}
const post = (data) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
async function submit(session, prompt) {
  return call(`/sessions/${session.id}/runs`, post({ prompt }));
}
async function wait(session, run) {
  let previous = "",
    deadline = Date.now() + 11 * 60000;
  while (Date.now() < deadline) {
    const snapshot = await call(`/sessions/${session.id}`),
      value = snapshot.runs.find((r) => r.id === run.id);
    const tools = snapshot.events.filter(
      (e) => e.run_id === run.id && e.type === "tool",
    ).length;
    const summary = `${session.title}: ${value.status} · ${tools} tool calls`;
    if (summary !== previous) {
      console.log(summary);
      previous = summary;
    }
    if (!["running", "queued"].includes(value.status)) {
      await fs.writeFile(
        path.join(evidence, session.kind + "-session.json"),
        JSON.stringify(snapshot, null, 2),
      );
      if (value.status !== "completed")
        throw new Error(`${session.title}: ${value.error || value.status}`);
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Demo deadline exceeded");
}
const health = await call("/health");
assert.ok(health.configured, "Configure .env first");
const code = await call(
  "/sessions",
  post({ title: "番茄钟 · 从想法到工具", kind: "code" }),
);
const work = await call(
  "/sessions",
  post({ title: "经营复盘 · 材料与行动", kind: "work" }),
);
const form = new FormData();
for (const name of ["sales.csv", "meeting-notes.txt"])
  form.append(
    "files",
    new Blob([await fs.readFile("demo/materials/" + name)]),
    name,
  );
await call(`/sessions/${work.id}/files`, { method: "POST", body: form });
await fs.writeFile(
  path.join(evidence, "demo-index.json"),
  JSON.stringify(
    {
      base,
      health,
      code: code.id,
      work: work.id,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(
  `Code: ${base}/?session=${code.id}\nWork: ${base}/?session=${work.id}`,
);
const initial = await Promise.all([
  submit(
    code,
    "开发一个独立的离线 HTML 番茄钟，不使用外部依赖。支持 25 分钟专注、5 分钟休息、开始、暂停、重置。保存为 artifacts/pomodoro.html。另写一段 Node 可执行的核心逻辑测试并实际运行。用中文说明成果路径、使用方式和验证结果。不要启动长期服务器。",
  ),
  submit(
    work,
    "读取 uploads/sales.csv 和 uploads/meeting-notes.txt，整理 8–10 月经营复盘。计算各月总收入、按渠道的收入趋势、退款率（退款额/收入）和毛利（收入-cost），明确缺少哪些净利润数据。保存 artifacts/review.md 和 artifacts/summary.csv；用实际脚本交叉核验总计，报告引用材料文件名，不捏造原因。",
  ),
]);
const initialResults = await Promise.allSettled([
  wait(code, initial[0]),
  wait(work, initial[1]),
]);
const failure = initialResults.find((r) => r.status === "rejected");
if (failure) throw failure.reason;
const follow = await Promise.all([
  submit(
    code,
    "继续修改刚才的番茄钟：增加自定义专注时长（1–60 分钟）与已完成专注次数，切换阶段不能重复计数；保留现有功能。补充并运行测试。",
  ),
  submit(
    work,
    "在上次分析基础上，为 11 月生成一份可执行的行动清单，包含负责人、截止日期、指标和待验证假设，保存 artifacts/action-plan.md。仅使用材料中已有的负责人；日期可以作为建议并明确标注。",
  ),
]);
const results = await Promise.allSettled([
  wait(code, follow[0]),
  wait(work, follow[1]),
]);
const laterFailure = results.find((r) => r.status === "rejected");
if (laterFailure) throw laterFailure.reason;
for (const session of [code, work]) {
  const snap = await call(`/sessions/${session.id}`);
  assert.equal(snap.runs.length, 2);
  assert.ok(snap.runs.every((r) => r.status === "completed"));
  for (const file of snap.files.filter(
    (f) => f.source === "artifact" && f.size < 1024 * 1024,
  )) {
    const response = await fetch(
      `${base}/api/sessions/${session.id}/file?path=${encodeURIComponent(file.path)}&download=1`,
    );
    assert.equal(response.status, 200);
    const target = path.join(evidence, session.kind, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
  }
  const archive = await fetch(`${base}/api/sessions/${session.id}/archive`);
  const zip = Buffer.from(await archive.arrayBuffer());
  assert.equal(zip.subarray(0, 2).toString(), "PK");
  await fs.writeFile(path.join(evidence, session.kind + "-workspace.zip"), zip);
}
console.log(
  "PASS: two real CLI sessions, uploads, four turns, artifacts, and ZIP downloads.",
);
