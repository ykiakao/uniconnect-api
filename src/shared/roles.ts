import { ApiUserRole, UserRole } from './types';

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
