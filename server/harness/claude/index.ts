import { forkSession, query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Harness, HarnessSession, ModelOption, OpenOptions, PermissionMode, Sink, UserInput } from "../types";
import { ClaudeAuth } from "./auth";
import { claudeUsage } from "./usage";

/** The installed CLI (self-updating, in $HOME/.local/bin) wins; otherwise the SDK's bundled binary. */
export function claudeBin(home: string): string | undefined {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const p = join(home, ".local/bin/claude");
  return existsSync(p) ? p : undefined;
}

/** Push-based async iterable used as the SDK's streaming prompt. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;
  push(m: SDKUserMessage) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: m, done: false });
    } else this.items.push(m);
  }
  end() {
    this.done = true;
    this.waiter?.({ value: undefined as any, done: true });
    this.waiter = null;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.done) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((r) => (this.waiter = r));
      },
    };
  }
}

/** Images in a tool result (e.g. Playwright screenshots) as data: URLs, capped so the event log stays small. */
function toolResultImages(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out = content
    .filter((b: any) => b?.type === "image" && b.source?.type === "base64" && /^image\/(png|jpeg|webp|gif)$/.test(b.source.media_type))
    .map((b: any) => `data:${b.source.media_type};base64,${b.source.data}`)
    .filter((u: string) => u.length <= 1_500_000)
    .slice(0, 4);
  return out.length ? out : undefined;
}

/**
 * Headless Chromium for every session via Playwright MCP, if installed (ops/server-setup.sh puts it in
 * ~/tools/playwright-mcp). Isolated in-memory profile; the browser starts on first use and dies with the session.
 */
export function browserMcp(home: string): Record<string, any> {
  const cli = join(home, "tools/playwright-mcp/node_modules/@playwright/mcp/cli.js");
  if (!existsSync(cli)) return {};
  return {
    playwright: {
      type: "stdio",
      command: "node",
      args: [cli, "--headless", "--isolated", "--browser", "chromium", "--viewport-size", "1280,800"],
    },
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : JSON.stringify(b)))
      .join("\n");
  return content == null ? "" : JSON.stringify(content);
}

const MAX_RESULT = 20_000;

/** `~/…` for the Claude home, `./…` for the project, else as is. */
export function shortPath(p: string, home: string, cwd: string): string {
  if (p.startsWith(cwd + "/")) return "." + p.slice(cwd.length);
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

class ClaudeSession implements HarnessSession {
  private input = new InputQueue();
  private q: Query;
  private closedFlag = false;

  private cwd: string;
  /** Tasks shown in the transcript (agents, workflows, background jobs); others' end notices are dropped. */
  private shownTasks = new Set<string>();

  constructor(
    private harness: ClaudeHarness,
    opts: OpenOptions,
    private sink: Sink,
  ) {
    this.cwd = opts.cwd;
    const mode = opts.permissionMode ?? "default";
    this.q = query({
      prompt: this.input,
      options: {
        cwd: opts.cwd,
        resume: opts.resumeId ?? undefined,
        model: opts.model ?? undefined,
        effort: (opts.effort as any) ?? undefined,
        permissionMode: mode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        // task_progress carries a one-line "what it's doing now" for running subagents.
        agentProgressSummaries: true,
        // The UI has a per-task Stop, so an interrupt only stops the turn and spares background agents.
        perTaskStopAffordance: true,
        systemPrompt: { type: "preset", preset: "claude_code" },
        mcpServers: browserMcp(harness.home),
        mcpServersDelivery: "initialize",
        pathToClaudeCodeExecutable: claudeBin(harness.home),
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts-workerbee" } as Record<string, string>,
        stderr: (d) => {
          const s = d.trim();
          if (s) console.error(`[claude stderr] ${s.slice(0, 500)}`);
        },
        hooks: {
          // Every CLAUDE.md / rules file Claude Code loads, with why (session start, nested dir, @include, …).
          InstructionsLoaded: [
            {
              hooks: [
                async (input: any) => {
                  sink.event({
                    type: "context",
                    files: [{ path: shortPath(input.file_path, harness.home, opts.cwd), scope: String(input.memory_type ?? "").toLowerCase(), reason: String(input.load_reason ?? "").replace(/_/g, " ") }],
                  });
                  return {};
                },
              ],
            },
          ],
        },
        canUseTool: async (toolName, input, o) => {
          const d = await sink.permission(
            { request_id: crypto.randomUUID(), tool: toolName, input, title: o.title, description: o.description ?? o.decisionReason },
            o.signal,
          );
          if (d.decision === "deny") return { behavior: "deny", message: d.message || "The user denied this." };
          return {
            behavior: "allow",
            updatedInput: (d as any).updatedInput ?? input,
            updatedPermissions: d.decision === "allow_always" ? o.suggestions : undefined,
          };
        },
      },
    });
    this.pump();
  }

  private async pump() {
    try {
      for await (const m of this.q) this.handle(m);
      this.finish();
    } catch (e: any) {
      this.finish(e?.message ?? String(e));
    }
  }

  private finish(err?: string) {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.sink.closed(err);
  }

  private handle(m: SDKMessage) {
    const s = this.sink;
    switch (m.type) {
      case "system":
        if (this.task(m as any)) break;
        if ((m as any).subtype === "init") {
          const i: any = m;
          s.harnessSessionId(m.session_id);
          s.event({
            type: "context",
            model: i.model,
            version: i.claude_code_version,
            skills: Array.isArray(i.skills) ? [...i.skills].sort() : undefined,
            mcp: Array.isArray(i.mcp_servers) ? i.mcp_servers.map((x: any) => `${x.name} (${x.status})`) : undefined,
          });
          // The instruction files actually in context (the InstructionsLoaded hook doesn't report start-up loads).
          this.q
            .getContextUsage()
            .then((u: any) => {
              this.contextUsage(u);
              const files = (u?.memoryFiles ?? u?.memory_files ?? []).map((f: any) => ({
                path: shortPath(String(f.path), this.harness.home, this.cwd),
                scope: String(f.type ?? "").toLowerCase(),
                reason: `${f.tokens ?? "?"} tokens`,
              }));
              if (files.length) s.event({ type: "context", files });
            })
            .catch(() => {});
        }
        break;
      case "stream_event": {
        if (m.parent_tool_use_id) break;
        s.busy();
        const ev: any = m.event;
        if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta") s.delta({ kind: "text", text: ev.delta.text });
          else if (ev.delta?.type === "thinking_delta") s.delta({ kind: "thinking", text: ev.delta.thinking });
        }
        break;
      }
      case "assistant": {
        const parent = m.parent_tool_use_id;
        if (!parent) s.busy();
        for (const b of m.message.content as any[]) {
          if (b.type === "text" && b.text) s.event({ type: "text", text: b.text, parent });
          else if (b.type === "thinking" && b.thinking) s.event({ type: "thinking", text: b.thinking, parent });
          else if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use")
            s.event({ type: "tool_use", id: b.id, name: b.name, input: b.input, parent });
        }
        if ((m as any).error) s.event({ type: "error", message: String((m as any).error) });
        break;
      }
      case "user": {
        if ((m as any).isReplay) break;
        const c = (m.message as any).content;
        if (Array.isArray(c))
          for (const b of c)
            if (b?.type === "tool_result") {
              let text = toolResultText(b.content);
              if (text.length > MAX_RESULT) text = text.slice(0, MAX_RESULT) + `\n… (${text.length - MAX_RESULT} more chars)`;
              s.event({ type: "tool_result", tool_use_id: b.tool_use_id, content: text, is_error: !!b.is_error, images: toolResultImages(b.content) });
            }
        break;
      }
      case "result": {
        const r: any = m;
        s.event({
          type: "turn_end",
          ok: r.subtype === "success" && !r.is_error,
          result: typeof r.result === "string" ? r.result.slice(0, 2000) : undefined,
          duration_ms: r.duration_ms,
          cost_usd: r.total_cost_usd,
          error: r.subtype !== "success" ? r.subtype : r.is_error ? r.result : undefined,
        });
        if (!this.closedFlag)
          this.q
            .getContextUsage()
            .then((u) => this.contextUsage(u))
            .catch(() => {});
        break;
      }
      case "auth_status" as any: {
        const a: any = m;
        if (a.error) s.event({ type: "error", message: `Auth: ${a.error}` });
        break;
      }
    }
  }

  private contextUsage(u: any) {
    if (!u || typeof u.totalTokens !== "number" || !u.maxTokens) return;
    this.sink.event({
      type: "context_usage",
      tokens: u.totalTokens,
      max: u.maxTokens,
      percentage: typeof u.percentage === "number" ? u.percentage : (100 * u.totalTokens) / u.maxTokens,
      model: u.model,
      categories: (u.categories ?? [])
        .filter((c: any) => c.tokens > 0)
        .map((c: any) => ({ name: String(c.name), tokens: Number(c.tokens), kind: c.kind ?? "used" })),
    });
  }

  /** Subagent / background task messages. Returns true if `m` was one. */
  private task(m: any): boolean {
    const s = this.sink;
    switch (m.subtype) {
      case "task_started": {
        if (m.ambient || m.skip_transcript) return true;
        const kind = String(m.task_type ?? "");
        // Foreground shell commands also register as tasks; their tool card already shows them.
        if (!/agent|workflow/.test(kind) && !m.is_backgrounded) return true;
        this.shownTasks.add(m.task_id);
        s.event({
          type: "task",
          task_id: m.task_id,
          tool_use_id: m.tool_use_id,
          status: "running",
          kind,
          agent: m.subagent_type ?? m.workflow_name,
          description: m.description,
          background: !!m.is_backgrounded,
        });
        return true;
      }
      case "task_updated":
        if (this.shownTasks.has(m.task_id) && m.patch?.is_backgrounded)
          s.event({ type: "task", task_id: m.task_id, status: "running", background: true });
        return true;
      case "task_progress":
        if (this.shownTasks.has(m.task_id))
          s.delta({
            kind: "task",
            task_id: m.task_id,
            tool_uses: m.usage?.tool_uses,
            duration_ms: m.usage?.duration_ms,
            last_tool: m.last_tool_name,
            summary: m.summary,
          });
        return true;
      case "task_notification":
        if (this.shownTasks.delete(m.task_id))
          s.event({
            type: "task",
            task_id: m.task_id,
            tool_use_id: m.tool_use_id,
            status: m.status,
            summary: typeof m.summary === "string" ? m.summary.slice(0, 2000) : undefined,
            tool_uses: m.usage?.tool_uses,
            duration_ms: m.usage?.duration_ms,
          });
        return true;
      case "background_tasks_changed":
        s.background(
          (m.tasks ?? [])
            .filter((t: any) => !t.ambient && /agent|workflow/.test(String(t.task_type ?? "")))
            .map((t: any) => ({ task_id: t.task_id, description: String(t.description ?? ""), kind: String(t.task_type) })),
        );
        return true;
    }
    return false;
  }

  async stopTask(taskId: string) {
    await this.q.stopTask(taskId);
  }

  send(input: UserInput) {
    const content: any[] = [];
    for (const img of input.images ?? [])
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    content.push({ type: "text", text: input.text });
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null } as SDKUserMessage);
  }
  async interrupt() {
    await this.q.interrupt();
  }
  async setModel(model: string | null) {
    await this.q.setModel(model ?? undefined);
  }
  async setPermissionMode(mode: PermissionMode) {
    await this.q.setPermissionMode(mode);
  }
  close() {
    this.input.end();
    try {
      this.q.close?.();
    } catch {}
  }
}

const FALLBACK_MODELS: ModelOption[] = [
  { value: "default", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

export class ClaudeHarness implements Harness {
  id = "claude";
  label = "Claude Code";
  auth: ClaudeAuth;
  private modelCache: { at: number; list: ModelOption[] } | null = null;

  constructor(public home: string) {
    this.auth = new ClaudeAuth(() => claudeBin(home) ?? "claude");
  }

  open(opts: OpenOptions, sink: Sink): HarnessSession {
    return new ClaudeSession(this, opts, sink);
  }

  /** The SDK copies the transcript file into a new session (fresh message ids); no CLI process or turn needed. */
  async fork(harnessSessionId: string, cwd: string, title?: string): Promise<string> {
    const r = await forkSession(harnessSessionId, { dir: cwd, ...(title ? { title } : {}) });
    return r.sessionId;
  }

  async models(): Promise<ModelOption[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 6 * 3600_000) return this.modelCache.list;
    const input = new InputQueue();
    const q = query({ prompt: input, options: { pathToClaudeCodeExecutable: claudeBin(this.home), cwd: this.home } });
    try {
      const list = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 20_000)),
      ]);
      const out = list.map((m) => ({
        value: m.value,
        label: m.displayName || m.value,
        description: m.description,
        efforts: m.supportsEffort ? m.supportedEffortLevels : undefined,
      }));
      this.modelCache = { at: Date.now(), list: out };
      return out;
    } catch {
      return FALLBACK_MODELS;
    } finally {
      input.end();
      try {
        q.close?.();
      } catch {}
    }
  }

  usage() {
    return claudeUsage(this.home, claudeBin(this.home) ?? "claude");
  }

  async version() {
    const p = Bun.spawn([claudeBin(this.home) ?? "claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    return (await new Response(p.stdout).text()).trim();
  }

  async update() {
    const p = Bun.spawn([claudeBin(this.home) ?? "claude", "update"], { stdout: "pipe", stderr: "pipe", cwd: this.home });
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    this.modelCache = null;
    return (o + e).trim();
  }
}
