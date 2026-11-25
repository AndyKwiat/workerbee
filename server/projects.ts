import { mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export type Project = { name: string; path: string; git: boolean; created_at: string };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class Projects {
  constructor(public root: string) {}

  path(name: string) {
    if (!NAME_RE.test(name)) throw new Error("bad project name");
    return join(this.root, name);
  }

  list(): Project[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NAME_RE.test(d.name))
      .map((d) => {
        const p = join(this.root, d.name);
        return { name: d.name, path: p, git: existsSync(join(p, ".git")), created_at: statSync(p).birthtime.toISOString() };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name: string, gitUrl?: string): Promise<Project> {
    const p = this.path(name);
    if (existsSync(p)) throw new Error(`project ${name} already exists`);
    if (gitUrl) {
      if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(gitUrl)) throw new Error("bad git URL");
      const proc = Bun.spawn(["git", "clone", "--", gitUrl, p], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const err = await new Response(proc.stderr).text();
      if ((await proc.exited) !== 0) throw new Error(`git clone failed: ${err.trim().slice(-500)}`);
    } else {
      mkdirSync(p);
      const g = Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: p, stdout: "ignore", stderr: "ignore" });
      await g.exited;
    }
    return this.list().find((x) => x.name === name)!;
  }
}
