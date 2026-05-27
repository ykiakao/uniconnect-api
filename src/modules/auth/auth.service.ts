import { createSupabaseAnonClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { AuthRepository } from './auth.repository';

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
}
