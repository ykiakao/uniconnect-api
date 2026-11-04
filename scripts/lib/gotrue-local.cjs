const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { randomBytes, createHmac, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { applyGuardedMigration } = require('./migration-executor.cjs');
const manifest = require('./migration-manifest.cjs');

const images = Object.freeze({ postgres: 'postgres:16-alpine', auth: 'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b', smtp: 'axllent/mailpit:v1.27.4@sha256:df6c2541907e1be6fac21f509927cf6ed771617a1f4b361ef66d97bd05593d2d', rest: 'postgrest/postgrest:v12.2.3', ingress: 'node:22-alpine' });
function assertLocalRun(args, version) {
  if (!args.includes('--allow-local-migrations') || version.split('.')[0] !== '22') throw new Error('Explicit --allow-local-migrations and Node 22 required.');
}
function isAllowedUrl(input, origins) {
  try {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && origins.has(url.origin);
  } catch { return false; }
}
function assertOwnedContainer(inspected, id) { assert.equal(inspected.Config?.Labels?.['uniconnect.gotrue.run'], id); }
function loopbackOrigin(binding) {
  assert.match(binding, /^127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  assert.ok(Number(binding.split(':')[1]) <= 65535);
  return `http://${binding}`;
}
function assertSyntheticEmail(email) { assert.match(email, /^[a-z0-9._+-]+@[a-z0-9-]+\.invalid$/); }
function capturedProof(html, origin, type) {
  for (const match of html.matchAll(/href=["']([^"']+)["']/g)) {
    const url = new URL(match[1].replace(/&amp;/g, '&'));
    if (url.origin === origin && url.pathname === '/verify' && url.searchParams.get('type') === type) {
      const proof = url.searchParams.get('token');
      assert.match(proof || '', /^[a-zA-Z0-9_-]{1,2048}$/);
      return proof;
    }
  }
  throw new Error('Captured local provider proof unavailable.');
}
function jwt(secret, role) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startGoTrueHarness(evidence) {
  assertLocalRun(process.argv, process.versions.node);
  const { Client } = require('pg');
  const { createClient } = require('@supabase/supabase-js');
  const root = join(__dirname, '../..');
  const id = randomBytes(8).toString('hex');
  const password = randomBytes(24).toString('hex');
  const secret = randomBytes(48).toString('hex');
  const anonKey = jwt(secret, 'anon'), serviceKey = jwt(secret, 'service_role');
  const containers = [], servers = [], origins = new Set();
  const originalFetch = globalThis.fetch;
  let network, ingressNetwork, db, authOrigin, restOrigin, closed = false;
  let databaseClosing, databaseLost = false;
  const stats = { authRequests: 0, restRequests: 0, smtpApiRequests: 0, forbiddenNetwork: 0 };
  const migrations = Object.entries(manifest).map(([name, sha256]) => ({ name: name === 'schema.sql' ? name : `migrations/${name}`, sha256, sql: readFileSync(join(root, 'supabase', name === 'schema.sql' ? name : `migrations/${name}`), 'utf8') }));
  Object.assign(evidence, { node: process.version, docker: null, images: {}, scope: 'Compiled Express + real SDK/Auth/PostgREST/PostgreSQL + captured SMTP; disposable local only.', config: { refreshRotation: true, refreshReuseIntervalSeconds: 0, otpExpirySeconds: 3600, jwtExpirySeconds: 3600, authNetworkInternal: true, authDatabaseRole: 'dedicated schema owner without superuser', smtpRelay: false, dockerLogs: 'disabled' }, migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })) });
  function docker(...args) {
    try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { throw Object.assign(new Error('Disposable Docker operation failed; private output withheld.'), { safeCode: `DOCKER_${args[0].toUpperCase()}` }); }
  }
  function owned(name) { const data = JSON.parse(docker('inspect', name))[0]; assertOwnedContainer(data, id); return data; }
  function run(name, args, image) {
    containers.push(name);
    docker('run', '--rm', '-d', '--pull', 'never', '--log-driver', 'none', '--label', `uniconnect.gotrue.run=${id}`, '--name', name, '--network', network, ...args, image);
    const data = owned(name);
    assert.deepEqual(Object.keys(data.NetworkSettings.Networks), [network]);
    return name;
  }
  async function listen(server) {
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`; origins.add(origin); return origin;
  }
  async function closeDatabase() {
    if (db) await (databaseClosing ??= db.end());
  }
  async function close() {
    if (closed) return; closed = true;
    const errors = []; let removed = 0;
    for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    globalThis.fetch = originalFetch;
    await closeDatabase().catch(() => errors.push('database-close'));
    for (const name of containers.reverse()) {
      try {
        if (docker('ps', '-aq', '--filter', `name=^/${name}$`)) { owned(name); docker('rm', '-f', '-v', name); }
        removed++;
      } catch { errors.push('owned-container-cleanup'); }
    }
    let networkRemoved = false, ingressNetworkRemoved = false;
    for (const target of [network, ingressNetwork].filter(Boolean)) {
      try {
        const data = JSON.parse(docker('network', 'inspect', target))[0];
        assert.equal(data.Labels?.['uniconnect.gotrue.run'], id);
        assert.equal(data.Internal, target === network); assert.equal(Object.keys(data.Containers || {}).length, 0);
        docker('network', 'rm', target); if (target === network) networkRemoved = true; else ingressNetworkRemoved = true;
      } catch { errors.push('owned-network-cleanup'); }
    }
    evidence.cleanup = { createdContainers: containers.length, removedContainers: removed, networkRemoved, ingressNetworkRemoved, errors };
    evidence.sourceUnchanged = migrations.every(row => createHash('sha256').update(readFileSync(join(root, 'supabase', row.name), 'utf8').replace(/\r\n/g, '\n')).digest('hex') === row.sha256);
    evidence.transport = stats;
    if (errors.length || !evidence.sourceUnchanged) throw new Error('Local cleanup or migration source integrity failed.');
  }
  try {
    evidence.startupPhase = 'image and isolation checks';
    globalThis.fetch = (input, init) => {
      if (!isAllowedUrl(input, origins)) { stats.forbiddenNetwork++; throw new Error('Unregistered network request blocked.'); }
      return originalFetch(input, { ...init, redirect: 'error', signal: init?.signal || AbortSignal.timeout(15000) });
    };
    evidence.docker = docker('version', '--format', '{{.Server.Version}}');
    for (const [name, image] of Object.entries(images)) evidence.images[name] = JSON.parse(docker('image', 'inspect', image, '--format', '{{json .RepoDigests}}'));
    network = `uniconnect-gotrue-${id}`;
    docker('network', 'create', '--internal', '--label', `uniconnect.gotrue.run=${id}`, network);
    assert.equal(JSON.parse(docker('network', 'inspect', network))[0].Internal, true);
    ingressNetwork = `uniconnect-gotrue-ingress-${id}`;
    docker('network', 'create', '--label', `uniconnect.gotrue.run=${id}`, ingressNetwork);
    const ingressName = `uniconnect-gotrue-proxy-${id}`;
    const proxyCode = `const net=require('node:net');for(const [port,host,target] of [[15432,'local-pg',5432],[19999,'local-auth',9999],[18025,'local-smtp',8025],[13000,'local-rest',3000]])net.createServer(socket=>{const upstream=net.connect(target,host);socket.setTimeout(15000,()=>socket.destroy());upstream.setTimeout(15000,()=>upstream.destroy());socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());socket.pipe(upstream);upstream.pipe(socket)}).listen(port,'0.0.0.0');`;
    containers.push(ingressName);
    docker('run', '--rm', '-d', '--pull', 'never', '--log-driver', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'node', '--label', `uniconnect.gotrue.run=${id}`, '--name', ingressName, '--network', ingressNetwork,
      ...[15432,19999,18025,13000].flatMap(port => ['-p', `127.0.0.1::${port}`]), images.ingress, 'node', '-e', proxyCode);
    docker('network', 'connect', network, ingressName);
    assert.deepEqual(Object.keys(owned(ingressName).NetworkSettings.Networks).sort(), [network, ingressNetwork].sort());
    evidence.ingress = 'Docker internal-network publishing unavailable; fixed-target TCP ingress only. Auth/PG/SMTP/PostgREST have no second network; only ingress proxy dual-homed.';
    evidence.startupPhase = 'PostgreSQL container and loopback connection';
    run(`uniconnect-gotrue-pg-${id}`, ['--network-alias', 'local-pg', '-e', `POSTGRES_PASSWORD=${password}`], images.postgres);
    const pgOrigin = loopbackOrigin(docker('port', ingressName, '15432/tcp'));
    const config = { host: '127.0.0.1', port: Number(new URL(pgOrigin).port), user: 'postgres', password, database: 'postgres', ssl: false, statement_timeout: 15000 };
    for (let n = 0; n < 100; n++) {
      const candidate = new Client(config);
      db = candidate;
      candidate.on('error', () => {
        if (db === candidate) databaseLost = true;
      });
      try {
        await candidate.connect();
        break;
      } catch {
        db = undefined;
        databaseLost = false;
        await candidate.end().catch(() => {});
        if (n === 99) throw new Error('Local PG startup timeout.');
        await delay(200);
      }
    }
    evidence.postgres = (await db.query('show server_version')).rows[0].server_version;
    evidence.startupPhase = 'dedicated Auth database role';
    await db.query(`create extension if not exists pgcrypto; create role supabase_auth_admin login password '${password}'; create schema auth authorization supabase_auth_admin; alter role supabase_auth_admin set search_path=auth,public;
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create role authenticator login password '${password}'; grant anon,authenticated,service_role to authenticator; grant usage on schema public,auth to anon,authenticated,service_role; grant usage,create on schema public to supabase_auth_admin`);
    evidence.startupPhase = 'captured SMTP container';
    run(`uniconnect-gotrue-smtp-${id}`, ['--network-alias', 'local-smtp', '-e', 'MP_MAX_MESSAGES=50', '-e', 'MP_SMTP_AUTH_ACCEPT_ANY=1', '-e', 'MP_SMTP_AUTH_ALLOW_INSECURE=1'], images.smtp);
    const smtpOrigin = loopbackOrigin(docker('port', ingressName, '18025/tcp')); origins.add(smtpOrigin);
    const gateway = await listen(http.createServer((req, res) => {
      const auth = req.url.startsWith('/auth/v1/'), rest = req.url.startsWith('/rest/v1/');
      const target = auth ? authOrigin : rest ? restOrigin : undefined;
      if (!target) { res.writeHead(404).end(); return; }
      if (auth) stats.authRequests++; else stats.restRequests++;
      const path = req.url.slice(auth ? '/auth/v1'.length : '/rest/v1'.length);
      const upstream = http.request(`${target}${path}`, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.setTimeout(15000, () => upstream.destroy()); upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
    }));
    const authEnv = { GOTRUE_API_HOST: '0.0.0.0', PORT: '9999', API_EXTERNAL_URL: gateway, GOTRUE_DB_DRIVER: 'postgres', DATABASE_URL: `postgres://supabase_auth_admin:${password}@local-pg:5432/postgres`, DB_NAMESPACE: 'auth',
      GOTRUE_SITE_URL: 'http://127.0.0.1:3000', GOTRUE_URI_ALLOW_LIST: 'http://127.0.0.1:3000/password/reset,http://127.0.0.1:3000/accounts/activate', GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated', GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_EXP: '3600',
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_EXTERNAL_PHONE_ENABLED: 'false', GOTRUE_MAILER_AUTOCONFIRM: 'false', GOTRUE_SMTP_HOST: 'local-smtp', GOTRUE_SMTP_PORT: '1025', GOTRUE_SMTP_ADMIN_EMAIL: 'auth@p04.invalid', GOTRUE_SMTP_SENDER_NAME: 'Local Synthetic', GOTRUE_SMTP_MAX_FREQUENCY: '1ns', GOTRUE_RATE_LIMIT_EMAIL_SENT: '100',
      GOTRUE_MAILER_URLPATHS_INVITE: '/verify', GOTRUE_MAILER_URLPATHS_RECOVERY: '/verify', GOTRUE_MAILER_OTP_EXP: '3600', GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: 'true', GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: '0', GOTRUE_PASSWORD_HIBP_ENABLED: 'false', GOTRUE_LOG_LEVEL: 'panic' };
    evidence.startupPhase = 'GoTrue migrations and health';
    run(`uniconnect-gotrue-auth-${id}`, ['--network-alias', 'local-auth', ...Object.entries(authEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`])], images.auth);
    authOrigin = loopbackOrigin(docker('port', ingressName, '19999/tcp')); origins.add(authOrigin);
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { const response = await fetch(`${authOrigin}/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { evidence.authHealth = await response.json(); ready = true; break; } } catch {}
      await delay(200);
    }
    if (!ready) throw new Error('Local GoTrue startup timeout.');
    evidence.startupPhase = 'guarded migration chain with actual Auth schema';
    const authRole = (await db.query("select to_regprocedure('auth.role()')::text existing")).rows[0].existing;
    if (!authRole) await db.query(`create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','authenticated')::text $$`);
    evidence.authRoleFunction = authRole ? 'GoTrue migration-owned existing helper preserved' : 'Local PostgREST JWT role adapter created';
    const protectedNames = ['20261031000006_platform_institutions.sql', '20261101000007_accounts_and_responsibility.sql'];
    for (const migration of migrations.filter(row => !protectedNames.some(name => row.name.endsWith(name)))) await applyGuardedMigration(db, migration);
    await db.query('grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role');
    for (const name of protectedNames) await applyGuardedMigration(db, migrations.find(row => row.name.endsWith(name)));
    evidence.startupPhase = 'PostgREST container and health';
    run(`uniconnect-gotrue-rest-${id}`, ['--network-alias', 'local-rest', '-e', `PGRST_DB_URI=postgresql://authenticator:${password}@local-pg:5432/postgres`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`], images.rest);
    restOrigin = loopbackOrigin(docker('port', ingressName, '13000/tcp')); origins.add(restOrigin);
    ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`${restOrigin}/`, { headers: { authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {} await delay(200); }
    if (!ready) throw new Error('Local PostgREST startup timeout.');
    Object.assign(process.env, { NODE_ENV: 'test', API_VERSION: 'v1', ACADEMIC_PROVIDER: 'native', PLATFORM_ADMIN_AUTH_USER_IDS: '', DOTENV_CONFIG_PATH: join(root, `.gotrue-nonexistent-${id}`), SUPABASE_URL: gateway, SUPABASE_ANON_KEY: anonKey, SUPABASE_SERVICE_ROLE_KEY: serviceKey, AUTH_RECOVERY_REDIRECT_URL: 'http://127.0.0.1:3000/password/reset', AUTH_INVITE_REDIRECT_URL: 'http://127.0.0.1:3000/accounts/activate' });
    evidence.startupPhase = 'compiled API';
    const { app } = require(join(root, 'dist/app.js'));
    const apiOrigin = await listen(http.createServer(app));
    if (databaseLost) throw new Error('Auxiliary PostgreSQL connection lost during startup.');
    const client = (admin = false) => createClient(gateway, admin ? serviceKey : anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    async function createAuth(email) { assertSyntheticEmail(email); const result = await client(true).auth.admin.createUser({ email, password, email_confirm: true }); if (result.error || !result.data.user) throw Object.assign(new Error('Local Auth creation failed.'), { safeCode: result.error?.code, safeStatus: result.error?.status }); return result.data.user; }
    async function capture(email, type) {
      assertSyntheticEmail(email);
      for (let n = 0; n < 50; n++) {
        stats.smtpApiRequests++;
        const listing = await (await fetch(`${smtpOrigin}/api/v1/messages`)).json();
        const messages = listing.messages || [];
        for (const message of messages.filter(row => row.To?.some(to => to.Address === email))) {
          const body = await (await fetch(`${smtpOrigin}/api/v1/message/${encodeURIComponent(message.ID)}`)).json();
          try { return capturedProof(body.HTML, gateway, type); } catch {}
        }
        await delay(100);
      }
      throw new Error('Local SMTP proof capture timeout.');
    }
    return { db, password, gateway, apiOrigin, client, createAuth, capture, close, closeDatabase, stats, evidence };
  } catch (error) { await close(); throw error; }
}
module.exports = { assertLocalRun, isAllowedUrl, assertOwnedContainer, loopbackOrigin, capturedProof, assertSyntheticEmail, startGoTrueHarness };
