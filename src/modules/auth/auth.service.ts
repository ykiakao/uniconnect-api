import {
  createSupabaseAdminClient,
  createSupabaseAnonClient,
} from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { toApiUserRole } from '../../shared/roles';
import { AppUser, AuthUserResponse, UserRole } from '../../shared/types';
import { AuthRepository } from './auth.repository';

const adminRoles = new Set<UserRole>(['admin', 'coordinator', 'owner']);

function toAuthUserResponse(params: {
  user: AppUser;
  tenantSlug: string;
}): AuthUserResponse {
  return {
    id: params.user.id,
    name: params.user.name,
    email: params.user.email,
    role: toApiUserRole(params.user.role),
    tenantSlug: params.tenantSlug,
  };
}

function toIsoExpiresAt(session: {
  expires_at?: number | null;
  expires_in?: number | null;
}) {
  const expiresAtInSeconds =
    session.expires_at ??
    Math.floor(Date.now() / 1000) + (session.expires_in ?? 0);

  return new Date(expiresAtInSeconds * 1000).toISOString();
}

export class AuthService {
  private readonly supabase = createSupabaseAnonClient();
  private readonly supabaseAdmin = createSupabaseAdminClient();
  private readonly repository = new AuthRepository();

  async login(params: {
    email: string;
    password: string;
    tenantId: string;
    tenantSlug: string;
  }) {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email: params.email,
      password: params.password,
    });

    if (error || !data.user || !data.session) {
      throw new HttpError(
        401,
        'INVALID_CREDENTIALS',
        'E-mail ou senha incorretos',
        error?.message,
      );
    }

    const user = await this.repository.findUserByAuthId({
      authUserId: data.user.id,
      tenantId: params.tenantId,
    });

    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: toIsoExpiresAt(data.session),
      user: toAuthUserResponse({
        user,
        tenantSlug: params.tenantSlug,
      }),
    };
  }

  async loginAdmin(params: {
    email: string;
    password: string;
    tenantId: string;
    tenantSlug: string;
  }) {
    const session = await this.login(params);
    const user = await this.repository.findUserByEmail({
      email: params.email,
      tenantId: params.tenantId,
    });

    if (!adminRoles.has(user.role)) {
      throw new HttpError(
        403,
        'ADMIN_ACCESS_REQUIRED',
        'Acesso administrativo restrito a coordenadores e mantenedores.',
      );
    }

    return session;
  }

  async findUserByAccessToken(params: {
    accessToken: string;
    tenantId: string;
    tenantSlug: string;
  }) {
    const user = await this.findInternalUserByAccessToken(params);

    return toAuthUserResponse({
      user,
      tenantSlug: params.tenantSlug,
    });
  }

  async findAdminUserByAccessToken(params: {
    accessToken: string;
    tenantId: string;
    tenantSlug: string;
  }) {
    const user = await this.findInternalUserByAccessToken(params);

    if (!adminRoles.has(user.role)) {
      throw new HttpError(
        403,
        'ADMIN_ACCESS_REQUIRED',
        'Sessao sem permissao administrativa.',
      );
    }

    return toAuthUserResponse({
      user,
      tenantSlug: params.tenantSlug,
    });
  }

  async logout(accessToken: string) {
    await this.supabaseAdmin.auth.admin.signOut(accessToken);
  }

  private async findInternalUserByAccessToken(params: {
    accessToken: string;
    tenantId: string;
  }) {
    const { data, error } = await this.supabase.auth.getUser(
      params.accessToken,
    );

    if (error || !data.user) {
      throw new HttpError(
        401,
        'INVALID_SESSION',
        'Sessão inválida ou expirada.',
        error?.message,
      );
    }

    return this.repository.findUserByAuthId({
      authUserId: data.user.id,
      tenantId: params.tenantId,
    });
  }
}
