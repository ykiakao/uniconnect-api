import request from 'supertest';
import express from 'express';
import { app } from '../../app';
import { env } from '../../config/env';
import { errorHandler } from '../../middleware/error-handler';
import { createAcademicProtection } from './academic.protection';

const base = '/api/v1/tenants/edukmais/academic';
const student = (path: string) => request(app).get(`${base}${path}`).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-student-token');
const original = { provider: env.ACADEMIC_PROVIDER, slug: env.ACADEMIC_DEMO_TENANT_SLUG };
beforeEach(() => { env.ACADEMIC_PROVIDER = 'demo'; env.ACADEMIC_DEMO_TENANT_SLUG = 'edukmais'; });
afterEach(() => { env.ACADEMIC_PROVIDER = original.provider; env.ACADEMIC_DEMO_TENANT_SLUG = original.slug; jest.restoreAllMocks(); });

describe('endpoints acadêmicos genéricos', () => {
  it.each(['/periods', '/overview', '/history'])('exige token UniConnect em %s', async path => {
    const res = await request(app).get(`${base}${path}`).set('x-tenant-slug', 'edukmais');
    expect(res.status).toBe(401); expect(res.body.error.code).toBe('AUTH_TOKEN_REQUIRED');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers.etag).toBeUndefined();
  });
  it('rejeita token inválido, tenant ausente e slug de outro tenant', async () => {
    expect((await request(app).get(`${base}/overview`).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer invalid-token')).status).toBe(401);
    expect((await request(app).get(`${base}/overview`).set('authorization', 'Bearer valid-student-token')).status).toBe(400);
    expect((await request(app).get('/api/v1/tenants/outra/academic/overview').set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-student-token')).status).toBe(404);
  });
  it('autentica pelo login existente e retorna demo sem nenhuma chamada ao portal', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('REDE PROIBIDA'));
    const login = await request(app).post('/api/v1/auth/login').set('x-tenant-slug', 'edukmais').send({ email: 'aluno@edukmais.edu.br', password: 'password123' });
    expect(login.status).toBe(200);
    const res = await request(app).get(`${base}/overview`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200); expect(res.body.source).toMatchObject({ providerId: 'demo', demonstration: true });
    expect(res.body.subjects).toHaveLength(5); expect(res.body.scope.userId).toBe('user-student');
    expect(res.body.subjects[0].grades.finalAverage).toBe(0); expect(res.body.subjects[0].grades.assessment2).toBeNull();
    expect(res.headers['cache-control']).toBe('no-store, private'); expect(fetch).not.toHaveBeenCalled();
    expect(res.headers.etag).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/password123|valid-student-token|cookie|supabase/i);
  });
  it('retorna períodos e histórico sintéticos e permite somente período disponível', async () => {
    const periods = await student('/periods'); expect(periods.status).toBe(200); expect(periods.body.periods).toHaveLength(2);
    const history = await student('/history'); expect(history.status).toBe(200); expect(history.body.periods).toHaveLength(2);
    expect(history.body.periods.every((p: { complete: boolean; subjects: unknown[] }) => p.complete && p.subjects.length === 5)).toBe(true);
    expect((await student('/overview?periodId=demo-2026-1')).body.period.id).toBe('demo-2026-1');
    expect((await student('/overview?periodId=nao-disponivel')).status).toBe(404);
  });
  it.each(['userId=outra-pessoa', 'provider=external', 'institution=outra', 'baseUrl=https://externo.test', 'credentials=privado', 'periodId=demo-2026-2&periodId=demo-2026-1'])('rejeita seleção arbitrária: %s', async query => {
    const res = await student(`/overview?${query}`); expect(res.status).toBe(400); expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
  it('rejeita corpos, inclusive credenciais, sem ecoar ou registrar seus valores', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await student('/overview').send({ password: 'SENHA-PRIVADA', cookie: 'COOKIE-PRIVADO' });
    expect(res.status).toBe(400); expect(JSON.stringify(res.body)).not.toMatch(/SENHA-PRIVADA|COOKIE-PRIVADO/);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it('seleção fica no servidor e pode ser desativada ou vinculada a outro tenant', async () => {
    env.ACADEMIC_PROVIDER = 'disabled'; expect((await student('/overview')).status).toBe(503);
    env.ACADEMIC_PROVIDER = 'demo'; env.ACADEMIC_DEMO_TENANT_SLUG = 'outra'; expect((await student('/overview')).status).toBe(403);
  });
  it('isola o escopo entre dois usuários autenticados sem compartilhar dados mutáveis', async () => {
    const a = await student('/overview');
    const b = await request(app).get(`${base}/overview`).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-teacher-token');
    expect(b.status).toBe(200); expect(a.body.scope.userId).toBe('user-student'); expect(b.body.scope.userId).toBe('user-teacher');
    expect(JSON.stringify(b.body)).not.toContain('user-student');
  });
  it('respostas acadêmicas condicionais continuam sem cache ou ETag', async () => {
    const res = await student('/overview').set('If-None-Match', '*');
    expect(res.status).toBe(200); expect(res.headers.etag).toBeUndefined();
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('limites locais de consultas acadêmicas', () => {
  it('limita frequência, concorrência e libera vaga ao terminar a resposta', async () => {
    const local = express();
    local.use((req, _res, next) => { req.tenant = { id: 't' } as never; req.currentUser = { id: 'u' } as never; next(); });
    local.use(createAcademicProtection({ maxPerMinute: 2, maxConcurrent: 1 }));
    let finish: (() => void) | undefined;
    local.get('/slow', (_req, res) => { finish = () => res.json({ ok: true }); });
    local.get('/fast', (_req, res) => res.json({ ok: true })); local.use(errorHandler);
    const slow = request(local).get('/slow').then(res => res);
    for (let i = 0; !finish && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect((await request(local).get('/fast')).status).toBe(429);
    finish!(); expect((await slow).status).toBe(200);
    expect((await request(local).get('/fast')).status).toBe(200);
    const limited = await request(local).get('/fast'); expect(limited.status).toBe(429); expect(limited.headers['retry-after']).toBeDefined();
  });
});
