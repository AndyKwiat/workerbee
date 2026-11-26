import { basename, extname, join, normalize, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";

/**
 * A shared drop folder for files going between Andy and the sessions (`$DATA_DIR/files`). Every session can read
 * and write it. Andy uploads with the 📎 button; sessions hand files back as links to `/files/<name>`. Files older
 * than `maxAgeMs` are deleted, so it is a temp folder, not storage.
 */
export class Files {
  constructor(readonly dir: string, readonly maxAgeMs = 7 * 24 * 3600_000) {
    mkdirSync(dir, { recursive: true });
  }

  /** A safe, unused file name: plain characters, no path, no leading dot; `name-1.ext` if taken. */
  freeName(raw: string) {
    let name = basename(raw.replace(/\\/g, "/")).replace(/[^\w.\- ]+/g, "_").replace(/^[.\s]+/, "").slice(0, 120).trim() || "file";
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 1; existsSync(join(this.dir, name)); i++) name = `${stem}-${i}${ext}`;
    return name;
  }

  async save(rawName: string, data: Blob | ArrayBuffer) {
    const name = this.freeName(rawName);
    const path = join(this.dir, name);
    await Bun.write(path, data);
    return { name, path, url: `/files/${encodeURIComponent(name)}` };
  }

  /** Resolve a `/files/…` path to a file inside the folder, or null. Subfolders are fine; dotfiles are not. */
  resolve(urlPath: string): string | null {
    let rel: string;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (rel.split("/").some((s) => s.startsWith("."))) return null;
    const p = normalize(join(this.dir, rel));
    if (!p.startsWith(this.dir + sep)) return null;
    try {
      return statSync(p).isFile() ? p : null;
    } catch {
      return null;
    }
  }

  /** Delete top-level entries not modified for `maxAgeMs`. */
  cleanup(now = Date.now()) {
    for (const e of readdirSync(this.dir)) {
      const p = join(this.dir, e);
      try {
        if (now - statSync(p).mtimeMs > this.maxAgeMs) rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }
}

/** Images open in the browser; everything else downloads. Never render agent-written HTML/SVG on this origin. */
const INLINE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".txt", ".log", ".md", ".json", ".csv"]);

export function fileResponse(path: string) {
  const name = basename(path);
  const inline = INLINE.has(extname(name).toLowerCase());
  const f = Bun.file(path);
  const type = inline && !f.type.startsWith("image/") ? "text/plain; charset=utf-8" : f.type || "application/octet-stream";
  return new Response(f, {
    headers: {
      "content-type": type,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self'",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
