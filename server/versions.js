import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { listFiles, resolveFile, workspacePath } from "./files.js";

export class FileVersions {
  constructor(store, dataDir) {
    this.store = store;
    this.dataDir = dataDir;
  }
  workspace(id) {
    return path.join(this.dataDir, "workspaces", id);
  }
  directory(id) {
    return path.join(this.dataDir, "versions", id);
  }
  validate(id, name) {
    workspacePath(this.workspace(id), name, true);
    if (name.replaceAll("\\", "/").split("/")[0] === "uploads")
      throw new Error("上传材料不在成果版本范围内");
    return name.replaceAll("\\", "/");
  }
  // Stream into an immutable, content-addressed blob with bounded memory.
  saveBlob(id, name) {
    const source = resolveFile(this.workspace(id), name),
      directory = this.directory(id);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, "." + crypto.randomUUID());
    let input, output;
    const hash = crypto.createHash("sha256"),
      buffer = Buffer.allocUnsafe(128 * 1024);
    let size = 0,
      complete = false;
    try {
      input = fs.openSync(source, "r");
      output = fs.openSync(temporary, "wx", 0o600);
      const before = fs.fstatSync(input);
      for (;;) {
        const count = fs.readSync(input, buffer, 0, buffer.length, null);
        if (!count) break;
        hash.update(buffer.subarray(0, count));
        fs.writeFileSync(output, buffer.subarray(0, count));
        size += count;
      }
      const after = fs.fstatSync(input);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        size !== after.size
      )
        throw new Error("文件在备份期间发生变化，请稍后重试");
      fs.fsyncSync(output);
      complete = true;
    } finally {
      if (input !== undefined) fs.closeSync(input);
      if (output !== undefined) fs.closeSync(output);
      if (!complete && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    const digest = hash.digest("hex"),
      destination = path.join(directory, digest);
    if (fs.existsSync(destination)) fs.unlinkSync(temporary);
    else fs.renameSync(temporary, destination);
    return { hash: digest, size, deleted: 0 };
  }
  capture(id, runId = null, reason = "baseline") {
    const latest = this.store.all(
      "SELECT v.* FROM file_versions v JOIN (SELECT path,MAX(id) AS last FROM file_versions WHERE session_id=? GROUP BY path) x ON x.last=v.id",
      [id],
    );
    const previous = new Map(latest.map((v) => [v.path, v]));
    const current = listFiles(this.workspace(id)).filter(
      (f) => f.source === "artifact",
    );
    const present = new Set(current.map((f) => f.path)),
      changes = [];
    for (const file of current) {
      const blob = this.saveBlob(id, file.path),
        old = previous.get(file.path);
      if (!old || old.deleted || old.hash !== blob.hash)
        changes.push({ path: file.path, ...blob });
    }
    // Check each previously versioned path directly: the UI listing has a cap.
    for (const old of latest) {
      if (old.deleted || present.has(old.path)) continue;
      try {
        const blob = this.saveBlob(id, old.path);
        if (blob.hash !== old.hash) changes.push({ path: old.path, ...blob });
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        changes.push({ path: old.path, hash: null, size: 0, deleted: 1 });
      }
    }
    if (changes.length)
      this.store.transaction(() => {
        for (const item of changes)
          this.store.raw(
            "INSERT INTO file_versions(session_id,path,hash,size,deleted,run_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
            [
              id,
              item.path,
              item.hash,
              item.size,
              item.deleted,
              runId,
              reason,
              new Date().toISOString(),
            ],
          );
      });
    return changes.length;
  }
  get(id, versionId) {
    return this.store.one(
      "SELECT * FROM file_versions WHERE session_id=? AND id=?",
      [id, versionId],
    );
  }
  blob(version) {
    if (version.deleted || !/^[a-f0-9]{64}$/.test(version.hash || ""))
      throw new Error("该版本没有文件内容");
    const name = path.join(this.directory(version.session_id), version.hash);
    if (fs.lstatSync(name).isSymbolicLink()) throw new Error("版本文件无效");
    return name;
  }
  restore(id, version) {
    this.validate(id, version.path);
    this.capture(id, null, "before_restore");
    const target = workspacePath(this.workspace(id), version.path, true);
    if (version.deleted) {
      if (fs.existsSync(target)) {
        resolveFile(this.workspace(id), version.path);
        fs.unlinkSync(target);
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      workspacePath(this.workspace(id), version.path, true);
      const temporary = path.join(
        path.dirname(target),
        ".restore-" + crypto.randomUUID(),
      );
      try {
        fs.copyFileSync(
          this.blob(version),
          temporary,
          fs.constants.COPYFILE_EXCL,
        );
        const fd = fs.openSync(temporary, "r"),
          buffer = Buffer.allocUnsafe(128 * 1024),
          hash = crypto.createHash("sha256");
        try {
          for (;;) {
            const count = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!count) break;
            hash.update(buffer.subarray(0, count));
          }
        } finally {
          fs.closeSync(fd);
        }
        if (hash.digest("hex") !== version.hash)
          throw new Error("历史文件校验失败，当前文件未被覆盖");
        fs.renameSync(temporary, target);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    this.capture(id, null, "restore");
    return this.store.one(
      "SELECT * FROM file_versions WHERE session_id=? AND path=? ORDER BY id DESC LIMIT 1",
      [id, version.path],
    );
  }
}
