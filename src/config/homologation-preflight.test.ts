import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const preflight = require('../../scripts/homologation-preflight.cjs');
const root = resolve(__dirname, '../..');
const project = 'pvacwfypqsstdrfxajkg';
const production = 'kpwofazhpiqrxjvxkozl';
const values = () => ({ UNICONNECT_ENVIRONMENT: 'homologation', SUPABASE_PROJECT_REF: project,
  SUPABASE_URL: `https://${project}.supabase.co`, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3334', API_VERSION: 'v1',
  APP_ORIGIN: 'http://localhost:5174', ACADEMIC_PROVIDER: 'disabled', PLATFORM_ADMIN_AUTH_USER_IDS: '',
  SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' });
const inspect = (data: Record<string, string>, options = {}) => preflight.inspectConfiguration(data, { template: true, profile: 'api', inherited: {}, ...options });
const jwt = (ref: string, role: string) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ ref, role })).toString('base64url')}.synthetic`;

describe('offline homologation isolation', () => {
  it('recognizes the prepared target without treating empty keys as connection readiness', () => {
    const result = inspect(values());
    expect(result.issues).toEqual([]);
    expect(result.missing).toEqual(['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
    expect(result.configurationComplete).toBe(false);
    expect(result.remoteAccessAuthorized).toBe(false);
  });
  it.each(['https://kpwofazhpiqrxjvxkozl.supabase.co', 'https://other.supabase.co', 'http://pvacwfypqsstdrfxajkg.supabase.co',
    'https://pvacwfypqsstdrfxajkg.supabase.co/auth/v1', 'https://user:PRIVATE@pvacwfypqsstdrfxajkg.supabase.co',
    'https://pvacwfypqsstdrfxajkg.supabase.co?token=PRIVATE'])('rejects an unsafe API target without echoing %s', url => {
    const result = inspect({ ...values(), SUPABASE_URL: url });
    expect(result.issues).toContain('INVALID_API_TARGET');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('rejects the main project in any selected setting and never copies it to diagnostics', () => {
    const result = inspect({ ...values(), SUPABASE_PROJECT_REF: production });
    expect(result.issues).toContain('MAIN_PROJECT_FORBIDDEN');
    expect(JSON.stringify(result)).not.toContain(production);
  });
  it('rejects inherited credentials even when the selected file targets homologation', () => {
    const result = inspect(values(), { inherited: { SUPABASE_SERVICE_ROLE_KEY: 'PRIVATE_INHERITED_SECRET' } });
    expect(result.issues).toContain('INHERITED_CONFIGURATION');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_INHERITED_SECRET');
  });
  it('checks declared project and roles in legacy keys without claiming signature validation', () => {
    const result = inspect({ ...values(), SUPABASE_ANON_KEY: jwt(project, 'anon'), SUPABASE_SERVICE_ROLE_KEY: jwt(project, 'service_role') });
    expect(result.issues).toEqual([]);
    expect(result.configurationComplete).toBe(true);
    expect(result.credentialOwnership).toBe('NOT_VERIFIED_OFFLINE');
    expect(inspect({ ...values(), SUPABASE_ANON_KEY: jwt(production, 'anon') }).issues).toContain('KEY_PROJECT_MISMATCH');
    expect(inspect({ ...values(), SUPABASE_ANON_KEY: jwt(project, 'service_role') }).issues).toContain('KEY_ROLE_MISMATCH');
  });
  it('does not put opaque keys or values into output', () => {
    const result = inspect({ ...values(), SUPABASE_ANON_KEY: 'sb_publishable_SYNTHETIC_PRIVATE', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_SYNTHETIC_PRIVATE' });
    expect(result.issues).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');
    expect(result.remoteAccessAuthorized).toBe(false);
  });
  it('keeps administrative DSNs out of the API profile', () => {
    expect(inspect({ ...values(), SUPABASE_DB_URL: 'postgresql://PRIVATE' }).issues).toContain('UNEXPECTED_CONFIGURATION');
  });
  it('requires explicit local binding and preparation flags', () => {
    expect(inspect({ ...values(), HOST: '0.0.0.0', PORT: '3333', ACADEMIC_PROVIDER: 'native' }).issues).toEqual(expect.arrayContaining(['INVALID_LOCAL_BINDING', 'PROVIDER_NOT_DISABLED']));
  });
  it('does not allow invalid optional redirects that the API would reject', () => {
    expect(inspect({ ...values(), AUTH_RECOVERY_REDIRECT_URL: '' }).issues).toContain('INVALID_REDIRECT');
    expect(inspect({ ...values(), AUTH_RECOVERY_REDIRECT_URL: 'http://other.invalid/reset' }).issues).toContain('INVALID_REDIRECT');
  });
  it('separates the migration profile and blocks transactional-pooler or mismatched DSNs', () => {
    const base = { UNICONNECT_ENVIRONMENT: 'homologation', SUPABASE_PROJECT_REF: project, SUPABASE_DB_SSL_MODE: 'verify-full', SUPABASE_DB_URL: '' };
    expect(inspect(base, { profile: 'migrations' }).issues).toEqual([]);
    const direct = `postgresql://synthetic:PRIVATE@db.${project}.supabase.co:5432/postgres`;
    expect(inspect({ ...base, SUPABASE_DB_URL: direct }, { profile: 'migrations' }).issues).toEqual([]);
    const pooler = `postgresql://synthetic.${project}:PRIVATE@aws-0-example.pooler.supabase.com:5432/postgres`;
    expect(inspect({ ...base, SUPABASE_DB_URL: pooler }, { profile: 'migrations' }).issues).toEqual([]);
    expect(inspect({ ...base, SUPABASE_DB_URL: pooler.replace(':5432/', ':6543/') }, { profile: 'migrations' }).issues).toContain('INVALID_DATABASE_TARGET');
    expect(inspect({ ...base, SUPABASE_DB_URL: direct.replace(project, production) }, { profile: 'migrations' }).issues).toContain('INVALID_DATABASE_TARGET');
    expect(inspect({ ...base, SUPABASE_DB_URL: direct + '?sslmode=disable' }, { profile: 'migrations' }).issues).toContain('INVALID_DATABASE_TARGET');
    expect(JSON.stringify(inspect({ ...base, SUPABASE_DB_URL: direct }, { profile: 'migrations' }))).not.toContain('PRIVATE');
  });
  it('has no arbitrary file, apply or start mode and pins the SQL ordering separately from manifest order', () => {
    expect(() => preflight.parseArgs(['--file', '.env'])).toThrow();
    expect(() => preflight.parseArgs(['--apply'])).toThrow();
    expect(() => preflight.parseArgs(['--start'])).toThrow();
    expect(preflight.verifyMigrations(root)).toMatchObject({ verified: true, count: 11 });
    expect(preflight.verifyMigrations(root).order[0]).toBe('schema.sql');
    expect(preflight.verifyMigrations(root).order.at(-1)).toBe('20261101000007_accounts_and_responsibility.sql');
  });
  it('imports and validates without opening network connections or loading real dotenv', () => {
    const original = globalThis.fetch;
    const blocked = jest.fn(() => { throw new Error('Network forbidden'); });
    globalThis.fetch = blocked;
    try { inspect(values()); preflight.verifyMigrations(root); expect(blocked).not.toHaveBeenCalled(); }
    finally { globalThis.fetch = original; }
  });
  it('reports missing isolated config without reading the default .env or leaking process credentials', () => {
    const result = spawnSync(process.execPath, ['scripts/homologation-preflight.cjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: 'PRIVATE_PROCESS_SECRET' } });
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_PROCESS_SECRET');
    expect(JSON.parse(result.stdout)).toMatchObject({ remoteAccessAuthorized: false });
  });
});
