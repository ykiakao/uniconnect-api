-- Dedicated, authorized demo only; this single DO statement is atomic.
-- Repeated runs preserve existing academic history instead of resetting it.
-- A duplicate natural key or an incompatible existing record aborts the batch.
do $$
declare
  fixtures constant jsonb := $fixtures$
{
  "users": [
    {"email":"admin@uniconnect.app","name":"Admin Demo","role":"admin"},
    {"email":"gestor@edukmais.edu.br","name":"Gestor Demo","role":"admin"},
    {"email":"coordenador@edukmais.edu.br","name":"Coordenador Demo","role":"coordinator","course":"es"},
    {"email":"professor@edukmais.edu.br","name":"Professor Demo","role":"teacher","course":"es"},
    {"email":"professor.comp@edukmais.edu.br","name":"Professor Demo Computacao","role":"teacher","course":"cc"},
    {"email":"professor.eng@edukmais.edu.br","name":"Professor Demo Engenharia","role":"teacher","course":"es"},
    {"email":"professor.si@edukmais.edu.br","name":"Professor Demo Sistemas","role":"teacher","course":"si"},
    {"email":"aluno@edukmais.edu.br","name":"Aluno Demo","role":"student","course":"es","registration":"DEMO-000","semester":4},
    {"email":"aluno01@edukmais.edu.br","name":"Aluno Demo 01","role":"student","course":"es","registration":"DEMO-001","semester":4},
    {"email":"aluno02@edukmais.edu.br","name":"Aluno Demo 02","role":"student","course":"es","registration":"DEMO-002","semester":4},
    {"email":"aluno03@edukmais.edu.br","name":"Aluno Demo 03","role":"student","course":"cc","registration":"DEMO-003","semester":3},
    {"email":"aluno04@edukmais.edu.br","name":"Aluno Demo 04","role":"student","course":"cc","registration":"DEMO-004","semester":3},
    {"email":"aluno05@edukmais.edu.br","name":"Aluno Demo 05","role":"student","course":"si","registration":"DEMO-005","semester":5}
  ],
  "courses": [
    {"key":"es","name":"Engenharia de Software","description":"Curso ficticio de produto, arquitetura e qualidade de software."},
    {"key":"cc","name":"Ciencia da Computacao","description":"Curso ficticio de algoritmos, dados e sistemas computacionais."},
    {"key":"si","name":"Sistemas de Informacao","description":"Curso ficticio de processos, gestao e sistemas corporativos."}
  ],
  "periods": [
    {"code":"DEMO-2026.1","name":"Periodo demonstrativo 2026.1","start_date":"2026-01-01","end_date":"2026-12-31","status":"active"}
  ],
  "subjects": [
    {"code":"DEMO-ES2","course":"es","name":"Engenharia de Software II","status":"active"},
    {"code":"DEMO-BD","course":"es","name":"Banco de Dados","status":"active"},
    {"code":"DEMO-AED","course":"cc","name":"Algoritmos e Estruturas de Dados","status":"active"},
    {"code":"DEMO-GPS","course":"si","name":"Gestao de Projetos de Software","status":"active"}
  ],
  "classes": [
    {"key":"es2","course":"es","subject":"DEMO-ES2","period":"DEMO-2026.1","name":"Engenharia de Software II - 2026.1 Turma A","teacher":"professor.eng@edukmais.edu.br","semester":4,"additional_teachers":["professor@edukmais.edu.br"]},
    {"key":"bd","course":"es","subject":"DEMO-BD","period":"DEMO-2026.1","name":"Banco de Dados - 2026.1 Turma A","teacher":"professor.eng@edukmais.edu.br","semester":4,"additional_teachers":["professor@edukmais.edu.br"]},
    {"key":"aed","course":"cc","subject":"DEMO-AED","period":"DEMO-2026.1","name":"Algoritmos e Estruturas de Dados - 2026.1 Turma B","teacher":"professor.comp@edukmais.edu.br","semester":3,"additional_teachers":[]},
    {"key":"gps","course":"si","subject":"DEMO-GPS","period":"DEMO-2026.1","name":"Gestao de Projetos de Software - 2026.1 Turma A","teacher":"professor.si@edukmais.edu.br","semester":5,"additional_teachers":[]}
  ],
  "enrollments": [
    {"class":"es2","student":"aluno@edukmais.edu.br"},
    {"class":"bd","student":"aluno@edukmais.edu.br"},
    {"class":"es2","student":"aluno01@edukmais.edu.br"},
    {"class":"bd","student":"aluno01@edukmais.edu.br"},
    {"class":"es2","student":"aluno02@edukmais.edu.br"},
    {"class":"bd","student":"aluno02@edukmais.edu.br"},
    {"class":"aed","student":"aluno03@edukmais.edu.br"},
    {"class":"aed","student":"aluno04@edukmais.edu.br"},
    {"class":"gps","student":"aluno05@edukmais.edu.br"}
  ],
  "activities": [
    {"key":"requisitos","class":"es2","title":"Documento de requisitos","description":"Mapear requisitos funcionais e nao funcionais do estudo de caso ficticio.","type":"assignment","due_days":7,"instructions":"Apresente uma resposta textual sobre o estudo de caso ficticio.","evaluation_criteria":"Coerencia, clareza e justificativa da solucao."},
    {"key":"prototipo","class":"es2","title":"Prototipo navegavel","description":"Entregar fluxo principal validado com usuarios ficticios.","type":"project","due_days":14,"instructions":"Apresente uma resposta textual sobre o estudo de caso ficticio.","evaluation_criteria":"Coerencia, clareza e justificativa da solucao."},
    {"key":"modelagem","class":"bd","title":"Modelagem entidade-relacionamento","description":"Criar o modelo ER do sistema ficticio.","type":"assignment","due_days":10,"instructions":"Apresente uma resposta textual sobre o estudo de caso ficticio.","evaluation_criteria":"Coerencia, clareza e justificativa da solucao."},
    {"key":"normalizacao","class":"bd","title":"Normalizacao de tabelas","description":"Aplicar as tres primeiras formas normais no modelo ficticio.","type":"assignment","due_days":17,"instructions":"Apresente uma resposta textual sobre o estudo de caso ficticio.","evaluation_criteria":"Coerencia, clareza e justificativa da solucao."},
    {"key":"arvores","class":"aed","title":"Lista de arvores binaria","description":"Resolver exercicios de insercao, busca e percurso.","type":"assignment","due_days":9,"instructions":"Apresente uma resposta textual sobre o estudo de caso ficticio.","evaluation_criteria":"Coerencia, clareza e justificativa da solucao."},
    {"key":"sprint","class":"gps","title":"Plano de sprint","description":"Planejar backlog, responsaveis e criterios de aceite ficticios.","type":"assignment","due_days":12,"instructions":"Apresente uma resposta textual sobre o estudo de caso ficticio.","evaluation_criteria":"Coerencia, clareza e justificativa da solucao."}
  ],
  "deliveries": [
    {"activity":"requisitos","student":"aluno@edukmais.edu.br","grade":8.8,"review":"published","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico.","feedback":"Avaliacao ficticia: boa coerencia; revise as justificativas."},
    {"activity":"requisitos","student":"aluno01@edukmais.edu.br","grade":8.8,"review":"draft","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico.","feedback":"Avaliacao ficticia: boa coerencia; revise as justificativas."},
    {"activity":"requisitos","student":"aluno02@edukmais.edu.br","grade":9.2,"review":"published","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico.","feedback":"Avaliacao ficticia: boa coerencia; revise as justificativas."},
    {"activity":"modelagem","student":"aluno@edukmais.edu.br","grade":8.5,"review":"published","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico.","feedback":"Avaliacao ficticia: boa coerencia; revise as justificativas."},
    {"activity":"modelagem","student":"aluno01@edukmais.edu.br","grade":8.5,"review":"published","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico.","feedback":"Avaliacao ficticia: boa coerencia; revise as justificativas."},
    {"activity":"modelagem","student":"aluno02@edukmais.edu.br","grade":7.9,"review":"published","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico.","feedback":"Avaliacao ficticia: boa coerencia; revise as justificativas."},
    {"activity":"arvores","student":"aluno03@edukmais.edu.br","grade":9,"review":"published","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico.","feedback":"Avaliacao ficticia: boa coerencia; revise as justificativas."},
    {"activity":"arvores","student":"aluno04@edukmais.edu.br","grade":8.1,"review":"published","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico.","feedback":"Avaliacao ficticia: boa coerencia; revise as justificativas."},
    {"activity":"sprint","student":"aluno05@edukmais.edu.br","grade":8.7,"review":"published","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico.","feedback":"Avaliacao ficticia: boa coerencia; revise as justificativas."},
    {"activity":"prototipo","student":"aluno@edukmais.edu.br","review":"pending","answer":"Resposta ficticia para demonstrar a entrega e o workflow academico."}
  ],
  "messages": [
    {"class":"es2","sender":"professor.eng@edukmais.edu.br","content":"Mensagem ficticia: sigam as instrucoes da atividade."},
    {"class":"es2","sender":"aluno01@edukmais.edu.br","content":"Duvida ficticia: podemos incluir requisitos de acessibilidade?"},
    {"class":"bd","sender":"professor.eng@edukmais.edu.br","content":"Mensagem ficticia: revisem as cardinalidades do modelo."},
    {"class":"aed","sender":"professor.comp@edukmais.edu.br","content":"Mensagem ficticia: revisem os percursos em arvores."}
  ]
}
$fixtures$::jsonb;
  item jsonb;
  extra_teacher jsonb;
  demo_tenant_id uuid;
  demo_auth_id uuid;
  demo_course_id uuid;
  demo_class_id uuid;
  demo_teacher_id uuid;
  demo_student_id uuid;
  course_name text;
  course_ids jsonb := '{}'::jsonb;
  auth_ids jsonb := '{}'::jsonb;
  member_ids jsonb := '{}'::jsonb;
  period_ids jsonb := '{}'::jsonb;
  subject_ids jsonb := '{}'::jsonb;
  class_ids jsonb := '{}'::jsonb;
  activity_ids jsonb := '{}'::jsonb;
  workflow_result jsonb;
  delivery_created boolean;
  course_row public.courses%rowtype;
  member_row public.app_users%rowtype;
  period_row public.academic_periods%rowtype;
  subject_row public.subjects%rowtype;
  class_row public.classes%rowtype;
  assignment_row public.teaching_assignments%rowtype;
  enrollment_row public.enrollments%rowtype;
  activity_row public.activities%rowtype;
  delivery_row public.activity_submissions%rowtype;
  grade_row public.grades%rowtype;
begin
  -- Serializes seed batches, not normal API operations. Guards still apply.
  perform pg_advisory_xact_lock(hashtextextended('uniconnect:seed_demo:edukmais', 0));

  insert into public.tenants (name, slug, plan, status, active_users)
    values ('EduKMais', 'edukmais', 'growth', 'active', 13)
    on conflict (slug) do nothing;
  select id into strict demo_tenant_id from public.tenants where slug = 'edukmais';
  perform public.assert_operational_tenant(demo_tenant_id);

  for item in select value from jsonb_array_elements(fixtures->'courses') loop
    begin
      select * into strict course_row from public.courses
        where tenant_id = demo_tenant_id and name = item->>'name';
    exception when no_data_found then
      insert into public.courses (tenant_id, name, description)
        values (demo_tenant_id, item->>'name', item->>'description')
        returning * into course_row;
    end;
    course_ids := course_ids || jsonb_build_object(item->>'key', course_row.id);
  end loop;

  for item in select value from jsonb_array_elements(fixtures->'users') loop
    -- Missing, unconfirmed or ambiguous Auth identities must not be silently skipped.
    select id into strict demo_auth_id from auth.users
      where lower(email) = item->>'email' and email_confirmed_at is not null;
    demo_course_id := (course_ids->>(item->>'course'))::uuid;
    select name into course_name from public.courses
      where tenant_id = demo_tenant_id and id = demo_course_id;
    begin
      select * into strict member_row from public.app_users
        where tenant_id = demo_tenant_id and email = item->>'email';
    exception when no_data_found then
      insert into public.app_users (tenant_id, auth_user_id, name, email, role, course, course_id, registration, semester, active)
        values (demo_tenant_id, demo_auth_id, item->>'name', item->>'email', item->>'role',
          course_name, demo_course_id, item->>'registration', (item->>'semester')::integer, true)
        returning * into member_row;
    end;
    if member_row.auth_user_id <> demo_auth_id or member_row.role <> item->>'role' or not member_row.active
      or (member_row.course_id is not null and member_row.course_id is distinct from demo_course_id) then
      raise exception 'Demo membership conflicts with existing identity, role, course or active status; review manually.';
    end if;
    member_ids := member_ids || jsonb_build_object(item->>'email', member_row.id);
    auth_ids := auth_ids || jsonb_build_object(item->>'email', demo_auth_id);
  end loop;

  for item in select value from jsonb_array_elements(fixtures->'periods') loop
    begin
      select * into strict period_row from public.academic_periods
        where tenant_id = demo_tenant_id and code = item->>'code';
    exception when no_data_found then
      insert into public.academic_periods (tenant_id, code, name, start_date, end_date, status)
        values (demo_tenant_id, item->>'code', item->>'name', (item->>'start_date')::date,
          (item->>'end_date')::date, item->>'status')
        returning * into period_row;
    end;
    if period_row.status <> 'active' then
      raise exception 'Demo period is not active; do not reopen academic history automatically.';
    end if;
    period_ids := period_ids || jsonb_build_object(item->>'code', period_row.id);
  end loop;

  for item in select value from jsonb_array_elements(fixtures->'subjects') loop
    demo_course_id := (course_ids->>(item->>'course'))::uuid;
    begin
      select * into strict subject_row from public.subjects
        where tenant_id = demo_tenant_id and code = item->>'code';
    exception when no_data_found then
      insert into public.subjects (tenant_id, course_id, code, name, status)
        values (demo_tenant_id, demo_course_id, item->>'code', item->>'name', item->>'status')
        returning * into subject_row;
    end;
    if subject_row.course_id <> demo_course_id or subject_row.status <> 'active' then
      raise exception 'Demo subject has an incompatible course or status; review manually.';
    end if;
    subject_ids := subject_ids || jsonb_build_object(item->>'code', subject_row.id);
  end loop;

  for item in select value from jsonb_array_elements(fixtures->'classes') loop
    demo_course_id := (course_ids->>(item->>'course'))::uuid;
    demo_auth_id := (auth_ids->>(item->>'teacher'))::uuid;
    begin
      select * into strict class_row from public.classes
        where tenant_id = demo_tenant_id and name = item->>'name';
    exception when no_data_found then
      -- classes_mirror_primary_teacher creates the primary assignment with the member ID.
      insert into public.classes (tenant_id, course_id, subject_id, academic_period_id, teacher_id, name, semester, academic_status)
        values (demo_tenant_id, demo_course_id, (subject_ids->>(item->>'subject'))::uuid,
          (period_ids->>(item->>'period'))::uuid, demo_auth_id, item->>'name', (item->>'semester')::integer, 'active')
        returning * into class_row;
    end;
    if class_row.course_id <> demo_course_id or class_row.teacher_id is distinct from demo_auth_id
      or class_row.subject_id is distinct from (subject_ids->>(item->>'subject'))::uuid
      or class_row.academic_period_id is distinct from (period_ids->>(item->>'period'))::uuid
      or class_row.academic_status <> 'active' then
      raise exception 'Demo class mapping, teacher or status conflicts with existing records; review manually.';
    end if;
    class_ids := class_ids || jsonb_build_object(item->>'key', class_row.id);

    -- Additional teachers are not primary; never write is_primary outside the class trigger.
    for extra_teacher in select value from jsonb_array_elements(item->'additional_teachers') loop
      demo_teacher_id := (member_ids->>(extra_teacher #>> '{}'))::uuid;
      insert into public.teaching_assignments (tenant_id, class_id, teacher_id, status)
        values (demo_tenant_id, class_row.id, demo_teacher_id, 'active')
        on conflict (tenant_id, class_id, teacher_id) do nothing;
      select * into strict assignment_row from public.teaching_assignments
        where tenant_id = demo_tenant_id and class_id = class_row.id and teacher_id = demo_teacher_id;
      if assignment_row.status <> 'active' then
        raise exception 'Demo teaching assignment is inactive; preserve its history and review manually.';
      end if;
    end loop;
  end loop;

  for item in select value from jsonb_array_elements(fixtures->'enrollments') loop
    demo_class_id := (class_ids->>(item->>'class'))::uuid;
    demo_student_id := (member_ids->>(item->>'student'))::uuid;
    insert into public.enrollments (tenant_id, class_id, student_id, status)
      values (demo_tenant_id, demo_class_id, demo_student_id, 'active')
      on conflict (tenant_id, class_id, student_id) do nothing;
    select * into strict enrollment_row from public.enrollments
      where tenant_id = demo_tenant_id and class_id = demo_class_id and student_id = demo_student_id;
    if enrollment_row.status <> 'active' then
      raise exception 'Demo enrollment is not active; do not overwrite academic history.';
    end if;
  end loop;

  for item in select value from jsonb_array_elements(fixtures->'activities') loop
    demo_class_id := (class_ids->>(item->>'class'))::uuid;
    select * into strict class_row from public.classes where tenant_id = demo_tenant_id and id = demo_class_id;
    select id into strict demo_teacher_id from public.app_users
      where tenant_id = demo_tenant_id and auth_user_id = class_row.teacher_id and role = 'teacher' and active;
    -- STRICT rejects duplicate titles within a class instead of choosing an arbitrary activity.
    begin
      select * into strict activity_row from public.activities
        where tenant_id = demo_tenant_id and class_id = demo_class_id and title = item->>'title';
    exception when no_data_found then
      activity_row := null;
    end;
    if activity_row.id is null then
      workflow_result := public.manage_academic_activity(
        demo_tenant_id, demo_teacher_id, 'create', null, demo_class_id,
        jsonb_build_object('title', item->>'title', 'description', item->>'description', 'type', item->>'type',
          'due_date', now() + make_interval(days => (item->>'due_days')::integer),
          'instructions', item->>'instructions', 'evaluation_criteria', item->>'evaluation_criteria'));
      workflow_result := public.manage_academic_activity(
        demo_tenant_id, demo_teacher_id, 'publish', (workflow_result->>'id')::uuid, demo_class_id,
        jsonb_build_object('expected_version', (workflow_result->>'revision')::integer));
      select * into strict activity_row from public.activities
        where tenant_id = demo_tenant_id and id = (workflow_result->>'id')::uuid;
    end if;
    if not activity_row.workflow_enabled or activity_row.state not in ('published', 'closed') then
      raise exception 'Existing demo activity is legacy or unpublished; do not rewrite its history.';
    end if;
    activity_ids := activity_ids || jsonb_build_object(item->>'key', activity_row.id);
  end loop;

  for item in select value from jsonb_array_elements(fixtures->'deliveries') loop
    select * into strict activity_row from public.activities
      where tenant_id = demo_tenant_id and id = (activity_ids->>(item->>'activity'))::uuid;
    select * into strict class_row from public.classes where tenant_id = demo_tenant_id and id = activity_row.class_id;
    select id into strict demo_teacher_id from public.app_users
      where tenant_id = demo_tenant_id and auth_user_id = class_row.teacher_id and role = 'teacher' and active;
    demo_student_id := (member_ids->>(item->>'student'))::uuid;
    select * into delivery_row from public.activity_submissions
      where tenant_id = demo_tenant_id and activity_id = activity_row.id and student_id = demo_student_id;
    select * into grade_row from public.grades
      where tenant_id = demo_tenant_id and activity_id = activity_row.id and student_id = (auth_ids->>(item->>'student'))::uuid;
    delivery_created := false;
    -- Never resubmit, regrade or publish a participant's existing work on repetition.
    if delivery_row.id is null and grade_row.id is null then
      workflow_result := public.submit_activity_answer(demo_tenant_id, demo_student_id, activity_row.id, 0, item->>'answer');
      select * into strict delivery_row from public.activity_submissions
        where tenant_id = demo_tenant_id and id = (workflow_result->>'id')::uuid;
      delivery_created := true;
    end if;
    if grade_row.id is null and delivery_created and item->>'review' <> 'pending' then
      workflow_result := public.review_activity_submission(
        demo_tenant_id, demo_teacher_id, delivery_row.id, 0, delivery_row.current_version,
        (item->>'grade')::numeric, item->>'feedback', false);
      select * into strict grade_row from public.grades
        where tenant_id = demo_tenant_id and id = (workflow_result->>'id')::uuid;
      if item->>'review' = 'published' then
        perform public.publish_activity_review(demo_tenant_id, demo_teacher_id, delivery_row.id, grade_row.revision);
      end if;
    end if;
  end loop;

  -- Preserve the legacy class-message fixtures; no inferred private conversations.
  for item in select value from jsonb_array_elements(fixtures->'messages') loop
    demo_class_id := (class_ids->>(item->>'class'))::uuid;
    insert into public.messages (tenant_id, sender_id, class_id, content)
      select demo_tenant_id, (member_ids->>(item->>'sender'))::uuid, demo_class_id, item->>'content'
      where not exists (
        select 1 from public.messages where tenant_id = demo_tenant_id and class_id = demo_class_id
          and sender_id = (member_ids->>(item->>'sender'))::uuid and content = item->>'content' and conversation_id is null
      );
  end loop;
end $$;
