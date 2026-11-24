// Read-only verification of version metadata and persisted blob bytes.
import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
const base = process.env.WORKBENCH_URL || "http://127.0.0.1:3000";
const baselinePath = "docs/evidence/versions-baseline.json";
const ids = JSON.parse(fs.readFileSync("docs/evidence/live-baseline.json", "utf8")).sessions.map((session) => session.id);
async function get(route) {
  const response = await fetch(base + "/api" + route);
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response;
}
const sessions = [];
for (const id of ids) {
  const { files } = await (await get(`/sessions/${id}/versions`)).json();
  const versions = [];
  for (const file of files) {
    let before;
    for (;;) {
      const query = new URLSearchParams({ path: file.path, limit: "100" });
      if (before) query.set("before", before);
      const page = await (await get(`/sessions/${id}/versions?${query}`)).json();
      for (const version of page.items) {
        if (!version.deleted) {
          const bytes = await (await get(`/sessions/${id}/versions/${version.id}?download=1`)).arrayBuffer();
          assert.equal(crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex"), version.hash);
          assert.equal(bytes.byteLength, version.size);
        }
        versions.push(version);
      }
      if (!page.hasMore) break;
      before = page.nextBefore;
    }
  }
  assert.ok(versions.length > 0, "Expected legacy workspace baseline versions");
  sessions.push({ id, versions });
}
const result = { checkedAt: new Date().toISOString(), sessions };
if (process.argv.includes("--baseline")) fs.writeFileSync(baselinePath, JSON.stringify(result, null, 2) + "\n");
else if (process.argv.includes("--compare")) {
  assert.deepEqual(sessions, JSON.parse(fs.readFileSync(baselinePath, "utf8")).sessions);
  fs.writeFileSync("docs/evidence/versions-restart-verified.json", JSON.stringify({ ...result, matchesBaseline: true }, null, 2) + "\n");
} else throw new Error("Use --baseline before restart, then --compare after restart");
console.log(`Verified ${sessions.length} sessions and ${sessions.reduce((total, session) => total + session.versions.length, 0)} version blobs; hashes and metadata match.`);
