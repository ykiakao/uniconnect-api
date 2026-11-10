import request from 'supertest';
import { app } from '../../app';
import { reviewSchema } from './activities.workflow.schemas';

const input = { expectedRevision: 0, submissionVersion: 1, publish: false };
describe('review HTTP grade precision contract', () => {
  it.each([0, null, 1, 7.2, 7.25, 10, 0.29, 1.1, 1e-2, 7.2500])('preserves valid value %s without transformation', grade => {
    expect(reviewSchema.parse({ ...input, grade }).grade).toBe(grade);
  });
  it.each([7.255, 7.2549, 0.001, 1e-7, 0.1 + 0.2, 1.0000000000000002, -0.01, 10.01, NaN, Infinity])('rejects incompatible grade %s', grade => {
    expect(reviewSchema.safeParse({ ...input, grade }).success).toBe(false);
  });
  it('keeps omitted grade optional', () => {
    expect(reviewSchema.parse(input).grade).toBeUndefined();
  });
  it('returns clear HTTP 400 before trying to correct a submission', async () => {
    const response = await request(app).put('/api/v1/tenants/edukmais/submissions/00000000-0000-4000-8000-000000000001/review')
      .set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-teacher-token')
      .send({ ...input, grade: 7.255 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).toContain('duas casas decimais');
  });
});
