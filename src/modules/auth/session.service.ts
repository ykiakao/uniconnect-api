import { createSupabaseAnonClient } from '../../config/supabase';
import { createPlatformPrincipal, platformAuthorization } from '../../shared/authorization';
import { checkAuthError, checkSupabaseAvailability } from '../../shared/supabase-errors';
import { HttpError } from '../../shared/http-error';
import { Tenant } from '../../shared/types';
import { toApiUserRole } from '../../shared/roles';
import { TenantRepository } from '../tenants/tenant.repository';
import { AuthRepository } from './auth.repository';
import { AuthOperationClientFactory, authOperation, requireCoherentSession, requireVerifiedIdentity, sessionTokens } from './session.client';

export class SessionService {
  constructor(
    private readonly createClient: AuthOperationClientFactory = createSupabaseAnonClient,
    private readonly repository: Pick<AuthRepository, 'findUserByAuthId'> = new AuthRepository(),
    private readonly tenants: Pick<TenantRepository, 'requireOperationalById'> = new TenantRepository(),
  ) {}

  private async rotate(refreshToken: string) {
    return authOperation(async () => {
      const client = this.createClient();
      const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
      checkSupabaseAvailability(error);
      if (error && ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'user_not_found', 'user_banned', 'bad_jwt', 'validation_failed'].includes(String(error.code))) {
        throw new HttpError(401, 'INVALID_SESSION', 'Sessao invalida ou expirada.');
      }
      checkAuthError(error, 'session');
      const session = requireCoherentSession(data);
      const identity = await client.auth.getUser(session.access_token);
      checkAuthError(identity.error, 'session');
      requireVerifiedIdentity(identity.data.user, session.user.id);
      return session;
    });
  }

  async refreshInstitution(params: { refreshToken: string; tenant: Pick<Tenant, 'id' | 'slug'>; administrative?: boolean }) {
    const session = await this.rotate(params.refreshToken);
    const user = await this.repository.findUserByAuthId({ authUserId: session.user.id, tenantId: params.tenant.id });
    await this.tenants.requireOperationalById(params.tenant.id);
    if (user.active === false || user.tenantId !== params.tenant.id || user.authUserId !== session.user.id) {
      throw new HttpError(403, 'USER_NOT_LINKED_TO_TENANT', 'Vinculo institucional invalido.');
    }
    if (params.administrative && !['owner', 'admin', 'coordinator'].includes(user.role)) {
      throw new HttpError(403, 'ADMIN_ACCESS_REQUIRED', 'Sessao sem permissao administrativa.');
    }
    return { ...sessionTokens(session), user: { id: user.id, name: user.name, email: user.email,
      role: toApiUserRole(user.role), tenantSlug: params.tenant.slug, course: user.course } };
  }

  async refreshPlatform(refreshToken: string) {
    const session = await this.rotate(refreshToken);
    const authorization = platformAuthorization(createPlatformPrincipal(session.user.id));
    return { ...sessionTokens(session), authorization };
  }
}
