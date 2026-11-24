import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yazl from "yazl";
const output = path.resolve(
  process.argv[2] || "../harbor-agent-workbench-source.zip",
);
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
if (files.some((name) => name === ".env" || name.startsWith("node_modules/")))
  throw new Error("Unexpected private/runtime files in Git");
const zip = new yazl.ZipFile();
const stream = fs.createWriteStream(output);
zip.outputStream.pipe(stream);
for (const name of files)
  zip.addFile(path.resolve(name), "harbor-agent-workbench/" + name);
zip.end();
await new Promise((resolve, reject) => {
  stream.on("close", resolve);
  stream.on("error", reject);
  zip.on("error", reject);
});
console.log(`Packaged ${files.length} Git-tracked files: ${output}`);
