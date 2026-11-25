import { expect, test } from "bun:test";
import { fmtTokens, latestContextUsage, level } from "./ContextMeter";
import type { EventRow, WbEvent } from "./api";

const row = (seq: number, event: WbEvent): EventRow => ({ session_id: "s", seq, ts: String(seq), event });
const cu = (tokens: number): WbEvent => ({ type: "context_usage", tokens, max: 200_000, percentage: tokens / 2000, categories: [] });

test("latest snapshot wins", () => {
  expect(latestContextUsage([row(1, { type: "user", text: "x" })])).toBeNull();
  const got = latestContextUsage([row(1, cu(10_000)), row(2, { type: "turn_end", ok: true }), row(3, cu(84_000))])!;
  expect(got.usage.tokens).toBe(84_000);
  expect(got.ts).toBe("3");
});

test("token formatting and levels", () => {
  expect([950, 1_234, 12_345, 84_312, 200_000, 1_000_000].map(fmtTokens)).toEqual(["950", "1.2k", "12k", "84k", "200k", "1.0M"]);
  expect([42, 70, 91].map(level)).toEqual(["", "warn", "crit"]);
});
