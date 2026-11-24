// Independently re-run generated code tests and check source-data arithmetic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-artifact-"));
try {
  for (const name of ["pomodoro.html", "pomodoro.test.js"])
    fs.copyFileSync(
      "docs/evidence/code/artifacts/" + name,
      path.join(temporary, name),
    );
  const result = spawnSync(
    process.execPath,
    [path.join(temporary, "pomodoro.test.js")],
    { cwd: temporary, encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  fs.writeFileSync(
    "docs/evidence/generated-code-tests.txt",
    (result.stdout || "") + (result.stderr || ""),
  );
  assert.equal(
    result.status,
    0,
    "Generated code tests failed; inspect evidence output",
  );
  const html = fs.readFileSync(path.join(temporary, "pomodoro.html"), "utf8");
  assert.ok(
    !/\b(?:src|href)\s*=\s*["']https?:\/\//i.test(html),
    "HTML has external dependencies",
  );
  const source = fs
    .readFileSync("demo/materials/sales.csv", "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((row) => row.split(","));
  const totals = source.reduce(
    (t, row) => ({
      revenue: t.revenue + Number(row[2]),
      refunds: t.refunds + Number(row[4]),
      cost: t.cost + Number(row[5]),
    }),
    { revenue: 0, refunds: 0, cost: 0 },
  );
  const summary = fs
    .readFileSync("docs/evidence/work/artifacts/summary.csv", "utf8")
    .split(/\r?\n/);
  const totalRow = summary.find((row) => row.startsWith("TOTAL,")).split(",");
  assert.equal(Number(totalRow[1]), totals.revenue);
  assert.equal(Number(totalRow[2]), totals.cost);
  assert.equal(Number(totalRow[3]), totals.revenue - totals.cost);
  assert.equal(Number(totalRow[5]), totals.refunds);
  for (const month of ["2026-08", "2026-09", "2026-10"]) {
    const rows = source.filter((row) => row[0] === month);
    const row = summary.find((row) => row.startsWith(month + ",")).split(",");
    assert.equal(
      Number(row[1]),
      rows.reduce((n, r) => n + Number(r[2]), 0),
    );
    assert.equal(
      Number(row[2]),
      rows.reduce((n, r) => n + Number(r[5]), 0),
    );
    assert.equal(
      Number(row[5]),
      rows.reduce((n, r) => n + Number(r[4]), 0),
    );
  }
  const report = {
    verifiedAt: new Date().toISOString(),
    codeTests:
      "PASS: generated tests independently re-run in an isolated directory",
    offlineHTML: "PASS: no external src/href dependencies",
    arithmetic: {
      result: "PASS: all months and totals match the uploaded source CSV",
      ...totals,
      grossProfit: totals.revenue - totals.cost,
    },
  };
  fs.writeFileSync(
    "docs/evidence/artifact-verification.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
