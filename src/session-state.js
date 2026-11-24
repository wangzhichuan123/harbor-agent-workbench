// Merge a REST snapshot without dropping newer events already received over SSE.
export function mergeSnapshots(previous, incoming) {
  if (previous?.session.id !== incoming.session.id) return incoming;
  const events = [
    ...new Map(
      [...previous.events, ...incoming.events].map((e) => [e.id, e]),
    ).values(),
  ].sort((a, b) => a.id - b.id);
  const runs = new Map(previous.runs.map((run) => [run.id, run]));
  for (const run of incoming.runs) {
    const old = runs.get(run.id),
      merged = { ...old, ...run };
    for (const [cursor, fields] of [
      ["answer_cursor", ["answer"]],
      ["status_cursor", ["status", "error", "finished_at"]],
      ["tool_cursor", ["tool_count"]],
    ]) {
      if ((old?.[cursor] || 0) > (run[cursor] || 0)) {
        merged[cursor] = old[cursor];
        for (const field of fields) merged[field] = old[field];
      }
    }
    runs.set(run.id, merged);
  }
  for (const event of events) {
    if (runs.has(event.run_id))
      runs.set(event.run_id, updateRun(runs.get(event.run_id), event));
  }
  const ordered = [...runs.values()].sort(
    (a, b) => (a.sequence || 0) - (b.sequence || 0),
  );
  return {
    ...incoming,
    eventCursor: Math.max(previous.eventCursor || 0, incoming.eventCursor || 0),
    events: events.slice(-200),
    runs: ordered,
    page: incoming.page
      ? {
          ...incoming.page,
          hasMore: incoming.page.total > ordered.length,
          nextBefore: ordered[0]?.sequence || null,
        }
      : incoming.page,
  };
}

function updateRun(run, event) {
  if (event.type === "status" && event.id > (run.status_cursor || 0))
    return { ...run, status: event.data.status, status_cursor: event.id };
  if (event.type === "text" && event.id > (run.answer_cursor || 0))
    return {
      ...run,
      answer: (run.answer || "") + event.data.text + "\n\n",
      answer_cursor: event.id,
    };
  if (event.type === "tool" && event.id > (run.tool_cursor || 0))
    return {
      ...run,
      tool_count: (run.tool_count || 0) + 1,
      tool_cursor: event.id,
    };
  return run;
}
export function applyLiveEvent(snapshot, event) {
  if (
    !snapshot ||
    snapshot.session.id !== event.session_id ||
    snapshot.events.some((e) => e.id === event.id)
  )
    return snapshot;
  return {
    ...snapshot,
    eventCursor: Math.max(snapshot.eventCursor || 0, event.id),
    events: [...snapshot.events, event].slice(-200),
    runs: snapshot.runs.map((run) =>
      run.id === event.run_id ? updateRun(run, event) : run,
    ),
  };
}

// Keep loaded pages only when the refreshed first page overlaps them. A burst
// larger than one page must reset the cursor so the middle remains reachable.
export function mergeLogRefresh(previous, incoming) {
  if (
    !previous?.items.length ||
    !incoming.items.some((item) => item.id === previous.items[0].id)
  )
    return incoming;
  return {
    ...previous,
    items: [
      ...new Map(
        [...previous.items, ...incoming.items].map((item) => [item.id, item]),
      ).values(),
    ].sort((a, b) => b.id - a.id),
  };
}

export const draftKey = (id) => id || "home";
export function clearSubmittedDraft(drafts, id, submitted, saved = "") {
  const key = draftKey(id);
  if ((drafts[key] ?? saved) !== submitted) return drafts;
  return { ...drafts, [key]: "" };
}

// Each request captures its own validity check, independent of other sessions.
export function createRequestTracker() {
  const versions = new Map();
  function invalidate(key) {
    versions.set(key, (versions.get(key) || 0) + 1);
  }
  return {
    invalidate,
    start(key) {
      invalidate(key);
      const version = versions.get(key);
      return () => versions.get(key) === version;
    },
  };
}
