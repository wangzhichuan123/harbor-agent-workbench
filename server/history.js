export function pageNumber(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
    throw Object.assign(new Error("分页参数无效"), { status: 400 });
  return number;
}
export function readSnapshot(
  store,
  id,
  { full = false, before, limit = 20 } = {},
) {
  const cursor = store.one(
    "SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=?",
    [id],
  ).id;
  let runs = full
    ? store.all(
        "SELECT rowid AS sequence,* FROM runs WHERE session_id=? ORDER BY rowid",
        [id],
      )
    : store.all(
        "SELECT rowid AS sequence,* FROM runs WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?",
        [id, before || Number.MAX_SAFE_INTEGER, limit + 1],
      );
  const hasMore = !full && runs.length > limit;
  if (!full) runs = runs.slice(0, limit).reverse();
  for (const run of runs) {
    run.tool_count = store.one(
      "SELECT COUNT(*) AS n FROM events WHERE run_id=? AND type='tool'",
      [run.id],
    ).n;
    run.answer_cursor = cursor;
    run.status_cursor = cursor;
    run.tool_cursor = cursor;
    if (!run.answer)
      run.answer = store
        .all(
          "SELECT data FROM events WHERE run_id=? AND type='text' ORDER BY id",
          [run.id],
        )
        .map((e) => JSON.parse(e.data).text + "\n\n")
        .join("");
  }
  const rows = full
    ? store.all("SELECT * FROM events WHERE session_id=? ORDER BY id", [id])
    : store
        .all(
          "SELECT * FROM events WHERE session_id=? ORDER BY id DESC LIMIT 50",
          [id],
        )
        .reverse();
  return {
    runs,
    events: rows.map((e) => ({ ...e, data: JSON.parse(e.data) })),
    eventCursor: cursor,
    page: {
      hasMore,
      nextBefore: runs[0]?.sequence || null,
      total: store.one("SELECT COUNT(*) AS n FROM runs WHERE session_id=?", [
        id,
      ]).n,
      limit,
    },
  };
}
export function readLogs(store, id, query) {
  const limit = pageNumber(query.limit, 30, 100),
    before = pageNumber(query.before, Number.MAX_SAFE_INTEGER);
  const search =
    typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
  const type = query.type || "all";
  if (!["all", "tool", "text", "status"].includes(type))
    throw Object.assign(new Error("日志类型无效"), { status: 400 });
  const conditions = ["e.session_id=?", "e.id<?"],
    parameters = [id, before];
  if (query.run_id) {
    conditions.push("e.run_id=?");
    parameters.push(String(query.run_id));
  }
  if (type === "status")
    conditions.push("e.type IN ('status','error','files')");
  else if (type !== "all") {
    conditions.push("e.type=?");
    parameters.push(type);
  }
  if (search) {
    conditions.push(
      "(instr(lower(e.data),lower(?))>0 OR instr(lower(COALESCE(r.prompt,'')),lower(?))>0)",
    );
    parameters.push(search, search);
  }
  const rows = store.all(
    `SELECT e.*,r.prompt FROM events e LEFT JOIN runs r ON r.id=e.run_id WHERE ${conditions.join(" AND ")} ORDER BY e.id DESC LIMIT ?`,
    [...parameters, limit + 1],
  );
  const items = rows.slice(0, limit).map((row) => {
    const data = JSON.parse(row.data);
    for (const key of ["text", "output", "input", "message"]) {
      const value = data[key];
      if (typeof value !== "string" || value.length <= 8000) continue;
      const position = search
          ? value.toLowerCase().indexOf(search.toLowerCase())
          : 0,
        start = Math.max(0, position - 120);
      data[key] = (start ? "…" : "") + value.slice(start, start + 8000) + "…";
      data.truncated = true;
    }
    return { ...row, data };
  });
  return {
    items,
    hasMore: rows.length > limit,
    nextBefore: items.at(-1)?.id || null,
    limit,
    query: search,
  };
}

// Replay in bounded database batches and respect HTTP backpressure.
export function subscribeEvents(store, id, res, after, onClose) {
  let cursor = after,
    pumping = false,
    waiting = false,
    closed = false;
  function pump() {
    if (closed || pumping || waiting) return;
    pumping = true;
    try {
      const rows = store.all(
        "SELECT * FROM events WHERE session_id=? AND id>? ORDER BY id LIMIT 100",
        [id, cursor],
      );
      for (const row of rows) {
        cursor = row.id;
        if (
          !res.write(
            `id: ${row.id}\ndata: ${JSON.stringify({ ...row, data: JSON.parse(row.data) })}\n\n`,
          )
        ) {
          waiting = true;
          res.once("drain", () => {
            waiting = false;
            pump();
          });
          break;
        }
      }
      if (!waiting && rows.length === 100) setImmediate(pump);
    } catch {
      res.end();
    } finally {
      pumping = false;
    }
  }
  const heartbeat = setInterval(() => {
    if (!waiting && !closed) res.write(": heartbeat\n\n");
  }, 15000);
  res.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    onClose();
  });
  return { pump, end: () => res.end() };
}
