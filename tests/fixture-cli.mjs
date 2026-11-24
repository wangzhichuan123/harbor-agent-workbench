// Deterministic protocol fixture. No model service is called by unit tests.
import fs from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const index = process.argv.indexOf("--session");
const sessionID = index >= 0 ? process.argv[index + 1] : "ses_fixture123";
if (prompt.includes("follow-up") && index < 0) {
  console.error("Missing --session on follow-up");
  process.exit(2);
}
const emit = (type, part) =>
  console.log(JSON.stringify({ type, sessionID, part }));
if (prompt.includes("slow"))
  await new Promise((resolve) => setTimeout(resolve, 5000));
if (prompt.includes("fail")) {
  console.log(
    JSON.stringify({
      type: "error",
      error: {
        data: {
          message: "provider rejected fixture " + process.env.AGENT_API_KEY,
        },
      },
    }),
  );
  process.exit(1);
}
if (prompt.includes("partial")) {
  emit("text", { text: "partial result" });
  process.exit(0);
}
if (prompt.includes("length")) {
  emit("step_finish", { reason: "length" });
  process.exit(0);
}
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/result.md", "# Completed\n" + prompt);
emit("tool_use", {
  tool: "write",
  callID: "tool1",
  state: {
    status: "completed",
    title: "write report",
    input: { filePath: "artifacts/result.md" },
    output: "saved",
    sessionID,
  },
});
emit("text", { text: "已保存 artifacts/result.md。" });
emit("step_finish", { reason: "stop", tokens: { input: 20, output: 10 } });
