import type { Client } from 'pg';

export function applyGuardedMigration(
  db: Pick<Client, 'query' | 'on' | 'removeListener'>,
  migration: { name: string; sql: string },
): Promise<unknown>;
