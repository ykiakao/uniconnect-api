import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('administrative TLS configuration wiring', () => {
  it.each(['setup-supabase.ts', 'seed-demo-university.ts'])('%s uses the reviewed TLS boundary', script => {
    // Do not import these administrative entrypoints: their main functions write data.
    const source = readFileSync(join(__dirname, '../../scripts', script), 'utf8');
    expect(source).not.toMatch(/rejectUnauthorized\s*:\s*false/);
    expect(source).toContain('new Client(buildAdminDatabaseConfig(');
    expect(source).toContain('SUPABASE_DB_SSL_MODE');
    expect(source).toContain('SUPABASE_DB_CA_FILE');
  });
  it('verifies the seed database connection before any Auth write', () => {
    const source = readFileSync(join(__dirname, '../../scripts/seed-demo-university.ts'), 'utf8');
    const main = source.slice(source.indexOf('async function main()'));
    expect(main.indexOf('await db.connect()')).toBeLessThan(main.indexOf('await ensureAuthUser(admin, user)'));
  });
});


describe('demo credentials are externally configured before administrative clients', () => {
  const cases = [
    ['setup-supabase.ts', ['DEMO_STUDENT_PASSWORD', 'DEMO_TEACHER_PASSWORD', 'DEMO_COORDINATOR_PASSWORD', 'DEMO_OWNER_PASSWORD']],
  ] as const;

  function configuration(script: string) {
    const source = readFileSync(join(__dirname, '../../scripts', script), 'utf8');
    // Evaluate only configuration declarations and validation; never import/run the entrypoint.
    const preflight = source.slice(source.indexOf('const requiredEnv ='), source.indexOf('const supabase ='));
    const users = source.match(/const demoUsers = \[[\s\S]*?\n\s*\];/);
    if (!users || !preflight.includes('for (const key of requiredEnv)')) throw new Error('Configuration boundary missing');
    const config = preflight.includes('const demoUsers =') ? preflight : preflight + '\n' + users[0];
    const ts = require('typescript') as typeof import('typescript');
    return ts.transpileModule(config + '\nglobalThis.result = demoUsers;', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }

  for (const [script, keys] of cases) {
    const external = Object.fromEntries([
      'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', ...keys,
    ].map(key => [key, ' external-' + key + ' ']));

    it.each(keys)('%s is required by ' + script + ' when absent, empty or whitespace-only', key => {
      const { runInNewContext } = require('node:vm') as typeof import('node:vm');
      for (const invalid of [undefined, '', '   ']) {
        const env = { ...external, [key]: invalid };
        expect(() => runInNewContext(configuration(script), { process: { env } })).toThrow(key);
      }
    });

    it(script + ' preserves supplied passwords and demo identities without defaults', () => {
      const { runInNewContext } = require('node:vm') as typeof import('node:vm');
      const context = { process: { env: external }, result: [] as Array<{ email: string; password: string }> };
      runInNewContext(configuration(script), context);
      expect(context.result).toHaveLength(4);
      for (const user of context.result) {
        const key = user.email === 'aluno@edukmais.edu.br' ? 'DEMO_STUDENT_PASSWORD'
          : user.email === 'professor@edukmais.edu.br' ? 'DEMO_TEACHER_PASSWORD'
          : user.email === 'coordenador@edukmais.edu.br' ? 'DEMO_COORDINATOR_PASSWORD'
          : 'DEMO_OWNER_PASSWORD';
        expect(user.password).toBe(external[key]);
      }
    });
  }
});
