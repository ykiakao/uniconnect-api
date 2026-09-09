insert into public.tenants (name, slug, plan, status, active_users)
values ('EduKMais', 'edukmais', 'growth', 'active', 128)
on conflict (slug) do update set
  name = excluded.name,
  plan = excluded.plan,
  status = excluded.status,
  active_users = excluded.active_users,
  updated_at = now();

do $$
declare
  demo_tenant_id uuid;
begin
  select id
    into demo_tenant_id
    from public.tenants
    where slug = 'edukmais';

  delete from public.messages
    where tenant_id = demo_tenant_id;

  delete from public.grades
    where tenant_id = demo_tenant_id;

  delete from public.activities
    where tenant_id = demo_tenant_id;

  delete from public.classes
    where tenant_id = demo_tenant_id;

  delete from public.courses
    where tenant_id = demo_tenant_id;

  delete from public.app_users
    where tenant_id = demo_tenant_id
      and email in (
        'admin@uniconnect.app',
        'gestor@edukmais.edu.br',
        'coordenador@edukmais.edu.br',
        'professor.comp@edukmais.edu.br',
        'professor.eng@edukmais.edu.br',
        'professor.si@edukmais.edu.br',
        'aluno01@edukmais.edu.br',
        'aluno02@edukmais.edu.br',
        'aluno03@edukmais.edu.br',
        'aluno04@edukmais.edu.br',
        'aluno05@edukmais.edu.br'
      );
end $$;

insert into public.app_users (
  tenant_id,
  auth_user_id,
  name,
  email,
  role,
  course,
  registration,
  semester
)
select
  tenants.id,
  auth_users.id,
  users.name,
  users.email,
  users.role,
  users.course,
  users.registration,
  users.semester
from public.tenants tenants
join (
  values
    ('admin@uniconnect.app', 'Admin UniConnect', 'admin', null, null, null),
    ('gestor@edukmais.edu.br', 'Gestor EduKMais', 'admin', null, null, null),
    ('coordenador@edukmais.edu.br', 'Coordenador Academico', 'coordinator', 'Engenharia de Software', null, null),
    ('professor.comp@edukmais.edu.br', 'Prof. Computacao', 'teacher', 'Ciencia da Computacao', null, null),
    ('professor.eng@edukmais.edu.br', 'Prof. Engenharia', 'teacher', 'Engenharia de Software', null, null),
    ('professor.si@edukmais.edu.br', 'Prof. Sistemas', 'teacher', 'Sistemas de Informacao', null, null),
    ('aluno01@edukmais.edu.br', 'Aluno EduKMais 01', 'student', 'Engenharia de Software', '2026001001', 4),
    ('aluno02@edukmais.edu.br', 'Aluno EduKMais 02', 'student', 'Engenharia de Software', '2026001002', 4),
    ('aluno03@edukmais.edu.br', 'Aluno EduKMais 03', 'student', 'Ciencia da Computacao', '2026001003', 3),
    ('aluno04@edukmais.edu.br', 'Aluno EduKMais 04', 'student', 'Ciencia da Computacao', '2026001004', 3),
    ('aluno05@edukmais.edu.br', 'Aluno EduKMais 05', 'student', 'Sistemas de Informacao', '2026001005', 5)
) as users(email, name, role, course, registration, semester)
  on tenants.slug = 'edukmais'
join auth.users auth_users
  on auth_users.email = users.email
on conflict (tenant_id, email) do update set
  auth_user_id = excluded.auth_user_id,
  name = excluded.name,
  role = excluded.role,
  course = excluded.course,
  registration = excluded.registration,
  semester = excluded.semester,
  updated_at = now();

insert into public.courses (tenant_id, name, description)
select tenants.id, courses.name, courses.description
from public.tenants tenants
join (
  values
    ('Ciencia da Computacao', 'Bacharelado com foco em algoritmos, dados e sistemas computacionais.'),
    ('Engenharia de Software', 'Bacharelado com foco em produto, arquitetura e qualidade de software.'),
    ('Sistemas de Informacao', 'Bacharelado com foco em processos, gestao e sistemas corporativos.')
) as courses(name, description)
  on tenants.slug = 'edukmais';

insert into public.classes (tenant_id, course_id, name, teacher_id, semester)
select
  tenants.id,
  courses.id,
  classes.name,
  teachers.auth_user_id,
  classes.semester
from public.tenants tenants
join (
  values
    ('Engenharia de Software', 'Engenharia de Software II - 2026.1 Turma A', 'professor.eng@edukmais.edu.br', 4),
    ('Engenharia de Software', 'Banco de Dados - 2026.1 Turma A', 'professor.eng@edukmais.edu.br', 4),
    ('Ciencia da Computacao', 'Algoritmos e Estruturas de Dados - 2026.1 Turma B', 'professor.comp@edukmais.edu.br', 3),
    ('Sistemas de Informacao', 'Gestao de Projetos de Software - 2026.1 Turma A', 'professor.si@edukmais.edu.br', 5)
) as classes(course_name, name, teacher_email, semester)
  on tenants.slug = 'edukmais'
join public.courses courses
  on courses.tenant_id = tenants.id
  and courses.name = classes.course_name
join public.app_users teachers
  on teachers.tenant_id = tenants.id
  and teachers.email = classes.teacher_email;

insert into public.activities (
  tenant_id,
  class_id,
  title,
  description,
  due_date,
  type,
  created_by
)
select
  classes.tenant_id,
  classes.id,
  activities.title,
  activities.description,
  activities.due_date,
  activities.type,
  teachers.auth_user_id
from public.classes classes
join (
  values
    ('Engenharia de Software II - 2026.1 Turma A', 'Documento de requisitos', 'Mapear requisitos funcionais e nao funcionais do estudo de caso.', now() + interval '7 days', 'assignment'),
    ('Engenharia de Software II - 2026.1 Turma A', 'Prototipo navegavel', 'Entregar fluxo principal validado com usuarios demo.', now() + interval '14 days', 'project'),
    ('Banco de Dados - 2026.1 Turma A', 'Modelagem entidade-relacionamento', 'Criar o modelo ER do sistema proposto.', now() + interval '10 days', 'assignment'),
    ('Banco de Dados - 2026.1 Turma A', 'Normalizacao de tabelas', 'Aplicar as tres primeiras formas normais no modelo entregue.', now() + interval '17 days', 'assignment'),
    ('Algoritmos e Estruturas de Dados - 2026.1 Turma B', 'Lista de arvores binaria', 'Resolver exercicios de insercao, busca e percurso.', now() + interval '9 days', 'assignment'),
    ('Gestao de Projetos de Software - 2026.1 Turma A', 'Plano de sprint', 'Planejar backlog, responsaveis e criterios de aceite.', now() + interval '12 days', 'assignment')
) as activities(class_name, title, description, due_date, type)
  on activities.class_name = classes.name
join public.app_users teachers
  on teachers.tenant_id = classes.tenant_id
  and teachers.auth_user_id = classes.teacher_id;

insert into public.grades (
  tenant_id,
  activity_id,
  student_id,
  grade,
  feedback,
  graded_at,
  graded_by
)
select
  activities.tenant_id,
  activities.id,
  students.auth_user_id,
  grades.grade,
  grades.feedback,
  now() - interval '1 day',
  activities.created_by
from public.activities activities
join (
  values
    ('Documento de requisitos', 'aluno01@edukmais.edu.br', 8.80, 'Boa cobertura dos requisitos. Revisar prioridades.'),
    ('Documento de requisitos', 'aluno02@edukmais.edu.br', 9.20, 'Documento claro e bem organizado.'),
    ('Modelagem entidade-relacionamento', 'aluno01@edukmais.edu.br', 8.50, 'Boa modelagem. Revisar cardinalidades.'),
    ('Modelagem entidade-relacionamento', 'aluno02@edukmais.edu.br', 7.90, 'Modelo correto, mas faltam justificativas.'),
    ('Lista de arvores binaria', 'aluno03@edukmais.edu.br', 9.00, 'Solucoes eficientes.'),
    ('Lista de arvores binaria', 'aluno04@edukmais.edu.br', 8.10, 'Revisar complexidade do percurso.'),
    ('Plano de sprint', 'aluno05@edukmais.edu.br', 8.70, 'Backlog coerente com o escopo.')
) as grades(activity_title, student_email, grade, feedback)
  on grades.activity_title = activities.title
join public.app_users students
  on students.tenant_id = activities.tenant_id
  and students.email = grades.student_email;

insert into public.messages (tenant_id, sender_id, class_id, content)
select
  classes.tenant_id,
  senders.id,
  classes.id,
  messages.content
from public.classes classes
join (
  values
    ('Engenharia de Software II - 2026.1 Turma A', 'professor.eng@edukmais.edu.br', 'Pessoal, o documento de requisitos deve seguir o template discutido em aula.'),
    ('Engenharia de Software II - 2026.1 Turma A', 'aluno01@edukmais.edu.br', 'Professor, podemos incluir requisitos de acessibilidade no escopo?'),
    ('Banco de Dados - 2026.1 Turma A', 'professor.eng@edukmais.edu.br', 'A entrega de modelagem ER sera avaliada pela consistencia das relacoes.'),
    ('Algoritmos e Estruturas de Dados - 2026.1 Turma B', 'professor.comp@edukmais.edu.br', 'Revisem percurso em ordem, pre-ordem e pos-ordem antes da lista.')
) as messages(class_name, sender_email, content)
  on messages.class_name = classes.name
join public.app_users senders
  on senders.tenant_id = classes.tenant_id
  and senders.email = messages.sender_email;
