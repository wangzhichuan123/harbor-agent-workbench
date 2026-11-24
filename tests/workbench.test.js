import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { createStore } from "../server/store.js";
import { resolveFile, listFiles, safeName } from "../server/files.js";
import {
  mergeSnapshots,
  clearSubmittedDraft,
  createRequestTracker,
  applyLiveEvent,
  mergeLogRefresh,
} from "../src/session-state.js";
import { FileVersions } from "../server/versions.js";

const fixture = fileURLToPath(new URL("./fixture-cli.mjs", import.meta.url));
const delay = (n) => new Promise((resolve) => setTimeout(resolve, n));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "harbor-test-"));
test("live log bursts keep every middle page reachable", () => {
  const page = (ids, hasMore = true) => ({
    items: ids.map((id) => ({ id })),
    hasMore,
    nextBefore: ids.at(-1),
  });
  const previous = page([100, 99, 98, 97]);
  const overlapping = mergeLogRefresh(previous, page([102, 101, 100]));
  assert.deepEqual(
    overlapping.items.map((item) => item.id),
    [102, 101, 100, 99, 98, 97],
  );
  assert.equal(overlapping.nextBefore, 97);
  const burst = page([200, 199, 198]);
  assert.deepEqual(mergeLogRefresh(previous, burst), burst);
  assert.equal(mergeLogRefresh(previous, burst).nextBefore, 198);
});
const post = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
async function waitFor(fn, message) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await delay(70);
  }
  throw new Error(message || "wait timed out");
}

test("HTTP lifecycle: multi-session, upload, real subprocess protocol, follow-up, SSE replay, downloads, failures and cancellation", async (t) => {
  process.env.AGENT_API_KEY = "fixture-secret-do-not-persist";
  const root = temp();
  const service = await createApp({
    dataDir: root,
    config: {
      model: "fixture",
      baseURL: "https://unused.invalid/v1",
      cli: process.execPath,
      cliArgs: [fixture],
      concurrency: 1,
      timeout: 30000,
    },
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    service.store.close();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_API_KEY;
  });
  const request = (url, options) => fetch(base + url, options);
  const read = async (url) => (await request(url)).json();
  const make = async (title, kind) =>
    (await request("/sessions", post({ title, kind }))).json();
  const code = await make("代码开发", "code"),
    work = await make("日常分析", "work");

  await t.test(
    "sessions and files are isolated; duplicate uploads preserve originals",
    async () => {
      const form = new FormData();
      form.append("files", new Blob(["revenue\n100"]), "input.csv");
      assert.equal(
        (
          await request(`/sessions/${work.id}/files`, {
            method: "POST",
            body: form,
          })
        ).status,
        201,
      );
      const second = new FormData();
      second.append("files", new Blob(["other"]), "input.csv");
      await request(`/sessions/${work.id}/files`, {
        method: "POST",
        body: second,
      });
      const snapshot = await read(`/sessions/${work.id}`);
      assert.deepEqual(
        snapshot.files.map((f) => f.path),
        ["uploads/input (2).csv", "uploads/input.csv"],
      );
      assert.equal((await read(`/sessions/${code.id}`)).files.length, 0);
      assert.equal(
        (await request(`/sessions/${code.id}/file?path=uploads/input.csv`))
          .status,
        400,
      );
      for (const name of [
        "../workbench.sqlite",
        ".secret",
        "/etc/passwd",
        "uploads/../../workbench.sqlite",
        "uploads\\..\\..\\workbench.sqlite",
      ])
        assert.equal(
          (
            await request(
              `/sessions/${work.id}/file?path=${encodeURIComponent(name)}`,
            )
          ).status,
          400,
        );
      assert.equal(
        (
          await request("/sessions", {
            ...post({ title: "bad" }),
            headers: {
              "Content-Type": "application/json",
              Origin: "https://evil.example",
            },
          })
        ).status,
        403,
      );
    },
  );
  await t.test(
    "queue serializes work, rejects duplicate turns, cancellation stops a process",
    async () => {
      const slow = await (
        await request(
          `/sessions/${code.id}/runs`,
          post({ prompt: "slow work" }),
        )
      ).json();
      await waitFor(async () =>
        (await read(`/sessions/${code.id}`)).runs.some(
          (r) => r.status === "running",
        ),
      );
      assert.equal(
        (
          await request(
            `/sessions/${code.id}/runs`,
            post({ prompt: "duplicate" }),
          )
        ).status,
        409,
      );
      assert.equal(
        (await request(`/sessions/${code.id}`, { method: "DELETE" })).status,
        409,
      );
      const queued = await (
        await request(
          `/sessions/${work.id}/runs`,
          post({ prompt: "analyze input" }),
        )
      ).json();
      assert.equal(
        (await read(`/sessions/${work.id}`)).runs[0].status,
        "queued",
      );
      await request(`/sessions/${code.id}/runs/${slow.id}/cancel`, post({}));
      await waitFor(
        async () =>
          (await read(`/sessions/${code.id}`)).runs[0].status === "cancelled",
      );
      await waitFor(
        async () =>
          (await read(`/sessions/${work.id}`)).runs.find(
            (r) => r.id === queued.id,
          )?.status === "completed",
      );
      const snapshot = await read(`/sessions/${work.id}`);
      assert.match(snapshot.runs[0].answer, /artifacts\/result.md/);
      assert.ok(snapshot.events.some((e) => e.type === "tool"));
      assert.ok(
        snapshot.events.every((e) => Number.isInteger(e.id) && e.id > 0),
      );
    },
  );
  await t.test(
    "follow-up reuses CLI session; replay cursor returns only new events; ZIP works",
    async () => {
      const before = await read(`/sessions/${work.id}`),
        cursor = before.events.at(-1).id;
      await request(
        `/sessions/${work.id}/runs`,
        post({ prompt: "follow-up report" }),
      );
      await waitFor(async () => {
        const s = await read(`/sessions/${work.id}`);
        return s.runs.length === 2 && s.runs.at(-1).status === "completed";
      });
      const stream = await request(
          `/sessions/${work.id}/events?after=${cursor}`,
        ),
        reader = stream.body.getReader();
      const { value } = await reader.read();
      const data = new TextDecoder().decode(value);
      const ids = [...data.matchAll(/id: (\d+)/g)].map((m) => Number(m[1]));
      assert.ok(ids.length > 0 && ids.every((id) => id > cursor));
      await reader.cancel();
      const latest = await read(`/sessions/${work.id}`);
      assert.equal(
        service.store.one("SELECT cli_session FROM sessions WHERE id=?", [
          work.id,
        ]).cli_session,
        "ses_fixture123",
      );
      assert.equal(latest.runs.length, 2);
      const download = await request(
        `/sessions/${work.id}/file?path=artifacts/result.md&download=1`,
      );
      assert.match(download.headers.get("content-disposition"), /attachment/);
      assert.match(await download.text(), /follow-up report/);
      const zip = Buffer.from(
        await (await request(`/sessions/${work.id}/archive`)).arrayBuffer(),
      );
      assert.equal(zip.subarray(0, 2).toString(), "PK");
      assert.ok(zip.includes(Buffer.from("uploads/input.csv")));
    },
  );
  await t.test(
    "CLI errors are surfaced and secrets redacted; exit zero without stop is not success",
    async () => {
      await request(`/sessions/${work.id}/runs`, post({ prompt: "fail" }));
      const failure = await waitFor(async () => {
        const s = await read(`/sessions/${work.id}`);
        return s.runs.at(-1).status === "failed" && s;
      });
      assert.match(failure.runs.at(-1).error, /REDACTED/);
      assert.ok(!JSON.stringify(failure).includes(process.env.AGENT_API_KEY));
      await request(`/sessions/${work.id}/runs`, post({ prompt: "partial" }));
      await waitFor(async () => {
        const s = await read(`/sessions/${work.id}`);
        return (
          s.runs.at(-1).prompt === "partial" &&
          s.runs.at(-1).status === "failed"
        );
      });
      await request(`/sessions/${work.id}/runs`, post({ prompt: "length" }));
      const limited = await waitFor(async () => {
        const s = await read(`/sessions/${work.id}`);
        return (
          s.runs.at(-1).prompt === "length" &&
          s.runs.at(-1).status === "failed" &&
          s
        );
      });
      assert.match(limited.runs.at(-1).error, /长度限制/);
      await request(
        `/sessions/${work.id}/runs`,
        post({ prompt: "unfinished-next-step" }),
      );
      await waitFor(async () => {
        const s = await read(`/sessions/${work.id}`);
        return (
          s.runs.at(-1).prompt === "unfinished-next-step" &&
          s.runs.at(-1).status === "failed"
        );
      });
      const stored = await createStore(root);
      assert.equal(stored.all("SELECT * FROM sessions").length, 2);
      assert.ok(stored.all("SELECT * FROM events").length > 0);
      stored.close();
    },
  );
  await t.test(
    "long assistant replies are complete while tool logs are visibly truncated and secrets redacted",
    async () => {
      await request(
        `/sessions/${work.id}/runs`,
        post({ prompt: "long-answer" }),
      );
      const snapshot = await waitFor(async () => {
        const s = await read(`/sessions/${work.id}`);
        return s.runs.at(-1).status === "completed" && s;
      });
      const run = snapshot.runs.at(-1);
      assert.ok(run.answer.length > 16000);
      assert.ok(run.answer.endsWith("[REDACTED]回复结束\n\n"));
      assert.ok(!JSON.stringify(snapshot).includes(process.env.AGENT_API_KEY));
      const tool = snapshot.events
        .filter((e) => e.run_id === run.id && e.type === "tool")
        .at(-1);
      assert.match(tool.data.output, /展示已截断/);
    },
  );
  await t.test(
    "deleting a session removes its runs and replay events",
    async () => {
      assert.equal(
        (await request(`/sessions/${work.id}`, { method: "DELETE" })).status,
        200,
      );
      assert.equal(
        service.store.all("SELECT * FROM runs WHERE session_id=?", [work.id])
          .length,
        0,
      );
      assert.equal(
        service.store.all("SELECT * FROM events WHERE session_id=?", [work.id])
          .length,
        0,
      );
      assert.equal((await request(`/sessions/${work.id}`)).status, 404);
      assert.equal((await read("/sessions")).length, 1);
    },
  );
});

test("drafts remain scoped to the submitted session and retain edits made during a pending send", () => {
  const drafts = {
    first: "sent text",
    second: "keep this draft",
    home: "home draft",
  };
  assert.deepEqual(clearSubmittedDraft(drafts, "first", "sent text"), {
    first: "",
    second: "keep this draft",
    home: "home draft",
  });
  assert.equal(clearSubmittedDraft(drafts, "first", "earlier text"), drafts);
  assert.deepEqual(clearSubmittedDraft({}, null, "home text", "home text"), {
    home: "",
  });
});

test("stale REST responses cannot discard streamed text or roll a completed run back to running", () => {
  const previous = {
    session: { id: "a" },
    files: [],
    runs: [{ id: "run", status: "completed" }],
    events: [
      { id: 1, run_id: "run", type: "status", data: { status: "running" } },
      { id: 2, run_id: "run", type: "text", data: { text: "retained reply" } },
      { id: 3, run_id: "run", type: "status", data: { status: "completed" } },
    ],
  };
  const stale = {
    ...previous,
    runs: [{ id: "run", status: "running" }],
    events: [previous.events[0]],
  };
  const merged = mergeSnapshots(previous, stale);
  assert.equal(merged.runs[0].status, "completed");
  assert.equal(merged.events[1].data.text, "retained reply");
  assert.deepEqual(
    merged.events.map((e) => e.id),
    [1, 2, 3],
  );
  const other = { session: { id: "b" }, runs: [], events: [], files: [] };
  assert.equal(mergeSnapshots(previous, other), other);
});

test("late session and preview requests are invalidated without affecting another session", () => {
  const requests = createRequestTracker();
  const oldA = requests.start("a"),
    b = requests.start("b"),
    newA = requests.start("a");
  assert.equal(oldA(), false);
  assert.equal(newA(), true);
  assert.equal(b(), true);
  const preview = requests.start("preview");
  requests.invalidate("preview");
  assert.equal(preview(), false);
});

test("Unicode upload names fit Linux byte limits and file listings obey the advertised cap", () => {
  const name = safeName("经营分析".repeat(50) + ".csv");
  assert.ok(Buffer.byteLength(name) <= 180);
  assert.ok(name.endsWith(".csv"));
  assert.equal(name.includes("\ufffd"), false);
  assert.throws(() => safeName(".env"));
  const root = temp();
  try {
    fs.writeFileSync(path.join(root, name), "unicode file");
    for (let i = 0; i < 1505; i++)
      fs.writeFileSync(path.join(root, `${i}.txt`), "");
    assert.equal(listFiles(root).length, 1500);
    assert.deepEqual(listFiles(path.join(root, "missing")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart marks running turns interrupted and preserves history and files", async () => {
  const root = temp(),
    store = await createStore(root),
    date = new Date().toISOString();
  store.run(
    "INSERT INTO sessions(id,title,kind,created_at,updated_at) VALUES(?,?,?,?,?)",
    ["persisted", "test", "work", date, date],
  );
  store.run(
    "INSERT INTO runs(id,session_id,prompt,status,created_at) VALUES(?,?,?,?,?)",
    ["turn", "persisted", "do work", "running", date],
  );
  store.close();
  const service = await createApp({ dataDir: root });
  assert.equal(
    service.store.one("SELECT status FROM runs WHERE id=?", ["turn"]).status,
    "interrupted",
  );
  assert.equal(
    service.store.one("SELECT title FROM sessions WHERE id=?", ["persisted"])
      .title,
    "test",
  );
  service.close();
  service.store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("timeout stops a running CLI and keeps a resumable failed turn", async (t) => {
  process.env.AGENT_API_KEY = "fixture-secret";
  const root = temp(),
    service = await createApp({
      dataDir: root,
      config: {
        model: "fixture",
        baseURL: "https://unused.invalid",
        cli: process.execPath,
        cliArgs: [fixture],
        timeout: 1000,
      },
    });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    service.store.close();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_API_KEY;
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const session = await (
    await fetch(base + "/sessions", post({ title: "timeout" }))
  ).json();
  await fetch(`${base}/sessions/${session.id}/runs`, post({ prompt: "slow" }));
  const snapshot = await waitFor(async () => {
    const s = await (await fetch(`${base}/sessions/${session.id}`)).json();
    return s.runs[0]?.status === "timed_out" && s;
  });
  assert.match(snapshot.runs[0].error, /超时/);
  assert.equal(snapshot.session.id, session.id);
});

test("file listing hides internal state and rejects directory junctions/symlinks", () => {
  const root = temp();
  fs.mkdirSync(path.join(root, "files"));
  fs.mkdirSync(path.join(root, "outside"));
  fs.writeFileSync(path.join(root, "outside", "secret"), "hidden");
  fs.writeFileSync(path.join(root, "files", ".env"), "hidden");
  fs.writeFileSync(path.join(root, "files", "visible.txt"), "ok");
  fs.symlinkSync(
    path.join(root, "outside"),
    path.join(root, "files", "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.deepEqual(
    listFiles(path.join(root, "files")).map((f) => f.path),
    ["visible.txt"],
  );
  assert.throws(() => resolveFile(path.join(root, "files"), "link/secret"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("version rollback, legacy migration and paginated searchable logs", async (t) => {
  process.env.AGENT_API_KEY = "fixture-version-key";
  const root = temp(),
    workspace = path.join(root, "workspaces", "legacy");
  fs.mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "artifacts", "legacy.md"),
    "legacy content",
  );
  const initial = await createStore(root),
    date = new Date().toISOString();
  initial.run(
    "INSERT INTO sessions(id,title,kind,created_at,updated_at) VALUES(?,?,?,?,?)",
    ["legacy", "old workspace", "code", date, date],
  );
  initial.close();
  const service = await createApp({
    dataDir: root,
    config: {
      model: "fixture",
      baseURL: "https://unused.invalid",
      cli: process.execPath,
      cliArgs: [fixture],
      concurrency: 1,
      timeout: 30000,
    },
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    service.store.close();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_API_KEY;
  });
  const request = (url, options) => fetch(base + url, options),
    read = async (url) => (await request(url)).json();
  const history = (name) =>
    read(
      `/sessions/legacy/versions?path=${encodeURIComponent(name)}&limit=100`,
    );
  const restore = (version) =>
    request(`/sessions/legacy/versions/${version.id}/restore`, post({}));
  const task = async (prompt) => {
    const run = await (
      await request("/sessions/legacy/runs", post({ prompt }))
    ).json();
    await waitFor(
      async () =>
        (await read("/sessions/legacy")).runs.find((r) => r.id === run.id)
          ?.status === "completed",
    );
    return run;
  };
  let firstVersion, editedVersion;
  await t.test(
    "existing workspaces get a baseline; each CLI turn saves immutable changed content",
    async () => {
      const legacy = await history("artifacts/legacy.md");
      assert.equal(legacy.items.length, 1);
      assert.equal(legacy.items[0].reason, "baseline");
      assert.equal(
        (await read(`/sessions/legacy/versions/${legacy.items[0].id}`)).content,
        "legacy content",
      );
      const first = await task("revision-one"),
        second = await task("revision-two");
      const versions = await history("artifacts/result.md");
      assert.equal(versions.items.length, 2);
      firstVersion = versions.items[1];
      assert.equal(versions.items[0].run_id, second.id);
      assert.equal(firstVersion.run_id, first.id);
      assert.notEqual(versions.items[0].hash, firstVersion.hash);
      assert.equal(
        (await read(`/sessions/legacy/versions/${firstVersion.id}`)).content,
        "# Completed\nrevision-one",
      );
      const download = await request(
        `/sessions/legacy/versions/${firstVersion.id}?download=1`,
      );
      assert.match(download.headers.get("content-disposition"), /attachment/);
      assert.equal(await download.text(), "# Completed\nrevision-one");
    },
  );
  await t.test(
    "rollback backs up unsaved edits and can itself be reversed",
    async () => {
      fs.writeFileSync(
        path.join(workspace, "artifacts/result.md"),
        "edit outside a task",
      );
      assert.equal((await restore(firstVersion)).status, 200);
      assert.equal(
        fs.readFileSync(path.join(workspace, "artifacts/result.md"), "utf8"),
        "# Completed\nrevision-one",
      );
      const versions = await history("artifacts/result.md");
      assert.equal(versions.items[0].reason, "restore");
      editedVersion = versions.items.find((v) => v.reason === "before_restore");
      assert.ok(editedVersion);
      assert.equal(
        (await read(`/sessions/legacy/versions/${editedVersion.id}`)).content,
        "edit outside a task",
      );
      assert.equal((await restore(editedVersion)).status, 200);
      assert.equal(
        fs.readFileSync(path.join(workspace, "artifacts/result.md"), "utf8"),
        "edit outside a task",
      );
      const smallPage = await read(
        "/sessions/legacy/versions?path=artifacts/result.md&limit=2",
      );
      assert.equal(smallPage.items.length, 2);
      assert.equal(smallPage.hasMore, true);
      const older = await read(
        `/sessions/legacy/versions?path=artifacts/result.md&limit=2&before=${smallPage.nextBefore}`,
      );
      assert.ok(older.items.every((v) => v.id < smallPage.nextBefore));
    },
  );
  await t.test(
    "deleted files can be restored and deletion versions can be selected",
    async () => {
      fs.unlinkSync(path.join(workspace, "artifacts/result.md"));
      const deleted = (await history("artifacts/result.md")).items[0];
      assert.equal(deleted.deleted, 1);
      assert.equal((await restore(firstVersion)).status, 200);
      assert.ok(fs.existsSync(path.join(workspace, "artifacts/result.md")));
      assert.equal((await restore(deleted)).status, 200);
      assert.equal(
        fs.existsSync(path.join(workspace, "artifacts/result.md")),
        false,
      );
      await restore(firstVersion);
    },
  );
  await t.test(
    "versions persist across store reload and cannot cross sessions or symlinks",
    async () => {
      const other = await (
        await request("/sessions", post({ title: "other" }))
      ).json();
      assert.equal(
        (await request(`/sessions/${other.id}/versions/${firstVersion.id}`))
          .status,
        404,
      );
      assert.equal(
        (
          await request(
            `/sessions/${other.id}/versions/${firstVersion.id}/restore`,
            post({}),
          )
        ).status,
        404,
      );
      for (const name of ["../workbench.sqlite", "uploads/private.txt", ".env"])
        assert.equal(
          (
            await request(
              `/sessions/legacy/versions?path=${encodeURIComponent(name)}`,
            )
          ).status,
          400,
        );
      const reloaded = await createStore(root),
        saved = new FileVersions(reloaded, root);
      assert.equal(
        fs.readFileSync(
          saved.blob(saved.get("legacy", firstVersion.id)),
          "utf8",
        ),
        "# Completed\nrevision-one",
      );
      reloaded.close();
      const outside = path.join(root, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "result.md"), "must stay unchanged");
      fs.symlinkSync(
        outside,
        path.join(workspace, "unsafe"),
        process.platform === "win32" ? "junction" : "dir",
      );
      service.store.run(
        "INSERT INTO file_versions(session_id,path,hash,size,deleted,reason,created_at) VALUES(?,?,?,?,?,?,?)",
        [
          "legacy",
          "unsafe/result.md",
          firstVersion.hash,
          firstVersion.size,
          0,
          "baseline",
          date,
        ],
      );
      const unsafe = service.store.one(
        "SELECT * FROM file_versions WHERE path='unsafe/result.md'",
      );
      assert.equal((await restore(unsafe)).status, 400);
      assert.equal(
        fs.readFileSync(path.join(outside, "result.md"), "utf8"),
        "must stay unchanged",
      );
      service.store.run("DELETE FROM file_versions WHERE id=?", [unsafe.id]);
    },
  );
  await t.test("rollback is rejected while a CLI task is running", async () => {
    const run = await (
      await request("/sessions/legacy/runs", post({ prompt: "slow" }))
    ).json();
    await waitFor(
      async () =>
        (await read("/sessions/legacy")).runs.find((r) => r.id === run.id)
          ?.status === "running",
    );
    assert.equal((await restore(firstVersion)).status, 409);
    await request(`/sessions/legacy/runs/${run.id}/cancel`, post({}));
    await waitFor(
      async () =>
        (await read("/sessions/legacy")).runs.find((r) => r.id === run.id)
          ?.status === "cancelled",
    );
  });
  await t.test(
    "binary versions stream across chunks and corrupted history never overwrites the current file",
    async () => {
      const name = path.join(workspace, "artifacts", "binary.bin"),
        bytes = Buffer.alloc(350000, 173);
      fs.writeFileSync(name, bytes);
      const original = (await history("artifacts/binary.bin")).items[0];
      fs.writeFileSync(name, Buffer.from("new current data"));
      fs.writeFileSync(service.versions.blob(original), "corrupted");
      const rejected = await restore(original);
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /校验失败/);
      assert.equal(fs.readFileSync(name, "utf8"), "new current data");
      fs.writeFileSync(service.versions.blob(original), bytes);
      assert.equal((await restore(original)).status, 200);
      assert.deepEqual(fs.readFileSync(name), bytes);
    },
  );
  const long = await (
    await request("/sessions", post({ title: "long conversation" }))
  ).json();
  const needle = "Needle稀有%_";
  service.store.transaction(() => {
    for (let i = 0; i < 65; i++) {
      const id = `history-${i}`;
      service.store.raw(
        "INSERT INTO runs(id,session_id,prompt,status,answer,created_at) VALUES(?,?,?,?,?,?)",
        [id, long.id, `task-${i}`, "completed", `reply-${i}`, date],
      );
      for (const [type, data] of [
        ["text", { text: `reply-${i}` }],
        [
          "tool",
          {
            tool: "bash",
            title: `command-${i}`,
            output: i === 2 ? "x".repeat(9000) + needle : `output-${i}`,
          },
        ],
        ["status", { status: "completed" }],
      ])
        service.store.raw(
          "INSERT INTO events(session_id,run_id,type,data,created_at) VALUES(?,?,?,?,?)",
          [long.id, id, type, JSON.stringify(data), date],
        );
    }
  });
  await t.test(
    "dialogue pages are bounded and cursor pagination has no gaps or duplicates",
    async () => {
      let snapshot = await read(`/sessions/${long.id}`),
        all = snapshot.runs.map((r) => r.id);
      assert.equal(snapshot.runs.length, 20);
      assert.equal(snapshot.events.length, 50);
      assert.equal(snapshot.page.total, 65);
      while (snapshot.page.hasMore) {
        snapshot = await read(
          `/sessions/${long.id}?before=${snapshot.page.nextBefore}`,
        );
        all.push(...snapshot.runs.map((r) => r.id));
      }
      assert.equal(all.length, 65);
      assert.equal(new Set(all).size, 65);
      const exported = await read(`/sessions/${long.id}?full=1`);
      assert.equal(exported.runs.length, 65);
      assert.equal(exported.events.length, 195);
      for (const query of ["limit=0", "limit=101", "before=-1", "before=abc"])
        assert.equal(
          (await request(`/sessions/${long.id}?${query}`)).status,
          400,
        );
    },
  );
  await t.test(
    "log search covers unloaded history, literal Unicode terms, types and task prompts",
    async () => {
      const result = await read(
        `/sessions/${long.id}/logs?q=${encodeURIComponent(needle)}`,
      );
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].run_id, "history-2");
      assert.ok(result.items[0].data.output.includes(needle));
      assert.equal(result.items[0].data.truncated, true);
      const detail = await read(
        `/sessions/${long.id}/logs/${result.items[0].id}`,
      );
      assert.equal(detail.data.output, "x".repeat(9000) + needle);
      assert.equal(
        (await request(`/sessions/legacy/logs/${detail.id}`)).status,
        404,
      );
      assert.equal(
        (
          await read(
            `/sessions/${long.id}/logs?q=${encodeURIComponent("' OR 1=1 --")}`,
          )
        ).items.length,
        0,
      );
      const prompt = await read(`/sessions/${long.id}/logs?q=task-12`);
      assert.equal(prompt.items.length, 3);
      let page = await read(`/sessions/${long.id}/logs?type=tool&limit=17`),
        ids = page.items.map((e) => e.id);
      while (page.hasMore) {
        page = await read(
          `/sessions/${long.id}/logs?type=tool&limit=17&before=${page.nextBefore}`,
        );
        ids.push(...page.items.map((e) => e.id));
      }
      assert.equal(ids.length, 65);
      assert.equal(new Set(ids).size, 65);
      assert.equal(
        (await request(`/sessions/${long.id}/logs?type=invalid`)).status,
        400,
      );
    },
  );
  await t.test("SSE replays multiple bounded batches in order", async () => {
    const response = await request(`/sessions/${long.id}/events?after=0`),
      reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      ids = [];
    while (ids.length < 195) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop();
      for (const chunk of chunks) {
        const match = chunk.match(/^id: (\d+)/m);
        if (match) ids.push(Number(match[1]));
      }
    }
    await reader.cancel();
    assert.equal(new Set(ids).size, 195);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
    );
  });
});

test("bounded live events preserve full reply text and paginated snapshots keep older loaded turns", () => {
  let snapshot = {
    session: { id: "a" },
    runs: [{ id: "run", sequence: 1, answer: "", tool_count: 0 }],
    events: [],
    page: { total: 1 },
  };
  for (let id = 1; id <= 350; id++)
    snapshot = applyLiveEvent(snapshot, {
      id,
      session_id: "a",
      run_id: "run",
      type: "text",
      data: { text: `part-${id}` },
    });
  assert.equal(snapshot.events.length, 200);
  assert.ok(snapshot.runs[0].answer.includes("part-1\n"));
  assert.ok(snapshot.runs[0].answer.includes("part-350"));
  const stale = {
    session: { id: "a" },
    runs: [{ id: "run", sequence: 1, answer: "old", answer_cursor: 1 }],
    events: [],
    page: { total: 1 },
  };
  const merged = mergeSnapshots(snapshot, stale);
  assert.equal(merged.runs[0].answer, snapshot.runs[0].answer);
  const earlier = {
    session: { id: "a" },
    runs: [{ id: "earlier", sequence: 0 }],
    events: [],
    page: { total: 2 },
  };
  const paged = mergeSnapshots(merged, earlier);
  assert.equal(paged.runs.length, 2);
  assert.equal(paged.runs[0].id, "earlier");
  assert.equal(paged.page.hasMore, false);
});
