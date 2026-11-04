import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import { app } from '../../app';
import { env } from '../../config/env';
import * as supabase from '../../config/supabase';
import { ActivitiesRepository } from '../activities/activities.repository';

const previous = env.ACADEMIC_PROVIDER;
afterEach(() => { env.ACADEMIC_PROVIDER = previous; jest.restoreAllMocks(); });

it('preserves long feedback and activity texts accepted by existing HTTP write contracts', async () => {
  env.ACADEMIC_PROVIDER = 'native';
  const base = '/api/v1/tenants/edukmais';
  const feedback = 'F'.repeat(2001), title = 'T'.repeat(2001), description = 'D'.repeat(2001), type = 'Y'.repeat(2001);
  const grade = await request(app).put(`${base}/activities/activity-existing/grades/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`)
    .set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-teacher-token').send({ grade: 7, feedback });
  expect(grade.status).toBe(200);
  const activity = await request(app).put(`${base}/activities/activity-existing`).set('x-tenant-slug', 'edukmais')
    .set('authorization', 'Bearer valid-coordinator-token').send({ title, description, type });
  expect(activity.status).toBe(200);
  const result = await request(app).get(`${base}/academic/overview`).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-student-token');
  expect(result.status).toBe(200);
  expect(result.body.subjects[0].assessments[0]).toMatchObject({ feedback, title });
  expect(result.body.subjects[0].activities[0]).toMatchObject({ title, description, type });
});

it('sends a unique ordering to PostgREST for activities with equal or null deadlines', async () => {
  const urls: URL[] = [];
  const fetch = jest.fn(async (input: RequestInfo | URL) => {
    urls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } });
  });
  const client = createClient('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
  });
  jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue(client);
  await new ActivitiesRepository().listByClass({ tenantId: 'synthetic-tenant', classId: 'synthetic-class', pagination: { page: 2, limit: 100, offset: 100 } });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(urls[0].searchParams.get('order')).toBe('due_date.asc,id.asc');
  expect(urls[0].searchParams.get('offset')).toBe('100');
});
