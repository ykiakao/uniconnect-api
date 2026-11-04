import { z } from 'zod';

export function apiDateTime({ offset = false }: { offset?: boolean } = {}) {
  const iso = z.iso.datetime({ offset });
  return z.string().refine(value => {
    // The API already accepts minute precision and compact numeric offsets.
    // Normalize only the validation candidate; DTOs keep their original value.
    const candidate = value.replace(/T(\d{2}:\d{2})(?=Z|[+-])/, 'T$1:00')
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    return iso.safeParse(candidate).success;
  }, 'Data e horario invalidos.');
}
