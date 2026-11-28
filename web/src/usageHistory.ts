import type { TurnRecord, UsageSample } from "./api";

export type Point = { t: number; used: number };
export type Turn = TurnRecord & { start: number; end: number; lane: number };

/** Samples grouped by window key, in time order. */
export function seriesByKey(samples: UsageSample[]): Map<string, Point[]> {
  const m = new Map<string, Point[]>();
  for (const s of samples) {
    let a = m.get(s.key);
    if (!a) m.set(s.key, (a = []));
    a.push({ t: new Date(s.ts).getTime(), used: s.used });
  }
  for (const a of m.values()) a.sort((x, y) => x.t - y.t);
  return m;
}

/** Split a series into runs with no gap longer than `maxGap` ms (the server was down, or polling backed off). */
export function segments(points: Point[], maxGap: number): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] = [];
  for (const p of points) {
    if (cur.length && p.t - cur[cur.length - 1].t > maxGap) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Turns with numeric times, each given a lane (row) so that overlapping turns don't draw on top of each other. */
export function packTurns(turns: TurnRecord[]): { turns: Turn[]; lanes: number } {
  const sorted = turns
    .map((t) => ({ ...t, start: new Date(t.started_at).getTime(), end: new Date(t.ended_at).getTime(), lane: 0 }))
    .sort((a, b) => a.start - b.start);
  const laneEnds: number[] = [];
  for (const t of sorted) {
    let lane = laneEnds.findIndex((e) => e <= t.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = t.end;
    t.lane = lane;
  }
  return { turns: sorted, lanes: laneEnds.length };
}

/** Merged [start, end] intervals during which at least one turn was running. */
export function activeSpans(turns: { start: number; end: number }[]): [number, number][] {
  const s = [...turns].sort((a, b) => a.start - b.start);
  const out: [number, number][] = [];
  for (const t of s) {
    const last = out[out.length - 1];
    if (last && t.start <= last[1]) last[1] = Math.max(last[1], t.end);
    else out.push([t.start, t.end]);
  }
  return out;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Estimate how much of a window's usage each turn used. Between two readings the window went up by Δ points
 * (after a reset: by the second reading). That Δ is split over the turns running in between, by how long each ran
 * in that interval. A Δ with no turn running is "outside": Claude used elsewhere (claude.ai, another machine).
 * It's an estimate: readings are whole percents taken minutes apart, and a long quiet turn costs less than a busy one.
 */
export function attribute(points: Point[], turns: Turn[]): { byTurn: Map<Turn, number>; outside: number } {
  const byTurn = new Map<Turn, number>();
  let outside = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const d = b.used >= a.used ? b.used - a.used : b.used;
    if (d <= 0) continue;
    const w = turns.map((t) => overlap(a.t, b.t, t.start, t.end));
    const total = w.reduce((x, y) => x + y, 0);
    if (!total) {
      outside += d;
      continue;
    }
    turns.forEach((t, j) => w[j] && byTurn.set(t, (byTurn.get(t) ?? 0) + (d * w[j]) / total));
  }
  return { byTurn, outside };
}

const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;
const STEPS = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];

/** Time-axis ticks on local-clock boundaries (whole hours, midnights), at most `max` of them. */
export function timeTicks(t0: number, t1: number, max: number): { step: number; ticks: number[] } {
  const step = STEPS.find((s) => (t1 - t0) / s <= max) ?? STEPS[STEPS.length - 1];
  const d = new Date(t0);
  if (step < DAY) {
    d.setMinutes(0, 0, 0);
    const h = step / HOUR;
    if (h >= 1) d.setHours(Math.floor(d.getHours() / h) * h);
  } else d.setHours(0, 0, 0, 0);
  const ticks: number[] = [];
  for (let t = d.getTime(); t <= t1; ) {
    if (t >= t0) ticks.push(t);
    if (step < DAY) t += step;
    else {
      const n = new Date(t);
      n.setDate(n.getDate() + step / DAY); // DST-safe local midnights
      t = n.getTime();
    }
  }
  return { step, ticks };
}

export function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
