-- UniConnect: privilegios minimos para repositorios academicos.
-- Revisar e validar no ambiente TEST antes de aplicar.
-- Nao altera RLS nem politicas existentes.

BEGIN;

-- Leitura e manutencao de dados academicos basicos.
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.courses, public.classes
TO service_role;

GRANT SELECT, UPDATE (updated_at) ON TABLE public.activities TO service_role;

-- Notas: upsert exige leitura, insercao e atualizacao.
GRANT SELECT, INSERT, UPDATE
ON TABLE public.grades
TO service_role;

-- Estrutura academica: listagem, criacao e atualizacao.
GRANT SELECT, INSERT, UPDATE
ON TABLE public.academic_periods, public.subjects,
         public.enrollments, public.teaching_assignments
TO service_role;

-- Historico academico: consulta direta.
GRANT SELECT, INSERT
ON TABLE public.enrollment_status_history
TO service_role;

-- Convites: criacao e consulta.
GRANT SELECT, INSERT
ON TABLE public.invites
TO service_role;

-- Usuarios: consulta e atualizacao de perfil.
GRANT SELECT, UPDATE
ON TABLE public.app_users
TO service_role;

-- Instituicoes: consulta.
GRANT SELECT
ON TABLE public.tenants
TO service_role;

COMMIT;
