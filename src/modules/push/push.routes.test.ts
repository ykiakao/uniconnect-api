import request from 'supertest';
import { app } from '../../app';
import { routeRegistry } from '../../routes';
import { getPushTokens, unregisterPushDevice } from './push.devices';

const tenant = '11111111-1111-1111-1111-111111111111';
const base = '/api/v1/tenants/edukmais/notifications/devices';
const token = 'synthetic-http-fcm-device-token';
function call(method: 'post' | 'delete', role = 'student') {
  return request(app)[method](base).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer valid-${role}-token`);
}
afterEach(() => {
  unregisterPushDevice(tenant, 'user-student', token);
  unregisterPushDevice(tenant, 'user-teacher', token);
});

it('exposes both authenticated endpoints in the route registry', () => {
  expect(routeRegistry.resolve('POST', base)).toBe('/api/v1/tenants/:slug/notifications/devices');
  expect(routeRegistry.resolve('DELETE', base)).toBe('/api/v1/tenants/:slug/notifications/devices');
});

it('registers idempotently and unregisters using the authenticated identity', async () => {
  expect((await call('post').send({ token })).status).toBe(204);
  expect((await call('post').send({ token })).status).toBe(204);
  expect(getPushTokens(tenant, ['user-student'])).toEqual([token]);
  expect((await call('delete').send({ token })).status).toBe(204);
  expect((await call('delete').send({ token })).status).toBe(204);
  expect(getPushTokens(tenant, ['user-student'])).toEqual([]);
});

it('reassigns a shared device and protects it from the previous user logout', async () => {
  await call('post').send({ token });
  expect((await call('post', 'teacher').send({ token })).status).toBe(204);
  expect((await call('delete').send({ token })).status).toBe(204);
  expect(getPushTokens(tenant, ['user-student'])).toEqual([]);
  expect(getPushTokens(tenant, ['user-teacher'])).toEqual([token]);
});

it.each(['post', 'delete'] as const)('%s requires authentication and rejects tenant spoofing', async (method) => {
  expect((await request(app)[method](base).set('x-tenant-slug', 'edukmais').send({ token })).status).toBe(401);
  expect((await request(app)[method](base).set('authorization', 'Bearer valid-student-token').send({ token })).status).toBe(400);
  const mismatch = await request(app)[method]('/api/v1/tenants/another-institution/notifications/devices')
    .set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-student-token').send({ token });
  expect(mismatch.status).toBe(404);
  expect(getPushTokens(tenant, ['user-student'])).toEqual([]);
});

it.each([{}, { token: 'short' }, { token: 'x'.repeat(4097) }, { token, userId: 'another-user' }, { token, tenantId: 'another-tenant' }])('rejects invalid or client-selected identity fields', async (body) => {
  const response = await call('post').send(body);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(JSON.stringify(response.body)).not.toContain(token);
  expect(getPushTokens(tenant, ['user-student'])).toEqual([]);
});
