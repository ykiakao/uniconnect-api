import { ClientConfig } from 'pg';

export async function ensureUninitializedAdminDatabase(client: {
  query(sql: string): Promise<{ rows: Array<{ initialized: boolean }> }>;
}): Promise<void> {
  const { rows } = await client.query(`select exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')
      and c.relname=any(array['tenants','app_users','courses','classes','activities','grades','messages','invites'])
  ) as initialized`);
  if (rows.length !== 1 || rows[0].initialized !== false) {
    throw new Error('Banco ja inicializado ou estado desconhecido. Use um plano de migrations revisado; setup completo nao atualiza instalacoes existentes.');
  }
}

export function buildAdminDatabaseConfig(connectionString: string, { mode = 'verify-full', ca }: {
  mode?: string; ca?: string;
} = {}): ClientConfig {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('URL PostgreSQL invalida.');
  for (const key of url.searchParams.keys()) {
    if (['host', 'hostaddr'].includes(key.toLowerCase())) {
      throw new Error('Informe o destino PostgreSQL apenas no host da URL.');
    }
    if (key.toLowerCase().startsWith('ssl') && key !== 'sslmode') {
      throw new Error('Configure certificados usando SUPABASE_DB_CA_FILE, sem parametros SSL na URL.');
    }
  }
  const urlMode = url.searchParams.get('sslmode');
  if (urlMode && !['require', 'verify-full'].includes(urlMode)) throw new Error('sslmode inseguro ou nao suportado.');
  url.searchParams.delete('sslmode');
  if (mode === 'disable') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || ca) {
      throw new Error('TLS pode ser desativado apenas em conexoes locais explicitas, sem CA.');
    }
    return { connectionString: url.toString(), ssl: false };
  }
  if (mode !== 'verify-full') throw new Error('SUPABASE_DB_SSL_MODE invalido.');
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } };
}
