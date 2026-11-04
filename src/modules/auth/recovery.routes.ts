import { Router } from 'express';
import { RecoveryService } from './recovery.service';
import { passwordProofSchema, recoveryEmailSchema, requireJsonAuthProof } from './session.schemas';

const service = new RecoveryService();
export const publicRecoveryRoutes = Router();

publicRecoveryRoutes.post('/password/recovery', async (request, response, next) => {
  try {
    requireJsonAuthProof(request);
    const { email } = recoveryEmailSchema.parse(request.body);
    await service.requestRecovery(email);
    response.status(202).json({ message: 'Se a conta puder receber emails, enviaremos as instrucoes de recuperacao.' });
  } catch (error) { next(error); }
});

for (const [path, type] of [['/password/reset', 'recovery'], ['/accounts/activate', 'invite']] as const) {
  publicRecoveryRoutes.post(path, async (request, response, next) => {
    try {
      requireJsonAuthProof(request);
      await service.changePassword(passwordProofSchema.parse(request.body), type);
      response.status(204).send();
    } catch (error) { next(error); }
  });
}
