import request from 'supertest';
import { app } from '../../app';
import { env } from '../../config/env';
import { unregisterPushDevice } from './push.devices';
import { sendPushNotification } from './push.service';

jest.mock('./push.service', () => ({ sendPushNotification: jest.fn() }));
const tenant = '11111111-1111-1111-1111-111111111111';
const token = 'synthetic-publication-device-token';
const base = '/api/v1/tenants/edukmais';
function call(path: string, role = 'teacher') {
  return request(app).post(`${base}${path}`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer valid-${role}-token`);
}
async function draft() {
  const response = await call('/classes/class-teacher/activities').send({ title: 'Synthetic FCM publication' });
  expect(response.status).toBe(201);
  return response.body as { id: string; revision: number };
}
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(async () => {
  env.FCM_ENABLED = 'true';
  jest.mocked(sendPushNotification).mockReset().mockResolvedValue(true);
  expect((await call('/notifications/devices', 'student').send({ token })).status).toBe(204);
});
afterEach(() => {
  env.FCM_ENABLED = 'false';
  unregisterPushDevice(tenant, 'user-student', token);
  jest.restoreAllMocks();
});

it('publishes first, sends to enrolled registered students, and does not send on a rejected retry', async () => {
  const activity = await draft();
  expect(sendPushNotification).not.toHaveBeenCalled();
  const result = await call(`/activities/${activity.id}/publish`).send({ expectedVersion: activity.revision });
  expect(result.status).toBe(200);
  expect(result.body.state).toBe('published');
  await drain();
  expect(sendPushNotification).toHaveBeenCalledTimes(1);
  expect(sendPushNotification).toHaveBeenCalledWith(token, expect.objectContaining({ data: expect.objectContaining({ activityId: activity.id, type: 'activity_published' }) }));
  expect((await call(`/activities/${activity.id}/publish`).send({ expectedVersion: activity.revision })).status).toBe(409);
  expect((await call(`/activities/${activity.id}/close`).send({ expectedVersion: result.body.revision })).status).toBe(200);
  await drain();
  expect(sendPushNotification).toHaveBeenCalledTimes(1);
});

it('does not send when publication is forbidden', async () => {
  const activity = await draft();
  expect((await call(`/activities/${activity.id}/publish`, 'student').send({ expectedVersion: activity.revision })).status).toBe(403);
  await drain();
  expect(sendPushNotification).not.toHaveBeenCalled();
});

it('preserves successful publication when FCM is disabled', async () => {
  env.FCM_ENABLED = 'false';
  const activity = await draft();
  expect((await call(`/activities/${activity.id}/publish`).send({ expectedVersion: activity.revision })).status).toBe(200);
  await drain();
  expect(sendPushNotification).not.toHaveBeenCalled();
});

it('preserves successful publication when a push dependency fails, without leaking details', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.mocked(sendPushNotification).mockRejectedValueOnce(new Error('synthetic-private-push-detail'));
  const activity = await draft();
  expect((await call(`/activities/${activity.id}/publish`).send({ expectedVersion: activity.revision })).status).toBe(200);
  await drain();
  expect(log).toHaveBeenCalledWith('[FCM] Falha ao notificar atividade publicada.');
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-push-detail');
});

it('does not block the academic response while a push send is still pending', async () => {
  let finish!: (value: boolean) => void;
  jest.mocked(sendPushNotification).mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
  const activity = await draft();
  try {
    const result = await call(`/activities/${activity.id}/publish`).send({ expectedVersion: activity.revision }).timeout({ response: 1500 });
    expect(result.status).toBe(200);
    expect(result.body.state).toBe('published');
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  } finally { finish?.(true); await drain(); }
});
