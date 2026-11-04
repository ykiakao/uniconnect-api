import { env } from '../config/env';
import { ReportsRepository } from '../modules/reports/reports.repository';
import { ReportsService } from '../modules/reports/reports.service';
import { createPlatformPrincipal, institutionalAuthorization, platformAuthorization, PlatformPrincipal } from './authorization';
import { AppUser, Tenant, UserRole } from './types';

const tenant: Tenant = { id: 'synthetic-tenant', slug: 'synthetic', name: 'Synthetic', plan: 'starter', status: 'active', activeUsers: 0 };
const user: AppUser = { id: 'synthetic-user', tenantId: tenant.id, authUserId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'admin', name: 'Synthetic', email: 'synthetic@example.invalid', active: true };
const platformId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const originalAllowlist = [...env.PLATFORM_ADMIN_AUTH_USER_IDS];

beforeEach(() => { env.PLATFORM_ADMIN_AUTH_USER_IDS = [platformId]; });
afterEach(() => { jest.restoreAllMocks(); env.PLATFORM_ADMIN_AUTH_USER_IDS = [...originalAllowlist]; });

describe('authorization projection boundaries', () => {
  it('rejects a mismatched tenant before projecting capabilities', () => {
    expect(() => institutionalAuthorization(user, { ...tenant, id: 'different-tenant' })).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('does not project privileges from an inactive institutional user', () => {
    expect(() => institutionalAuthorization({ ...user, active: false }, tenant)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('fails closed if a dependency returns an unknown institutional role', () => {
    const invalidRole = 'platform_superadmin' as UserRole;
    expect(() => institutionalAuthorization({ ...user, role: invalidRole }, tenant)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('does not share mutable capability or assignment lists across responses', () => {
    const first = institutionalAuthorization(user, tenant);
    first.capabilities.length = 0;
    first.assignableRoles.push('owner');
    const next = institutionalAuthorization(user, tenant);
    expect(next.capabilities).toContain('institution.users.manage');
    expect(next.assignableRoles).toEqual(['student', 'teacher', 'coordinator']);
  });

  it('rejects an institutional principal masquerading as platform context', () => {
    const forged = { scope: 'institution', authUserId: platformId } as unknown as PlatformPrincipal;
    expect(() => platformAuthorization(forged)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('does not query global data when the service receives the wrong scope', async () => {
    const query = jest.spyOn(ReportsRepository.prototype, 'global');
    const forged = { scope: 'institution', authUserId: platformId } as unknown as PlatformPrincipal;
    await expect(new ReportsService().global(forged)).rejects.toMatchObject({ statusCode: 403 });
    expect(query).not.toHaveBeenCalled();
  });

  it('rechecks allowlist authority in the service before querying global data', async () => {
    const principal = createPlatformPrincipal(platformId);
    env.PLATFORM_ADMIN_AUTH_USER_IDS = [];
    const query = jest.spyOn(ReportsRepository.prototype, 'global');
    await expect(new ReportsService().global(principal)).rejects.toMatchObject({ statusCode: 403 });
    expect(query).not.toHaveBeenCalled();
  });
});
