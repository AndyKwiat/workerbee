import { expect, test } from "bun:test";
import { activeSpans, attribute, packTurns, segments, timeTicks } from "./usageHistory";

const turn = (id: string, start: number, end: number) => ({
  session_id: id,
  title: id,
  project: "p",
  started_at: new Date(start).toISOString(),
  ended_at: new Date(end).toISOString(),
  duration_ms: end - start,
  ok: true,
  cost_usd: null,
});

test("overlapping turns get separate lanes; active spans merge", () => {
  const { turns, lanes } = packTurns([turn("a", 0, 100), turn("b", 50, 150), turn("c", 120, 200)]);
  expect(turns.map((t) => t.lane)).toEqual([0, 1, 0]);
  expect(lanes).toBe(2);
  expect(activeSpans(turns)).toEqual([[0, 200]]);
  expect(activeSpans(packTurns([turn("a", 0, 10), turn("b", 20, 30)]).turns)).toEqual([[0, 10], [20, 30]]);
});

test("usage rises are split by time running; idle rises are outside; resets count from zero", () => {
  const { turns } = packTurns([turn("a", 0, 100), turn("b", 50, 100)]);
  const pts = [
    { t: 0, used: 10 },
    { t: 100, used: 16 }, // +6: a ran 100, b ran 50 → 4 / 2
    { t: 200, used: 18 }, // +2 with nothing running → outside
    { t: 300, used: 3 }, // reset, then 3 used, nothing running → outside
  ];
  const r = attribute(pts, turns);
  expect(r.byTurn.get(turns[0])).toBeCloseTo(4);
  expect(r.byTurn.get(turns[1])).toBeCloseTo(2);
  expect(r.outside).toBe(5);
});

test("gaps split a series", () => {
  expect(segments([{ t: 0, used: 1 }, { t: 10, used: 2 }, { t: 100, used: 3 }], 50).length).toBe(2);
});

test("ticks stay under the max and fall on whole hours", () => {
  const t0 = new Date(2026, 10, 28, 9, 17).getTime();
  const { ticks } = timeTicks(t0, t0 + 5 * 3600_000, 6);
  expect(ticks.length).toBeLessThanOrEqual(6);
  expect(ticks.every((t) => new Date(t).getMinutes() === 0)).toBe(true);
});
