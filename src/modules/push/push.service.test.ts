import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../../config/env';
import { sendPushNotification } from './push.service';

jest.mock('firebase-admin/app', () => ({
  applicationDefault: jest.fn(), getApps: jest.fn(), initializeApp: jest.fn(),
}));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));

const send = jest.fn();
const payload = { title: 'Synthetic title', body: 'Synthetic content', data: { type: 'activity_published', activityId: 'activity' } };

beforeEach(() => {
  jest.clearAllMocks();
  env.FCM_ENABLED = 'true';
  jest.mocked(getApps).mockReturnValue([]);
  jest.mocked(applicationDefault).mockReturnValue({} as ReturnType<typeof applicationDefault>);
  jest.mocked(getMessaging).mockReturnValue({ send } as unknown as ReturnType<typeof getMessaging>);
  send.mockReset().mockResolvedValue('synthetic-message-id');
});
afterEach(() => { env.FCM_ENABLED = 'false'; jest.restoreAllMocks(); });

it('does not initialize Firebase or send anything when disabled', async () => {
  env.FCM_ENABLED = 'false';
  expect(await sendPushNotification('synthetic-device', payload)).toBe(false);
  expect(getApps).not.toHaveBeenCalled();
  expect(getMessaging).not.toHaveBeenCalled();
});

it('uses ADC and the configured project to send an FCM notification', async () => {
  expect(await sendPushNotification('synthetic-device', payload)).toBe(true);
  expect(applicationDefault).toHaveBeenCalledTimes(1);
  expect(initializeApp).toHaveBeenCalledWith({ credential: {}, projectId: 'uniconnect-b9c75' });
  expect(send).toHaveBeenCalledWith({ token: 'synthetic-device', notification: { title: payload.title, body: payload.body }, data: payload.data, android: { priority: 'high', notification: { channelId: 'default' } } });
});

it('reuses an existing Firebase app', async () => {
  jest.mocked(getApps).mockReturnValue([{}] as ReturnType<typeof getApps>);
  await sendPushNotification('synthetic-device', payload);
  expect(initializeApp).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(['credential', 'send'])('contains %s failures without logging private error details', async (failure) => {
  const privateDetail = 'synthetic-private-credential-or-token';
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  if (failure === 'credential') jest.mocked(applicationDefault).mockImplementationOnce(() => { throw new Error(privateDetail); });
  else send.mockRejectedValueOnce(new Error(privateDetail));
  expect(await sendPushNotification(privateDetail, payload)).toBe(false);
  expect(log).toHaveBeenCalledWith('[FCM] Falha no envio da notificacao.');
  expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
});
