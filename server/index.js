import express from "express";
import multer from "multer";
import yazl from "yazl";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import { AgentRunner } from "./agent.js";
import { listFiles, resolveFile, safeName } from "./files.js";
import { FileVersions } from "./versions.js";
import {
  readSnapshot,
  readLogs,
  pageNumber,
  subscribeEvents,
} from "./history.js";

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const activeStatuses = ["queued", "running"];
const httpError = (code, message) =>
  Object.assign(new Error(message), { status: code });

export async function createApp(options = {}) {
  const dataDir = path.resolve(
    options.dataDir || process.env.DATA_DIR || "./data",
  );
  const config = {
    model: process.env.AGENT_MODEL || "",
    baseURL: process.env.AGENT_API_BASE_URL || "",
    cli: process.env.AGENT_CLI || "opencode",
    concurrency: Math.min(
      4,
      Math.max(1, Number(process.env.MAX_CONCURRENT_RUNS) || 2),
    ),
    timeout: Math.max(1000, Number(process.env.RUN_TIMEOUT_MS) || 600000),
    ...options.config,
  };
  const store = await createStore(dataDir);
  const app = express();
  const subscribers = new Map();
  const versions = new FileVersions(store, dataDir);
  const runner = new AgentRunner({ store, dataDir, config, emit, versions });
  // Existing workspaces receive their first baseline without changing the dialogue.
  for (const row of store.all("SELECT id FROM sessions"))
    versions.capture(row.id);
  function emit(sessionId, runId, type, data) {
    const createdAt = now();
    store.run(
      "INSERT INTO events(session_id,run_id,type,data,created_at) VALUES(?,?,?,?,?)",
      [sessionId, runId, type, JSON.stringify(data), createdAt],
    );
    for (const client of subscribers.get(sessionId) || []) client.pump();
  }
  function session(id) {
    const value = store.one("SELECT * FROM sessions WHERE id=?", [id]);
    if (!value) throw httpError(404, "会话不存在");
    return value;
  }
  function busy(id) {
    return store.one(
      "SELECT id FROM runs WHERE session_id=? AND status IN ('queued','running')",
      [id],
    );
  }
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    // Prevent cross-site scripts/forms from submitting work to the local Agent.
    if (req.path.startsWith("/api/")) {
      const host = req.headers.host || "";
      const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      const allowed = [
        "127.0.0.1",
        "localhost",
        "::1",
        process.env.ALLOWED_HOST,
      ].filter(Boolean);
      if (!allowed.includes(hostname))
        return next(httpError(403, "不允许的访问主机"));
      if (req.headers["sec-fetch-site"] === "cross-site")
        return next(httpError(403, "禁止跨站访问"));
      if (req.headers.origin) {
        try {
          if (new URL(req.headers.origin).host !== host)
            return next(httpError(403, "禁止跨站访问"));
        } catch {
          return next(httpError(403, "来源无效"));
        }
      }
    }
    next();
  });
  app.use(express.json({ limit: "128kb" }));
  app.get("/api/health", (req, res) =>
    res.json({
      status: "ok",
      configured: Boolean(
        config.model && config.baseURL && process.env.AGENT_API_KEY,
      ),
      model: config.model || "未配置",
      cli: "OpenCode 1.2.27",
      activeRuns: runner.active.size,
      concurrency: config.concurrency,
    }),
  );
  app.get("/api/sessions", (req, res) => {
    res.json(
      store.all(`SELECT s.*, (SELECT status FROM runs WHERE session_id=s.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS status,
      (SELECT prompt FROM runs WHERE session_id=s.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS last_prompt,
      (SELECT COUNT(*) FROM runs WHERE session_id=s.id) AS run_count FROM sessions s ORDER BY s.updated_at DESC`),
    );
  });
  app.post("/api/sessions", (req, res) => {
    const title =
      String(req.body.title || "新的工作")
        .trim()
        .slice(0, 100) || "新的工作";
    const kind = ["code", "work", "general"].includes(req.body.kind)
      ? req.body.kind
      : "general";
    const id = uuid(),
      date = now();
    fs.mkdirSync(path.join(runner.workspace(id), "uploads"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(runner.workspace(id), "artifacts"), {
      recursive: true,
    });
    store.run(
      "INSERT INTO sessions(id,title,kind,created_at,updated_at) VALUES(?,?,?,?,?)",
      [id, title, kind, date, date],
    );
    res.status(201).json(session(id));
  });
  app.get("/api/sessions/:id", (req, res) => {
    const value = session(req.params.id);
    const history = readSnapshot(store, value.id, {
      full: req.query.full === "1",
      before:
        req.query.before === undefined
          ? undefined
          : pageNumber(req.query.before),
      limit: pageNumber(req.query.limit, 20, 100),
    });
    // Private CLI ids are retained on the server but not needed by the interface.
    delete value.cli_session;
    res.json({
      session: value,
      ...history,
      files: listFiles(runner.workspace(value.id)),
    });
  });
  app.patch("/api/sessions/:id", (req, res) => {
    session(req.params.id);
    const title = String(req.body.title || "")
      .trim()
      .slice(0, 100);
    if (!title) throw httpError(400, "请输入会话名称");
    store.run("UPDATE sessions SET title=?,updated_at=? WHERE id=?", [
      title,
      now(),
      req.params.id,
    ]);
    res.json({ ok: true });
  });
  app.delete("/api/sessions/:id", (req, res) => {
    const value = session(req.params.id);
    if (busy(value.id)) throw httpError(409, "请先停止正在执行的任务");
    // UUIDs originate in our database; deletion never uses a client path.
    fs.rmSync(runner.workspace(value.id), { recursive: true, force: true });
    fs.rmSync(path.join(dataDir, "cli", value.id), {
      recursive: true,
      force: true,
    });
    fs.rmSync(versions.directory(value.id), { recursive: true, force: true });
    store.run("DELETE FROM sessions WHERE id=?", [value.id]);
    for (const client of subscribers.get(value.id) || []) client.end();
    subscribers.delete(value.id);
    res.json({ ok: true });
  });
  app.post("/api/sessions/:id/runs", (req, res) => {
    const value = session(req.params.id);
    if (!config.model || !config.baseURL || !process.env.AGENT_API_KEY)
      throw httpError(
        503,
        "请在服务端 .env 中配置 API 地址、密钥和模型，然后重启。",
      );
    if (busy(value.id))
      throw httpError(409, "此会话已有任务在执行，请等待完成或停止后继续。");
    const prompt =
      typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt || prompt.length > 60000)
      throw httpError(400, "请输入 1–60000 字符的任务");
    const id = uuid(),
      date = now();
    store.transaction(() => {
      store.raw(
        "INSERT INTO runs(id,session_id,prompt,status,created_at) VALUES(?,?,?,?,?)",
        [id, value.id, prompt, "queued", date],
      );
      store.raw("UPDATE sessions SET updated_at=? WHERE id=?", [
        date,
        value.id,
      ]);
    });
    emit(value.id, id, "status", {
      status: "queued",
      message: "任务已加入队列",
    });
    res.status(202).json({ id, status: "queued" });
    setImmediate(() => runner.schedule());
  });
  app.post("/api/sessions/:id/runs/:runId/cancel", (req, res) => {
    session(req.params.id);
    const run = store.one("SELECT * FROM runs WHERE id=? AND session_id=?", [
      req.params.runId,
      req.params.id,
    ]);
    if (!run) throw httpError(404, "执行记录不存在");
    if (activeStatuses.includes(run.status)) runner.cancel(run.id);
    res.json({ ok: true });
  });
  app.get("/api/sessions/:id/events", (req, res) => {
    const value = session(req.params.id);
    let cursor = Number(req.headers["last-event-id"] || req.query.after || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    res.set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    if (!subscribers.has(value.id)) subscribers.set(value.id, new Set());
    const client = subscribeEvents(store, value.id, res, cursor, () =>
      subscribers.get(value.id)?.delete(client),
    );
    subscribers.get(value.id).add(client);
    client.pump();
  });
  app.get("/api/sessions/:id/logs", (req, res) => {
    session(req.params.id);
    res.json(readLogs(store, req.params.id, req.query));
  });
  app.get("/api/sessions/:id/logs/:eventId", (req, res) => {
    session(req.params.id);
    const event = store.one(
      "SELECT * FROM events WHERE session_id=? AND id=?",
      [req.params.id, pageNumber(req.params.eventId)],
    );
    if (!event) throw httpError(404, "日志不存在");
    if (req.query.download === "1") res.attachment(`log-${event.id}.json`);
    res.json({ ...event, data: JSON.parse(event.data) });
  });
  app.get("/api/sessions/:id/versions", (req, res) => {
    const value = session(req.params.id);
    if (!busy(value.id)) versions.capture(value.id);
    if (req.query.path === undefined)
      return res.json({
        files: store.all(
          "SELECT v.path,v.deleted,v.created_at,COUNT(h.id) AS version_count FROM file_versions v JOIN (SELECT path,MAX(id) AS last FROM file_versions WHERE session_id=? GROUP BY path) x ON x.last=v.id JOIN file_versions h ON h.session_id=v.session_id AND h.path=v.path GROUP BY v.id ORDER BY v.path",
          [value.id],
        ),
      });
    let name;
    try {
      name = versions.validate(value.id, req.query.path);
    } catch (error) {
      throw httpError(400, error.message);
    }
    const limit = pageNumber(req.query.limit, 20, 100),
      before = pageNumber(req.query.before, Number.MAX_SAFE_INTEGER);
    const rows = store.all(
      "SELECT * FROM file_versions WHERE session_id=? AND path=? AND id<? ORDER BY id DESC LIMIT ?",
      [value.id, name, before, limit + 1],
    );
    res.json({
      items: rows.slice(0, limit),
      hasMore: rows.length > limit,
      nextBefore: rows.slice(0, limit).at(-1)?.id || null,
      head:
        store.one(
          "SELECT id FROM file_versions WHERE session_id=? AND path=? ORDER BY id DESC LIMIT 1",
          [value.id, name],
        )?.id || null,
    });
  });
  app.get("/api/sessions/:id/versions/:versionId", (req, res) => {
    const value = session(req.params.id),
      version = versions.get(value.id, pageNumber(req.params.versionId));
    if (!version) throw httpError(404, "版本不存在");
    if (version.deleted) return res.json({ ...version, content: null });
    const file = versions.blob(version);
    if (req.query.download === "1")
      return res.download(file, path.basename(version.path));
    if (version.size > 1024 * 1024)
      return res.json({ ...version, binary: true });
    const bytes = fs.readFileSync(file),
      binary = bytes.subarray(0, 8192).includes(0);
    res.json({
      ...version,
      binary,
      content: binary ? null : bytes.toString("utf8"),
    });
  });
  app.post("/api/sessions/:id/versions/:versionId/restore", (req, res) => {
    const value = session(req.params.id);
    if (busy(value.id))
      throw httpError(409, "请先停止此会话的任务，再回滚成果");
    const target = versions.get(value.id, pageNumber(req.params.versionId));
    if (!target) throw httpError(404, "版本不存在");
    let head;
    try {
      head = versions.restore(value.id, target);
    } catch (error) {
      throw httpError(400, "回滚失败：" + error.message);
    }
    store.run("UPDATE sessions SET updated_at=? WHERE id=?", [now(), value.id]);
    emit(value.id, null, "files", {
      action: "restore",
      path: target.path,
      fromVersion: target.id,
      currentVersion: head.id,
    });
    res.json({ ok: true, path: target.path, version: head });
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    preservePath: false,
    limits: { fileSize: 20 * 1024 * 1024, files: 10, fields: 0 },
  });
  app.post(
    "/api/sessions/:id/files",
    (req, res, next) => {
      session(req.params.id);
      if (busy(req.params.id))
        throw httpError(409, "执行期间请勿修改材料，请停止后再上传");
      upload.array("files", 10)(req, res, next);
    },
    (req, res) => {
      const value = session(req.params.id);
      if (busy(value.id))
        throw httpError(409, "执行期间请勿修改材料，请停止后再上传");
      if (!req.files?.length) throw httpError(400, "请选择文件");
      const saved = [];
      for (const file of req.files) {
        let original = file.originalname;
        // Multipart filenames are decoded by busboy as Latin-1.
        if (/[^\x00-\x7f]/.test(original)) {
          const decoded = Buffer.from(original, "latin1").toString("utf8");
          if (!decoded.includes("\ufffd")) original = decoded;
        }
        const name = safeName(original);
        const suffix = path.extname(name),
          stem = name.slice(0, name.length - suffix.length);
        let target = path.join(runner.workspace(value.id), "uploads", name),
          index = 2;
        while (fs.existsSync(target))
          target = path.join(
            runner.workspace(value.id),
            "uploads",
            `${stem} (${index++})${suffix}`,
          );
        fs.writeFileSync(target, file.buffer, { flag: "wx", mode: 0o600 });
        saved.push("uploads/" + path.basename(target));
      }
      store.run("UPDATE sessions SET updated_at=? WHERE id=?", [
        now(),
        value.id,
      ]);
      emit(value.id, null, "files", { paths: saved });
      res.status(201).json({ files: saved });
    },
  );
  app.get("/api/sessions/:id/file", (req, res) => {
    const value = session(req.params.id);
    let absolute;
    try {
      absolute = resolveFile(runner.workspace(value.id), req.query.path);
    } catch (e) {
      throw httpError(400, e.message);
    }
    if (req.query.download === "1") return res.download(absolute);
    if (fs.statSync(absolute).size > 1024 * 1024)
      throw httpError(413, "此文件超过 1 MB，请下载后查看");
    const bytes = fs.readFileSync(absolute);
    if (bytes.subarray(0, 8192).includes(0))
      return res.json({ binary: true, path: req.query.path });
    res.json({ content: bytes.toString("utf8"), path: req.query.path });
  });
  app.get("/api/sessions/:id/archive", (req, res) => {
    const value = session(req.params.id),
      root = runner.workspace(value.id);
    res.attachment(`workspace-${value.id.slice(0, 8)}.zip`);
    const zip = new yazl.ZipFile();
    zip.on("error", () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    res.on("close", () => zip.outputStream.destroy());
    zip.outputStream.pipe(res);
    for (const file of listFiles(root)) {
      try {
        zip.addFile(resolveFile(root, file.path), file.path);
      } catch {}
    }
    zip.end();
  });
  app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));
  if (fs.existsSync(path.join(projectDir, "dist"))) {
    app.use(express.static(path.join(projectDir, "dist")));
    app.get("/{*path}", (req, res) =>
      res.sendFile(path.join(projectDir, "dist/index.html")),
    );
  }
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err instanceof multer.MulterError ? 400 : err.status || 500;
    const message =
      err instanceof multer.MulterError
        ? "上传失败：每个文件最多 20 MB，一次最多 10 个。"
        : status >= 500 && status !== 503
          ? "服务暂时无法完成操作，请稍后重试。"
          : err.message;
    res.status(status).json({ error: message });
  });
  runner.schedule();
  return {
    app,
    store,
    runner,
    versions,
    close: () => {
      runner.shutdown();
      for (const set of subscribers.values())
        for (const client of set) client.end();
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const service = await createApp();
  const host = process.env.HOST || "127.0.0.1",
    port = Number(process.env.PORT) || 3000;
  const server = service.app.listen(port, host, () =>
    console.log(`Harbor 工作台 http://${host}:${port}`),
  );
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      service.close();
      server.close();
      setTimeout(() => {
        service.store.close();
        process.exit(0);
      }, 3000).unref();
    });
}
