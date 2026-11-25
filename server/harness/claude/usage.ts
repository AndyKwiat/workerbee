import { join } from "node:path";
import type { Usage, UsageWindow } from "../types";

type Creds = { accessToken?: string; expiresAt?: number };

/** Linux: $HOME/.claude/.credentials.json. macOS (local dev): the login keychain. */
async function readCreds(home: string): Promise<Creds | null> {
  const f = Bun.file(join(home, ".claude/.credentials.json"));
  if (await f.exists()) {
    try {
      return (await f.json()).claudeAiOauth ?? null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const p = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    try {
      return JSON.parse(out).claudeAiOauth ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

const LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Week",
  seven_day_opus: "Opus wk",
  seven_day_sonnet: "Sonnet wk",
};

let refreshing: Promise<unknown> | null = null;

export async function claudeUsage(home: string, bin: string): Promise<Usage> {
  const fetched_at = new Date().toISOString();
  let c = await readCreds(home);
  if (!c?.accessToken) return { ok: false, error: "Not logged in", fetched_at };
  if ((c.expiresAt ?? 0) < Date.now() + 60_000) {
    // Let the CLI refresh the OAuth token (same trick as the SwiftBar plugin: a tiny Haiku call).
    refreshing ??= (async () => {
      const p = Bun.spawn([bin, "-p", "ok", "--model", "haiku"], { cwd: home, stdout: "ignore", stderr: "ignore" });
      const t = setTimeout(() => p.kill(), 60_000);
      await p.exited;
      clearTimeout(t);
    })().finally(() => (refreshing = null));
    await refreshing;
    c = await readCreds(home);
    if (!c?.accessToken) return { ok: false, error: "Login refresh failed", fetched_at };
  }
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${c.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await r.json();
    if (!j?.five_hour) {
      const ra = Number(r.headers.get("retry-after"));
      return { ok: false, error: j?.error?.message ?? `HTTP ${r.status}`, fetched_at, retry_after_s: ra > 0 ? ra : r.status === 429 ? 600 : undefined };
    }
    const windows: UsageWindow[] = [];
    for (const key of Object.keys(LABELS)) {
      const w = j[key];
      if (w && typeof w.utilization === "number")
        windows.push({ key, label: LABELS[key], used: Math.round(w.utilization), resets_at: w.resets_at ?? null });
    }
    return { ok: true, windows, fetched_at };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), fetched_at };
  }
}
