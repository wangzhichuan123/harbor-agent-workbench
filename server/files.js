import fs from "node:fs";
import path from "node:path";

function truncateUtf8(value, limit) {
  let result = "",
    length = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (length + size > limit) break;
    result += character;
    length += size;
  }
  return result;
}
export function safeName(name) {
  const clean = path
    .basename(name.replaceAll("\\", "/"))
    .normalize("NFC")
    .replace(/[\x00-\x1f<>:"|?*]/g, "_");
  if (!clean || clean === "." || clean === ".." || clean.startsWith("."))
    throw new Error("文件名无效");
  const extension = truncateUtf8(path.extname(clean), 32);
  const stem = clean.slice(0, clean.length - path.extname(clean).length);
  return truncateUtf8(stem, 180 - Buffer.byteLength(extension)) + extension;
}
export function workspacePath(root, relative, allowMissing = false) {
  if (typeof relative !== "string" || !relative || relative.includes("\0"))
    throw new Error("文件路径无效");
  const parts = relative.replaceAll("\\", "/").split("/");
  if (
    parts.some((p) => !p || p === "." || p === ".." || p.startsWith(".")) ||
    path.isAbsolute(relative)
  )
    throw new Error("禁止访问此路径");
  const absolute = path.resolve(root, ...parts);
  if (!absolute.startsWith(path.resolve(root) + path.sep))
    throw new Error("禁止访问此路径");
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("不允许访问符号链接");
  }
  return absolute;
}
export function resolveFile(root, relative) {
  const absolute = workspacePath(root, relative);
  if (!fs.statSync(absolute).isFile()) throw new Error("文件不存在");
  return absolute;
}
const skipped = new Set(["node_modules", "__pycache__", "venv"]);
export function listFiles(root) {
  const files = [];
  function walk(dir, prefix = "", depth = 0) {
    if (depth > 12 || files.length >= 1500) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return;
      throw error;
    }
    for (const entry of entries) {
      if (files.length >= 1500) break;
      if (
        entry.name.startsWith(".") ||
        skipped.has(entry.name) ||
        entry.isSymbolicLink()
      )
        continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        walk(path.join(dir, entry.name), relative + "/", depth + 1);
      else if (entry.isFile()) {
        let stat;
        try {
          stat = fs.statSync(path.join(dir, entry.name));
        } catch (error) {
          if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code))
            continue;
          throw error;
        }
        files.push({
          path: relative,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          source: relative.startsWith("uploads/") ? "upload" : "artifact",
        });
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
