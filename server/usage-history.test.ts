import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db";

test("usage samples are stored per window and filtered by time", () => {
  const store = new Store(":memory:");
  store.recordUsage("claude", "2026-11-01T00:00:00.000Z", [
    { key: "five_hour", used: 10, resets_at: "2026-11-01T03:00:00Z" },
    { key: "seven_day", used: 40 },
  ]);
  store.recordUsage("claude", "2026-11-02T00:00:00.000Z", [{ key: "five_hour", used: 20 }]);
  expect(store.usageSamples("claude", "2026-01-01T00:00:00Z").length).toBe(3);
  const late = store.usageSamples("claude", "2026-11-01T12:00:00Z");
  expect(late).toEqual([{ ts: "2026-11-02T00:00:00.000Z", harness: "claude", key: "five_hour", used: 20, resets_at: null }]);
  expect(store.usageSamples("other", "2026-01-01T00:00:00Z")).toEqual([]);
});

test("turns record start = end - duration; first open backfills from turn_end events without fork duplicates", () => {
  const path = join(mkdtempSync(join(tmpdir(), "wb-")), "t.db");
  const a = new Store(path);
  a.recordTurn({ session_id: "x", ended_at: "2026-11-01T00:01:00.000Z", duration_ms: 60_000, ok: true, cost_usd: 0.5 });
  expect(a.turns("2026-01-01T00:00:00Z")[0]).toMatchObject({ started_at: "2026-11-01T00:00:00.000Z", duration_ms: 60_000, ok: 1 });

  // simulate an old database: events but no turns table
  a.db.exec("DROP TABLE turns");
  a.db.query("INSERT INTO events (session_id, seq, ts, data) VALUES (?, ?, ?, ?)").run("s1", 1, "2026-11-01T00:00:10.000Z", JSON.stringify({ type: "turn_end", ok: true, duration_ms: 5000 }));
  a.db.query("INSERT INTO events (session_id, seq, ts, data) VALUES (?, ?, ?, ?)").run("s2", 1, "2026-11-01T00:00:10.000Z", JSON.stringify({ type: "turn_end", ok: true, duration_ms: 5000 })); // fork copy
  a.db.query("INSERT INTO events (session_id, seq, ts, data) VALUES (?, ?, ?, ?)").run("s1", 2, "2026-11-01T00:00:20.000Z", JSON.stringify({ type: "turn_end", ok: false, error: "process exited" }));
  a.db.close();
  const b = new Store(path);
  const t = b.turns("2026-01-01T00:00:00Z");
  expect(t.length).toBe(1);
  expect(t[0]).toMatchObject({ session_id: "s1", started_at: "2026-11-01T00:00:05.000Z", duration_ms: 5000 });
});
