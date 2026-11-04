import { HttpError } from '../../shared/http-error';

const errors = {
  ACADEMIC_DISABLED: [503, 'Integração acadêmica não habilitada neste servidor.'],
  ACADEMIC_FORBIDDEN: [403, 'Integração acadêmica não permitida neste contexto.'],
  ACADEMIC_SCOPE_MISMATCH: [403, 'Os dados acadêmicos não correspondem ao contexto autenticado.'],
  ACADEMIC_PERIOD_NOT_FOUND: [404, 'Período acadêmico não disponível.'],
  ACADEMIC_AUTH_FAILED: [424, 'As credenciais da fonte acadêmica não foram aceitas.'],
  ACADEMIC_SESSION_EXPIRED: [424, 'A sessão da fonte acadêmica expirou; autorize uma nova consulta.'],
  ACADEMIC_UNAVAILABLE: [503, 'A fonte acadêmica está indisponível.'],
  ACADEMIC_TIMEOUT: [504, 'A fonte acadêmica excedeu o tempo de resposta.'],
  ACADEMIC_INVALID_RESPONSE: [502, 'A fonte acadêmica retornou dados incompatíveis.'],
  ACADEMIC_INVALID_PDF: [502, 'Não foi possível interpretar o boletim acadêmico.'],
  ACADEMIC_PROVIDER_ERROR: [502, 'Não foi possível consultar os dados acadêmicos.'],
} as const;
export class AcademicError extends HttpError {
  constructor(code: keyof typeof errors) { super(errors[code][0], code, errors[code][1]); }
}
export function academicExternalError(error: unknown): AcademicError {
  if (error instanceof AcademicError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  if (/Timeout|tempo.*excedido/i.test(message)) return new AcademicError('ACADEMIC_TIMEOUT');
  if (code === 'AUTH_FAILED') return new AcademicError('ACADEMIC_AUTH_FAILED');
  if (['SESSION_EXPIRED', 'SESSION_CONTEXT_CHANGED', 'NOT_AUTHENTICATED'].includes(code)) return new AcademicError('ACADEMIC_SESSION_EXPIRED');
  if (code === 'INVALID_PDF' || /PDF inválido|PDF.*ilegível/i.test(message)) return new AcademicError('ACADEMIC_INVALID_PDF');
  if (code === 'INVALID_RESPONSE' || code === 'INVALID_CONTEXT') return new AcademicError('ACADEMIC_INVALID_RESPONSE');
  if (code === 'HTTP_ERROR' || /rede ou TLS/i.test(message)) return new AcademicError('ACADEMIC_UNAVAILABLE');
  return new AcademicError('ACADEMIC_PROVIDER_ERROR');
}
