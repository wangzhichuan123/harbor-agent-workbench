// Read-only acceptance checks against the running app. No model calls.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import crypto from "node:crypto";
const index = JSON.parse(
  await fs.readFile("docs/evidence/demo-index.json", "utf8"),
);
const results = {
  verifiedAt: new Date().toISOString(),
  model: index.health.model,
  sessions: [],
};
for (const kind of ["code", "work"]) {
  const id = index[kind],
    base = index.base;
  const snapshot = await fetch(`${base}/api/sessions/${id}?full=1`).then((r) =>
    r.json(),
  );
  assert.equal(snapshot.runs.length, 2);
  assert.ok(snapshot.runs.every((r) => r.status === "completed"));
  const expected =
    kind === "code"
      ? ["artifacts/pomodoro.html"]
      : [
          "artifacts/review.md",
          "artifacts/summary.csv",
          "artifacts/action-plan.md",
        ];
  const hashes = {};
  for (const file of snapshot.files) {
    const data = await fetch(
      `${base}/api/sessions/${id}/file?path=${encodeURIComponent(file.path)}&download=1`,
    ).then((r) => r.arrayBuffer());
    hashes[file.path] = crypto
      .createHash("sha256")
      .update(Buffer.from(data))
      .digest("hex");
  }
  for (const name of expected)
    assert.ok(hashes[name], `${kind}: missing ${name}`);
  results.sessions.push({
    kind,
    id,
    runIds: snapshot.runs.map((r) => r.id),
    statuses: snapshot.runs.map((r) => r.status),
    eventCount: snapshot.events.length,
    toolCalls: snapshot.events.filter((e) => e.type === "tool").length,
    hashes,
  });
}
const baselineFile = "docs/evidence/live-baseline.json";
if (process.argv.includes("--compare")) {
  const baseline = JSON.parse(await fs.readFile(baselineFile, "utf8"));
  assert.deepEqual(
    results.sessions,
    baseline.sessions,
    "Restart changed conversations, events, or files",
  );
  await fs.writeFile(
    "docs/evidence/restart-verified.json",
    JSON.stringify(
      {
        ...results,
        result:
          "PASS: Docker restart preserved both sessions, turns, events, and all file SHA-256 hashes.",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: Docker restart retained both completed sessions, four turns, event counts, and every file hash.",
  );
} else {
  await fs.writeFile(baselineFile, JSON.stringify(results, null, 2));
  console.log(
    "PASS: four completed real CLI turns and all required deliverables present. Saved restart baseline.",
  );
}
