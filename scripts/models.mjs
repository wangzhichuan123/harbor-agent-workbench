const base = process.env.AGENT_API_BASE_URL?.replace(/\/$/, "");
if (!base || !process.env.AGENT_API_KEY) {
  console.error("请先在 .env 中设置 AGENT_API_BASE_URL 和 AGENT_API_KEY。");
  process.exit(1);
}
try {
  const response = await fetch(base + "/models", {
    headers: { Authorization: `Bearer ${process.env.AGENT_API_KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`模型目录返回 HTTP ${response.status}`);
  const body = await response.json();
  const models = body.data || body.models || [];
  for (const model of models)
    console.log(typeof model === "string" ? model : model.id || model.name);
  if (!models.length)
    console.log("服务未返回模型目录，请从提供方获取支持工具调用的模型名称。");
} catch (e) {
  console.error("无法读取模型目录：" + e.message);
  process.exit(1);
}
