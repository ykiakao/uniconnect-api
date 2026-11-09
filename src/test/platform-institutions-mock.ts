import { createHash, randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
type Identity = { id: string; email: string; email_confirmed_at?: string | null };
type Result = { data: unknown; error: { code: string; message: string } | null; status: number };
const ranks: Record<string, number> = { owner: 3, admin: 2, coordinator: 1, teacher: 0, student: 0 };
function canonical(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  return JSON.stringify(value);
}
function institution(row: Row) {
  return { id: row.id, name: row.name, slug: row.slug, operationalStatus: row.operational_status, version: row.operational_version, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function mockPlatformRpc(name: string, args: Record<string, unknown>, db: Record<string, Row[]>, accounts: Iterable<Identity>): Result | undefined {
  if (!['platform_manage_institution', 'manage_institutional_membership'].includes(name)) return undefined;
  for (const key of ['platform_operations', 'platform_audit_events']) db[key] ??= [];
  const snapshot = Object.fromEntries(['tenants', 'app_users', 'platform_operations', 'platform_audit_events'].map(key => [key, structuredClone(db[key])]));
  const reject = (code: string, message = 'Synthetic platform rejection'): never => { throw { code, message }; };
  const identities = [...accounts];
  const input = args.p_payload as Row;
  const operation = String(args.p_operation), actor = String(args.p_actor_auth_id);
  const audit = (tenant: unknown, action: string, target: unknown = null, from: unknown = null, to: unknown = null) => {
    db.platform_audit_events.push({ id: randomUUID(), tenant_id: tenant, actor_auth_id: actor, action, request_id: args.p_request_id, target_user_id: target, from_status: from, to_status: to, occurred_at: new Date().toISOString() });
  };
  try {
    if (!identities.some(u => u.id === actor)) reject('42501');
    if (name === 'manage_institutional_membership') {
      const tenant = db.tenants.find(t => t.id === args.p_tenant_id);
      if (tenant?.operational_status !== 'active') reject('PT403', 'TENANT_SUSPENDED');
      const manager = db.app_users.find(u => u.tenant_id === args.p_tenant_id && u.auth_user_id === actor && u.active !== false);
      if (!manager || !['owner', 'admin', 'coordinator'].includes(String(manager.role)) || ranks[String(manager.role)] <= ranks[String(input.role)]) reject('42501');
      let member: Row;
      if (operation === 'create') {
        if (db.app_users.some(u => u.tenant_id === args.p_tenant_id && (u.auth_user_id === input.auth_user_id || u.email === input.email))) reject('23505');
        member = { id: randomUUID(), tenant_id: args.p_tenant_id, ...input, active: true };
        db.app_users.push(member);
      } else {
        const found = db.app_users.find(u => u.tenant_id === args.p_tenant_id && u.id === input.id);
        if (!found) reject('P0002');
        member = found!;
        if (member.auth_user_id === actor || ranks[String(member.role)] >= ranks[String(manager!.role)]) reject('42501');
        if (member.role !== input.expected_role) reject('PT409', 'MEMBERSHIP_ROLE_CONFLICT');
        const incompatible = member.role === 'teacher' && db.classes.some(c => c.teacher_id === member.auth_user_id && c.tenant_id === member.tenant_id) || member.role === 'student' && db.grades.some(g => g.student_id === member.auth_user_id && g.tenant_id === member.tenant_id);
        if (incompatible && member.role !== input.role) reject('23514');
        member.role = input.role;
      }
      if (['owner', 'admin', 'coordinator'].includes(String(member.role))) audit(args.p_tenant_id, 'institutional_administrative_grant', member.id);
      return { data: structuredClone(member), error: null, status: 200 };
    }
    const hash = createHash('sha256').update(canonical(input)).digest('hex');
    const replay = db.platform_operations.find(o => o.actor_auth_id === actor && o.idempotency_key === args.p_idempotency_key);
    if (replay) {
      if (replay.operation !== operation || replay.payload_hash !== hash) reject('PT409', 'IDEMPOTENCY_CONFLICT');
      return { data: structuredClone(replay.result), error: null, status: 200 };
    }
    let tenant = db.tenants.find(t => t.id === input.id);
    let result: unknown;
    if (operation === 'create') {
      if (db.tenants.some(t => t.slug === input.slug)) reject('23505');
      tenant = { id: randomUUID(), name: input.name, slug: input.slug, operational_status: 'active', operational_version: 1, plan: 'starter', status: 'trialing', active_users: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      db.tenants.push(tenant); audit(tenant.id, 'institution_created', null, null, 'active');
      result = institution(tenant);
    } else {
      if (!tenant) reject('PT404', 'INSTITUTION_NOT_FOUND');
      const row = tenant!;
      if (operation === 'bootstrap') {
        if (row.operational_status !== 'active') reject('PT403', 'TENANT_SUSPENDED');
        if (db.platform_audit_events.some(e => e.tenant_id === row.id && e.action === 'administrator_bootstrapped')) reject('PT409', 'BOOTSTRAP_ALREADY_COMPLETED');
        if (db.app_users.some(u => u.tenant_id === row.id && ['owner', 'admin', 'coordinator'].includes(String(u.role)))) reject('PT409', 'BOOTSTRAP_MANAGER_EXISTS');
        const found = identities.filter(u => u.email.toLowerCase() === input.email);
        if (!found.length) reject('PT409', 'BOOTSTRAP_AUTH_REQUIRED');
        if (found.length !== 1) reject('PT409', 'BOOTSTRAP_AUTH_AMBIGUOUS');
        if (found[0].email_confirmed_at === null) reject('PT409', 'BOOTSTRAP_AUTH_UNCONFIRMED');
        if (db.app_users.some(u => u.tenant_id === row.id && (u.auth_user_id === found[0].id || u.email === input.email))) reject('PT409', 'BOOTSTRAP_MEMBERSHIP_EXISTS');
        const member = { id: randomUUID(), tenant_id: row.id, auth_user_id: found[0].id, role: 'admin', active: true, name: input.name, email: input.email };
        db.app_users.push(member); audit(row.id, 'administrator_bootstrapped', member.id);
        result = { institutionId: row.id, administrator: { id: member.id, role: 'admin', active: true } };
      } else {
        if (row.operational_version !== input.expectedVersion) reject('PT409', 'VERSION_CONFLICT');
        const previous = row.operational_status;
        row.operational_version = Number(row.operational_version) + 1; row.updated_at = new Date().toISOString();
        if (operation === 'update') row.name = input.name;
        else row.operational_status = operation === 'suspend' ? 'suspended' : 'active';
        audit(row.id, operation === 'update' ? 'institution_updated' : operation === 'suspend' ? 'institution_suspended' : 'institution_reactivated', null, previous, row.operational_status);
        result = institution(row);
      }
    }
    db.platform_operations.push({ actor_auth_id: actor, idempotency_key: args.p_idempotency_key, operation, payload_hash: hash, result: structuredClone(result) });
    return { data: result, error: null, status: 200 };
  } catch (error) {
    for (const key of Object.keys(snapshot)) db[key] = snapshot[key];
    const e = error as { code: string; message: string };
    return { data: null, error: e, status: e.code === 'PT403' || e.code === '42501' ? 403 : e.code === 'PT404' ? 404 : 409 };
  }
}
