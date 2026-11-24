import React, { useEffect, useRef, useState } from "react";
import { mergeLogRefresh } from "./session-state.js";
import {
  Search,
  ChevronDown,
  Terminal,
  X,
  Loader2,
  Download,
} from "lucide-react";

const when = (value) => new Date(value).toLocaleString("zh-CN");
const typeNames = {
  tool: "工具调用",
  text: "助手回复",
  status: "执行状态",
  error: "错误",
  files: "文件变更",
  usage: "用量",
};
function LogResults({ sessionId, runId, api, liveCursor }) {
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  const [type, setType] = useState(runId ? "tool" : "all"),
    [page, setPage] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    request = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  async function load(
    older = false,
    expected = generation.current,
    refresh = false,
  ) {
    const version = ++request.current;
    setLoading(true);
    setError("");
    const parameters = new URLSearchParams({ q: search, type, limit: "30" });
    if (runId) parameters.set("run_id", runId);
    if (older && page?.nextBefore) parameters.set("before", page.nextBefore);
    try {
      const result = await api(`/sessions/${sessionId}/logs?${parameters}`);
      if (expected !== generation.current || version !== request.current)
        return;
      setPage((old) =>
        older
          ? {
              ...result,
              items: [
                ...old.items,
                ...result.items.filter(
                  (item) => !old.items.some((e) => e.id === item.id),
                ),
              ],
            }
          : refresh
            ? mergeLogRefresh(old, result)
            : result,
      );
    } catch (e) {
      if (expected === generation.current) setError(e.message);
    } finally {
      if (expected === generation.current && version === request.current)
        setLoading(false);
    }
  }
  useEffect(() => {
    const current = ++generation.current;
    setPage(null);
    load(false, current);
    return () => {
      generation.current++;
    };
  }, [sessionId, runId, search, type]);
  useEffect(() => {
    if (!liveCursor) return;
    const timer = setTimeout(() => load(false, generation.current, true), 300);
    return () => clearTimeout(timer);
  }, [liveCursor, search, type]);
  return (
    <div className="log-results">
      <div className="history-toolbar">
        <label className="log-search">
          <Search size={15} />
          <input
            aria-label={runId ? "搜索本轮日志" : "搜索整个会话日志"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              runId ? "搜索本轮工具内容" : "搜索整个会话的提问和执行内容"
            }
          />
        </label>
        <select
          aria-label="日志类型"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">全部日志</option>
          <option value="tool">工具调用</option>
          <option value="text">助手回复</option>
          <option value="status">状态与错误</option>
        </select>
      </div>
      {error && (
        <p className="history-error" role="alert">
          {error}
          <button onClick={() => load()}>重试</button>
        </p>
      )}
      {loading && !page && (
        <p className="history-hint">
          <Loader2 size={14} className="spin" />
          正在读取日志…
        </p>
      )}
      {page && !page.items.length && (
        <p className="history-hint">
          {search
            ? "没有匹配的日志。搜索范围包含尚未加载的历史记录。"
            : "暂无此类执行日志。"}
        </p>
      )}
      {page?.items.map((event) => (
        <details className="log-entry" key={event.id}>
          <summary>
            <span className="log-kind">
              {typeNames[event.type] || event.type}
            </span>
            <strong>
              {event.data.title ||
                event.data.message ||
                event.data.text?.slice(0, 80) ||
                event.data.action ||
                "查看详情"}
            </strong>
            <time>{when(event.created_at)}</time>
            <ChevronDown size={13} />
          </summary>
          <div className="log-detail">
            {!runId && event.prompt && (
              <p className="log-context">所属提问：{event.prompt}</p>
            )}
            <pre>
              {event.type === "tool"
                ? [event.data.input, event.data.output]
                    .filter(Boolean)
                    .join("\n\n")
                : event.data.text ||
                  event.data.message ||
                  JSON.stringify(event.data, null, 2)}
            </pre>
            {event.data.truncated && (
              <p className="history-hint">
                此处显示内容片段，下载可获取该条完整记录。
              </p>
            )}
            <a href={`/api/sessions/${sessionId}/logs/${event.id}?download=1`}>
              <Download size={13} />
              下载完整记录
            </a>
          </div>
        </details>
      ))}
      {page?.hasMore && (
        <button
          className="secondary-button load-more"
          disabled={loading}
          onClick={() => load(true)}
        >
          {loading ? "读取中…" : "加载更早日志"}
        </button>
      )}
    </div>
  );
}
export function ExecutionLog({ sessionId, run, api, liveCursor }) {
  const busy = ["queued", "running"].includes(run.status),
    [open, setOpen] = useState(busy);
  return (
    <details
      className="trace"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <Terminal size={15} />
        <span>
          {busy
            ? run.status === "queued"
              ? "等待可用执行位置"
              : "正在工作，可以切换到其他会话"
            : `执行记录 · ${run.tool_count || 0} 次工具调用`}
        </span>
        <ChevronDown size={15} />
      </summary>
      {open && (
        <LogResults
          sessionId={sessionId}
          runId={run.id}
          api={api}
          liveCursor={liveCursor}
        />
      )}
    </details>
  );
}
export function LogDialog({ sessionId, api, liveCursor, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="搜索会话日志"
        className="history-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">
          <h2>
            <Search size={20} />
            搜索会话日志
          </h2>
          <button
            className="icon-button"
            aria-label="关闭日志搜索"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p className="history-hint">
          按时间倒序显示，每页 30 条。搜索覆盖整个会话及所属任务的提问。
        </p>
        <div className="history-scroll">
          <LogResults sessionId={sessionId} api={api} liveCursor={liveCursor} />
        </div>
      </section>
    </div>
  );
}
