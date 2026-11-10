import { HttpError } from './http-error';
import { canAccessPlatform, canAssignRole } from './roles';
import { AppUser, Tenant, UserRole } from './types';

export type PlatformPrincipal = Readonly<{ scope: 'platform'; authUserId: string }>;

export type AcademicCapability =
  | 'academic.catalog.read' | 'academic.classes.read' | 'academic.activities.read'
  | 'academic.self.read' | 'academic.activities.manage' | 'academic.activities.publish'
  | 'academic.grades.read' | 'academic.grades.record' | 'academic.submissions.read'
  | 'academic.submissions.review' | 'academic.submissions.own.read' | 'academic.submissions.submit';
export type InstitutionalCapability = AcademicCapability
  | 'institution.users.manage' | 'institution.invites.manage' | 'institution.academic.manage'
  | 'institution.courses.manage' | 'institution.classes.manage' | 'institution.reports.read';

export const platformCapabilities = ['platform.reports.read', 'platform.institutions.read', 'platform.institutions.manage', 'platform.institutions.bootstrap', 'platform.audit.read', 'platform.accounts.provision', 'platform.institutions.responsible.manage'] as const;
export type PlatformCapability = typeof platformCapabilities[number];
type PlatformAuthorization = PlatformPrincipal & {
  profile: 'platform_superadmin'; capabilities: PlatformCapability[];
};
type InstitutionalAuthorization = {
  scope: 'institution'; profile: 'institution_admin' | 'teacher' | 'student';
  userId: string; tenant: { id: string; slug: string }; institutionalRole: UserRole;
  academicScope: 'institution' | 'assigned_classes' | 'own_records';
  capabilities: InstitutionalCapability[]; assignableRoles: UserRole[];
};

const readers: AcademicCapability[] = ['academic.catalog.read', 'academic.classes.read', 'academic.activities.read'];
const managers: InstitutionalCapability[] = [
  ...readers, 'institution.users.manage', 'institution.invites.manage', 'institution.academic.manage',
  'institution.courses.manage', 'institution.classes.manage', 'institution.reports.read',
  'academic.activities.manage', 'academic.grades.read', 'academic.grades.record', 'academic.submissions.read',
];
const capabilitiesByRole: Record<UserRole, readonly InstitutionalCapability[]> = {
  owner: managers, admin: managers, coordinator: managers,
  teacher: [...readers, 'academic.self.read', 'academic.activities.manage', 'academic.activities.publish',
    'academic.grades.read', 'academic.grades.record', 'academic.submissions.read', 'academic.submissions.review'],
  student: [...readers, 'academic.self.read', 'academic.grades.read', 'academic.submissions.own.read', 'academic.submissions.submit'],
};
const institutionalRoles: UserRole[] = ['student', 'teacher', 'coordinator', 'admin', 'owner'];

export function createPlatformPrincipal(authUserId: string): PlatformPrincipal {
  if (!canAccessPlatform(authUserId)) throw new HttpError(403, 'FORBIDDEN', 'Acesso nao permitido.');
  return { scope: 'platform', authUserId };
}

export function platformAuthorization(principal: PlatformPrincipal): PlatformAuthorization {
  if (principal.scope !== 'platform') throw new HttpError(403, 'FORBIDDEN', 'Contexto de plataforma invalido.');
  return { ...createPlatformPrincipal(principal.authUserId), profile: 'platform_superadmin', capabilities: [...platformCapabilities] };
}

export function requirePlatformCapability(principal: PlatformPrincipal, capability: PlatformCapability) {
  if (!platformAuthorization(principal).capabilities.includes(capability)) throw new HttpError(403, 'FORBIDDEN', 'Capacidade de plataforma nao autorizada.');
}

export function institutionalAuthorization(user: AppUser, tenant: Tenant): InstitutionalAuthorization {
  if (user.tenantId !== tenant.id || user.active === false || !institutionalRoles.includes(user.role)) {
    throw new HttpError(403, 'FORBIDDEN', 'Contexto institucional invalido.');
  }
  const profile = user.role === 'student' || user.role === 'teacher' ? user.role : 'institution_admin';
  return {
    scope: 'institution', profile, userId: user.id, tenant: { id: tenant.id, slug: tenant.slug },
    institutionalRole: user.role,
    academicScope: user.role === 'student' ? 'own_records' : user.role === 'teacher' ? 'assigned_classes' : 'institution',
    capabilities: [...capabilitiesByRole[user.role]],
    assignableRoles: institutionalRoles.filter(desired => canAssignRole(user.role, desired)),
  };
}
