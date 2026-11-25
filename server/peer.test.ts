import { expect, test } from "bun:test";
import { findPeerUid, peerUid } from "./peer";

// Caddy (uid 996) connected from port 50000 (C350) to workerbee on 9100 (238C); the app's own accepted socket
// (uid 999) is the mirror entry and must not be picked.
const TABLE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:238C 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 1 1 0 100 0 0 10 0
   1: 0100007F:238C 0100007F:C350 01 00000000:00000000 00:00000000 00000000   999        0 2 1 0 20 4 30 10 -1
   2: 0100007F:C350 0100007F:238C 01 00000000:00000000 00:00000000 00000000   996        0 3 1 0 20 4 30 10 -1
   3: 0100007F:C351 0100007F:238C 01 00000000:00000000 00:00000000 00000000   999        0 4 1 0 20 4 30 10 -1
`;

test("finds the owner of the peer's socket", () => {
  expect(findPeerUid(TABLE, 50000, 9100)).toBe(996);
  expect(findPeerUid(TABLE, 50001, 9100)).toBe(999);
  expect(findPeerUid(TABLE, 50002, 9100)).toBeNull();
});

test("non-loopback peers are never trusted", () => {
  expect(peerUid("10.0.0.1", 50000, 9100)).toBeNull();
});
