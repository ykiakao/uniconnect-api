async function inspectLegacyGradeIdentities(db) {
  const { rows: [relations] } = await db.query(`select to_regclass('public.grades') is not null
    and to_regclass('public.app_users') is not null and to_regclass('auth.users') is not null
    and to_regclass('public.activities') is not null as complete`);
  if (!relations.complete) return { safe: false, target: 'unknown', total: 0, conversions: 0, invalid_members: 0, reasons: ['MISSING_IDENTITY_RELATION'] };
  const { rows: targets } = await db.query(`select n.nspname||'.'||c.relname as target, k.convalidated as validated,
    array(select a.attname::text from unnest(k.conkey) with ordinality x(num,ord)
      join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.num order by x.ord) as source_columns,
    array(select a.attname::text from unnest(k.confkey) with ordinality x(num,ord)
      join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.num order by x.ord) as referenced_columns
    from pg_constraint k join pg_class c on c.oid=k.confrelid
    join pg_namespace n on n.oid=c.relnamespace
    where k.conrelid='public.grades'::regclass and k.contype='f'
      and (select a.attnum from pg_attribute a where a.attrelid=k.conrelid and a.attname='student_id')=any(k.conkey)`);
  const fk = targets[0];
  const exact = targets.length === 1 && fk.validated && fk.source_columns.length === 1
    && fk.source_columns[0] === 'student_id' && fk.referenced_columns.length === 1 && fk.referenced_columns[0] === 'id'
    && ['auth.users', 'public.app_users'].includes(fk.target);
  const { rows: [total] } = await db.query('select count(*)::int as total from public.grades');
  if (!exact) return { safe: false, target: 'unknown', ...total, conversions: 0, invalid_members: 0, reasons: ['UNKNOWN_OR_UNVALIDATED_IDENTITY_FOREIGN_KEY'] };
  const { rows: columns } = await db.query(`select attname from pg_attribute
    where attrelid='public.grades'::regclass and attnum>0 and not attisdropped`);
  const names = columns.map(column => column.attname);
  if (!['id', 'tenant_id', 'student_id'].every(name => names.includes(name))) {
    return { safe: false, target: fk.target, ...total, conversions: 0, invalid_members: 0, reasons: ['INCOMPLETE_GRADE_IDENTITY_COLUMNS'] };
  }
  if (!names.includes('activity_id')) {
    return { safe: total.total === 0, target: fk.target, ...total, conversions: 0, invalid_members: 0,
      reasons: total.total === 0 ? [] : ['INCOMPLETE_GRADE_ACTIVITY_REFERENCE'] };
  }
  const { rows: [counts] } = await db.query(`select count(*)::int as total,
    count(*) filter(where m.id is not null and m.auth_user_id is distinct from g.student_id)::int as conversions,
    count(*) filter(where g.id is null or g.tenant_id is null or g.student_id is null or
      case when $1='public.app_users' then
        m.id is null or m.tenant_id is distinct from g.tenant_id or m.role is distinct from 'student' or a.id is null
      else (select count(*) from public.app_users s join auth.users au on au.id=s.auth_user_id
        where s.auth_user_id=g.student_id and s.tenant_id=g.tenant_id and s.role='student')<>1 end)::int as invalid_members,
    count(*) filter(where g.activity_id is null or not exists(select 1 from public.activities activity
      where activity.id=g.activity_id and activity.tenant_id=g.tenant_id))::int as invalid_activities,
    count(*) filter(where case when $1='auth.users' then
      m.id is not null and m.auth_user_id is distinct from g.student_id
      else m.auth_user_id is distinct from g.student_id and exists(select 1 from auth.users au where au.id=g.student_id) end)::int as collisions
    from public.grades g left join public.app_users m on m.id=g.student_id
    left join auth.users a on a.id=m.auth_user_id`, [fk.target]);
  const reasons = [];
  if (counts.collisions) reasons.push(fk.target === 'auth.users' ? 'AUTH_ID_WOULD_BE_REASSIGNED' : 'CONFLICTING_AUTH_AND_INSTITUTIONAL_IDENTITY');
  if (counts.invalid_members) reasons.push('IDENTITY_WITHOUT_VALID_TENANT_STUDENT');
  if (counts.invalid_activities) reasons.push('GRADE_ACTIVITY_REFERENCE_INVALID');
  return { safe: reasons.length === 0, target: fk.target, ...counts, reasons };
}
module.exports = { inspectLegacyGradeIdentities };
