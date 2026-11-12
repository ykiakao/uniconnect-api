const { createClient } = require('@supabase/supabase-js');
const { runCleanup, localUrl } = require('./lib/academic-attachments-cleanup.cjs');
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/academic-attachments-cleanup.cjs --local-url=http://127.0.0.1:54321 [--execute-local]\nDefault: dry-run. Requires ACADEMIC_ATTACHMENTS_LOCAL_SERVICE_KEY. Remote targets are rejected.');
    return;
  }
  if (args.some(arg => !arg.startsWith('--local-url=') && arg !== '--execute-local' && arg !== '--dry-run')) throw new Error('Unknown cleanup argument');
  const urlArg = args.filter(arg => arg.startsWith('--local-url='));
  if (urlArg.length !== 1 || (args.includes('--execute-local') && args.includes('--dry-run'))) throw new Error('Explicit loopback target and one mode required');
  const url = localUrl(urlArg[0].slice('--local-url='.length));
  const key = process.env.ACADEMIC_ATTACHMENTS_LOCAL_SERVICE_KEY;
  if (!key) throw new Error('Local service credential required');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'error' }) } });
  const bucket = process.env.ACADEMIC_ATTACHMENTS_BUCKET ?? 'academic-attachments';
  const result = await runCleanup({ bucket, execute: args.includes('--execute-local'),
    rpc: async (operation, fileId = null, token = null) => {
      const { data, error } = await client.rpc('academic_attachment_cleanup', { p_operation: operation, p_file_id: fileId, p_token: token });
      if (error) throw new Error('Local cleanup query failed'); return data;
    },
    remove: async (bucket, paths) => { const { error } = await client.storage.from(bucket).remove(paths); if (error) throw new Error('Local cleanup deletion failed'); },
  });
  console.log(JSON.stringify(result));
  if (result.results.some(row => row.action === 'failed')) process.exitCode = 1;
}
main().catch(() => { console.error('Cleanup rejected or failed. Check the explicit local target, mode and configuration. No remote cleanup is supported.'); process.exitCode = 1; });
