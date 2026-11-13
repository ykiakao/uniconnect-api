const original = { enabled: process.env.FCM_ENABLED, project: process.env.FIREBASE_PROJECT_ID };
afterEach(() => {
  if (original.enabled === undefined) delete process.env.FCM_ENABLED;
  else process.env.FCM_ENABLED = original.enabled;
  if (original.project === undefined) delete process.env.FIREBASE_PROJECT_ID;
  else process.env.FIREBASE_PROJECT_ID = original.project;
});

function config() {
  let result: { FCM_ENABLED: string; FIREBASE_PROJECT_ID?: string } | undefined;
  jest.isolateModules(() => { result = require('../../config/env').env; });
  return result!;
}

it('defaults to disabled without requiring a Firebase project', () => {
  delete process.env.FCM_ENABLED;
  delete process.env.FIREBASE_PROJECT_ID;
  expect(config().FCM_ENABLED).toBe('false');
});

it('requires an explicit project when FCM is enabled', () => {
  process.env.FCM_ENABLED = 'true';
  delete process.env.FIREBASE_PROJECT_ID;
  expect(config).toThrow('FIREBASE_PROJECT_ID');
});

it('accepts the configured Firebase project when enabled', () => {
  process.env.FCM_ENABLED = 'true';
  process.env.FIREBASE_PROJECT_ID = 'uniconnect-b9c75';
  expect(config()).toMatchObject({ FCM_ENABLED: 'true', FIREBASE_PROJECT_ID: 'uniconnect-b9c75' });
});

it.each(['yes', '1'])('rejects ambiguous enabled value %s', (value) => {
  process.env.FCM_ENABLED = value;
  expect(config).toThrow('FCM_ENABLED');
});
