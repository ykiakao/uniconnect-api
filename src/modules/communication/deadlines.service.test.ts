import { spawnSync } from 'node:child_process';
import * as supabase from '../../config/supabase';
import { parseDeadlineArguments, DeadlineNotificationService } from './deadlines.service';

const tenantId = '11111111-1111-1111-1111-111111111111';
afterEach(() => jest.restoreAllMocks());

describe('explicit upcoming deadline maintenance', () => {
  it('validates mandatory tenant and supplies bounded defaults', () => {
    expect(parseDeadlineArguments(['--tenant-id', tenantId])).toEqual({ tenantId, windowMinutes: 1440, limit: 100, afterId: null });
  });
  it.each([
    [], ['--tenant-id', 'invalid'], ['--tenant-id', tenantId, '--url', 'https://forbidden.invalid'],
    ['--tenant-id', tenantId, '--window-minutes', '0'], ['--tenant-id', tenantId, '--window-minutes', '10081'],
    ['--tenant-id', tenantId, '--limit', '101'], ['--tenant-id', tenantId, '--after-id', 'invalid'],
    ['--tenant-id', tenantId, '--tenant-id', tenantId], ['--tenant-id', tenantId, '--limit'],
  ].map(args => [args]))('rejects unsafe or ambiguous invocation %#', args => {
    expect(() => parseDeadlineArguments(args)).toThrow();
  });
  it('executes exactly one bounded page using the privileged RPC and returns only safe counts/cursor', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { processed_activities: 2, created_notifications: 3, has_more: true, next_after_id: tenantId }, error: null, status: 200 });
    const original = supabase.createSupabaseAdminClient();
    jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue({ ...original, rpc } as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
    const args = parseDeadlineArguments(['--tenant-id', tenantId, '--window-minutes', '120', '--limit', '2']);
    await expect(new DeadlineNotificationService().run(args)).resolves.toEqual({ processedActivities: 2, createdNotifications: 3, hasMore: true, nextAfterId: tenantId });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('generate_academic_deadline_notifications', { p_tenant_id: tenantId, p_window_minutes: 120, p_limit: 2, p_after_id: null });
  });
  it('does not treat failed maintenance as success', async () => {
    const original = supabase.createSupabaseAdminClient();
    const rpc = jest.fn().mockResolvedValue({ data: null, error: {code:'08006',message:'PRIVATE credentials'}, status: 503 });
    jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue({ ...original, rpc } as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
    await expect(new DeadlineNotificationService().run(parseDeadlineArguments(['--tenant-id',tenantId]))).rejects.toMatchObject({statusCode:503,details:undefined});
  });
  it('rejects an invalid maintenance result rather than losing a page silently', async () => {
    const original = supabase.createSupabaseAdminClient();
    const rpc = jest.fn().mockResolvedValue({ data: { processed_activities:2,created_notifications:0,has_more:true,next_after_id:null }, error:null,status:200 });
    jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue({...original,rpc} as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
    await expect(new DeadlineNotificationService().run(parseDeadlineArguments(['--tenant-id',tenantId]))).rejects.toMatchObject({statusCode:502});
  });
  it('prints CLI help without loading configuration or contacting a database', () => {
    const result = spawnSync(process.execPath,['scripts/notify-upcoming-deadlines.cjs','--help'],{encoding:'utf8',env:{...process.env,SUPABASE_URL:'',SUPABASE_SERVICE_ROLE_KEY:''}});
    expect(result.status).toBe(0);expect(result.stdout).toContain('--tenant-id');expect(result.stderr).toBe('');
  });
});
