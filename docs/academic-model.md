# Modelo acadêmico e gestão — Etapas 4–6

## Etapa 4: entidades e permissões

`academic_periods` representa o calendário de cada instituição (code/name/startDate/endDate/status planned,active,closed,archived). Código é único por tenant, não entre instituições. Datas opcionais são ISO YYYY-MM-DD, com início não posterior ao fim.

`subjects` é a disciplina do catálogo institucional, vinculada por ID a um curso. Status active/inactive e código único no tenant. Nesta versão a disciplina pertence a um curso; compartilhamento entre múltiplos cursos exige evolução explícita, não duplicação de ofertas.

`classes` continua sendo a turma/oferta das atividades existentes. A nova API `/offerings` usa essa mesma tabela: courseId,subjectId,periodId,name,status(active,closed,archived),teacherAuthId opcional. A disciplina deve pertencer ao curso e ao tenant. A coluna legada `classes.teacher_id` continua sendo Auth UUID do professor principal; nas atribuições docentes `teacherId` é o UUID institucional de `app_users.id`.

`enrollments` relaciona aluno institucional e turma/oferta, com status active/completed/cancelled/suspended. Há um registro por aluno/turma; reativação usa o mesmo registro e acrescenta histórico. `enrollment_status_history` é append-only, gerado pelo banco em criação/mudança de status. Vínculos não são removidos para contornar notas ou histórico.

`teaching_assignments` relaciona vários docentes a uma turma. Status active/inactive, isPrimary controlado pelo espelho do professor principal. A migration preserva/backfilla apenas docentes legados válidos, não cria alunos ou matrículas. Troca do docente principal atualiza `classes.teacher_id` e preserva o vínculo anterior inativo; docentes adicionais ativos permanecem. Reatribua o principal pela turma, não alterando isPrimary pela API de atribuições.

## Endpoints da Etapa 4

Todos sob `/api/v1/tenants/:slug`, com Bearer e `x-tenant-slug` consistentes. Respostas e erros usam requestId, logs e no-store existentes.

| Recurso | Operações |
| --- | --- |
| `/academic-periods` | GET paginado, POST |
| `/academic-periods/:id` | GET, PATCH |
| `/subjects` | GET paginado, POST |
| `/subjects/:id` | GET, PATCH |
| `/offerings` | GET paginado, POST |
| `/offerings/:id` | GET, PATCH |
| `/enrollments` | GET paginado, POST |
| `/enrollments/:id` | GET, PATCH apenas status |
| `/enrollments/:id/history` | GET |
| `/teaching-assignments` | GET paginado, POST docente adicional |
| `/teaching-assignments/:id` | GET, PATCH apenas status |

Administradores/coordenadores/owners institucionais criam e administram os recursos da própria instituição. Aluno/professor não gerenciam. IDs novos recebidos por esses endpoints são UUIDs; payloads estritos recusam tenantId, userId e campos não autorizados.

O catálogo de períodos/disciplinas é consultável por usuários autenticados do tenant. Ofertas e atribuições são visíveis ao aluno com matrícula active/completed ou professor com atribuição ativa; gestores veem as da instituição. Aluno consulta todas as situações de suas próprias matrículas/histórico, incluindo canceladas/trancadas, sem acesso a matrículas de outro aluno. Docentes veem matrículas das turmas em que têm atribuição ativa. Sem vínculo, turma direta retorna404; listagens retornam vazias.

Filtros permitidos: status em todos; courseId em subjects/offerings; periodId em offerings; classId/studentId em enrollments; classId/teacherId em teaching-assignments. `page` inteiro positivo e `limit`1–100. Resposta `{data,meta:{page,limit,total}}`. POST retorna201 e registro, PATCH/GET retornam200. Conflitos retornam409; vínculos inválidos/fora do tenant404; autorização403; validação400.

Exemplo de sequência administrativa, usando UUIDs retornados pela própria API:

```json
{"code":"2027.1","name":"Primeiro semestre 2027","startDate":"2027-01-01","endDate":"2027-06-30","status":"active"}
```

```json
{"courseId":"<uuid-curso>","code":"ALG","name":"Algoritmos","status":"active"}
```

```json
{"courseId":"<uuid-curso>","subjectId":"<uuid-disciplina>","periodId":"<uuid-periodo>","name":"Turma A","status":"active"}
```

```json
{"classId":"<uuid-oferta>","studentId":"<uuid-usuario-institucional>","status":"active"}
```

Os marcadores são referências de documentação, não dados de teste reais nem UUIDs para enviar literalmente.

## Autorização integrada e histórico

A autorização textual pelo nome do curso foi removida dos fluxos de consulta de turmas/atividades/detalhes de cursos. `AcademicAccess` centraliza matrículas e atribuições formais. Docentes adicionais podem acessar suas turmas e ler/lançar notas nelas, sem depender de serem o professor principal. Atualizar/apagar uma atividade como professor exige atribuição vigente e autoria existente; gestores mantêm administração institucional.

Lançamento de nota exige aluno do tenant e matrícula active/completed na turma da atividade, também validado pelo banco sob lock. A consulta das próprias notas históricas existentes continua permitida; não se cria matrícula por inferência para legitimar uma escrita nova.

Atividades com notas, turmas com vínculos/atividades e cursos com turmas/disciplinas não podem ser apagados para evitar cascatas destrutivas. A API retorna409 e a migration reforça as invariantes. Alterações de mapeamento curso/disciplina/período em turma com histórico também são bloqueadas, exceto primeiro mapeamento do legado nulo para disciplina/período válidos no mesmo curso.

## Migration e dados legados

Ordem futura de aplicação manual: schema/migrations existentes → `20261026000001_security_integrity.sql` → `20261026000002_academic_structure.sql`. Nenhuma aplicação remota foi realizada. As migrations históricas e schema.sql base não foram reescritos.

A nova migration é transacional, possui lock/statement timeout e preflight. Não remove dados, não limpa notas duplicadas e não inventa vínculos. A migration anterior de segurança deve ser saneada e aplicada antes; sua validação pode recusar inconsistências existentes.

Para levantamento autorizado do legado, consultar no ambiente de análise:

```sql
select id, tenant_id, course_id from public.classes
where subject_id is null or academic_period_id is null;

select g.id, g.tenant_id, a.class_id from public.grades g
join public.activities a on a.tenant_id=g.tenant_id and a.id=g.activity_id
join public.app_users u on u.tenant_id=g.tenant_id and u.auth_user_id=g.student_id
left join public.enrollments e on e.tenant_id=g.tenant_id and e.class_id=a.class_id and e.student_id=u.id
where e.id is null;
```

Os IDs retornados são dados administrativos privados. Uma instituição deve confirmar períodos/disciplinas e matrículas reais, cadastrar o catálogo e mapear as turmas. Não fazer backfill automático a partir do campo course textual. Até o vínculo real existir, o aluno perde o acesso que dependia exclusivamente desse texto e novas notas são recusadas. Dados antigos permanecem armazenados. Para reverter uma implantação, voltar a versão da API com planejamento, mantendo as tabelas/aditamentos; não apagar história para fazer rollback de schema.

Novas tabelas têm RLS e políticas apenas service_role. Não há acesso direto concedido ao app; a API valida tenant/papel/vínculo explicitamente e as FKs compostas impedem referências institucionais cruzadas. Isso não transforma a chave service_role em uma credencial com isolamento automático.

## Limites

Esta etapa não implementa frequência, avaliações avançadas, entregas, chat ou notificações. O papel institucional ainda é único; não se converte aluno com histórico em docente apagando vínculos. Consultas auxiliares de visibilidade usam conjuntos de IDs e precisam de evolução de paginação/RPC para instituições com volume superior ao limite de linhas configurado no PostgREST; o ambiente deve dimensionar esse limite antes de uso em grande escala. As novas listagens públicas são paginadas.
