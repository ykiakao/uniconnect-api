import { ensureCanAssignRole } from './roles';
import { UserRole } from './types';

describe('institutional role assignment matrix', () => {
  it.each<[UserRole, UserRole]>([
    ['coordinator', 'student'], ['coordinator', 'teacher'],
    ['admin', 'student'], ['admin', 'teacher'], ['admin', 'coordinator'],
    ['owner', 'student'], ['owner', 'teacher'], ['owner', 'coordinator'], ['owner', 'admin'],
  ])('allows %s to grant %s', (actor, desired) => {
    expect(() => ensureCanAssignRole(actor, desired)).not.toThrow();
  });
  it.each<[UserRole, UserRole]>([
    ['student', 'student'], ['teacher', 'student'],
    ['coordinator', 'coordinator'], ['coordinator', 'admin'], ['coordinator', 'owner'],
    ['admin', 'admin'], ['admin', 'owner'], ['owner', 'owner'],
  ])('denies %s granting %s', (actor, desired) => {
    expect(() => ensureCanAssignRole(actor, desired)).toThrow();
  });
  it.each<[UserRole, UserRole]>([
    ['coordinator', 'coordinator'], ['coordinator', 'admin'], ['coordinator', 'owner'],
    ['admin', 'admin'], ['admin', 'owner'], ['owner', 'owner'],
  ])('denies %s changing an existing %s', (actor, existing) => {
    expect(() => ensureCanAssignRole(actor, 'student', existing)).toThrow();
  });
});
