import { expect, test } from "bun:test";
import { fmtDuration, groupActivity, mergeTasks, splitSubagents } from "./Transcript";
import type { EventRow, WbEvent } from "./api";

const rows = (evs: WbEvent[]): EventRow[] => evs.map((event, i) => ({ session_id: "s", seq: i + 1, ts: "", event }));
const use = (id: string): WbEvent => ({ type: "tool_use", id, name: "Bash", input: {} });
const row = (seq: number, event: WbEvent): EventRow => ({ session_id: "s", seq, ts: new Date(seq * 1000).toISOString(), event });
const res = (id: string): WbEvent => ({ type: "tool_result", tool_use_id: id, content: "" });

test("runs of 2+ tool calls group; text, permissions and turn ends break runs", () => {
  const items = groupActivity(
    rows([
      { type: "user", text: "go" },
      use("a"), res("a"), { type: "thinking", text: "hm" }, use("b"), res("b"),
      { type: "text", text: "halfway" },
      use("c"), res("c"),
      { type: "turn_end", ok: true },
    ]),
  );
  expect(items.map((i) => (i.kind === "group" ? `group:${i.rows.length}` : i.row.event.type))).toEqual([
    "user", "group:5", "text", "tool_use", "tool_result", "turn_end",
  ]);
});

test("durations", () => {
  expect(fmtDuration(4_200)).toBe("4s");
  expect(fmtDuration(192_000)).toBe("3m 12s");
  expect(fmtDuration(3_840_000)).toBe("1h 4m");
});

test("subagent rows move into their agent card; agent calls are never folded into a tool group", () => {
  const ev = [
    row(1, { type: "tool_use", id: "a", name: "Read", input: {} }),
    row(2, { type: "tool_use", id: "ag", name: "Agent", input: { description: "look" } }),
    row(3, { type: "tool_use", id: "s1", name: "Bash", input: {}, parent: "ag" }),
    row(4, { type: "text", text: "found it", parent: "ag" }),
    row(5, { type: "tool_use", id: "b", name: "Read", input: {} }),
  ];
  const { main, children } = splitSubagents(ev);
  expect(main.map((r) => r.seq)).toEqual([1, 2, 5]);
  expect(children.get("ag")!.map((r) => r.seq)).toEqual([3, 4]);
  expect(groupActivity(main).map((i) => i.kind)).toEqual(["row", "row", "row"]);
});

test("task events merge per task id", () => {
  const t = mergeTasks([
    row(1, { type: "task", task_id: "t", tool_use_id: "ag", status: "running", description: "look", background: false }),
    row(2, { type: "task", task_id: "t", status: "running", background: true }),
    row(3, { type: "task", task_id: "t", status: "completed", summary: "done", duration_ms: 5000 }),
  ]).get("t")!;
  expect(t).toMatchObject({ tool_use_id: "ag", description: "look", background: true, status: "completed", summary: "done", duration_ms: 5000 });
  expect(t.ended).toBeDefined();
});
