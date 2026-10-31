#!/usr/bin/env node
// An end-to-end walk is refused any database whose host node-pg would not resolve to loopback,
// however the connection string spells it. Table-driven over the string, so a URL that names
// loopback in its text and connects elsewhere is a row here rather than a reading of a regex.
import assert from "node:assert/strict";

import { pgHost, refuseUnlessScratch } from "../scripts/scratch-only.ts";

const URL_OK = "http://127.0.0.1:8080";
const local = (db: string): boolean => refuseUnlessScratch(URL_OK, "zzp_x", db, "rows") === null;

const cases: [db: string, host: string | null, allowed: boolean][] = [
  ["postgresql://zz:evalflow@127.0.0.1:5432/zz", "127.0.0.1", true],
  ["postgres://zz@localhost/zz", "localhost", true],
  ["postgresql://zz@[::1]:5432/zz", "[::1]", true],
  // A `host` query parameter wins over the URL's own host in node-pg, so loopback in the
  // authority is not where it connects.
  ["postgresql://zz:x@127.0.0.1:5432/zz?host=db.example.com", "db.example.com", false],
  ["postgresql://zz:x@localhost:5432/zz?host=localhost&host=db.example.com", "db.example.com", false],
  // The host follows the LAST `@`: `localhost` here is inside the password.
  ["postgresql://user:x@localhost:y@db.example.com/zz", "db.example.com", false],
  ["postgresql://zz@db.example.com:5432/zz", "db.example.com", false],
  ["postgresql://zz@127.0.0.1.example.com/zz", "127.0.0.1.example.com", false],
  // No host: node-pg falls back to $PGHOST, which this cannot see.
  ["postgresql:///zz", null, false],
  // A socket path, and a scheme node-pg reads as a socket.
  ["/var/run/postgresql zz", null, false],
  ["socket://zz@/var/run/postgresql?db=zz", null, false],
  // An empty `host` parameter is not one: node-pg keeps the URL's host.
  ["postgresql://zz@127.0.0.1/zz?host=", "127.0.0.1", true],
];

for (const [db, host, allowed] of cases) {
  assert.equal(pgHost(db), host, `${db}: node-pg connects to ${host ?? "no URL host"}`);
  assert.equal(local(db), allowed, `${db} must be ${allowed ? "allowed" : "refused"}`);
}

console.log(`scratch-only database host: ok (${cases.length} connection strings)`);
