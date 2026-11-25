import { useEffect, useRef, useState } from "react";
import type { Session } from "./api";

export type Activity = "waiting" | "working" | "idle";

/** What a session is doing, counting background agents as working. */
export function activity(s: Session): Activity {
  if (s.status === "waiting") return "waiting";
  if (s.status === "running" || s.background?.length) return "working";
  return "idle";
}

const name = (s: Session) => s.title || "New session";

/**
 * The tab's title and icon dot. In a session: its own state. On the home page: counts across sessions.
 * `done` is a session that finished while the tab was hidden; it wins until the tab is looked at.
 */
export function tabStatus(sessions: Session[], current: Session | undefined, done: Session | null): { title: string; dot: Activity | "done" } {
  const live = sessions.filter((s) => !s.archived);
  const any: Activity = live.some((s) => activity(s) === "waiting") ? "waiting" : live.some((s) => activity(s) === "working") ? "working" : "idle";
  if (done) return { title: `✓ Done: ${name(done)} – workerbee`, dot: any === "idle" ? "done" : any };
  if (current) {
    const a = activity(current);
    const mark = a === "waiting" ? "❓ " : a === "working" ? "⏳ " : "";
    // The title is this session; the icon is all of them, so another session needing you still shows.
    return { title: `${mark}${name(current)} – workerbee`, dot: any };
  }
  const waiting = live.filter((s) => activity(s) === "waiting").length;
  const working = live.filter((s) => activity(s) === "working").length;
  const parts = [waiting && `${waiting} need${waiting === 1 ? "s" : ""} you`, working && `${working} working`].filter(Boolean);
  return { title: parts.length ? `(${parts.join(", ")}) workerbee` : "workerbee", dot: any };
}

const DOT: Record<string, string> = { working: "#d97757", waiting: "#e0a020", done: "#3fa45b" };

/** The bee, with a colored dot in the corner unless idle. An SVG data: URL (allowed by the CSP's img-src). */
export function faviconUrl(dot: string) {
  const c = DOT[dot];
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐝</text>` +
    (c ? `<circle cx='76' cy='76' r='22' fill='${c}' stroke='white' stroke-width='6'/>` : "") +
    `</svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

/** Keeps document.title and the favicon in step with what the sessions are doing. */
export function useTabStatus(sessions: Session[] | undefined, current: Session | undefined) {
  const [done, setDone] = useState<Session | null>(null);
  const prev = useRef(new Map<string, Activity>());

  // A session that stops working while the tab is in the background: flag it until the tab is visible again.
  useEffect(() => {
    if (!sessions) return;
    const next = new Map(sessions.map((s) => [s.id, activity(s)] as const));
    if (document.hidden)
      for (const s of sessions) if (prev.current.get(s.id) === "working" && next.get(s.id) === "idle") setDone(s);
    prev.current = next;
  }, [sessions]);
  useEffect(() => {
    const onVis = () => !document.hidden && setDone(null);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const { title, dot } = tabStatus(sessions ?? [], current, done);
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = faviconUrl(dot);
  }, [dot]);
}
