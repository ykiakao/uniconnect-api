import {
  createSupabaseAdminClient,
  createSupabaseAnonClient,
} from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { UserRole } from '../../shared/types';
import { AuthRepository } from './auth.repository';
import { toAuthUserResponse } from './auth.dto';
import { checkAuthError, checkSupabaseAvailability, invalidAuthResponse, isAlreadyInvalidSession, isExistingAuthUser } from '../../shared/supabase-errors';

const adminRoles = new Set<UserRole>(['admin', 'coordinator', 'owner']);

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

  async confirmedIdentity(accessToken: string) {
    const { data, error } = await this.supabase.auth.getUser(accessToken);
    checkAuthError(error, 'session');
    if (!data.user) invalidAuthResponse();
    if (!data.user.email || !data.user.email_confirmed_at) {
      throw new HttpError(403, 'CONFIRMED_EMAIL_REQUIRED', 'Confirme o email antes de aceitar o convite.');
    }
    return { id: data.user.id, email: data.user.email.trim().toLowerCase() };
  }

  async createInvitedAccount(email: string, password: string) {
    const { data, error } = await this.supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    checkSupabaseAvailability(error);
    if (isExistingAuthUser(error)) throw new HttpError(409, 'AUTH_ACCOUNT_EXISTS', 'A conta ja existe. Entre com sua senha e aceite o convite autenticado.');
    if (error) throw new HttpError(500, 'AUTH_USER_CREATE_FAILED', 'Nao foi possivel criar a conta.');
    if (!data.user) invalidAuthResponse();
    return { id: data.user.id, email };
  }

  async invitedSession(email: string, password: string) {
    const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
    checkAuthError(error, 'credentials');
    if (!data.user || !data.session) invalidAuthResponse();
    if (!data.user.email || !data.user.email_confirmed_at) throw new HttpError(403, 'CONFIRMED_EMAIL_REQUIRED', 'Confirme o email antes de aceitar o convite.');
    return { identity: { id: data.user.id, email: data.user.email.trim().toLowerCase() },
      session: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: toIsoExpiresAt(data.session) } };
  }

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

    checkAuthError(error, 'credentials');
    if (!data.user || !data.session) invalidAuthResponse();

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
    if (!['admin', 'gestor'].includes(session.user.role)) {
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
    const { error } = await this.supabaseAdmin.auth.admin.signOut(accessToken);
    checkSupabaseAvailability(error);
    if (error && !isAlreadyInvalidSession(error)) {
      throw new HttpError(500, 'AUTH_LOGOUT_FAILED', 'Nao foi possivel encerrar a sessao.');
    }
  }

  private async findInternalUserByAccessToken(params: {
    accessToken: string;
    tenantId: string;
  }) {
    const { data, error } = await this.supabase.auth.getUser(
      params.accessToken,
    );

    checkAuthError(error, 'session');
    if (!data.user) invalidAuthResponse();

    return this.repository.findUserByAuthId({
      authUserId: data.user.id,
      tenantId: params.tenantId,
    });
  }
}
