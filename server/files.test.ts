import { test, expect } from "bun:test";
import { mkdtempSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Files, fileResponse } from "./files";

const dir = () => mkdtempSync(join(tmpdir(), "wbfiles-"));

test("save sanitizes names and never overwrites", async () => {
  const f = new Files(dir());
  const a = await f.save("../../etc/pass wd.txt", new TextEncoder().encode("x").buffer);
  expect(a.name).toBe("pass wd.txt");
  expect((await f.save(".bashrc", new ArrayBuffer(1))).name).toBe("bashrc");
  expect((await f.save("pass wd.txt", new ArrayBuffer(1))).name).toBe("pass wd-1.txt");
  expect(f.resolve(encodeURIComponent(a.name))).toBe(a.path);
});

test("resolve stays inside the folder", async () => {
  const f = new Files(dir());
  await f.save("ok.txt", new ArrayBuffer(1));
  for (const bad of ["../workerbee.db", "%2e%2e/x", ".hidden", "a/../../x", "", "%E0%A4%A"]) expect(f.resolve(bad)).toBeNull();
});

test("html downloads, images inline, all sandboxed", async () => {
  const f = new Files(dir());
  const h = await f.save("x.html", new ArrayBuffer(1));
  const r = fileResponse(h.path);
  expect(r.headers.get("content-disposition")).toStartWith("attachment");
  expect(r.headers.get("content-security-policy")).toContain("sandbox");
  const p = await f.save("x.png", new ArrayBuffer(1));
  expect(fileResponse(p.path).headers.get("content-disposition")).toStartWith("inline");
});

test("cleanup deletes old files only", async () => {
  const f = new Files(dir(), 1000);
  const old = await f.save("old.txt", new ArrayBuffer(1));
  const fresh = await f.save("new.txt", new ArrayBuffer(1));
  utimesSync(old.path, new Date(0), new Date(0));
  f.cleanup();
  expect(existsSync(old.path)).toBe(false);
  expect(existsSync(fresh.path)).toBe(true);
});
