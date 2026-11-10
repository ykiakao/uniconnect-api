import { ApiUserRole, UserRole } from './types';
import { env } from '../config/env';
import { HttpError } from './http-error';

const apiRoleByUserRole: Record<UserRole, ApiUserRole> = {
  student: 'aluno',
  teacher: 'professor',
  coordinator: 'gestor',
  admin: 'admin',
  owner: 'admin',
};

const userRoleByApiRole: Record<ApiUserRole, UserRole> = {
  aluno: 'student',
  professor: 'teacher',
  gestor: 'coordinator',
  admin: 'admin',
};

export function toApiUserRole(role: UserRole): ApiUserRole {
  return apiRoleByUserRole[role];
}

export function toUserRole(role: ApiUserRole): UserRole {
  return userRoleByApiRole[role];
}

export function canManageTenant(role: UserRole) {
  return role === 'admin' || role === 'owner' || role === 'coordinator';
}

const roleRank: Record<UserRole, number> = { student: 0, teacher: 0, coordinator: 1, admin: 2, owner: 3 };

export function canAssignRole(actor: UserRole, desired: UserRole, existing?: UserRole) {
  return canManageTenant(actor) && roleRank[desired] < roleRank[actor] &&
    (existing === undefined || roleRank[existing] < roleRank[actor]);
}

export function ensureCanAssignRole(actor: UserRole, desired: UserRole, existing?: UserRole) {
  if (!canAssignRole(actor, desired, existing)) {
    throw new HttpError(403, 'ROLE_CHANGE_FORBIDDEN', 'Alteracao de papel nao permitida.');
  }
}

export function canAccessPlatform(authUserId: string) {
  return env.PLATFORM_ADMIN_AUTH_USER_IDS.includes(authUserId);
}
