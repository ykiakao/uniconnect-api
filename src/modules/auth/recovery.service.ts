import { env } from '../../config/env';
import { createSupabaseAnonClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { checkSupabaseAvailability, invalidAuthResponse } from '../../shared/supabase-errors';
import { AuthOperationClientFactory, authOperation, requireCoherentSession, requireVerifiedIdentity } from './session.client';

function checkPasswordProofError(error: { code?: string; status?: number } | null) {
  checkSupabaseAvailability(error);
  if (!error) return;
  if (error.status === 429) throw new HttpError(429, 'AUTH_RATE_LIMIT', 'Limite de autenticacao atingido. Tente novamente mais tarde.');
  throw new HttpError(401, 'RECOVERY_INVALID_OR_EXPIRED', 'Comprovante invalido ou expirado. Solicite um novo envio.');
}

export class RecoveryService {
  constructor(
    private readonly createClient: AuthOperationClientFactory = createSupabaseAnonClient,
    private readonly recoveryRedirect: () => string | undefined = () => env.AUTH_RECOVERY_REDIRECT_URL,
  ) {}

  async requestRecovery(email: string) {
    const redirectTo = this.recoveryRedirect();
    if (!redirectTo) throw new HttpError(503, 'AUTH_RECOVERY_NOT_CONFIGURED', 'Recuperacao de senha indisponivel.');
    return authOperation(async () => {
      const { error } = await this.createClient().auth.resetPasswordForEmail(email, { redirectTo });
      checkSupabaseAvailability(error);
      if (!error || ['user_not_found', 'email_not_confirmed', 'user_banned', 'over_email_send_rate_limit'].includes(String(error.code))) return;
      throw new HttpError(503, 'AUTH_RECOVERY_UNAVAILABLE', 'Recuperacao de senha temporariamente indisponivel.');
    });
  }

  async changePassword(input: { tokenHash: string; newPassword: string }, type: 'recovery' | 'invite') {
    return authOperation(async () => {
      const client = this.createClient();
      const proof = await client.auth.verifyOtp({ token_hash: input.tokenHash, type });
      checkPasswordProofError(proof.error);
      const session = requireCoherentSession(proof.data);
      const verified = await client.auth.getUser(session.access_token);
      checkPasswordProofError(verified.error);
      requireVerifiedIdentity(verified.data.user, session.user.id);
      const updated = await client.auth.updateUser({ password: input.newPassword });
      checkSupabaseAvailability(updated.error);
      if (updated.error) throw new HttpError(400, 'PASSWORD_UPDATE_REJECTED', 'Nao foi possivel definir a senha solicitada.');
      let revocationFailed = false;
      try { revocationFailed = Boolean((await client.auth.signOut({ scope: 'global' })).error); }
      catch { revocationFailed = true; }
      if (revocationFailed) throw new HttpError(503, 'PASSWORD_CHANGED_REVOCATION_FAILED', 'A senha foi alterada, mas nao foi possivel encerrar todas as sessoes. Solicite suporte antes de continuar.');
      if (!updated.data.user || updated.data.user.id !== session.user.id) invalidAuthResponse();
    });
  }
}
