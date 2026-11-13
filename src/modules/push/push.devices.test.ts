import { getPushTokens, registerPushDevice, unregisterPushDevice } from './push.devices';

const token = 'synthetic-fcm-device-token';
afterEach(() => {
  for (const tenant of ['tenant-a', 'tenant-b']) {
    for (const user of ['student', 'teacher']) unregisterPushDevice(tenant, user, token);
  }
});

it('registers a device idempotently and scopes reads by tenant and recipient', () => {
  registerPushDevice('tenant-a', 'student', token);
  registerPushDevice('tenant-a', 'student', token);
  expect(getPushTokens('tenant-a', ['student'])).toEqual([token]);
  expect(getPushTokens('tenant-b', ['student'])).toEqual([]);
  expect(getPushTokens('tenant-a', ['teacher'])).toEqual([]);
  expect(getPushTokens('tenant-a', [])).toEqual([]);
});

it('transfers the same device without retaining associations to previous owners', () => {
  registerPushDevice('tenant-a', 'student', token);
  registerPushDevice('tenant-b', 'teacher', token);
  expect(getPushTokens('tenant-a', ['student'])).toEqual([]);
  expect(getPushTokens('tenant-b', ['teacher'])).toEqual([token]);
});

it('only the owning user in the owning tenant can unregister the device', () => {
  registerPushDevice('tenant-a', 'student', token);
  unregisterPushDevice('tenant-b', 'student', token);
  unregisterPushDevice('tenant-a', 'teacher', token);
  expect(getPushTokens('tenant-a', ['student'])).toEqual([token]);
  unregisterPushDevice('tenant-a', 'student', token);
  unregisterPushDevice('tenant-a', 'student', token);
  expect(getPushTokens('tenant-a', ['student'])).toEqual([]);
});
