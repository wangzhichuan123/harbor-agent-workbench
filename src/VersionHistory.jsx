import React, { useEffect, useRef, useState } from "react";
import { History, X, Download, RotateCcw, Loader2 } from "lucide-react";
const reasons = {
  baseline: "初始版本",
  before_run: "执行前备份",
  after_run: "任务成果",
  before_restore: "回滚前备份",
  restore: "回滚生成",
};
export default function VersionHistory({
  sessionId,
  initialPath,
  api,
  busy,
  onClose,
  onRestored,
}) {
  const [files, setFiles] = useState([]),
    [selected, setSelected] = useState(initialPath || ""),
    [history, setHistory] = useState(null),
    [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false),
    [restoring, setRestoring] = useState(false),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  const request = useRef(0),
    previewRequest = useRef(0);
  useEffect(() => {
    let gone = false;
    api(`/sessions/${sessionId}/versions`)
      .then((data) => {
        if (gone) return;
        setFiles(data.files);
        setSelected((old) => old || data.files[0]?.path || "");
      })
      .catch((e) => {
        if (!gone) setError(e.message);
      });
    return () => {
      gone = true;
    };
  }, [sessionId, reload]);
  async function load(older = false) {
    if (!selected) return;
    const version = ++request.current;
    setLoading(true);
    setError("");
    const parameters = new URLSearchParams({ path: selected, limit: "20" });
    if (older && history?.nextBefore)
      parameters.set("before", history.nextBefore);
    try {
      const data = await api(`/sessions/${sessionId}/versions?${parameters}`);
      if (version !== request.current) return;
      setHistory((old) =>
        older ? { ...data, items: [...old.items, ...data.items] } : data,
      );
    } catch (e) {
      if (version === request.current) setError(e.message);
    } finally {
      if (version === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    setHistory(null);
    setContent(null);
    previewRequest.current++;
    load();
    return () => {
      request.current++;
      previewRequest.current++;
    };
  }, [selected, reload]);
  async function view(version) {
    const sequence = ++previewRequest.current;
    try {
      const data = await api(`/sessions/${sessionId}/versions/${version.id}`);
      if (sequence === previewRequest.current) setContent(data);
    } catch (e) {
      if (sequence === previewRequest.current) setError(e.message);
    }
  }
  async function restore(version) {
    if (
      !confirm(
        `将 ${version.path} 恢复到 ${new Date(version.created_at).toLocaleString("zh-CN")} 的版本？当前文件会先备份，聊天记录保持不变。${version.deleted ? "此版本表示文件已删除。" : ""}`,
      )
    )
      return;
    setRestoring(true);
    setError("");
    try {
      const result = await api(
        `/sessions/${sessionId}/versions/${version.id}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      setReload((n) => n + 1);
      await onRestored(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setRestoring(false);
    }
  }
  return (
    <div className="modal-backdrop" onClick={restoring ? undefined : onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="成果版本历史"
        className="history-modal versions-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">
          <h2>
            <History size={20} />
            成果版本历史
          </h2>
          <button
            className="icon-button"
            aria-label="关闭版本历史"
            disabled={restoring}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p className="history-hint">
          任务执行前后自动保存；回滚前备份当前文件，可再次恢复。仅回滚文件，不撤销对话。
        </p>
        <label className="version-file-label">
          成果文件
          <select
            aria-label="选择成果文件"
            value={selected}
            disabled={restoring}
            onChange={(e) => setSelected(e.target.value)}
          >
            {!files.length && <option value="">暂无成果版本</option>}
            {files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path} · {file.version_count} 个版本
                {file.deleted ? " · 已删除" : ""}
              </option>
            ))}
          </select>
        </label>
        {busy && (
          <p className="history-hint">
            此会话正在执行任务，结束或停止后可回滚。
          </p>
        )}
        {error && (
          <p className="history-error" role="alert">
            {error}
          </p>
        )}
        <div className="versions-layout">
          <div className="history-scroll version-list">
            {loading && !history && (
              <p className="history-hint">
                <Loader2 size={14} className="spin" />
                正在读取版本…
              </p>
            )}
            {history?.items.map((version) => (
              <article className="version-row" key={version.id}>
                <div className="version-row-heading">
                  <strong>
                    #{version.id} ·{" "}
                    {new Date(version.created_at).toLocaleString("zh-CN")}
                  </strong>
                  {version.id === history.head && (
                    <span className="current-version">当前版本</span>
                  )}
                </div>
                <p>
                  {reasons[version.reason] || version.reason} ·{" "}
                  {version.deleted
                    ? "文件删除状态"
                    : `${version.size.toLocaleString()} B · ${version.hash.slice(0, 10)}`}
                </p>
                <div className="version-actions">
                  <button
                    className="secondary-button"
                    onClick={() => view(version)}
                  >
                    查看内容
                  </button>
                  {!version.deleted && (
                    <a
                      className="secondary-button"
                      href={`/api/sessions/${sessionId}/versions/${version.id}?download=1`}
                    >
                      <Download size={13} />
                      下载
                    </a>
                  )}
                  <button
                    className="secondary-button"
                    disabled={busy || restoring || version.id === history.head}
                    onClick={() => restore(version)}
                  >
                    <RotateCcw size={13} />
                    {restoring ? "恢复中…" : "回滚到此版本"}
                  </button>
                </div>
              </article>
            ))}
            {history?.hasMore && (
              <button
                className="secondary-button load-more"
                disabled={loading}
                onClick={() => load(true)}
              >
                {loading ? "读取中…" : "加载更早版本"}
              </button>
            )}
            {!loading && !history?.items.length && (
              <p className="history-hint">
                还没有版本。创建成果文件后，任务结束或打开此面板时会保存初始版本。
              </p>
            )}
          </div>
          <div className="version-content">
            {content ? (
              <>
                <strong>
                  {content.path} · 版本 {content.id}
                </strong>
                {content.deleted ? (
                  <p>此版本中的文件已删除，回滚将恢复该删除状态。</p>
                ) : content.binary ? (
                  <p>二进制或较大文件，请点击对应版本的下载按钮查看。</p>
                ) : (
                  <pre>{content.content}</pre>
                )}
              </>
            ) : (
              <p>选择一个版本查看内容，再决定是否回滚。</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
