import type { Subprocess } from "bun";
import type { AuthStatus } from "../types";

const URL_RE = /https:\/\/\S*oauth\/authorize\S+/;

/**
 * Drives `claude auth login` headlessly: it prints an authorize URL, the user opens it, signs in, and pastes
 * the code shown on the callback page back into the UI, which we write to the CLI's stdin.
 * Credentials end up in $HOME/.claude/.credentials.json and the CLI refreshes them itself.
 */
export class ClaudeAuth {
  private login: { proc: Subprocess<"pipe", "pipe", "pipe">; url: string; out: string } | null = null;

  constructor(private bin: () => string) {}

  private async run(args: string[], timeoutMs = 20_000) {
    const p = Bun.spawn([this.bin(), ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const t = setTimeout(() => p.kill(), timeoutMs);
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(t);
    return { out: o, err: e, code: p.exitCode };
  }

  async status(): Promise<AuthStatus> {
    try {
      const r = await this.run(["auth", "status", "--json"]);
      const j = JSON.parse(r.out);
      return {
        loggedIn: !!j.loggedIn,
        method: j.authMethod,
        email: j.email ?? j.account?.email ?? null,
        expiresAt: j.loginExpiresAt ?? null,
        pendingLoginUrl: this.login?.url ?? null,
      };
    } catch (e: any) {
      return { loggedIn: false, detail: `auth status failed: ${e?.message ?? e}`, pendingLoginUrl: this.login?.url ?? null };
    }
  }

  async startLogin(): Promise<AuthStatus> {
    this.cancel();
    const proc = Bun.spawn([this.bin(), "auth", "login", "--claudeai"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const state = { proc, url: "", out: "" };
    this.login = state;
    const read = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const chunk of s) state.out += dec.decode(chunk);
    };
    read(proc.stdout);
    read(proc.stderr);
    // Abandon a login nobody finishes.
    setTimeout(() => this.login === state && this.cancel(), 15 * 60_000);
    const deadline = Date.now() + 20_000;
    while (!state.url && Date.now() < deadline && proc.exitCode === null) {
      const m = state.out.match(URL_RE);
      if (m) state.url = m[0];
      else await Bun.sleep(100);
    }
    if (!state.url) {
      this.cancel();
      return { ...(await this.status()), detail: `login did not print a URL: ${state.out.slice(-500)}` };
    }
    return { ...(await this.status()), pendingLoginUrl: state.url };
  }

  async submitCode(code: string): Promise<AuthStatus> {
    const l = this.login;
    if (!l) return { ...(await this.status()), detail: "No login in progress; start again." };
    l.proc.stdin.write(code.trim() + "\n");
    l.proc.stdin.flush();
    const t = setTimeout(() => l.proc.kill(), 45_000);
    await l.proc.exited;
    clearTimeout(t);
    await Bun.sleep(200);
    this.login = null;
    const tail = l.out.split("Paste code here if prompted >").pop()?.trim() ?? "";
    const st = await this.status();
    return { ...st, detail: st.loggedIn ? "Logged in." : tail.slice(-500) || "Login failed." };
  }

  async logout(): Promise<AuthStatus> {
    this.cancel();
    await this.run(["auth", "logout"]);
    return this.status();
  }

  private cancel() {
    if (this.login) {
      try {
        this.login.proc.kill();
      } catch {}
      this.login = null;
    }
  }
}
