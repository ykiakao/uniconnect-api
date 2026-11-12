const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
function safePaths(file, paths, bucket) {
  if (file.bucket !== bucket || !Array.isArray(paths) || paths.length > 11 || !paths.length) throw new Error('Invalid cleanup scope');
  const match = new RegExp(`^staging/(${uuid})/(${uuid})/(${uuid})/(${uuid})$`).exec(file.staging_path);
  if (!match || match[3] !== file.id) throw new Error('Invalid cleanup scope');
  const finalPattern = new RegExp(`^files/${match[1]}/${match[2]}/${file.id}/${uuid}\\.(pdf|docx|png|jpg)$`);
  if (paths.some(path => path !== file.staging_path && !finalPattern.test(path))) throw new Error('Invalid cleanup path');
  if (file.protected && file.final_path && paths.includes(file.final_path)) throw new Error('Protected cleanup target');
  return [...new Set(paths)];
}
async function runCleanup({ rpc, remove, bucket = 'academic-attachments', execute = false }) {
  const files = await rpc('candidates');
  if (!Array.isArray(files) || files.length > 100) throw new Error('Invalid cleanup inventory');
  const results = [];
  for (const file of files) {
    try {
      const planned = safePaths(file, [file.staging_path, ...file.candidate_paths.filter(path => !file.protected || path !== file.final_path)], bucket);
      if (!execute) { results.push({ id: file.id, action: 'dry-run', objects: planned.length }); continue; }
      const claim = await rpc('claim', file.id);
      if (claim.id !== file.id || claim.bucket !== file.bucket || !new RegExp(`^${uuid}$`).test(claim.token)) throw new Error('Invalid cleanup claim');
      const paths = safePaths(file, claim.paths, bucket);
      await remove(bucket, paths);
      await rpc('finish', file.id, claim.token);
      results.push({ id: file.id, action: 'cleaned', objects: paths.length });
    } catch { results.push({ id: file.id, action: 'failed' }); }
  }
  return { mode: execute ? 'execute-local' : 'dry-run', results };
}
function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Cleanup requires an explicit loopback-only Storage URL');
  return url.origin;
}
module.exports = { runCleanup, localUrl };
