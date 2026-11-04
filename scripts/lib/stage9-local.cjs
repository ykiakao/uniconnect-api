const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { randomBytes, randomUUID, createHmac, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { applyGuardedMigration } = require('./migration-executor.cjs');
const syntheticAuthResponseHeaders = Object.freeze({ 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' });

function isAllowedUrl(input, origins = new Set()) {
  try {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && origins.has(url.origin);
  } catch { return false; }
}
function jwt(secret, claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const files = ['schema.sql', ...[
  '20260528000001_academic_base.sql', '20260528000002_activities_grades_reports.sql', '20260528000003_invites.sql',
  '20261026000001_security_integrity.sql', '20261026000002_academic_structure.sql',
  '20261026000003_institutional_management.sql', '20261026000004_activity_workflow.sql', '20261026000005_academic_communication.sql',
  '20261031000006_platform_institutions.sql', '20261101000007_accounts_and_responsibility.sql',
].map(name => `migrations/${name}`)];

function createSyntheticAuth({ db, secret, defaultPassword, serviceKey }) {
  const users = new Map();
  const sessions = new Map();
  const refreshTokens = new Map();
  const usedRefreshTokens = new Set();
  const proofs = new Map();
  const latestRefresh = new Map();
  async function createAuth(email, accountPassword = defaultPassword, { confirmed = true } = {}) {
    email = email.trim().toLowerCase();
    if (users.has(email)) return null;
    const timestamp = new Date().toISOString();
    const user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: confirmed ? timestamp : null,
      created_at: timestamp, app_metadata: {}, user_metadata: {} };
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)', [user.id, email, user.email_confirmed_at]);
    users.set(email, { user, password: accountPassword });
    return user;
  }
  function accountById(authId) { return [...users.values()].find(account => account.user.id === authId); }
  function createProof(email, type, { expired = false } = {}) {
    if (!['recovery', 'invite'].includes(type)) throw new Error('Unsupported synthetic proof type.');
    const account = users.get(email.trim().toLowerCase());
    if (!account) throw new Error('Synthetic proof account unavailable.');
    const tokenHash = randomBytes(32).toString('hex');
    proofs.set(tokenHash, { authId: account.user.id, type, expiresAt: Date.now() + (expired ? -1 : 15 * 60000) });
    return tokenHash;
  }
  function issueSession(user) {
    const access = jwt(secret, { sub: user.id, role: 'authenticated', aud: 'authenticated', jti: randomUUID() });
    const refresh = randomBytes(32).toString('hex');
    sessions.set(access, user.id);
    refreshTokens.set(refresh, user.id);
    latestRefresh.set(user.id, refresh);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: refresh, user };
  }
  function refreshTokenFor(authId) {
    const account = accountById(authId);
    if (!account?.user.email_confirmed_at) throw new Error('Synthetic confirmed account unavailable.');
    const current = latestRefresh.get(authId);
    return current && refreshTokens.has(current) ? current : issueSession(account.user).refresh_token;
  }
  function revokeSessions(authId) {
    for (const [token, id] of sessions) if (id === authId) sessions.delete(token);
    for (const [token, id] of refreshTokens) if (id === authId) refreshTokens.delete(token);
    latestRefresh.delete(authId);
  }
  async function handle({ path, method, body = {}, bearer, query = new URLSearchParams() }) {
    const response = (status, data) => ({ status, data });
    const invalidSession = () => response(401, { code: 'bad_jwt', msg: 'Invalid synthetic session' });
    if ((path.startsWith('/auth/v1/admin/') || path === '/auth/v1/invite') && bearer !== serviceKey) return response(403, { code: 'not_admin', message: 'Forbidden' });
    if (path === '/auth/v1/admin/users' && method === 'POST') {
      const user = await createAuth(body.email, body.password, { confirmed: body.email_confirm !== false });
      return user ? response(200, { user }) : response(422, { code: 'email_exists', msg: 'User already registered' });
    }
    if (path === '/auth/v1/admin/users' && method === 'GET') {
      const page = Number(query.get('page') || 1); const perPage = Number(query.get('per_page') || 50);
      return response(200, { users: [...users.values()].map(row => row.user).slice((page - 1) * perPage, page * perPage), aud: 'authenticated' });
    }
    if (/^\/auth\/v1\/admin\/users\/[^/]+$/.test(path) && method === 'GET') {
      const account = accountById(path.split('/').pop());
      return account ? response(200, { user: account.user }) : response(404, { code: 'user_not_found', msg: 'User unavailable' });
    }
    if (path === '/auth/v1/invite' && method === 'POST') {
      const user = await createAuth(body.email, undefined, { confirmed: false });
      if (!user) return response(422, { code: 'email_exists', msg: 'User already registered' });
      user.invited_at = new Date().toISOString();
      createProof(user.email, 'invite');
      return response(200, { user });
    }
    if (path === '/auth/v1/recover' && method === 'POST') {
      if (users.has(String(body.email).trim().toLowerCase())) createProof(body.email, 'recovery');
      return response(200, {});
    }
    if (path === '/auth/v1/verify' && method === 'POST') {
      const proof = proofs.get(body.token_hash);
      if (!proof || proof.type !== body.type || proof.expiresAt <= Date.now()) return response(403, { code: 'otp_expired', msg: 'Invalid or expired synthetic proof' });
      const account = accountById(proof.authId);
      if (!account) return response(403, { code: 'otp_expired', msg: 'Invalid or expired synthetic proof' });
      proofs.delete(body.token_hash);
      if (!account.user.email_confirmed_at) {
        account.user.email_confirmed_at = new Date().toISOString();
        await db.query('update auth.users set email_confirmed_at=$2 where id=$1', [account.user.id, account.user.email_confirmed_at]);
      }
      return response(200, issueSession(account.user));
    }
    if (path === '/auth/v1/token' && method === 'POST') {
      if (query.get('grant_type') === 'refresh_token') {
        const authId = refreshTokens.get(body.refresh_token);
        if (!authId) return response(400, { code: usedRefreshTokens.has(body.refresh_token) ? 'refresh_token_already_used' : 'refresh_token_not_found', msg: 'Invalid synthetic refresh session' });
        refreshTokens.delete(body.refresh_token);
        usedRefreshTokens.add(body.refresh_token);
        const account = accountById(authId);
        return account ? response(200, issueSession(account.user)) : response(400, { code: 'user_not_found', msg: 'User unavailable' });
      }
      const account = users.get(String(body.email).trim().toLowerCase());
      if (!account || account.password !== body.password) return response(400, { code: 'invalid_credentials', error: 'invalid_grant', error_description: 'Invalid login credentials' });
      if (!account.user.email_confirmed_at) return response(400, { code: 'email_not_confirmed', msg: 'Confirm synthetic email first' });
      return response(200, issueSession(account.user));
    }
    if (path === '/auth/v1/user' && (method === 'GET' || method === 'PUT')) {
      const account = accountById(sessions.get(bearer));
      if (!account) return invalidSession();
      if (method === 'PUT') {
        if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) return response(422, { code: 'weak_password', msg: 'Synthetic password rejected' });
        account.password = body.password;
      }
      return response(200, account.user);
    }
    if (path === '/auth/v1/logout' && method === 'POST') {
      const authId = sessions.get(bearer);
      if (authId && query.get('scope') !== 'local') revokeSessions(authId);
      else sessions.delete(bearer);
      return response(204);
    }
    return response(404, { message: 'Unsupported synthetic Auth operation' });
  }
  return { createAuth, createProof, refreshTokenFor, revokeSessions, handle };
}

async function startLocalHarness() {
  if (!process.argv.includes('--allow-local-migrations')) throw Object.assign(new Error(), { safeMessage: 'Required: --allow-local-migrations; disposable local databases only.' });
  if (Number(process.versions.node.split('.')[0]) !== 22) throw Object.assign(new Error(), { safeMessage: 'Node 22 is required.' });
  const { Client } = require('pg');
  const root = join(__dirname, '../..');
  const migrations = files.map(name => ({ name, sql: readFileSync(join(root, 'supabase', name), 'utf8') }));
  const fingerprint = value => createHash('sha256').update(value).digest('hex');
  const password = randomBytes(24).toString('hex');
  const secret = randomBytes(48).toString('hex');
  const id = randomBytes(8).toString('hex');
  const serviceKey = jwt(secret, { role: 'service_role' });
  const anonKey = jwt(secret, { role: 'anon' });
  const origins = new Set();
  const originalFetch = globalThis.fetch;
  const syntheticAuth = createSyntheticAuth({ db: { query: (...args) => db.query(...args) }, secret, defaultPassword: password, serviceKey });
  const containers = [];
  const servers = [];
  let networkId;
  let db;
  let cleaned = false;
  const stats = { restRequests: 0, rpcRequests: 0, authRequests: 0, countHeaders: 0, rangeRequests: 0, preferRequests: 0, forbiddenNetwork: 0, restErrors: [] };
  const evidence = { node: process.version, scope: 'Compiled Express + real Supabase SDK + real PostgREST + disposable PostgreSQL; synthetic local Auth only; not remote Supabase equivalence.', migrations: migrations.map(row => ({ name: row.name, sha256: fingerprint(row.sql) })) };
  function docker(...args) {
    try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { throw new Error(`Local Docker command failed: ${args[0]}; command arguments and output withheld.`); }
  }
  async function close() {
    if (cleaned) return;
    cleaned = true;
    const errors = [];
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    globalThis.fetch = originalFetch;
    if (db) await db.end().catch(() => errors.push('database-close'));
    for (const container of containers.reverse()) {
      try { docker('rm', '-f', '-v', container); } catch { errors.push('container-remove'); }
    }
    if (networkId) { try { docker('network', 'rm', networkId); } catch { errors.push('network-remove'); } }
    evidence.cleanup = { createdContainers: containers.length, removedContainers: containers.length - errors.filter(x => x === 'container-remove').length, networkRemoved: Boolean(networkId) && !errors.includes('network-remove'), errors };
    evidence.sourceUnchanged = migrations.every(row => fingerprint(readFileSync(join(root, 'supabase', row.name), 'utf8')) === fingerprint(row.sql));
    if (errors.length || !evidence.sourceUnchanged) throw new Error('Disposable cleanup or source integrity check failed.');
  }
  async function listen(server) {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    origins.add(origin);
    return origin;
  }
  try {
    globalThis.fetch = (input, init) => {
      if (!isAllowedUrl(input, origins)) { stats.forbiddenNetwork++; throw new Error('External or unregistered network request blocked.'); }
      return originalFetch(input, { ...init, redirect: 'error' });
    };
    networkId = docker('network', 'create', `uniconnect-stage9-${id}`);
    const pgId = docker('run', '--rm', '-d', '--name', `uniconnect-stage9-pg-${id}`, '--network', networkId, '--network-alias', 'stage9-pg', '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    containers.push(pgId);
    const published = docker('port', pgId, '5432/tcp');
    assert.match(published, /^127\.0\.0\.1:\d+$/);
    const config = { host: '127.0.0.1', port: Number(published.split(':')[1]), user: 'postgres', password, database: 'postgres', ssl: false, statement_timeout: 15000 };
    for (let attempt = 0; attempt < 100; attempt++) {
      db = new Client(config);
      try { await db.connect(); break; } catch { await db.end().catch(() => {}); if (attempt === 99) throw new Error('Disposable PostgreSQL did not start.'); await delay(200); }
    }
    await db.query(`create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','authenticated')::text $$;
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create role authenticator login password '${password}'; grant anon,authenticated,service_role to authenticator;
      grant usage on schema public,auth to anon,authenticated,service_role`);
    const protectedMigrations = ['20261031000006_platform_institutions.sql', '20261101000007_accounts_and_responsibility.sql'];
    for (const migration of migrations.filter(row => !protectedMigrations.some(name => row.name.endsWith(name)))) await applyGuardedMigration(db, migration);
    await db.query('grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role');
    for (const name of protectedMigrations) {
      const migration = migrations.find(row => row.name.endsWith(name));
      if (migration) await applyGuardedMigration(db, migration);
    }
    const pgrstId = docker('run', '--rm', '-d', '--name', `uniconnect-stage9-rest-${id}`, '--network', networkId,
      '-e', `PGRST_DB_URI=postgresql://authenticator:${password}@stage9-pg:5432/postgres`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
      '-e', `PGRST_JWT_SECRET=${secret}`, '-p', '127.0.0.1::3000', 'postgrest/postgrest:v12.2.3');
    containers.push(pgrstId);
    const restPublished = docker('port', pgrstId, '3000/tcp');
    assert.match(restPublished, /^127\.0\.0\.1:\d+$/);
    const restOrigin = `http://${restPublished}`;
    origins.add(restOrigin);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await globalThis.fetch(`${restOrigin}/`, { headers: { authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(2000) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await delay(200);
    }
    if (!ready) throw new Error('Disposable PostgREST did not start.');
    evidence.postgres = (await db.query('show server_version')).rows[0].server_version;
    evidence.postgresImage = docker('image', 'inspect', 'postgres:16-alpine', '--format', '{{json .RepoDigests}}');
    evidence.postgrestImage = docker('image', 'inspect', 'postgrest/postgrest:v12.2.3', '--format', '{{json .RepoDigests}}');
    evidence.postgrestVersion = '12.2.3';
    const gateway = await listen(http.createServer(async (req, res) => {
      try {
        const path = new URL(req.url, 'http://127.0.0.1').pathname;
        if (path.startsWith('/rest/v1/')) {
          stats.restRequests++;
          if (path.startsWith('/rest/v1/rpc/')) stats.rpcRequests++;
          if (req.headers.range || /[?&](offset|limit)=/.test(req.url)) stats.rangeRequests++;
          if (req.headers.prefer) stats.preferRequests++;
          const upstream = http.request(`${restOrigin}${req.url.slice('/rest/v1'.length)}`, { method: req.method, headers: { ...req.headers, host: new URL(restOrigin).host } }, response => {
            if (response.headers['content-range']) stats.countHeaders++;
            if (response.statusCode >= 400) {
              let diagnostic = '';
              response.on('data', chunk => { if (diagnostic.length < 4096) diagnostic += chunk.toString('utf8'); });
              response.on('end', () => {
                try {
                  const code = JSON.parse(diagnostic).code;
                  if (typeof code === 'string' && /^[A-Z0-9_]{1,16}$/.test(code)) stats.restErrors.push({ status: response.statusCode, code });
                } catch {}
              });
            }
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          });
          upstream.setTimeout(15000, () => upstream.destroy());
          upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
          req.on('aborted', () => upstream.destroy());
          req.pipe(upstream);
          return;
        }
        if (!path.startsWith('/auth/v1/')) { res.writeHead(404).end(); return; }
        stats.authRequests++;
        const respond = (status, data) => { res.writeHead(status, syntheticAuthResponseHeaders); res.end(data === undefined ? '' : JSON.stringify(data)); };
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 65536) { respond(413, {}); return; } }
        const body = raw ? JSON.parse(raw) : {};
        const bearer = req.headers.authorization?.replace(/^Bearer /, '');
        const result = await syntheticAuth.handle({ path, method: req.method, body, bearer, query: new URL(req.url, 'http://127.0.0.1').searchParams });
        respond(result.status, result.data);
      } catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); }
    }));
    Object.assign(process.env, { NODE_ENV: 'test', API_VERSION: 'v1', ACADEMIC_PROVIDER: 'native', PLATFORM_ADMIN_AUTH_USER_IDS: '',
      DOTENV_CONFIG_PATH: join(root, `.stage9-nonexistent-${id}`), SUPABASE_URL: gateway, SUPABASE_ANON_KEY: anonKey, SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      AUTH_RECOVERY_REDIRECT_URL: 'http://127.0.0.1:3000/password/reset', AUTH_INVITE_REDIRECT_URL: 'http://127.0.0.1:3000/accounts/activate' });
    const { app } = require(join(root, 'dist/app.js'));
    const apiOrigin = await listen(http.createServer(app));
    return { db, password, apiOrigin, gateway, restOrigin, serviceKey, anonKey, evidence, stats,
      createAuth: syntheticAuth.createAuth, createProof: syntheticAuth.createProof, refreshTokenFor: syntheticAuth.refreshTokenFor, revokeSessions: syntheticAuth.revokeSessions, close };
  } catch (error) {
    try { await close(); }
    finally { console.log(JSON.stringify({ ...evidence, result: 'FAIL', transport: stats })); }
    throw error;
  }
}
module.exports = { isAllowedUrl, startLocalHarness, createSyntheticAuth, syntheticAuthResponseHeaders };
