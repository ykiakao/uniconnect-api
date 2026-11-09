import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

type PasswordPair = { variable: string; primary: string; fallback: string };
type Spec = { file: string; pairs: PasswordPair[]; flow: string[] };
type Call = { path: string; method: string; body: Record<string, string>; headers: Record<string, string> };
type Reply = { status: number; body?: unknown };

const inviteCode = 'EDU-' + 'A1'.repeat(24);
const expiresAt = '2033-05-18T03:33:20.000Z';
const accessToken = 'SYNTHETIC_ACCESS_MARKER';
const refreshToken = 'SYNTHETIC_REFRESH_MARKER';
const rotatedAccess = 'SYNTHETIC_ROTATED_ACCESS_MARKER';
const rotatedRefresh = 'SYNTHETIC_ROTATED_REFRESH_MARKER';

const specs: Spec[] = [
  {
    file: 'auth-smoke.ts',
    pairs: [{ variable: 'password', primary: 'AUTH_SMOKE_PASSWORD', fallback: 'DEMO_STUDENT_PASSWORD' }],
    flow: ['GET /auth/me', 'GET /auth/me', 'POST /auth/login', 'POST /auth/login', 'POST /auth/login', 'POST /auth/refresh', 'GET /auth/me', 'POST /auth/logout', 'POST /auth/refresh'],
  },
  {
    file: 'academic-smoke.ts',
    pairs: [
      { variable: 'coordinatorPassword', primary: 'ACADEMIC_SMOKE_COORDINATOR_PASSWORD', fallback: 'DEMO_COORDINATOR_PASSWORD' },
      { variable: 'studentPassword', primary: 'ACADEMIC_SMOKE_STUDENT_PASSWORD', fallback: 'DEMO_STUDENT_PASSWORD' },
    ],
    flow: ['POST /auth/login', 'POST /auth/login', 'GET /tenants/edukmais/users', 'GET /tenants/edukmais/courses', 'POST /tenants/edukmais/courses', 'POST /tenants/edukmais/courses', 'POST /tenants/edukmais/courses/course-fixture/classes'],
  },
  {
    file: 'invite-smoke.ts',
    pairs: [{ variable: 'password', primary: 'INVITE_SMOKE_PASSWORD', fallback: 'DEMO_COORDINATOR_PASSWORD' }],
    flow: ['POST /auth/login', 'POST /tenants/edukmais/invites', 'GET /invites/' + inviteCode],
  },
  {
    file: 'seed-demo-smoke.ts',
    pairs: [{ variable: 'demoPassword', primary: 'SEED_DEMO_PASSWORD', fallback: 'DEMO_UNIVERSITY_PASSWORD' }],
    flow: ['POST /auth/login', 'POST /auth/login', 'POST /auth/login', 'POST /auth/admin/login', 'GET /tenants/edukmais/courses', 'GET /tenants/edukmais/reports/summary', 'GET /tenants/edukmais/courses/course-fixture/classes', 'GET /tenants/edukmais/classes/class-fixture/activities', 'GET /tenants/edukmais/activities/activity-fixture/grades'],
  },
];

function sourceOf(spec: Spec) {
  return readFileSync(join(__dirname, '../../scripts', spec.file), 'utf8');
}

function environment(spec: Spec): Record<string, string | undefined> {
  const env = Object.fromEntries(spec.pairs.flatMap(pair => [
    [pair.primary, ' PRIMARY_MARKER_' + pair.primary + ' '],
    [pair.fallback, ' FALLBACK_MARKER_' + pair.fallback + ' '],
  ]));
  if (spec.file === 'invite-smoke.ts') env.INVITE_SMOKE_RECIPIENT_EMAIL = '  RECIPIENT@EXAMPLE.INVALID  ';
  return env;
}

function successfulReply(spec: Spec, index: number, call: Call): Reply {
  const login = (role = 'aluno') => ({
    accessToken, refreshToken, expiresAt,
    user: { id: 'member-fixture', email: call.body.email?.toLowerCase(), tenantSlug: 'edukmais', role },
    tenant: { slug: 'edukmais' },
  });
  if (spec.file === 'auth-smoke.ts') {
    const user = { ...login().user, email: 'aluno@edukmais.edu.br' };
    const replies: Reply[] = [
      { status: 401 }, { status: 401 }, { status: 401, body: { error: { code: 'INVALID_CREDENTIALS' } } },
      { status: 400, body: { error: { code: 'TENANT_REQUIRED' } } }, { status: 200, body: login() },
      { status: 200, body: { ...login(), user, accessToken: rotatedAccess, refreshToken: rotatedRefresh } },
      { status: 200, body: { ...user, tenant: { slug: 'edukmais' } } },
      { status: 204 }, { status: 401, body: { error: { code: 'INVALID_SESSION' } } },
    ];
    return replies[index];
  }
  if (spec.file === 'academic-smoke.ts') {
    if (index < 2) return { status: 200, body: login() };
    if (index < 4) return { status: 200, body: { data: [], meta: {} } };
    if (index === 4) return { status: 403, body: { error: { code: 'FORBIDDEN' } } };
    return { status: 201, body: { id: 'course-fixture', name: call.body.name } };
  }
  if (spec.file === 'invite-smoke.ts') {
    return [
      { status: 200, body: login('gestor') },
      { status: 201, body: { code: inviteCode, role: 'aluno', expiresAt } },
      { status: 200, body: { tenantSlug: 'edukmais', role: 'aluno' } },
    ][index];
  }
  if (index < 4) return { status: 200, body: login(['aluno', 'professor', 'admin', 'admin'][index]) };
  return [
    { status: 200, body: { data: [
      { id: 'course-fixture', name: 'Engenharia de Software' },
      { name: 'Ciencia da Computacao' }, { name: 'Sistemas de Informacao' },
    ], meta: { total: 3 } } },
    { status: 200, body: { totalUsers: 11, totalCourses: 3, totalClasses: 4, activeStudents: 5 } },
    { status: 200, body: { data: [{ id: 'class-fixture', name: 'Engenharia de Software II' }] } },
    { status: 200, body: { data: [{ id: 'activity-fixture', title: 'Documento de requisitos' }] } },
    { status: 200, body: { data: [{}, {}] } },
  ][index - 4];
}

async function simulate(spec: Spec, env = environment(spec), options: {
  reply?: (index: number, call: Call) => Reply;
  assertionFailure?: boolean;
} = {}) {
  const calls: Call[] = [];
  const logs: unknown[][] = [];
  const text = jest.fn();
  const close = jest.fn();
  const listen = jest.fn(() => ({ address: () => ({ port: 33333 }), close }));
  const context = {
    exports: {}, process: { env, exitCode: 0 }, console: { error: (...args: unknown[]) => logs.push(args) },
    completion: undefined as Promise<void> | undefined,
    require(name: string) {
      if (name === '../src/app') return { app: { listen } };
      if (name === 'node:crypto') return { randomUUID: () => '11111111-1111-4111-8111-111111111111' };
      if (name === 'zod') return { z };
      if (name === 'node:assert/strict') return options.assertionFailure ? new Proxy(assert, {
        get(target, key) {
          if (key === 'ok') return () => { throw new assert.AssertionError({ actual: 'PRIVATE_ASSERTION_MARKER', expected: true }); };
          return Reflect.get(target, key);
        },
      }) : assert;
      throw new Error('Unexpected import in isolated smoke simulation');
    },
    async fetch(input: string, init?: RequestInit) {
      const url = new URL(input);
      const call = {
        path: (url.pathname + url.search).replace('/api/v1', ''),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : {},
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(call);
      const reply = options.reply ? options.reply(calls.length - 1, call) : successfulReply(spec, calls.length - 1, call);
      return { status: reply.status, async text() { text(); return JSON.stringify(reply.body ?? {}); } };
    },
  };
  // The real app, dotenv, transports and credentials are never loaded. Only VM fakes run.
  const source = sourceOf(spec).replace('main().catch(', 'globalThis.completion = main().catch(');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  runInNewContext(compiled, context, { timeout: 1000 });
  if (!context.completion) throw new Error('Smoke completion boundary missing');
  await context.completion;
  return { calls, logs, text, close, listen, exitCode: context.process.exitCode };
}

function safeLogs(logs: unknown[][]) {
  return logs.flat().map(value => inspect(value, { depth: null })).join('\n');
}

describe.each(specs)('$file configuration and diagnostics without HTTP', spec => {
  it('has no literal password fallback and uses fixed diagnostic labels', () => {
    const source = ts.createSourceFile(spec.file, sourceOf(spec), ts.ScriptTarget.Latest, true);
    const passwordLiterals: ts.StringLiteral[] = [];
    const dynamicLabels: ts.Node[] = [];
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && spec.pairs.some(pair => pair.variable === node.name.getText(source)) && node.initializer) {
        function literals(child: ts.Node) { if (ts.isStringLiteral(child)) passwordLiterals.push(child); ts.forEachChild(child, literals); }
        literals(node.initializer);
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'assertStatus' && !ts.isStringLiteral(node.arguments[2])) dynamicLabels.push(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(passwordLiterals.length).toBe(0);
    expect(dynamicLabels.length).toBe(0);
  });

  for (const pair of spec.pairs) {
    it(pair.primary + ' requires a configured value before listen or fetch', async () => {
      const result = await simulate(spec, { ...environment(spec), [pair.primary]: undefined, [pair.fallback]: undefined });
      expect(result.exitCode).toBe(1);
      expect(result.listen).not.toHaveBeenCalled();
      expect(result.calls).toHaveLength(0);
      expect(safeLogs(result.logs)).toContain(pair.primary);
      expect(safeLogs(result.logs)).toContain(pair.fallback);
    });

    it.each(['', '   ', '\t\r\n'])(pair.primary + ' rejects blank configuration, including a blank primary with a valid alternative (%j)', async blank => {
      for (const override of [{ [pair.primary]: blank }, { [pair.primary]: undefined, [pair.fallback]: blank }]) {
        const result = await simulate(spec, { ...environment(spec), ...override });
        expect(result.exitCode).toBe(1);
        expect(result.listen).not.toHaveBeenCalled();
        expect(result.calls).toHaveLength(0);
      }
    });

    it.each([true, false])(pair.primary + ' preserves precedence and supplied spaces (primary present: %s)', async primaryPresent => {
      const env = environment(spec);
      if (!primaryPresent) delete env[pair.primary];
      const result = await simulate(spec, env);
      expect(result.exitCode).toBe(0);
      const logins = result.calls.filter(call => call.path === '/auth/login' || call.path === '/auth/admin/login');
      const selected = spec.file === 'academic-smoke.ts' ? [logins[pair.variable === 'coordinatorPassword' ? 0 : 1]]
        : spec.file === 'auth-smoke.ts' ? logins.slice(1) : logins;
      expect(selected.length).toBeGreaterThan(0);
      expect(selected.every(call => call.body.password === env[primaryPresent ? pair.primary : pair.fallback])).toBe(true);
    });
  }

  it('completes the expected request sequence and closes the server', async () => {
    const result = await simulate(spec);
    expect(result.exitCode).toBe(0);
    expect(result.calls.map(call => call.method + ' ' + call.path)).toEqual(spec.flow);
    expect(result.close).toHaveBeenCalledTimes(1);
    expect(result.logs).toHaveLength(0);
  });

  it('reports only numeric HTTP status diagnostics without reading an unexpected response', async () => {
    const result = await simulate(spec, environment(spec), { reply: () => ({ status: 599, body: { accessToken: 'PRIVATE_BODY_MARKER', refreshToken: 'PRIVATE_BODY_MARKER', password: 'PRIVATE_BODY_MARKER', cookie: 'PRIVATE_BODY_MARKER', authorization: 'PRIVATE_BODY_MARKER' } }) });
    expect(result.exitCode).toBe(1);
    expect(result.text).not.toHaveBeenCalled();
    const output = safeLogs(result.logs);
    expect(output).toContain('599');
    expect(output.includes('PRIVATE_BODY_MARKER')).toBe(false);
    expect(output.includes('@')).toBe(false);
    expect(result.close).toHaveBeenCalledTimes(1);
  });

  it('does not expose transport error messages or objects, including forged error names', async () => {
    const result = await simulate(spec, environment(spec), { reply: () => { throw Object.assign(new Error('PRIVATE_TRANSPORT_MARKER'), { name: 'SmokeError', headers: { authorization: 'PRIVATE_TRANSPORT_MARKER' }, cookie: 'PRIVATE_TRANSPORT_MARKER' }); } });
    expect(result.exitCode).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(safeLogs(result.logs).includes('PRIVATE_TRANSPORT_MARKER')).toBe(false);
    expect(result.close).toHaveBeenCalledTimes(1);
  });

  it('does not expose assertion actual/expected values or error stacks', async () => {
    const result = await simulate(spec, environment(spec), { assertionFailure: true });
    expect(result.exitCode).toBe(1);
    const output = safeLogs(result.logs);
    expect(output.includes('PRIVATE_ASSERTION_MARKER')).toBe(false);
    expect(output.includes('AssertionError')).toBe(false);
    expect(result.close).toHaveBeenCalledTimes(1);
  });
});

const authSpec = specs.find(spec => spec.file === 'auth-smoke.ts')!;
const inviteSpec = specs.find(spec => spec.file === 'invite-smoke.ts')!;

describe('auth smoke refresh and logout', () => {
  it('uses JSON-only refresh proof and switches to the rotated session before logout', async () => {
    const result = await simulate(authSpec);
    expect(result.exitCode).toBe(0);
    const [refresh, afterLogout] = result.calls.filter(call => call.path === '/auth/refresh');
    for (const call of [refresh, afterLogout]) {
      expect(call.method).toBe('POST');
      expect(call.headers).toEqual({ 'content-type': 'application/json', 'x-tenant-slug': 'edukmais' });
    }
    expect(refresh.body).toEqual({ refreshToken });
    expect(afterLogout.body).toEqual({ refreshToken: rotatedRefresh });
    for (const path of ['/auth/me', '/auth/logout']) {
      expect(result.calls.filter(call => call.path === path).at(-1)?.headers).toMatchObject({
        authorization: 'Bearer ' + rotatedAccess, 'x-tenant-slug': 'edukmais',
      });
    }
    expect(result.calls.filter(call => call.path === '/auth/login')[0].body.password).toBe('11111111-1111-4111-8111-111111111111');
  });

  it.each([
    { refreshToken },
    { refreshToken: '' },
    { accessToken: '' },
    { tenant: { slug: 'different-tenant' } },
    { user: { id: 'different-member', email: 'aluno@edukmais.edu.br', tenantSlug: 'edukmais', role: 'aluno' } },
  ])('stops before using an invalid refresh response (%j)', async patch => {
    const result = await simulate(authSpec, environment(authSpec), { reply: (index, call) => {
      const reply = successfulReply(authSpec, index, call);
      return index === 5 ? { ...reply, body: { ...(reply.body as object), ...patch } } : reply;
    } });
    expect(result.exitCode).toBe(1);
    expect(result.calls.at(-1)?.path).toBe('/auth/refresh');
    expect(result.calls.some(call => call.path === '/auth/logout')).toBe(false);
    expect(safeLogs(result.logs)).not.toMatch(/SYNTHETIC_|different-tenant|different-member/);
  });

  it('fails safely if the refresh token still works after logout', async () => {
    const result = await simulate(authSpec, environment(authSpec), { reply: (index, call) =>
      index === 8 ? { status: 200, body: { refreshToken: rotatedRefresh } } : successfulReply(authSpec, index, call) });
    expect(result.exitCode).toBe(1);
    expect(safeLogs(result.logs)).not.toContain(rotatedRefresh);
    expect(result.calls).toHaveLength(9);
  });
});

describe('invite smoke recipient and code contract', () => {
  it.each([undefined, '', '   ', 'invalid-email', 'recipient@external.example', 'a@b..invalid', 'a@-b.invalid'])(
    'requires a synthetic recipient before starting the smoke (%j)', async recipient => {
      const result = await simulate(inviteSpec, { ...environment(inviteSpec), INVITE_SMOKE_RECIPIENT_EMAIL: recipient });
      expect(result.exitCode).toBe(1);
      expect(result.listen).not.toHaveBeenCalled();
      expect(result.calls).toHaveLength(0);
      expect(safeLogs(result.logs)).toContain('INVITE_SMOKE_RECIPIENT_EMAIL');
    },
  );

  it('creates a student invite with the configured recipient and resolves it without consuming it', async () => {
    const code = 'ABU-' + '0F'.repeat(24);
    const result = await simulate(inviteSpec, { ...environment(inviteSpec), INVITE_SMOKE_TENANT_SLUG: 'a-b' }, {
      reply: (index, call) => index === 1 ? { status: 201, body: { code, role: 'aluno', expiresAt } }
        : index === 2 ? { status: 200, body: { tenantSlug: 'a-b', role: 'aluno' } }
          : successfulReply(inviteSpec, index, call),
    });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toHaveLength(3);
    expect(result.calls[1]).toMatchObject({
      method: 'POST', path: '/tenants/a-b/invites',
      headers: { 'x-tenant-slug': 'a-b', authorization: 'Bearer ' + accessToken },
      body: { role: 'aluno', expiresIn: 7, recipientEmail: 'recipient@example.invalid' },
    });
    expect(result.calls[2]).toMatchObject({ path: '/invites/' + code, method: 'GET' });
  });

  it.each(['EDU-A1B2C3D4', 'EDU-' + 'G'.repeat(48), 'BAD-' + 'A'.repeat(48), inviteCode + '\n'])(
    'rejects a malformed code without fetching or logging it (%#)', async code => {
      const result = await simulate(inviteSpec, environment(inviteSpec), { reply: (index, call) =>
        index === 1 ? { status: 201, body: { code, role: 'aluno', expiresAt } } : successfulReply(inviteSpec, index, call) });
      expect(result.exitCode).toBe(1);
      expect(result.calls).toHaveLength(2);
      expect(safeLogs(result.logs)).not.toContain(code.trim());
    },
  );
});
