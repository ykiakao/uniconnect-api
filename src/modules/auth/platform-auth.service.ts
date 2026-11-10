import { createSupabaseAnonClient } from '../../config/supabase';
import { createPlatformPrincipal, platformAuthorization } from '../../shared/authorization';
import { checkAuthError, invalidAuthResponse } from '../../shared/supabase-errors';

export class PlatformAuthService {
  private readonly supabase = createSupabaseAnonClient();

  async authorize(accessToken: string) {
    const { data, error } = await this.supabase.auth.getUser(accessToken);
    checkAuthError(error, 'session');
    if (!data.user) invalidAuthResponse();
    return createPlatformPrincipal(data.user.id);
  }

  async login(credentials: { email: string; password: string }) {
    const { data, error } = await this.supabase.auth.signInWithPassword(credentials);
    checkAuthError(error, 'credentials');
    if (!data.user || !data.session) invalidAuthResponse();
    const authorization = platformAuthorization(createPlatformPrincipal(data.user.id));
    const expiresAt = data.session.expires_at ?? Math.floor(Date.now() / 1000) + (data.session.expires_in ?? 0);
    return {
      accessToken: data.session.access_token, refreshToken: data.session.refresh_token,
      expiresAt: new Date(expiresAt * 1000).toISOString(), authorization,
    };
  }
}
