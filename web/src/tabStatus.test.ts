import { expect, test } from "bun:test";
import { faviconUrl, tabStatus } from "./tabStatus";
import type { Session } from "./api";

const s = (id: string, status: Session["status"], extra: Partial<Session> = {}): Session =>
  ({ id, title: id, project: "p", status, archived: 0, background: [], ...extra }) as Session;

test("home page counts sessions; background agents count as working", () => {
  const all = [s("a", "running"), s("b", "idle", { background: [{ task_id: "t", description: "x", kind: "local_agent" }] }), s("c", "waiting"), s("d", "idle")];
  expect(tabStatus(all, undefined, null)).toEqual({ title: "(1 needs you, 2 working) workerbee", dot: "waiting" });
  expect(tabStatus([s("d", "idle")], undefined, null)).toEqual({ title: "workerbee", dot: "idle" });
  expect(tabStatus([s("x", "running", { archived: 1 })], undefined, null).dot).toBe("idle");
});

test("the title is this session; the icon is all sessions", () => {
  const cur = s("Fix it", "running");
  expect(tabStatus([cur], cur, null)).toEqual({ title: "⏳ Fix it – workerbee", dot: "working" });
  const idle = s("Idle one", "idle");
  expect(tabStatus([idle, s("o", "waiting")], idle, null)).toEqual({ title: "Idle one – workerbee", dot: "waiting" });
  expect(tabStatus([idle, s("o", "running")], idle, null).dot).toBe("working");
});

test("finished while away wins until seen", () => {
  const d = s("Deploy", "idle");
  expect(tabStatus([d], d, d)).toEqual({ title: "✓ Done: Deploy – workerbee", dot: "done" });
});

test("favicon is a data URL with a dot only when not idle", () => {
  expect(decodeURIComponent(faviconUrl("idle"))).not.toContain("circle");
  expect(decodeURIComponent(faviconUrl("working"))).toContain("circle");
});
