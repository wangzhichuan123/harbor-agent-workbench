import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  Anchor,
  Plus,
  Search,
  Code2,
  FileText,
  Layers3,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Send,
  Square,
  Download,
  FolderOpen,
  File,
  X,
  ChevronDown,
  Check,
  Loader2,
  CircleAlert,
  MoreHorizontal,
  Pencil,
  Trash2,
  Terminal,
  ArrowUpRight,
  WifiOff,
  ExternalLink,
  Sparkles,
  RefreshCw,
  Play,
  Copy,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  mergeSnapshots,
  clearSubmittedDraft,
  draftKey,
  createRequestTracker,
} from "./session-state.js";
import "./styles.css";

function readDraft(id) {
  try {
    return localStorage.getItem("harbor-draft-" + draftKey(id)) || "";
  } catch {
    return "";
  }
}
function saveDraft(id, value) {
  try {
    localStorage.setItem("harbor-draft-" + draftKey(id), value);
  } catch {}
}

const labels = {
  queued: "排队中",
  running: "正在执行",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  timed_out: "已超时",
  interrupted: "执行中断",
};
const isBusy = (status) => ["queued", "running"].includes(status);
const kindIcon = { code: Code2, work: FileText, general: Layers3 };
const kinds = { code: "代码开发", work: "日常工作", general: "自由任务" };
const presets = [
  {
    kind: "code",
    icon: Code2,
    title: "把想法变成小工具",
    desc: "开发、测试，并交付可以运行的代码。",
    prompt:
      "帮我开发一个无需安装、可离线使用的番茄钟网页，支持开始、暂停和重置，界面简洁。将成果保存为 artifacts/pomodoro.html，并验证基本交互。",
  },
  {
    kind: "work",
    icon: FileText,
    title: "让材料成为洞察",
    desc: "阅读文件、分析数据，整理成清晰的报告。",
    prompt:
      "请分析我上传的材料，提取关键发现、风险和行动建议，注明数据依据。将报告保存为 artifacts/report.md。",
  },
  {
    kind: "general",
    icon: Terminal,
    title: "交给助手一件工作",
    desc: "批量整理文件，或完成一个重复流程。",
    prompt: "请先检查当前工作区的文件，概述内容，并提出可执行的整理方案。",
  },
];
async function api(url, options) {
  const response = await fetch("/api" + url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `请求失败 (${response.status})`);
  }
  return response.json();
}
const json = (method, data) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
const date = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const bytes = (n) =>
  n < 1024
    ? n + " B"
    : n < 1024 * 1024
      ? (n / 1024).toFixed(1) + " KB"
      : (n / 1024 / 1024).toFixed(1) + " MB";
function Status({ status }) {
  return (
    <span className={"status " + (status || "")}>
      {isBusy(status) ? (
        <Loader2 size={13} className="spin" />
      ) : status === "completed" ? (
        <Check size={13} />
      ) : status ? (
        <CircleAlert size={13} />
      ) : null}
      {labels[status] || "准备就绪"}
    </span>
  );
}
function Md({ children }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children || ""}
      </Markdown>
    </div>
  );
}
function IconButton({ title, children, ...props }) {
  return (
    <button className="icon-button" title={title} aria-label={title} {...props}>
      {children}
    </button>
  );
}

function App() {
  const [sessions, setSessions] = useState([]),
    [selected, setSelected] = useState(() =>
      new URLSearchParams(location.search).get("session"),
    );
  const [snapshot, setSnapshot] = useState(null),
    [health, setHealth] = useState(null),
    [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState({}),
    [sending, setSending] = useState(false),
    [uploading, setUploading] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [connected, setConnected] = useState(true);
  const [filesOpen, setFilesOpen] = useState(() => window.innerWidth > 760),
    [fileTab, setFileTab] = useState("artifact"),
    [modal, setModal] = useState(null),
    [preview, setPreview] = useState(null);
  const [formTitle, setFormTitle] = useState(""),
    [formKind, setFormKind] = useState("general"),
    [menu, setMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const uploadRef = useRef(),
    textareaRef = useRef(),
    feedRef = useRef();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const requests = useRef();
  if (!requests.current) requests.current = createRequestTracker();
  const draft = drafts[draftKey(selected)] ?? readDraft(selected);
  function setDraft(value, id = selected) {
    setDrafts((old) => ({ ...old, [draftKey(id)]: value }));
  }
  function closePreview() {
    requests.current.invalidate("preview");
    setPreview(null);
  }
  const loadSessions = useCallback(async () => {
    const isCurrent = requests.current.start("session-list");
    const rows = await api("/sessions");
    if (isCurrent()) setSessions(rows);
  }, []);
  const refresh = useCallback(async (id) => {
    const isCurrent = requests.current.start(`session:${id}`);
    const data = await api(`/sessions/${id}`);
    if (selectedRef.current === id && isCurrent())
      setSnapshot((old) => mergeSnapshots(old, data));
    return data;
  }, []);
  useEffect(() => {
    loadSessions().catch((e) => setError(e.message));
    api("/health")
      .then(setHealth)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const onPop = () =>
      setSelected(new URLSearchParams(location.search).get("session"));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    setSnapshot(null);
    setError("");
    closePreview();
    setMenu(false);
    if (!selected) return;
    let stream,
      gone = false;
    setLoading(true);
    refresh(selected)
      .then((data) => {
        if (gone) return;
        const after = data.events.at(-1)?.id || 0;
        stream = new EventSource(
          `/api/sessions/${selected}/events?after=${after}`,
        );
        stream.onopen = () => {
          if (!gone) setConnected(true);
        };
        stream.onerror = () => {
          if (!gone) setConnected(false);
        };
        stream.onmessage = (e) => {
          if (gone) return;
          const event = JSON.parse(e.data);
          setSnapshot((old) => {
            if (
              !old ||
              old.session.id !== selected ||
              old.events.some((v) => v.id === event.id)
            )
              return old;
            return {
              ...old,
              events: [...old.events, event],
              runs: old.runs.map((r) =>
                r.id === event.run_id && event.type === "status"
                  ? { ...r, status: event.data.status }
                  : r,
              ),
            };
          });
          if (event.type === "status" || event.type === "files") {
            refresh(selected).catch((e) => {
              if (!gone) setError(e.message);
            });
            loadSessions().catch(() => {});
          }
        };
      })
      .catch((e) => {
        if (!gone) setError(e.message);
      })
      .finally(() => {
        if (!gone) setLoading(false);
      });
    return () => {
      gone = true;
      stream?.close();
    };
  }, [selected]);
  useEffect(() => {
    for (const [id, value] of Object.entries(drafts)) saveDraft(id, value);
  }, [drafts]);
  const hasBackgroundWork = sessions.some((s) => isBusy(s.status));
  useEffect(() => {
    const sync = () => loadSessions().catch(() => {});
    window.addEventListener("focus", sync);
    const timer = hasBackgroundWork ? setInterval(sync, 5000) : null;
    return () => {
      window.removeEventListener("focus", sync);
      clearInterval(timer);
    };
  }, [hasBackgroundWork, loadSessions]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 4000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const current = snapshot?.session.id === selected ? snapshot.session : null;
  const activeRun = current && snapshot.runs.find((r) => isBusy(r.status));
  const files = current ? snapshot.files : [];
  function select(id) {
    setSelected(id);
    if (window.innerWidth <= 760) setFilesOpen(false);
    const url = id ? `/?session=${id}` : "/";
    history.pushState({}, "", url);
  }
  async function create(kind = formKind, title = formTitle, prompt = "") {
    try {
      const value = await api(
        "/sessions",
        json("POST", { title: title || "新的工作", kind }),
      );
      if (prompt) saveDraft(value.id, prompt);
      await loadSessions();
      select(value.id);
      setModal(null);
    } catch (e) {
      setError(e.message);
    }
  }
  async function send() {
    if (
      !draft.trim() ||
      sending ||
      uploading ||
      activeRun ||
      (selected && !current)
    )
      return;
    setSending(true);
    setError("");
    const text = draft;
    const draftSession = selected;
    try {
      let id = selected;
      if (!id) {
        const value = await api(
          "/sessions",
          json("POST", { title: text.slice(0, 24), kind: "general" }),
        );
        id = value.id;
        select(id);
      }
      await api(`/sessions/${id}/runs`, json("POST", { prompt: text }));
      setDrafts((old) =>
        clearSubmittedDraft(old, draftSession, text, readDraft(draftSession)),
      );
      await Promise.all([refresh(id), loadSessions()]);
      setTimeout(
        () =>
          selectedRef.current === id &&
          feedRef.current?.scrollTo({
            top: feedRef.current.scrollHeight,
            behavior: "smooth",
          }),
        100,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }
  async function uploadFiles(list) {
    if (!list?.length || uploading) return;
    if (list.length > 10 || [...list].some((f) => f.size > 20 * 1024 * 1024))
      return setError("一次最多上传 10 个文件，每个文件不超过 20 MB。");
    setUploading(true);
    setError("");
    try {
      let id = selected;
      if (!id) {
        const value = await api(
          "/sessions",
          json("POST", { title: "材料分析", kind: "work" }),
        );
        id = value.id;
        select(id);
      }
      const form = new FormData();
      for (const file of list) form.append("files", file);
      await api(`/sessions/${id}/files`, { method: "POST", body: form });
      await Promise.all([refresh(id), loadSessions()]);
      if (selectedRef.current === id) {
        setFileTab("upload");
        setFilesOpen(true);
        setNotice("材料已上传，可以告诉助手你的需求。");
      } else setNotice("材料已上传到原会话，可切换回去查看。");
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }
  async function viewFile(file) {
    const id = selected;
    const isCurrent = requests.current.start("preview");
    try {
      const value = await api(
        `/sessions/${id}/file?path=${encodeURIComponent(file.path)}`,
      );
      if (selectedRef.current === id && isCurrent())
        setPreview({ ...value, sessionId: id, mode: "source" });
    } catch (e) {
      if (selectedRef.current === id && isCurrent()) setError(e.message);
    }
  }
  async function rename(e) {
    e.preventDefault();
    try {
      await api(`/sessions/${selected}`, json("PATCH", { title: formTitle }));
      await Promise.all([refresh(selected), loadSessions()]);
      setModal(null);
    } catch (e) {
      setError(e.message);
    }
  }
  async function remove() {
    setMenu(false);
    if (!confirm("删除此会话及全部文件？此操作无法恢复。")) return;
    try {
      await api(`/sessions/${selected}`, { method: "DELETE" });
      if (selectedRef.current === selected) select(null);
      await loadSessions();
    } catch (e) {
      setError(e.message);
    }
  }
  function newModal() {
    setFormTitle("");
    setFormKind("general");
    setModal("new");
  }
  const counts = {
    artifact: files.filter((f) => f.source === "artifact").length,
    upload: files.filter((f) => f.source === "upload").length,
  };
  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!activeRun) uploadFiles(e.dataTransfer.files);
      }}
    >
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => select(null)}
          aria-label="Harbor 首页"
        >
          <span className="brand-icon">
            <Anchor size={23} />
          </span>
          <span>
            Harbor<span className="brand-caption">AGENT WORKSPACE</span>
          </span>
        </button>
        <button className="new-button" onClick={newModal}>
          <Plus size={18} />
          新建会话<span>＋</span>
        </button>
        <label className="search">
          <Search size={16} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
        </label>
        <div className="side-label">
          我的工作<span>{sessions.length}</span>
        </div>
        <nav className="session-list" aria-label="会话列表">
          {sessions
            .filter((s) => s.title.toLowerCase().includes(search.toLowerCase()))
            .map((s) => {
              const Icon = kindIcon[s.kind] || Layers3;
              return (
                <button
                  key={s.id}
                  aria-label={s.title}
                  title={s.title}
                  className={
                    "session-item " + (s.id === selected ? "selected" : "")
                  }
                  onClick={() => select(s.id)}
                >
                  <span className={"session-symbol " + s.kind}>
                    <Icon size={17} />
                  </span>
                  <span className="session-meta">
                    <strong>{s.title}</strong>
                    <small>
                      {isBusy(s.status) ? (
                        <span className="working">
                          <Loader2 size={11} className="spin" />
                          {labels[s.status]}
                        </span>
                      ) : (
                        date(s.updated_at)
                      )}
                    </small>
                  </span>
                  {s.status === "completed" && (
                    <span className="done-dot" title="已完成" />
                  )}
                </button>
              );
            })}
          {!sessions.length && (
            <p className="empty-sidebar">
              工作从一次对话开始。
              <br />
              新建会话，把任务交给助手。
            </p>
          )}
          {search &&
            !sessions.some((s) =>
              s.title.toLowerCase().includes(search.toLowerCase()),
            ) && <p className="empty-sidebar">没有匹配的会话</p>}
        </nav>
        <div className="sidebar-bottom">
          <div className="runtime">
            <span
              className={health?.configured ? "online-dot" : "offline-dot"}
            />
            <strong>OpenCode CLI</strong>
            <span>{health?.configured ? "已连接" : "待配置"}</span>
          </div>
          <div className="profile">
            <span className="avatar-user">W</span>
            <div>
              <strong>个人工作台</strong>
              <small>本地运行 · 单用户</small>
            </div>
            <span className="local-badge">LOCAL</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作台</span>
            <span className="slash">/</span>
            <strong>{current?.title || "开始新的工作"}</strong>
          </div>
          <div className="top-actions">
            <span className="model-tag">
              <Sparkles size={14} />
              {health?.model || "连接中"}
            </span>
            {selected && (
              <IconButton
                title={filesOpen ? "收起文件面板" : "展开文件面板"}
                onClick={() => setFilesOpen(!filesOpen)}
              >
                {filesOpen ? (
                  <PanelRightClose size={19} />
                ) : (
                  <PanelRightOpen size={19} />
                )}
              </IconButton>
            )}
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="关闭错误提示">
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <Check size={16} />
            {notice}
          </div>
        )}
        <div className="workspace">
          <section className="conversation">
            {selected && (
              <div className="session-heading">
                <div>
                  <span className="eyebrow">
                    {kinds[current?.kind] || "工作会话"}
                  </span>
                  <h1>{current?.title || "加载会话"}</h1>
                  <p>对话、执行过程与成果，持续保存在这里。</p>
                </div>
                <div className="heading-actions">
                  <Status status={current && snapshot.runs.at(-1)?.status} />
                  <div className="menu-wrap">
                    <IconButton title="会话操作" onClick={() => setMenu(!menu)}>
                      <MoreHorizontal size={20} />
                    </IconButton>
                    {menu && (
                      <div className="dropdown">
                        <button
                          onClick={() => {
                            setFormTitle(current.title);
                            setModal("rename");
                            setMenu(false);
                          }}
                        >
                          <Pencil size={15} />
                          重命名
                        </button>
                        <button className="danger" onClick={remove}>
                          <Trash2 size={15} />
                          删除会话
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            {!connected && selected && (
              <div className="connection-banner">
                <WifiOff size={15} />
                实时连接已断开，正在自动重连。任务继续在后台执行。
              </div>
            )}
            <div className="feed" ref={feedRef}>
              {loading && !current ? (
                <div className="loading">
                  <Loader2 className="spin" />
                  正在载入已保存的工作…
                </div>
              ) : !current || !snapshot.runs.length ? (
                <div
                  className={"welcome " + (selected ? "session-welcome" : "")}
                >
                  <div className="welcome-kicker">
                    <span />
                    让工作，有一个停靠的地方
                  </div>
                  <h2>
                    {selected ? (
                      "准备好了，开始吧。"
                    ) : (
                      <>
                        想法在这里启航，
                        <br />
                        <span>工作持续向前。</span>
                      </>
                    )}
                  </h2>
                  <p>
                    {selected
                      ? "描述你的目标，或先上传材料。助手会在这个独立的工作区中完成任务。"
                      : "开发一个工具，读懂一份材料，完成一项工作。\n把任务交给助手，随时回来继续。"}
                  </p>
                  <div className="starter-grid">
                    {presets.map((p) => (
                      <button
                        className={"starter " + p.kind}
                        key={p.kind}
                        onClick={() =>
                          selected
                            ? (setDraft(p.prompt), textareaRef.current?.focus())
                            : create(p.kind, p.title, p.prompt)
                        }
                      >
                        <span className="starter-icon">
                          <p.icon size={21} />
                        </span>
                        <strong>{p.title}</strong>
                        <span>{p.desc}</span>
                        <span className="starter-action">
                          {p.kind === "code"
                            ? "开始开发"
                            : p.kind === "work"
                              ? "分析材料"
                              : "开始工作"}
                          <Plus size={15} />
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="welcome-note">
                    <Layers3 size={15} />
                    每个会话都有独立文件空间，关闭页面也不会中断工作。
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {snapshot.runs.map((run, index) => {
                    const events = snapshot.events.filter(
                      (e) => e.run_id === run.id,
                    );
                    const tools = events.filter((e) => e.type === "tool");
                    const answer =
                      run.answer ||
                      events
                        .filter((e) => e.type === "text")
                        .map((e) => e.data.text)
                        .join("\n\n");
                    const failure =
                      run.error ||
                      events.filter((e) => e.type === "error").at(-1)?.data
                        .message;
                    return (
                      <article className="turn" key={run.id}>
                        <div className="message user-message">
                          <div className="message-avatar">W</div>
                          <div className="message-body">
                            <div className="message-byline">
                              <strong>你</strong>
                              <time>{date(run.created_at)}</time>
                            </div>
                            <div className="user-text">{run.prompt}</div>
                          </div>
                        </div>
                        <div className="message assistant-message">
                          <div className="message-avatar assistant-avatar">
                            <Anchor size={17} />
                          </div>
                          <div className="message-body">
                            <div className="message-byline">
                              <strong>Harbor</strong>
                              <span>助手</span>
                              <Status status={run.status} />
                            </div>
                            <details
                              className="trace"
                              open={isBusy(run.status) || undefined}
                            >
                              <summary>
                                <Terminal size={15} />
                                <span>
                                  {isBusy(run.status)
                                    ? run.status === "queued"
                                      ? "等待可用执行位置"
                                      : "正在工作，可以切换到其他会话"
                                    : `执行记录 · ${tools.length} 次工具调用`}
                                </span>
                                <ChevronDown size={15} />
                              </summary>
                              <div className="trace-content">
                                {!tools.length && (
                                  <p>
                                    {run.status === "queued"
                                      ? "任务已保存，将在有空闲位置时开始。"
                                      : isBusy(run.status)
                                        ? "正在启动 CLI 并连接模型…"
                                        : "本次执行没有工具调用。"}
                                  </p>
                                )}
                                {tools.map((event, i) => (
                                  <details className="tool-item" key={event.id}>
                                    <summary>
                                      <Check size={13} />
                                      <code>{event.data.tool}</code>
                                      <span>{event.data.title}</span>
                                      <ChevronDown size={13} />
                                    </summary>
                                    <pre>
                                      {event.data.input}
                                      {event.data.output &&
                                        "\n\n" + event.data.output}
                                    </pre>
                                  </details>
                                ))}
                              </div>
                            </details>
                            {answer && <Md>{answer}</Md>}
                            {isBusy(run.status) && !answer && (
                              <div className="thinking">
                                <span />
                                <span />
                                <span />
                              </div>
                            )}
                            {failure && (
                              <div className="run-error">
                                <CircleAlert size={17} />
                                <div>
                                  <strong>
                                    {labels[run.status] || "遇到问题"}
                                  </strong>
                                  <p>{failure}</p>
                                  <button
                                    onClick={() => {
                                      setDraft(
                                        "请检查当前已有文件，并继续完成上次未完成的任务：\n" +
                                          run.prompt,
                                      );
                                      textareaRef.current?.focus();
                                    }}
                                  >
                                    准备继续任务
                                    <RefreshCw size={13} />
                                  </button>
                                </div>
                              </div>
                            )}
                            {run.status === "completed" && (
                              <div className="run-footer">
                                <Check size={13} />
                                本轮成果已保存
                                <span>
                                  {run.finished_at ? date(run.finished_at) : ""}
                                </span>
                                <IconButton
                                  title="复制回复"
                                  onClick={() =>
                                    navigator.clipboard
                                      .writeText(answer)
                                      .then(() => setNotice("回复已复制"))
                                      .catch(() =>
                                        setError("无法复制，请手动选择文本。"),
                                      )
                                  }
                                >
                                  <Copy size={13} />
                                </IconButton>
                              </div>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                  <div className="conversation-divider">
                    <span>继续对话，推进这项工作</span>
                  </div>
                </div>
              )}
            </div>
            <div className="composer-area">
              <div className={"composer " + (activeRun ? "busy" : "")}>
                <textarea
                  ref={textareaRef}
                  aria-label="任务描述"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={
                    activeRun
                      ? "任务正在后台执行。你可以先写下后续想法…"
                      : "描述一项工作，或接着上次的想法继续…"
                  }
                  rows={3}
                />
                <div className="composer-tools">
                  <button
                    className="attach-button"
                    onClick={() => uploadRef.current?.click()}
                    disabled={!!activeRun || uploading}
                  >
                    <Paperclip size={17} />
                    {uploading ? "上传中…" : "添加材料"}
                  </button>
                  <span className="composer-hint">
                    Enter 发送 · Shift + Enter 换行
                  </span>
                  {activeRun ? (
                    <button
                      className="stop-button"
                      onClick={() =>
                        api(
                          `/sessions/${selected}/runs/${activeRun.id}/cancel`,
                          json("POST", {}),
                        ).catch((e) => setError(e.message))
                      }
                    >
                      <Square size={13} />
                      停止
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      onClick={send}
                      disabled={
                        !draft.trim() ||
                        sending ||
                        uploading ||
                        !!(selected && !current)
                      }
                      aria-label="发送任务"
                    >
                      {sending ? (
                        <Loader2 size={17} className="spin" />
                      ) : (
                        <Send size={17} />
                      )}
                      <span>发送</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-footnote">
                <span className="tiny-dot" />
                工作自动保存 · 成果可随时下载
                <span>由 OpenCode 提供执行能力</span>
              </div>
            </div>
          </section>
          {selected && filesOpen && (
            <aside className="files-panel">
              <div className="files-heading">
                <h2>
                  <FolderOpen size={17} />
                  工作文件
                </h2>
                <IconButton
                  title="刷新文件"
                  onClick={() =>
                    refresh(selected).catch((e) => setError(e.message))
                  }
                >
                  <RefreshCw size={15} />
                </IconButton>
              </div>
              <div className="file-tabs">
                <button
                  className={fileTab === "artifact" ? "active" : ""}
                  onClick={() => setFileTab("artifact")}
                >
                  工作成果<span>{counts.artifact}</span>
                </button>
                <button
                  className={fileTab === "upload" ? "active" : ""}
                  onClick={() => setFileTab("upload")}
                >
                  上传材料<span>{counts.upload}</span>
                </button>
              </div>
              <div className="file-list">
                {files
                  .filter((f) => f.source === fileTab)
                  .map((file) => (
                    <button
                      className="file-row"
                      key={file.path}
                      onClick={() => viewFile(file)}
                    >
                      <span
                        className={
                          "file-icon " +
                          (file.path.endsWith(".html") ? "html" : "")
                        }
                      >
                        {/\.(js|py|html|css|json)$/.test(file.path) ? (
                          <Code2 size={18} />
                        ) : (
                          <FileText size={18} />
                        )}
                      </span>
                      <span>
                        <strong>{file.path.split("/").at(-1)}</strong>
                        <small>
                          {bytes(file.size)} ·{" "}
                          {file.path.split("/").slice(0, -1).join("/") || "/"}
                        </small>
                      </span>
                      <ExternalLink size={13} />
                    </button>
                  ))}
                {!files.some((f) => f.source === fileTab) && (
                  <div className="empty-files">
                    <div>
                      <File size={27} />
                    </div>
                    <strong>
                      {fileTab === "artifact"
                        ? "成果将出现在这里"
                        : "给助手一些背景材料"}
                    </strong>
                    <p>
                      {fileTab === "artifact"
                        ? "代码、报告和整理好的文件，\n都可以预览或下载。"
                        : "拖拽文件到工作台，\n或点击下方按钮上传。"}
                    </p>
                    {fileTab === "upload" && (
                      <button
                        className="secondary-button"
                        disabled={!!activeRun || uploading}
                        onClick={() => uploadRef.current?.click()}
                      >
                        <Plus size={14} />
                        上传材料
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="files-bottom">
                <div className="storage-note">
                  <span className="storage-icon">
                    <Layers3 size={18} />
                  </span>
                  <div>
                    <strong>独立的会话工作区</strong>
                    <p>文件与对话一起保存，随时继续。</p>
                  </div>
                </div>
                <a
                  className="download-all"
                  href={`/api/sessions/${selected}/archive`}
                >
                  <Download size={16} />
                  下载完整工作区<span>ZIP</span>
                </a>
              </div>
            </aside>
          )}
        </div>
      </main>
      <input
        ref={uploadRef}
        type="file"
        multiple
        hidden
        onChange={(e) => uploadFiles(e.target.files)}
      />
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={
              modal === "rename"
                ? rename
                : (e) => {
                    e.preventDefault();
                    create();
                  }
            }
          >
            <div className="modal-title">
              <h2>{modal === "rename" ? "重命名会话" : "开启一项新工作"}</h2>
              <IconButton
                title="关闭"
                type="button"
                onClick={() => setModal(null)}
              >
                <X size={19} />
              </IconButton>
            </div>
            <p>每项工作，都有自己的对话和文件空间。</p>
            <label className="field-label">
              会话名称
              <input
                autoFocus
                required
                maxLength={100}
                placeholder="例如：开发番茄钟 / 整理月度报告"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
              />
            </label>
            {modal === "new" && (
              <div className="kind-options">
                {Object.entries(kinds).map(([key, label]) => {
                  const Icon = kindIcon[key];
                  return (
                    <button
                      className={formKind === key ? "active" : ""}
                      key={key}
                      type="button"
                      onClick={() => setFormKind(key)}
                    >
                      <Icon size={18} />
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
            <button className="primary-button" type="submit">
              {modal === "rename" ? "保存名称" : "创建会话"}
            </button>
          </form>
        </div>
      )}
      {preview && preview.sessionId === selected && (
        <div className="modal-backdrop" onClick={closePreview}>
          <section
            className="preview-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="preview-header">
              <div>
                <FileText size={18} />
                <strong>{preview.path}</strong>
              </div>
              <div>
                {preview.path.endsWith(".html") && !preview.binary && (
                  <button
                    className="secondary-button"
                    onClick={() =>
                      setPreview({
                        ...preview,
                        mode: preview.mode === "source" ? "preview" : "source",
                      })
                    }
                  >
                    {preview.mode === "source" ? (
                      <>
                        <Play size={14} />
                        运行预览
                      </>
                    ) : (
                      <>
                        <Code2 size={14} />
                        查看源码
                      </>
                    )}
                  </button>
                )}
                <a
                  className="secondary-button"
                  href={`/api/sessions/${preview.sessionId}/file?path=${encodeURIComponent(preview.path)}&download=1`}
                >
                  <Download size={14} />
                  下载
                </a>
                <IconButton title="关闭预览" onClick={closePreview}>
                  <X size={20} />
                </IconButton>
              </div>
            </div>
            <div className="preview-content">
              {preview.binary ? (
                <div className="empty-files">
                  <File size={40} />
                  <p>此格式请下载后打开。</p>
                </div>
              ) : preview.mode === "preview" ? (
                <iframe
                  title="成果隔离预览"
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  srcDoc={
                    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'\">" +
                    preview.content
                  }
                />
              ) : preview.path.endsWith(".md") ? (
                <Md>{preview.content}</Md>
              ) : (
                <pre>{preview.content}</pre>
              )}
            </div>
            <div className="preview-footnote">
              {preview.path.endsWith(".html")
                ? "HTML 预览在隔离环境运行；网络请求与对工作台的访问已禁用。"
                : "文件保存在此会话的工作区中，可下载后继续使用。"}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
