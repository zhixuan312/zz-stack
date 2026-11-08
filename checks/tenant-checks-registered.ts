import assert from 'node:assert/strict';
import { isGateLaunchSource } from '../scripts/gate/read.ts';
const safe=[
  '// execFileSync("npm", ["run", "test:release"]);',
  'const text = "spawnSync npm run test:release";',
  'const pattern = /(execFileSync|spawnSync|execSync)[\\s\\S]{0,200}gate/;',
  'import { execFileSync } from "node:child_process"; execFileSync("node", ["checks/example.ts"]);'];
for (const source of safe) assert.equal(isGateLaunchSource(source),false);
const unsafe=[
  'import { execFileSync } from "node:child_process"; execFileSync("npm", ["run", "test:release"]);',
  'import { spawnSync as launch } from "node:child_process"; launch("node", ["scripts/gate.ts"]);',
  'import * as cp from "node:child_process"; cp.execSync("npm run test:release");'];
for (const source of unsafe) assert.equal(isGateLaunchSource(source),true);
console.log('tenant-checks-registered: ok');
