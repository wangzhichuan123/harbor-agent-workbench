import initSqlJs from "sql.js";
import fs from "node:fs";
import path from "node:path";

export async function createStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "workbench.sqlite");
  const SQL = await initSqlJs();
  const db = new SQL.Database(
    fs.existsSync(file) ? fs.readFileSync(file) : undefined,
  );
  db.run(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, cli_session TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, prompt TEXT NOT NULL, status TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_session ON events(session_id,id);
    CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id,created_at);`);
  function flush() {
    const temporary = file + ".tmp";
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(fd, Buffer.from(db.export()));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
      db.run("PRAGMA foreign_keys=ON");
    }
    fs.renameSync(temporary, file);
  }
  function all(sql, args = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(args);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }
  function run(sql, args = []) {
    db.run(sql, args);
    flush();
  }
  function transaction(fn) {
    db.run("BEGIN");
    try {
      fn();
      db.run("COMMIT");
      flush();
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  }
  flush();
  return {
    all,
    one: (sql, args) => all(sql, args)[0],
    run,
    transaction,
    raw: (sql, args = []) => db.run(sql, args),
    close: () => {
      flush();
      db.close();
    },
  };
}
