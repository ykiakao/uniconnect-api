import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyGuardedMigration } from '../../scripts/lib/migration-executor.cjs';

const manifest = require('../../scripts/lib/migration-manifest.cjs') as Readonly<Record<string, string>>;

describe('mandatory migration boundary wiring (not database integrity proof)', () => {
  it.each(Object.entries(manifest))('pins reviewed SQL content for %s', (name, expected) => {
    const path = name === 'schema.sql' ? name : `migrations/${name}`;
    const source = readFileSync(join(__dirname, '../../supabase', path), 'utf8');
    expect(createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex')).toBe(expected);
  });
  it.each([
    'update only public.grades set student_id=student_id',
    'update public.grades set (student_id)=row(student_id)',
    'do $$ begin execute \'update grades set student_id=student_id\'; end $$',
    'select 1',
  ])('refuses unreviewed content before any database query: %s', async sql => {
    const query = jest.fn(async (_sql: string) => ({ rows: [] }));
    // Local adapter for pg's overloaded API. No connection or SQL is executed here.
    const db = { query, on: jest.fn(), removeListener: jest.fn() } as unknown as Parameters<typeof applyGuardedMigration>[0];
    await expect(applyGuardedMigration(db, { name: 'alias.sql', sql })).rejects.toMatchObject({
      code: 'LEGACY_GRADE_IDENTITY_BLOCKED', reasons: ['UNRECOGNIZED_MIGRATION_CONTENT'],
    });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    'setup-supabase.ts', 'security-database-test.cjs', 'academic-structure-database-test.cjs',
    'institutional-management-database-test.cjs', 'activity-workflow-database-test.cjs',
    'communication-database-test.cjs', 'legacy-upgrade-database-test.cjs', 'lib/stage9-local.cjs',
  ])('keeps the supported entrypoint %s wired to the boundary', path => {
    const source = readFileSync(join(__dirname, '../../scripts', path), 'utf8');
    expect(source).toMatch(/(?:import|require)[^\n]*migration-executor\.cjs/);
    expect(source).toMatch(/await applyGuardedMigration\(/);
  });
});
