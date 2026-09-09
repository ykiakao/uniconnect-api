process.env.NODE_ENV = 'test';
process.env.API_VERSION = 'v1';
process.env.APP_ORIGIN =
  'http://127.0.0.1:8080,http://localhost:3000,http://127.0.0.1:5173';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

jest.mock('../config/supabase', () => require('./supabase-mock'));
