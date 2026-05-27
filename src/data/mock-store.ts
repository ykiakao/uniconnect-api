import { AppUser, Tenant } from '../shared/types';

export const tenants: Tenant[] = [
  {
    id: 'tenant_universidade_norte',
    name: 'Universidade Norte',
    slug: 'universidade-norte',
    plan: 'growth',
    status: 'trialing',
    activeUsers: 384,
  },
];

export const users: AppUser[] = [
  {
    id: 'user_student_lucas',
    tenantId: 'tenant_universidade_norte',
    name: 'Lucas Oliveira',
    email: 'aluno@uni.com',
    role: 'student',
    course: 'Engenharia de Software',
    registration: '2024021845',
    semester: 4,
  },
  {
    id: 'user_teacher_marina',
    tenantId: 'tenant_universidade_norte',
    name: 'Marina Costa',
    email: 'professor@uni.com',
    role: 'teacher',
    course: 'Engenharia de Software',
  },
];
