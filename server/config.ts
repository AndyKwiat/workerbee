import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const dev = !!process.env.WB_DEV;
const dataDir = resolve(process.env.DATA_DIR ?? ".data");

export const config = {
  dev,
  port: Number(process.env.PORT ?? 8787),
  dataDir,
  dbPath: join(dataDir, "workerbee.db"),
  projectsDir: resolve(process.env.WB_PROJECTS_DIR ?? join(dataDir, "projects")),
  /** Shared upload/download folder for all sessions (served at /files/). */
  filesDir: resolve(process.env.WB_FILES_DIR ?? join(dataDir, "files")),
  staticDir: process.env.STATIC_DIR ?? resolve("dist/static"),
  home: process.env.HOME ?? homedir(),
  /** Comma-separated emails allowed in (defense in depth behind the radify gate). Empty = trust the gate. */
  allowedEmails: (process.env.WB_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** Close an idle harness process after this long (its conversation resumes from disk on the next message). */
  idleCloseMs: Number(process.env.WB_IDLE_CLOSE_MS ?? 10 * 60_000),
  /** The usage endpoint rate-limits per account (Andy's SwiftBar plugin polls it too), so don't go below ~5 min. */
  usagePollMs: Number(process.env.WB_USAGE_POLL_MS ?? 5 * 60_000),
  ghToken: process.env.GH_TOKEN ?? "",
};

mkdirSync(config.projectsDir, { recursive: true });
