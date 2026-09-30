import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

/** A Hermes store with nothing in it: enough for the collector to read, which
 *  is all these cases need. One schema, shared by every suite, because two drift. */
export function createEmptyHermesStore(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "state.db"));
  db.exec("CREATE TABLE session_model_usage (session_id TEXT, model TEXT, input_tokens INT," +
          " output_tokens INT, cache_read_tokens INT, cache_write_tokens INT, first_seen REAL, last_seen REAL)");
  db.close();
}
