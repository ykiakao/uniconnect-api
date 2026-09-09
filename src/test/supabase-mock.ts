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

let generatedId = 1;

const db: Record<string, Row[]> = {
  tenants: [
    {
      id: tenantId,
      name: 'EduKMais',
      slug: 'edukmais',
      plan: 'starter',
      status: 'active',
      active_users: 4,
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
      id: 'activity-existing',
      tenant_id: tenantId,
      class_id: 'class-teacher',
      title: 'Atividade Integrada',
      description: 'Entrega demo',
      due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
  grades: [
    {
      id: 'grade-existing',
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
  private updatePayload?: Row;
  private shouldDelete = false;
  private rangeStart?: number;
  private rangeEnd?: number;
  private orderColumn?: string;

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
    this.orderColumn = column;
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
    const row = result.data[0] as T | undefined;

    if (!row) {
      return {
        data: null,
        error: { message: 'No rows returned' },
      };
    }

    return {
      data: row,
      error: null,
    };
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
      const inserted = payload.map((row) => ({
        id: row.id ?? `generated-${generatedId++}`,
        created_at: row.created_at ?? new Date().toISOString(),
        updated_at: row.updated_at ?? new Date().toISOString(),
        ...row,
      }));
      db[this.table].push(...inserted);

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
    if (this.orderColumn) {
      rows.sort((left, right) =>
        String(left[this.orderColumn!] ?? '').localeCompare(
          String(right[this.orderColumn!] ?? ''),
        ),
      );
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

const auth = {
  async signInWithPassword(params: { email: string; password: string }) {
    const email = params.email.toLowerCase();
    const user = db.app_users.find(
      (candidate) =>
        candidate.email === email && authPasswords.get(email) === params.password,
    );

    if (!user) {
      return {
        data: { user: null, session: null },
        error: { message: 'Invalid credentials' },
      };
    }

    const token =
      [...tokens.entries()].find(([, authUserId]) => authUserId === user.auth_user_id)
        ?.[0] ?? `valid-${user.auth_user_id}-token`;
    tokens.set(token, user.auth_user_id);

    return {
      data: {
        user: { id: user.auth_user_id, email: user.email },
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
        error: { message: 'Invalid token' },
      };
    }

    return {
      data: { user: { id: authUserId } },
      error: null,
    };
  },
  admin: {
    async signOut(accessToken: string) {
      if (!tokens.has(accessToken)) {
        return { error: { message: 'Invalid token' } };
      }

      return { error: null };
    },
    async createUser(params: { email: string; password?: string }) {
      const email = params.email.toLowerCase();
      const existing = db.app_users.find((user) => user.email === email);
      if (existing) {
        return {
          data: { user: null },
          error: { message: 'User already registered' },
        };
      }

      const authUserId = `auth-${generatedId++}`;
      authPasswords.set(email, params.password ?? 'password123');

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
          users: db.app_users.map((user) => ({
            id: user.auth_user_id,
            email: user.email,
          })),
        },
        error: null,
      };
    },
  },
};

export function createSupabaseAnonClient() {
  return {
    auth,
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
