// Merge a REST snapshot without dropping newer events already received over SSE.
export function mergeSnapshots(previous, incoming) {
  if (previous?.session.id !== incoming.session.id) return incoming;
  const events = [
    ...new Map(
      [...previous.events, ...incoming.events].map((e) => [e.id, e]),
    ).values(),
  ].sort((a, b) => a.id - b.id);
  const runs = new Map(
    [...previous.runs, ...incoming.runs].map((run) => [run.id, run]),
  );
  for (const event of events) {
    if (event.type !== "status" || !runs.has(event.run_id)) continue;
    runs.set(event.run_id, {
      ...runs.get(event.run_id),
      status: event.data.status,
    });
  }
  return { ...incoming, events, runs: [...runs.values()] };
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
