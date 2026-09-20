import assert from 'node:assert/strict';
import { validateBackupManifest } from '../testing/tenant-info/deployment.ts';
const kinds=['database','artifacts','git','credentials','configuration_keys'];
const good={scope:'isolated-rehearsal',components:kinds.map((kind,i)=>({
  kind,locator:`protected:fixture-${i}`,sha256:'a'.repeat(64)})),
  artifacts_include_canonical_record:true,compose_project:'fixture'};
assert.equal(validateBackupManifest(good).ok,true);
for (const kind of kinds) {
  assert.equal(validateBackupManifest({...good,components:good.components.filter(x=>x.kind!==kind)}).ok,false);
}
assert.equal(validateBackupManifest({...good,artifacts_include_canonical_record:false}).ok,false);
const bad=structuredClone(good); bad.components[0].sha256='not-a-hash';
assert.equal(validateBackupManifest(bad).ok,false);
console.log('backup-covers-the-undisposable: ok');
