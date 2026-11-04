const { createHash } = require('node:crypto');
const digest = text => createHash('sha256').update(text).digest('hex');
const names = ['schema.sql', '20260528000001_academic_base.sql', '20260528000002_activities_grades_reports.sql',
  '20260528000003_invites.sql', '20261026000001_security_integrity.sql', '20261026000002_academic_structure.sql',
  '20261026000003_institutional_management.sql', '20261026000004_activity_workflow.sql',
  '20261026000005_academic_communication.sql', '20261031000006_platform_institutions.sql',
  '20261101000007_accounts_and_responsibility.sql'];
function fixture() {
  const files = names.map((name, index) => {
    const text = 'SYNTHETIC_NON_SQL_SOURCE_' + (index + 1);
    return { id: 'supabase/' + (index === 0 ? '' : 'migrations/') + name, ordinal: index + 1,
      text, rawHash: digest(text), normalizedHash: digest(text) };
  });
  const artifacts = ['scripts/lib/migration-executor.cjs', 'scripts/homologation-migrations.cjs',
    'scripts/homologation-preflight.cjs', 'scripts/lib/migration-manifest.cjs', 'package-lock.json', 'runtime-contract.json']
    .map(id => { const text = 'SYNTHETIC_ARTIFACT:' + id; return { id, text, rawHash: digest(text) }; });
  return { version: 'prototype-v0.1', environment: 'homologation', projectRef: 'pvacwfypqsstdrfxajkg',
    baselineRef: 'synthetic-baseline-v1', files, artifacts };
}
module.exports = { fixture, digest };
