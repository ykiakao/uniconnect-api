import { randomUUID } from 'node:crypto';
import { mockActivityRpc } from './activity-workflow-mock';
import { mockCommunicationRpc, notifyWorkflowEvent } from './communication-mock';
import { mockPlatformRpc } from './platform-institutions-mock';
type Row = Record<string, any>;

const tenantId = '11111111-1111-1111-1111-111111111111';
const invalidTenantId = '99999999-9999-9999-9999-999999999999';

const authUsers = {
  student: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  teacher: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  coordinator: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  admin: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
};

const tokens = new Map([
  ['valid-student-token', authUsers.student],
  ['valid-teacher-token', authUsers.teacher],
  ['valid-coordinator-token', authUsers.coordinator],
  ['valid-admin-token', authUsers.admin],
]);

const authPasswords = new Map([
  ['aluno@edukmais.edu.br', 'password123'],
  ['professor@edukmais.edu.br', 'password123'],
  ['coordenador@edukmais.edu.br', 'password123'],
  ['admin@edukmais.edu.br', 'password123'],
]);

const db: Record<string, Row[]> = {
  tenants: [
    {
      id: tenantId,
      name: 'EduKMais',
      slug: 'edukmais',
      plan: 'starter',
      status: 'active',
      active_users: 4,
      operational_status: 'active', operational_version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
  app_users: [
    {
      id: 'user-student',
      tenant_id: tenantId,
      auth_user_id: authUsers.student,
      name: 'Aluno EduKMais',
      email: 'aluno@edukmais.edu.br',
      role: 'student',
      course: 'Curso Existente',
      registration: null,
      semester: null,
    },
    {
      id: 'user-teacher',
      tenant_id: tenantId,
      auth_user_id: authUsers.teacher,
      name: 'Professor EduKMais',
      email: 'professor@edukmais.edu.br',
      role: 'teacher',
      course: null,
      registration: null,
      semester: null,
    },
    {
      id: 'user-coordinator',
      tenant_id: tenantId,
      auth_user_id: authUsers.coordinator,
      name: 'Coordenador EduKMais',
      email: 'coordenador@edukmais.edu.br',
      role: 'coordinator',
      course: null,
      registration: null,
      semester: null,
    },
    {
      id: 'user-admin',
      tenant_id: tenantId,
      auth_user_id: authUsers.admin,
      name: 'Admin EduKMais',
      email: 'admin@edukmais.edu.br',
      role: 'admin',
      course: null,
      registration: null,
      semester: null,
    },
  ],
  courses: [
    {
      id: 'course-existing',
      tenant_id: tenantId,
      name: 'Curso Existente',
      description: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
  classes: [
    {
      id: 'class-teacher',
      subject_id: 'subject-existing',
      academic_period_id: 'period-existing',
      academic_status: 'active',
      tenant_id: tenantId,
      course_id: 'course-existing',
      name: 'Turma Professor',
      teacher_id: authUsers.teacher,
      semester: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
  activities: [
    {
      id: 'activity-existing', type: 'assignment', state: 'published', workflow_enabled: false, revision: 1, allow_late: false, priority: 'medium',
      tenant_id: tenantId,
      class_id: 'class-teacher',
      title: 'Atividade Integrada',
      description: 'Entrega demo',
      due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
  academic_periods: [{ id: 'period-existing', tenant_id: tenantId, code: '2026.2', name: 'Periodo Sintetico', status: 'active' }],
  subjects: [{ id: 'subject-existing', tenant_id: tenantId, course_id: 'course-existing', code: 'SYN', name: 'Disciplina Sintetica', status: 'active' }],
  enrollments: [{ id: 'enrollment-existing', tenant_id: tenantId, class_id: 'class-teacher', student_id: 'user-student', status: 'active' }],
  teaching_assignments: [{ id: 'assignment-existing', tenant_id: tenantId, class_id: 'class-teacher', teacher_id: 'user-teacher', status: 'active', is_primary: true }],
  grades: [
    {
      id: 'grade-existing', publication_state: 'published', revision: 1, submission_id: null, submission_version: null, grade_unit: 'score_0_10',
      tenant_id: tenantId,
      activity_id: 'activity-existing',
      student_id: authUsers.student,
      grade: 8.5,
      feedback: 'Bom trabalho',
      graded_at: new Date().toISOString(),
      graded_by: authUsers.teacher,
    },
  ],
  invites: [
    {
      id: 'invite-existing',
      tenant_id: tenantId,
      code: 'EDU-VALID1',
      role: 'student',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      used_at: null,
      created_by: authUsers.coordinator,
      created_at: new Date().toISOString(),
    },
    {
      id: 'invite-expired',
      tenant_id: tenantId,
      code: 'EDU-OLD01',
      role: 'student',
      expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      used_at: null,
      created_by: authUsers.coordinator,
      created_at: new Date().toISOString(),
    },
    {
      id: 'invite-used',
      tenant_id: tenantId,
      code: 'EDU-USED1',
      role: 'student',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      used_at: new Date().toISOString(),
      created_by: authUsers.coordinator,
      created_at: new Date().toISOString(),
    },
  ],
};

function clone(row: Row) {
  return { ...row };
}

function applySelect(rows: Row[], columns?: string) {
  if (!columns || columns.includes('(')) {
    return rows.map(clone);
  }

  const selected = columns
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);

  return rows.map((row) =>
    selected.reduce<Row>((result, column) => {
      result[column] = row[column];
      return result;
    }, {}),
  );
}

class QueryBuilder {
  private selectColumns?: string;
  private countMode?: string;
  private filters: Array<(row: Row) => boolean> = [];
  private insertPayload?: Row | Row[];
  private conflictColumns?: string[];
  private updatePayload?: Row;
  private shouldDelete = false;
  private rangeStart?: number;
  private rangeEnd?: number;
  private orderColumns: string[] = [];

  constructor(private readonly table: string) {}

  select(columns?: string, options?: { count?: string }) {
    this.selectColumns = columns;
    this.countMode = options?.count;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  gt(column: string, value: string) {
    this.filters.push(
      (row) => new Date(row[column]).getTime() > new Date(value).getTime(),
    );
    return this;
  }

  ilike(column: string, pattern: string) {
    const term = pattern.replaceAll('%', '').toLowerCase();
    this.filters.push((row) =>
      String(row[column] ?? '')
        .toLowerCase()
        .includes(term),
    );
    return this;
  }

  order(column: string) {
    this.orderColumns.push(column);
    return this;
  }

  range(start: number, end: number) {
    this.rangeStart = start;
    this.rangeEnd = end;
    return this.resolve();
  }

  insert(payload: Row | Row[]) {
    this.insertPayload = payload;
    return this;
  }

  upsert(payload: Row, options: { onConflict: string }) {
    this.insertPayload = payload;
    this.conflictColumns = options.onConflict.split(',');
    return this;
  }

  update(payload: Row) {
    this.updatePayload = payload;
    return this;
  }

  delete() {
    this.shouldDelete = true;
    return this;
  }

  async single<T = Row>() {
    const result = await this.resolve();
    if (result.error) return { data: null, error: result.error };
    const row = result.data[0] as T | undefined;

    if (!row) {
      return {
        data: null,
        error: { code: 'PGRST116', message: 'No rows returned' },
      };
    }

    return {
      data: row,
      error: null,
    };
  }

  async maybeSingle<T = Row>() {
    const result = await this.resolve();
    if (result.error) return { data: null, error: result.error };
    if (result.data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'Multiple rows returned' } };
    return { data: (result.data[0] as T | undefined) ?? null, error: null };
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return this.resolve().then(onfulfilled, onrejected);
  }

  private async resolve() {
    if (!db[this.table]) db[this.table] = [];

    if (this.insertPayload) {
      const payload = Array.isArray(this.insertPayload)
        ? this.insertPayload
        : [this.insertPayload];
      if (this.table==='grades'&&payload.some(candidate=>db.activities.some(activity=>activity.id===candidate.activity_id&&activity.tenant_id===candidate.tenant_id&&activity.workflow_enabled))) {
        return {data:[],error:{code:'23514',message:'Synthetic workflow mutation requires RPC'},count:null};
      }
      if (this.table === 'app_users' && payload.some(candidate => db.app_users.some(row =>
        row.tenant_id === candidate.tenant_id && (row.auth_user_id === candidate.auth_user_id || row.email === candidate.email)))) {
        return { data: [], error: { code: '23505', message: 'Synthetic institutional uniqueness conflict' }, count: null };
      }
      const inserted = payload.map((row) => {
        const existing = this.conflictColumns && db[this.table].find((candidate) =>
          this.conflictColumns!.every((column) => candidate[column] === row[column]));
        if (existing) { Object.assign(existing, row); return existing; }
        const created = {
        ...(this.table === 'activities' ? { type: 'assignment', state: 'published', workflow_enabled: false, revision: 1, priority: 'medium', allow_late: false } : {}),
        ...(this.table === 'grades' ? { publication_state: 'published', revision: 1, feedback: null, graded_at: null, graded_by: null, submission_id: null, submission_version: null, grade_unit: 'score_0_10' } : {}),
        ...(this.table === 'tenants' ? { operational_status: 'active', operational_version: 1 } : {}),
        id: row.id ?? randomUUID(),
        created_at: row.created_at ?? new Date().toISOString(),
        updated_at: row.updated_at ?? new Date().toISOString(),
        ...row,
        };
        db[this.table].push(created);
        return created;
      });

      return {
        data: applySelect(inserted, this.selectColumns),
        error: null,
        count: this.countMode ? inserted.length : null,
      };
    }

    const matchingRows = db[this.table].filter((row) =>
      this.filters.every((filter) => filter(row)),
    );

    if (this.updatePayload) {
      matchingRows.forEach((row) => Object.assign(row, this.updatePayload));
      return {
        data: applySelect(matchingRows, this.selectColumns),
        error: null,
        count: this.countMode ? matchingRows.length : null,
      };
    }

    if (this.shouldDelete) {
      db[this.table] = db[this.table].filter((row) => !matchingRows.includes(row));
      return {
        data: [],
        error: null,
        count: this.countMode ? matchingRows.length : null,
      };
    }

    let rows = [...matchingRows];
    if (this.orderColumns.length) {
      rows.sort((left, right) => {
        for (const column of this.orderColumns) {
          const comparison = String(left[column] ?? '').localeCompare(String(right[column] ?? ''));
          if (comparison) return comparison;
        }
        return 0;
      });
    }

    const count = rows.length;
    if (this.rangeStart !== undefined && this.rangeEnd !== undefined) {
      rows = rows.slice(this.rangeStart, this.rangeEnd + 1);
    }

    return {
      data: applySelect(rows, this.selectColumns),
      error: null,
      count: this.countMode ? count : null,
    };
  }
}

const authAccounts = new Map(db.app_users.map(user => [user.email as string, { id: user.auth_user_id as string, email: user.email as string, email_confirmed_at: new Date().toISOString() as string | null }]));
const auth = {
  async signInWithPassword(params: { email: string; password: string }) {
    const email = params.email.toLowerCase();
    const user = authPasswords.get(email) === params.password ? authAccounts.get(email) : undefined;

    if (!user) {
      return {
        data: { user: null, session: null },
        error: { status: 400, code: 'invalid_credentials', message: 'Invalid credentials' },
      };
    }

    const token =
      [...tokens.entries()].find(([, authUserId]) => authUserId === user.id)
        ?.[0] ?? `valid-${user.id}-token`;
    tokens.set(token, user.id);

    return {
      data: {
        user: { id: user.id, email: user.email, email_confirmed_at: new Date().toISOString() },
        session: {
          access_token: token,
          refresh_token: `refresh-${token}`,
          expires_in: 3600,
        },
      },
      error: null,
    };
  },
  async getUser(accessToken: string) {
    const authUserId = tokens.get(accessToken);

    if (!authUserId) {
      return {
        data: { user: null },
        error: { status: 401, code: 'bad_jwt', message: 'Invalid token' },
      };
    }

    return {
      data: { user: { id: authUserId, email: [...authAccounts.values()].find(user => user.id === authUserId)?.email, email_confirmed_at: new Date().toISOString() } },
      error: null,
    };
  },
  admin: {
    async signOut(accessToken: string) {
      if (!tokens.has(accessToken)) {
        return { error: { status: 401, code: 'bad_jwt', message: 'Invalid token' } };
      }

      return { error: null };
    },
    async createUser(params: { email: string; password?: string; email_confirm?: boolean }) {
      const email = params.email.toLowerCase();
      const existing = authAccounts.get(email);
      if (existing) {
        return {
          data: { user: null },
          error: { status: 422, code: 'user_already_exists', message: 'User already registered' },
        };
      }

      const authUserId = randomUUID();
      authPasswords.set(email, params.password ?? 'password123');
      authAccounts.set(email, { id: authUserId, email, email_confirmed_at: params.email_confirm === false ? null : new Date().toISOString() });

      return {
        data: {
          user: {
            id: authUserId,
            email,
          },
        },
        error: null,
      };
    },
    async listUsers() {
      return {
        data: {
          users: [...authAccounts.values()],
        },
        error: null,
      };
    },
  },
};

export function createSupabaseAnonClient() {
  return {
    auth,
    async rpc(name: string, input: Record<string, unknown>) {
      const platform = mockPlatformRpc(name, input, db, authAccounts.values());
      if (platform) return platform;
      const communication = mockCommunicationRpc(name, input, db);
      if (communication) return communication;
      const workflow = mockActivityRpc(name, input, db);
      if (workflow) {
        if (!workflow.error) notifyWorkflowEvent(db, name, input, workflow.data);
        return workflow;
      }
      const args = input as { p_code: string; p_auth_user_id: string; p_email: string; p_name: string };
      const failure = (code: string) => ({ data: null, error: { code, message: 'Synthetic RPC rejection' }, status: 400 });
      if (name !== 'accept_institution_invite') return failure('PGRST202');
      const invite = db.invites.find(row => row.code === args.p_code && !row.used_at && new Date(row.expires_at).getTime() > Date.now());
      if (!invite) return failure('P0002');
      if (db.tenants.find(row => row.id === invite.tenant_id)?.operational_status !== 'active') return failure('PT403');
      const identity = authAccounts.get(args.p_email);
      const issuer = db.app_users.find(row => row.tenant_id === invite.tenant_id && row.auth_user_id === invite.created_by && row.active !== false);
      const ranks: Record<string, number> = { owner: 3, admin: 2, coordinator: 1, teacher: 0, student: 0 };
      if (!invite.recipient_email || invite.recipient_email !== args.p_email || identity?.id !== args.p_auth_user_id || !issuer || ranks[issuer.role] <= ranks[invite.role]) return failure('42501');
      if (db.app_users.some(row => row.tenant_id === invite.tenant_id && (row.auth_user_id === args.p_auth_user_id || row.email === args.p_email))) return failure('23505');
      const row = { id: randomUUID(), tenant_id: invite.tenant_id, auth_user_id: args.p_auth_user_id, name: args.p_name, email: args.p_email, role: invite.role, active: true, course_id: null };
      db.app_users.push(row); invite.used_at = new Date().toISOString(); invite.accepted_by = args.p_auth_user_id;
      return { data: row, error: null, status: 200 };
    },
    from(table: string) {
      return new QueryBuilder(table);
    },
  };
}

export function createSupabaseAdminClient() {
  return createSupabaseAnonClient();
}

export const supabaseMockData = {
  tenantId,
  invalidTenantId,
  authUsers,
};
