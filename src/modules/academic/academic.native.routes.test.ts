import request from 'supertest';
import { app } from '../../app';
import { env } from '../../config/env';
import { createSupabaseAdminClient } from '../../config/supabase';
import { AcademicStructureRepository } from '../academic-structure/academic-structure.repository';
import { HttpError } from '../../shared/http-error';

const original = env.ACADEMIC_PROVIDER;
const base = '/api/v1/tenants/edukmais';
const db = createSupabaseAdminClient();
const tenantId = '11111111-1111-1111-1111-111111111111';
function get(path: string, role = 'student') {
  return request(app).get(`${base}/academic${path}`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer valid-${role}-token`);
}
beforeEach(() => { env.ACADEMIC_PROVIDER = 'native'; });
afterEach(() => { env.ACADEMIC_PROVIDER = original; jest.restoreAllMocks(); });

describe('native academic HTTP integration', () => {
  it('uses persisted data with existing authentication and safe response headers', async () => {
    const login = await request(app).post('/api/v1/auth/login').set('x-tenant-slug', 'edukmais').send({ email: 'aluno@edukmais.edu.br', password: 'password123' });
    expect(login.status).toBe(200);
    const response = await request(app).get(`${base}/academic/overview`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer ${login.body.accessToken}`);
    expect(response.status).toBe(200);
    expect(response.body.source).toMatchObject({ providerId: 'native', demonstration: false });
    expect(response.body.scope).toEqual({ tenantId, userId: 'user-student' });
    expect(response.body.subjects[0].id).toBe('subject-existing');
    expect(response.body.subjects[0].assessments[0]).toMatchObject({ activityId: 'activity-existing', grade: 8.5, feedback: 'Bom trabalho' });
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers.etag).toBeUndefined();
  });
  it('reflects a legitimate grade change and preserves an explicit zero', async () => {
    const response = await request(app).put(`${base}/activities/activity-existing/grades/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`).set('x-tenant-slug', 'edukmais')
      .set('authorization', 'Bearer valid-teacher-token').send({ grade: 0, feedback: 'Synthetic feedback' });
    expect(response.status).toBe(200);
    const overview = await get('/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.subjects[0].assessments[0]).toMatchObject({ grade: 0, feedback: 'Synthetic feedback' });
    expect(overview.body.subjects[0].grades).toBeNull();
    expect(overview.body.subjects[0].attendance.absences).toBeNull();
  });
  it('reads persisted periods and history without consulting external portals', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('External requests forbidden'));
    const periods = await get('/periods');
    expect(periods.status).toBe(200); expect(periods.body.periods[0].id).toBe('period-existing');
    const history = await get('/history');
    expect(history.status).toBe(200); expect(history.body.periods[0].subjects[0].offeringId).toBe('class-teacher');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns no subjects for a teacher without a current assignment', async () => {
    await db.from('teaching_assignments').update({ status: 'inactive' }).eq('id', 'assignment-existing');
    try {
      const response = await get('/overview', 'teacher');
      expect(response.status).toBe(200); expect(response.body.subjects).toEqual([]);
    } finally { await db.from('teaching_assignments').update({ status: 'active' }).eq('id', 'assignment-existing'); }
  });
  it('does not turn a management role into an arbitrary student academic profile', async () => {
    expect((await get('/overview', 'coordinator')).status).toBe(403);
    expect((await get('/overview?userId=other')).status).toBe(400);
    expect((await get('/overview?provider=demo')).status).toBe(400);
  });
  it('returns a sanitized unavailable response for failed persisted-data queries', async () => {
    jest.spyOn(AcademicStructureRepository.prototype, 'list').mockRejectedValue(new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'Servico de dados indisponivel.'));
    const response = await get('/periods');
    expect(response.status).toBe(503); expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });
  it('keeps tenant and user selection under server control', async () => {
    expect((await request(app).get('/api/v1/tenants/other/academic/overview').set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-student-token')).status).toBe(404);
    env.ACADEMIC_PROVIDER = 'demo';
    const response = await get('/overview');
    expect(response.status).toBe(200); expect(response.body.source.demonstration).toBe(true); expect(response.body.subjects).toHaveLength(5);
  });
});
