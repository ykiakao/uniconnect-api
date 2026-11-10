const { createHash } = require('node:crypto');
const { inspectLegacyGradeIdentities } = require('./legacy-preflight.cjs');
const manifest = require('./migration-manifest.cjs');

const dangerousName = '20260528000002_activities_grades_reports.sql';
function blocked(reasons) {
  return Object.assign(new Error('Legacy grade identity migration blocked; provenance review required.'), {
    code: 'LEGACY_GRADE_IDENTITY_BLOCKED', reasons,
  });
}

async function applyGuardedMigration(db, { name, sql }) {
  const digest = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
  const basename = name.replace(/\\/g, '/').split('/').pop();
  const recognized = Object.keys(manifest).find(key => manifest[key] === digest);
  if (!recognized || (Object.hasOwn(manifest, basename) && manifest[basename] !== digest)) {
    throw blocked(['UNRECOGNIZED_MIGRATION_CONTENT']);
  }
  if (recognized !== dangerousName) return db.query(sql);
  let nested = false;
  const notice = value => { if (value.code === '25001') nested = true; };
  db.on('notice', notice);
  try { await db.query('begin'); }
  finally { db.removeListener('notice', notice); }
  if (nested) throw blocked(['EXISTING_TRANSACTION_NOT_SUPPORTED']);
  try {
    await db.query("set local lock_timeout='5s'; set local statement_timeout='60s'");
    await db.query('lock table public.grades, public.app_users, auth.users, public.activities in access exclusive mode');
    const diagnosis = await inspectLegacyGradeIdentities(db);
    if (!diagnosis.safe) throw blocked(diagnosis.reasons);
    await db.query(`create temporary table stage_10_1_expected_grades on commit drop as
      select g.id, g.tenant_id,
        (to_jsonb(g) || jsonb_build_object('student_id',case when $1='public.app_users' then m.auth_user_id else g.student_id end))
        || case when to_jsonb(g) ? 'value' and (to_jsonb(g)->'grade' is null or to_jsonb(g)->'grade'='null'::jsonb)
          then jsonb_build_object('grade',to_jsonb(g)->'value') else '{}'::jsonb end as cells
      from public.grades g left join public.app_users m on m.id=g.student_id`, [diagnosis.target]);
    await db.query('create unique index on pg_temp.stage_10_1_expected_grades(id)');
    await db.query(sql);
    const { rows: [result] } = await db.query(`select
      (select count(*) from public.grades)=(select count(*) from pg_temp.stage_10_1_expected_grades)
      and not exists(select 1 from pg_temp.stage_10_1_expected_grades e
        left join public.grades g on g.id=e.id and g.tenant_id=e.tenant_id
        where g.id is null or not (to_jsonb(g) @> e.cells)) as preserved`);
    if (!result.preserved) throw blocked(['GRADE_IDENTITY_POSTCHECK_FAILED']);
    const after = await inspectLegacyGradeIdentities(db);
    if (!after.safe || after.target !== 'auth.users') throw blocked(['GRADE_IDENTITY_POSTCHECK_FAILED']);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    if (error.code === 'LEGACY_GRADE_IDENTITY_BLOCKED') throw error;
    throw blocked(['GRADE_IDENTITY_EXECUTION_FAILED']);
  }
}
module.exports = { applyGuardedMigration };
