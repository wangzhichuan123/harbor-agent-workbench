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
} from "../src/session-state.js";

const fixture = fileURLToPath(new URL("./fixture-cli.mjs", import.meta.url));
const delay = (n) => new Promise((resolve) => setTimeout(resolve, n));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "harbor-test-"));
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
