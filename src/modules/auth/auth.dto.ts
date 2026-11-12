import { toApiUserRole } from '../../shared/roles';
import { AppUser, AuthUserResponse } from '../../shared/types';

export function toAuthUserResponse(params: { user: AppUser; tenantSlug: string }): AuthUserResponse {
  return {
    id: params.user.id,
    name: params.user.name,
    email: params.user.email,
    role: toApiUserRole(params.user.role),
    tenantSlug: params.tenantSlug,
    course: params.user.course,
    registration: params.user.registration,
    semester: params.user.semester,
  };
}
