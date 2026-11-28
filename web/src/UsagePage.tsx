import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Usage, type UsageHistory } from "./api";
import { activeSpans, attribute, fmtDuration, packTurns, segments, seriesByKey, timeTicks, type Turn } from "./usageHistory";

export const RANGES = { "5h": 5 * 3600_000, "24h": 86400_000, "7d": 7 * 86400_000, "30d": 30 * 86400_000 } as const;
export type Range = keyof typeof RANGES;

/** Fixed series order: the colour follows the window, whatever is toggled on. */
const SERIES = [
  { key: "five_hour", label: "5-hour", color: "var(--series-1)" },
  { key: "seven_day", label: "Week", color: "var(--series-2)" },
  { key: "seven_day_opus", label: "Opus wk", color: "var(--series-3)" },
  { key: "seven_day_sonnet", label: "Sonnet wk", color: "var(--series-4)" },
];
const MAX_GAP = 2 * 3600_000; // the poller backs off up to an hour; longer than this, the line breaks
const M = { l: 40, r: 14, t: 10 };
const PLOT_H = 220;
const AXIS_H = 22;
const ROW = 9; // turn lane row height incl. gap
const MAX_ROWS = 8;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const fmtTick = (t: number, step: number) =>
  step < 86400_000
    ? new Date(t).toLocaleTimeString([], { hour: "numeric", ...(new Date(t).getMinutes() ? { minute: "2-digit" } : {}) })
    : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
const fmtWhen = (t: number) => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
const pct = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "%";

export function UsagePage(p: { harness: string; usage?: Usage; range: Range }) {
  const [hist, setHist] = useState<UsageHistory | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [shown, setShown] = useState<Set<string>>(new Set(["five_hour", "seven_day"]));
  const [hover, setHover] = useState<{ x: number; turn?: Turn } | null>(null);
  const [wrap, width] = useWidth<HTMLDivElement>();
  const span = RANGES[p.range];

  // Reload on range change, on each usage poll (a new sample), and every minute (new turns).
  useEffect(() => {
    let live = true;
    const load = () => {
      const n = Date.now();
      api
        .usageHistory(p.harness, new Date(n - span).toISOString())
        .then((h) => live && (setHist(h), setNow(n), setErr(null)))
        .catch((e) => live && setErr(e?.message ?? String(e)));
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [p.harness, span, p.usage?.fetched_at]);

  const t0 = now - span,
    t1 = now;
  const series = useMemo(() => seriesByKey(hist?.samples ?? []), [hist]);
  const packed = useMemo(() => packTurns((hist?.turns ?? []).filter((t) => new Date(t.ended_at).getTime() >= t0)), [hist, t0]);
  const spans = useMemo(() => activeSpans(packed.turns), [packed]);
  const avail = SERIES.filter((s) => series.get(s.key)?.length || p.usage?.ok && p.usage.windows.some((w) => w.key === s.key));

  const rows = Math.min(MAX_ROWS, Math.max(1, packed.lanes));
  const laneTop = M.t + PLOT_H + AXIS_H + 18;
  const H = laneTop + rows * ROW + 4;
  const pw = width - M.l - M.r;
  const x = (t: number) => M.l + ((t - t0) / span) * pw;
  const y = (u: number) => M.t + PLOT_H - (Math.min(100, Math.max(0, u)) / 100) * PLOT_H;
  const { step, ticks } = timeTicks(t0, t1, Math.max(2, Math.floor(pw / 64)));

  const hoverT = hover ? t0 + ((hover.x - M.l) / pw) * span : null;
  const at = (key: string, t: number) => {
    const pts = series.get(key) ?? [];
    let best: (typeof pts)[number] | undefined;
    for (const q of pts) if (q.t <= t) best = q;
    return best && t - best.t <= MAX_GAP ? best : undefined;
  };
  const runningAt = hoverT === null ? [] : packed.turns.filter((t) => t.start <= hoverT && t.end >= hoverT);
  const hiSession = hover?.turn?.session_id;

  // Who used what, per window, over this range.
  const attr = useMemo(() => {
    const out = new Map<string, { title: string; project: string | null; turns: number; ms: number; by: Record<string, number> }>();
    for (const t of packed.turns) {
      const r = out.get(t.session_id) ?? { title: t.title, project: t.project, turns: 0, ms: 0, by: {} };
      r.turns++;
      r.ms += t.duration_ms;
      out.set(t.session_id, r);
    }
    const outside: Record<string, number> = {};
    const perTurn = new Map<Turn, Record<string, number>>();
    for (const key of ["five_hour", "seven_day"]) {
      const a = attribute(series.get(key) ?? [], packed.turns);
      outside[key] = a.outside;
      for (const [t, v] of a.byTurn) {
        const r = out.get(t.session_id)!;
        r.by[key] = (r.by[key] ?? 0) + v;
        perTurn.set(t, { ...perTurn.get(t), [key]: v });
      }
    }
    const list = [...out.entries()].sort((a, b) => (b[1].by.five_hour ?? 0) - (a[1].by.five_hour ?? 0) || b[1].ms - a[1].ms);
    return { list, outside, perTurn };
  }, [packed, series]);

  const move = (e: React.PointerEvent<SVGSVGElement>, turn?: Turn) => {
    const r = e.currentTarget.ownerSVGElement?.getBoundingClientRect() ?? e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < M.l || px > M.l + pw) return setHover(null);
    setHover({ x: px, turn });
  };

  const tipLeft = hover ? Math.min(Math.max(hover.x + 12, 0), width - 230) : 0;
  const flip = hover && hover.x > width - 250;

  return (
    <div className="usage-page">
      <div className="usage-head">
        <h2>Usage</h2>
        <div className="seg" role="group" aria-label="Time range">
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <a key={r} href={`#/usage/${r}`} className={r === p.range ? "on" : ""}>
              {r}
            </a>
          ))}
        </div>
        <button className="small-btn" onClick={() => api.refreshUsage(p.harness).catch(() => {})} title="Check usage now (at most once a minute)">
          ↻ Refresh
        </button>
      </div>

      {p.usage?.ok && (
        <div className="usage-tiles">
          {p.usage.windows.map((w) => (
            <div key={w.key} className="tile">
              <div className="muted small">{w.label}</div>
              <div className="tile-num">{100 - w.used}% left</div>
              {w.resets_at && <div className="muted small">resets {fmtWhen(new Date(w.resets_at).getTime())}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="legend">
        {avail.map((s) => (
          <button
            key={s.key}
            className={`legend-item ${shown.has(s.key) ? "" : "off"}`}
            aria-pressed={shown.has(s.key)}
            onClick={() => setShown((cur) => (cur.has(s.key) ? new Set([...cur].filter((k) => k !== s.key)) : new Set([...cur, s.key])))}
          >
            <span className="swatch" style={{ background: s.color }} />
            {s.label}
          </button>
        ))}
        <span className="legend-item static">
          <span className="swatch band" />
          a turn was running
        </span>
      </div>

      <div className="chart" ref={wrap}>
        {err && <div className="muted small">Couldn't load history: {err}</div>}
        <svg width={width} height={H} onPointerMove={(e) => move(e as any)} onPointerLeave={() => setHover(null)} role="img" aria-label="Usage over time, with turns below">
          {/* activity bands behind everything */}
          {spans.map(([a, b], i) => (
            <rect key={i} className="active-band" x={x(Math.max(a, t0))} width={Math.max(1, x(Math.min(b, t1)) - x(Math.max(a, t0)))} y={M.t} height={PLOT_H} />
          ))}
          {[0, 25, 50, 75, 100].map((u) => (
            <g key={u}>
              <line className="grid" x1={M.l} x2={M.l + pw} y1={y(u)} y2={y(u)} />
              <text className="axis" x={M.l - 6} y={y(u) + 4} textAnchor="end">
                {u}%
              </text>
            </g>
          ))}
          {ticks.map((t) => (
            <text key={t} className="axis" x={x(t)} y={M.t + PLOT_H + 16} textAnchor="middle">
              {fmtTick(t, step)}
            </text>
          ))}
          <text className="axis" x={M.l} y={laneTop - 6}>
            Turns ({packed.turns.length})
          </text>
          {SERIES.filter((s) => shown.has(s.key)).map((s) =>
            segments((series.get(s.key) ?? []).filter((q) => q.t >= t0 - MAX_GAP), MAX_GAP).map((seg, i) =>
              seg.length === 1 ? (
                <circle key={s.key + i} cx={x(seg[0].t)} cy={y(seg[0].used)} r={3} fill={s.color} />
              ) : (
                <path key={s.key + i} className="line" stroke={s.color} d={seg.map((q, j) => `${j ? "L" : "M"}${x(Math.max(q.t, t0)).toFixed(1)},${y(q.used).toFixed(1)}`).join("")} />
              ),
            ),
          )}
          {packed.turns.map((t, i) => {
            const x0 = x(Math.max(t.start, t0)),
              x1 = x(Math.min(t.end, t1));
            return (
              <rect
                key={i}
                className={`turn ${t.ok ? "" : "failed"} ${hiSession && hiSession === t.session_id ? "hi" : ""} ${hiSession && hiSession !== t.session_id ? "dim" : ""}`}
                x={x0}
                width={Math.max(2, x1 - x0)}
                y={laneTop + Math.min(t.lane, MAX_ROWS - 1) * ROW}
                height={ROW - 3}
                rx={2}
                onPointerMove={(e) => {
                  e.stopPropagation();
                  move(e as any, t);
                }}
                onClick={() => (location.hash = `#/s/${t.session_id}`)}
              />
            );
          })}
          {hover && <line className="crosshair" x1={hover.x} x2={hover.x} y1={M.t} y2={H} />}
          {hover &&
            hoverT !== null &&
            SERIES.filter((s) => shown.has(s.key)).map((s) => {
              const q = at(s.key, hoverT);
              return q ? <circle key={s.key} className="dot-ring" cx={x(q.t)} cy={y(q.used)} r={4} fill={s.color} /> : null;
            })}
        </svg>
        {hover && hoverT !== null && (
          <div className="viz-tip" style={flip ? { right: width - hover.x + 12 } : { left: tipLeft }}>
            {hover.turn ? (
              <>
                <b>{hover.turn.title || "Untitled"}</b>
                <div className="muted">{hover.turn.project}</div>
                <div>
                  {fmtWhen(hover.turn.start)} · {fmtDuration(hover.turn.duration_ms)}
                  {hover.turn.ok ? "" : " · failed"}
                </div>
                {hover.turn.cost_usd ? <div className="muted">API-equivalent ${hover.turn.cost_usd.toFixed(2)}</div> : null}
                {attr.perTurn.get(hover.turn) && (
                  <div>
                    ≈ {pct(attr.perTurn.get(hover.turn)!.five_hour ?? 0)} of 5-hour · {pct(attr.perTurn.get(hover.turn)!.seven_day ?? 0)} of week
                  </div>
                )}
                <div className="muted small">Click to open the session</div>
              </>
            ) : (
              <>
                <b>{fmtWhen(hoverT)}</b>
                {SERIES.filter((s) => shown.has(s.key)).map((s) => {
                  const q = at(s.key, hoverT);
                  return (
                    <div key={s.key} className="tip-row">
                      <span className="swatch" style={{ background: s.color }} />
                      {s.label} <span className="tip-val">{q ? `${q.used}% used` : "—"}</span>
                    </div>
                  );
                })}
                <div className="muted">{runningAt.length ? `${runningAt.length} turn${runningAt.length > 1 ? "s" : ""} running` : "No turns running"}</div>
                {runningAt.slice(0, 4).map((t, i) => (
                  <div key={i} className="small tip-turn">
                    {t.title || "Untitled"}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        {!hist?.samples.length && hist && <div className="muted small">No usage readings in this range yet: they're recorded every time the server checks usage (about every 5 minutes).</div>}
      </div>

      <h3>Where it went</h3>
      <p className="muted small">
        Estimated: each rise in a meter between two readings is split over the turns that ran in between, by how long each ran. Rises with no workerbee turn running are usage from elsewhere
        (claude.ai, the desktop app, another machine). Numbers are points of each meter, so over a range longer than one window
        they can add up past 100%.
      </p>
      <table className="attr">
        <thead>
          <tr>
            <th>Session</th>
            <th className="num">Turns</th>
            <th className="num">Working</th>
            <th className="num">5-hour</th>
            <th className="num">Week</th>
          </tr>
        </thead>
        <tbody>
          {attr.list.slice(0, 25).map(([id, r]) => (
            <tr key={id} className={hiSession === id ? "hi" : ""}>
              <td>
                <a href={`#/s/${id}`}>{r.title || "Untitled"}</a> <span className="muted small">{r.project}</span>
              </td>
              <td className="num">{r.turns}</td>
              <td className="num">{fmtDuration(r.ms)}</td>
              <td className="num">{r.by.five_hour ? pct(r.by.five_hour) : "—"}</td>
              <td className="num">{r.by.seven_day ? pct(r.by.seven_day) : "—"}</td>
            </tr>
          ))}
          <tr className="muted">
            <td>Outside workerbee</td>
            <td className="num" />
            <td className="num" />
            <td className="num">{attr.outside.five_hour ? pct(attr.outside.five_hour) : "—"}</td>
            <td className="num">{attr.outside.seven_day ? pct(attr.outside.seven_day) : "—"}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
