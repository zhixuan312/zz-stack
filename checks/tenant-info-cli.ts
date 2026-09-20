import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveSuite } from '../scripts/tenant-info/verify.ts';
const names = ['model','persistence','lifecycle','okf','rebuild',
  'isolation','retrieval','migration','deployment','compatibility'];
const tmp = mkdtempSync(join(tmpdir(), 'tenant-cli-'));
const run = (workspace: string | undefined, args: string[]) => {
  const env = { ...process.env };
  delete env.ZZ_TENANT_INFO_WORKSPACE;
  if (workspace !== undefined) env.ZZ_TENANT_INFO_WORKSPACE = workspace;
  return spawnSync(process.execPath, ['scripts/tenant-info/cli.ts', ...args],
    { env, encoding: 'utf8', timeout: 10000 });
};
const refused = (workspace: string | undefined, code: string) => {
  const r = run(workspace, ['verify','--suite','not-a-suite']);
  assert.equal(r.error, undefined);
  assert.equal(r.status, 2);
  const body = JSON.parse(r.stderr.trim());
  assert.equal(body.code, code);
  return body;
};
try {
  refused(undefined, 'WORKSPACE_REQUIRED');
  refused(process.cwd(), 'WORKSPACE_UNSAFE');
  refused(join(tmp, 'absent'), 'WORKSPACE_INVALID');
  symlinkSync(process.cwd(), join(tmp, 'into-repo'), 'dir');
  refused(join(tmp, 'into-repo'), 'WORKSPACE_UNSAFE');
  assert.deepEqual(refused(tmp, 'UNKNOWN_SUITE').suites, names);
  for (const name of names) {
    assert.equal(resolveSuite(name, []).status, 'not_run');
    assert.equal(resolveSuite(name, names).status, 'ready');
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts['tenant-info'], 'node scripts/tenant-info/cli.ts');
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log('tenant-info-cli: ok');
