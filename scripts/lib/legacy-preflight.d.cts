import type { Client } from 'pg';

export function inspectLegacyGradeIdentities(db: Pick<Client, 'query'>): Promise<{
  safe: boolean;
  target: string;
  total: number;
  conversions: number;
  invalid_members: number;
  invalid_activities?: number;
  collisions?: number;
  reasons: string[];
}>;
