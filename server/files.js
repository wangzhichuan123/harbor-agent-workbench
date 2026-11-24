import fs from "node:fs";
import path from "node:path";

export function safeName(name) {
  const clean = path
    .basename(name.replaceAll("\\", "/"))
    .normalize("NFC")
    .replace(/[\x00-\x1f<>:"|?*]/g, "_");
  if (!clean || clean === "." || clean === ".." || clean.startsWith("."))
    throw new Error("文件名无效");
  return clean.slice(0, 180);
}
export function resolveFile(root, relative) {
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
    if (fs.lstatSync(cursor).isSymbolicLink())
      throw new Error("不允许访问符号链接");
  }
  if (!fs.statSync(absolute).isFile()) throw new Error("文件不存在");
  return absolute;
}
const skipped = new Set(["node_modules", "__pycache__", "venv"]);
export function listFiles(root) {
  const files = [];
  function walk(dir, prefix = "", depth = 0) {
    if (depth > 12 || files.length >= 1500) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
        const stat = fs.statSync(path.join(dir, entry.name));
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
