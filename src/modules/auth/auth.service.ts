import { createSupabaseAnonClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { UserRole } from '../../shared/types';
import { AuthRepository } from './auth.repository';

const adminRoles = new Set<UserRole>(['admin', 'coordinator', 'owner']);

export class AuthService {
  private readonly supabase = createSupabaseAnonClient();
  private readonly repository = new AuthRepository();

  async login(params: {
    email: string;
    password: string;
    tenantId: string;
  }) {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email: params.email,
      password: params.password,
    });

    if (error || !data.user || !data.session) {
      throw new HttpError(401, 'Credenciais inválidas.', error?.message);
    }

    const user = await this.repository.findUserByAuthId({
      authUserId: data.user.id,
      tenantId: params.tenantId,
    });

    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at,
      user,
    };
  }

  async loginAdmin(params: {
    email: string;
    password: string;
    tenantId: string;
  }) {
    const session = await this.login(params);

    if (!adminRoles.has(session.user.role)) {
      throw new HttpError(
        403,
        'Acesso administrativo restrito a coordenadores e mantenedores.',
      );
    }

    return session;
  }

  async findUserByAccessToken(params: {
    accessToken: string;
    tenantId: string;
  }) {
    const { data, error } = await this.supabase.auth.getUser(
      params.accessToken,
    );

    if (error || !data.user) {
      throw new HttpError(401, 'Sessão inválida ou expirada.', error?.message);
    }

    return this.repository.findUserByAuthId({
      authUserId: data.user.id,
      tenantId: params.tenantId,
    });
  }

  async findAdminUserByAccessToken(params: {
    accessToken: string;
    tenantId: string;
  }) {
    const user = await this.findUserByAccessToken(params);

    if (!adminRoles.has(user.role)) {
      throw new HttpError(
        403,
        'Sessao sem permissao administrativa.',
      );
    }

    return user;
  }
}
