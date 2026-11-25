// Is this request really from Caddy?
//
// workerbee listens on 127.0.0.1, so besides Caddy every local process can connect, including the Claude sessions
// workerbee itself runs. Caddy strips client-sent X-Auth-Email and sets it only after the radify gate approves,
// so that header is trustworthy only on connections Caddy made. Linux records the owning uid of every socket in
// /proc/net/tcp{,6}; Caddy runs as its own `caddy` user. Same approach as radify admin (admin/src/peer.rs).
import { readFileSync } from "node:fs";

export function uidOf(user: string): number | null {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === user) return Number(f[2]);
    }
  } catch {}
  return null;
}

const port = (addr: string) => parseInt(addr.slice(addr.lastIndexOf(":") + 1), 16);

/** In /proc/net/tcp the peer's own socket has local port = peerPort and remote port = our localPort. */
export function findPeerUid(table: string, peerPort: number, localPort: number): number | null {
  for (const line of table.split("\n").slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 8) continue;
    if (port(c[1]) === peerPort && port(c[2]) === localPort) return Number(c[7]);
  }
  return null;
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

export function peerUid(peerAddress: string, peerPort: number, localPort: number): number | null {
  if (!LOOPBACK.test(peerAddress)) return null;
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const uid = findPeerUid(readFileSync(f, "utf8"), peerPort, localPort);
      if (uid !== null) return uid;
    } catch {}
  }
  return null;
}
