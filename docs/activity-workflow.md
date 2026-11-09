# Atividades, entregas e avaliações — Etapa 7

Implementação exclusivamente no backend. Não depende de portal externo. A persistência usa Supabase/PostgreSQL; nenhuma migration foi aplicada remotamente. Este guia descreve o código preparado, condicionado à aplicação manual autorizada da cadeia SQL no ambiente de destino.

## Fluxo e modelo

O professor com atribuição docente ativa cria uma atividade em uma oferta formal ativa, vinculada a disciplina ativa e período ativo. O registro começa em `draft`. A publicação permite sua consulta pelo aluno elegível. O aluno envia texto; um professor atribuído corrige, salva avaliação em rascunho e publica o resultado. Não se cria outro sistema de notas: a avaliação atual permanece em `grades`.

| Registro | Papel |
| --- | --- |
| `activities` | Campos anteriores mais `state`, `instructions`, `evaluation_criteria`, `priority`, `allow_late`, `revision`, `workflow_enabled`, datas de publicação/encerramento. |
| `activity_submissions` | Uma entrega atual por tenant/atividade/aluno institucional, com oferta, texto, versão, horário e indicador de atraso. |
| `activity_submission_versions` | Texto e recibo de cada versão, append-only. |
| `grades` | Uma nota por atividade/aluno, publicação, revisão e vínculo opcional à entrega/versão corrigida. |
| `grade_revisions` | Snapshots append-only da nota, feedback, autoria, horário, estado e versão da entrega. |

`activity_submissions.student_id` referencia o ID institucional (`app_users.id`). O campo legado `grades.student_id` continua sendo o UUID do Supabase Auth. A conversão ocorre no servidor/banco; não é um seletor livre de identidade do cliente. FKs compostas validam tenant, atividade, oferta, matrícula e versão corrigida. A matrícula precisa existir; nenhuma matrícula ou associação acadêmica é inventada.

## Estados e edição

| Estado | Transição/regra |
| --- | --- |
| `draft` | Visível a docentes atribuídos e gestores institucionais; pode editar ou publicar. Somente docente publica. |
| `published` | Recebe entregas elegíveis; pode encerrar. Não volta a rascunho. |
| `closed` | Terminal: não recebe entregas nem alterações de conteúdo. Correção de entregas existentes continua permitida. |
| `not_submitted` | Consulta pessoal sem entrega; retorna `{ "status": "not_submitted", "submission": null }`. |
| `submitted` / `late` | Entrega recebida sem avaliação, distinguindo atraso aceito. |
| `in_review` | Avaliação em rascunho com nota `null`. |
| `corrected` | Avaliação em rascunho com nota numérica, incluindo zero. |
| `result_published` | Resultado publicado, disponível ao próprio aluno. |

Antes da primeira entrega, título, descrição, tipo, instruções, critérios, prioridade, prazo e política de atraso podem mudar. Depois da primeira entrega, o conteúdo e a política de atraso ficam congelados; o prazo pode somente ser estendido. Prazo ilimitado não pode virar restritivo. `closed` é imutável. Não há transição direta de rascunho para encerrada: isso impediria a proteção de conteúdo não publicado. DELETE é rejeitado quando existem entregas ou notas, sem apagar histórico.

Novas atividades exigem `expectedVersion` nas atualizações, publicação e encerramento. A resposta contém a `revision` atual; usar esse valor na próxima mutação. Uma requisição com versão antiga recebe409. A publicação/edição concorre com entrega e é serializada no banco.

Datas de entrada devem ser ISO8601 com offset; são normalizadas para UTC. Recebimento, atraso e correção usam o relógio do banco. O prazo é reavaliado **depois dos locks**, inclusive se a requisição esperar outra transação. `allowLate` é falso por padrão: após o prazo o envio retorna409. Com `allowLate:true`, a entrega é aceita com `isLate:true`. Oferta/período inativos impedem novo envio; a consulta histórica continua possível conforme a matrícula.

## Autorizações

Todos os endpoints exigem autenticação existente, membro institucional ativo, slug da rota e contexto do tenant coerentes. Usar `Authorization: Bearer <token UniConnect>` e `x-tenant-slug: <slug>`. Nenhum papel institucional concede autorização global.

| Perfil/vínculo | Acesso |
| --- | --- |
| Professor ativo e atribuído à oferta | Gerencia atividades, publica, consulta entregas e corrige/publica resultados. Não precisa ser o autor original para editar uma atividade do workflow novo. |
| Owner/admin/coordenador institucional | Gerencia rascunhos/edição/encerramento e consulta entregas no próprio tenant; não publica atividades nem corrige entregas como professor. O lançamento manual anterior de notas mantém a política institucional existente. |
| Aluno com matrícula `active` | Consulta atividades publicadas/encerradas da oferta e envia enquanto oferta, período e prazo permitirem. |
| Matrícula `completed` | Consulta atividades/resultados; não envia novas respostas. |
| Matrícula `cancelled` ou `suspended` | Somente atividades em que possui entrega ou nota publicada e os próprios recibos/histórico; sem novas entregas nem acesso geral às atividades da oferta. |
| Membro institucional inativo | Acesso bloqueado, inclusive com token anteriormente emitido. |

Outro aluno não consulta a entrega por ID (404). Docente sem atribuição e gestor de outro tenant não obtêm respostas. A correção histórica de uma entrega existente pode continuar após alteração da matrícula ou desativação do destinatário; o professor que atua precisa continuar ativo e atribuído. O destinatário e a matrícula históricos precisam continuar existindo. Novos envios e lançamentos manuais exigem vínculos elegíveis atuais.

A exclusão mantém também a regra anterior de autoria docente; gestores autorizados mantêm sua administração institucional. Consultas usam filtro de tenant e autorização formal. Na listagem do aluno, a visibilidade é aplicada no banco **antes** da contagem/paginação. A RPC materializa somente IDs/datas antes do LIMIT e carrega o conteúdo da página depois.

## Endpoints

Prefixo de todos os caminhos: `/api/v1/tenants/:slug`. IDs novos são UUID. Os endpoints existentes mantêm validação sintática de identificadores legados; um UUID incompatível no banco recebe400. Corpos novos são estritos: não aceitam `studentId`, autor, horário ou anexos enviados pelo cliente.

| Método/caminho | Permissão e contrato |
| --- | --- |
| POST `/classes/:classId/activities` | Docente atribuído/gestor. Campos anteriores e novos;201 com atividade `draft`. |
| GET `/classes/:classId/activities?page=1&limit=20` | Visibilidade por vínculo; `{data,meta}`. |
| GET `/activities/:id` | Detalhe autorizado; rascunho invisível ao aluno. |
| PUT `/activities/:id` | Docente/gestor autorizado, campos editáveis mais `expectedVersion` para workflow novo. |
| POST `/activities/:id/publish` | Docente atribuído; `{expectedVersion}`. |
| POST `/activities/:id/close` | Docente/gestor; `{expectedVersion}`; somente publicada. |
| DELETE `/activities/:id` | Regra anterior de autoria/gestão, sem notas/entregas;204. |
| POST `/activities/:activityId/submissions` | Aluno da sessão; `{answer,expectedVersion}`;201 com recibo. |
| GET `/activities/:activityId/submissions/me` | Próprio aluno; recibo/resultado publicado ou `not_submitted`. |
| GET `/activities/:activityId/submissions?page=1&limit=20` | Docente atribuído/gestor; entregas paginadas com avaliações. |
| GET `/submissions/:id` | Próprio aluno ou docente atribuído/gestor. |
| GET `/submissions/:id/history?page=1&limit=20` | Mesma autorização; versões e avaliações paginadas separadamente com a mesma página/limite. Aluno recebe somente avaliações publicadas. |
| PUT `/submissions/:id/review` | Docente atribuído; `{expectedRevision,submissionVersion,grade?,feedback?,publish?}`. |
| POST `/submissions/:id/review/publish` | Docente atribuído; `{expectedRevision}`. |
| PUT `/activities/:activityId/grades/:studentId` existente | Preservado para lançamento manual sem entrega; atividade publicada/encerrada e matrícula elegível. Com entrega,409 `USE_SUBMISSION_REVIEW`. |

Página1–100000, limite1–100; padrão20. Novos envios/correções/publicações de resultado têm limite60/minuto por IP em cada rota; publicar/encerrar atividade,120/minuto por rota. Mantidos os demais limites existentes. Esses limitadores são em memória por processo e não substituem um mecanismo distribuído em implantação com várias instâncias.

Exemplo de criação (todos os dados abaixo são sintéticos):

```json
{
  "title": "Projeto de testes",
  "description": "Atividade sintética",
  "type": "assignment",
  "instructions": "Explique os cenários escolhidos.",
  "evaluationCriteria": "Clareza e cobertura",
  "dueDate": "2026-11-10T23:59:00-05:00",
  "priority": "high",
  "allowLate": false
}
```

A resposta preserva `id,title,description,dueDate,type,classId,createdBy`, com campos novos `state,instructions,evaluationCriteria,priority,allowLate,revision,workflowEnabled,publishedAt,closedAt` quando aplicáveis. Descrição/datas opcionais continuam omitidas quando ausentes. Prioridades: `low|medium|high`. Tipo permanece textual livre; não se impõe uma enumeração nova sobre dados anteriores.

Primeira entrega: `{ "answer": "Resposta sintética", "expectedVersion": 0 }`. Reenvio exige a versão atual e incrementa-a. Uma única entrega atual existe por atividade/aluno; versões anteriores permanecem. Duplicatas concorrentes não sobrescrevem: uma vence, outra recebe409. Reenvio é bloqueado após qualquer avaliação/nota, inclusive rascunho. A resposta da submissão é:

```json
{
  "id": "00000000-0000-4000-8000-000000000100",
  "activityId": "00000000-0000-4000-8000-000000000101",
  "studentId": "00000000-0000-4000-8000-000000000102",
  "version": 1,
  "answer": "Resposta sintética",
  "submittedAt": "2026-10-26T15:00:00.000Z",
  "isLate": false,
  "status": "submitted",
  "result": null
}
```

Correção inicial: `{ "expectedRevision":0, "submissionVersion":1, "grade":0, "feedback":"Feedback sintético", "publish":false }`. Repetir a revisão esperada correta para editar. Campo omitido preserva o valor atual; `null` limpa nota/feedback explicitamente. Nota aceita a escala **0–10 já existente em grades**; não é uma nova regra universal. Feedback até20000 caracteres, resposta até20000; título/descrição/tipo/instruções/critérios até102400, sujeitos também ao limite global de corpo JSON100kb. Não há truncamento silencioso.

Publicar a correção: `{ "expectedRevision":1 }`. Retorno:

```json
{
  "grade": 0,
  "feedback": "Feedback sintético",
  "gradedAt": "2026-10-26T16:00:00.000Z",
  "revision": 2,
  "publicationState": "published",
  "submissionVersion": 1
}
```

Nota ausente fica `null`; zero permanece zero. Uma correção publicada não volta a rascunho. Uma revisão posterior exige `publish:true` e a revisão atual, com snapshot anterior preservado. O aluno não recebe nota/feedback de rascunho; seu histórico também filtra as revisões não publicadas antes de paginar. O status do recibo pode indicar que existe uma correção em andamento, sem revelar seu conteúdo.

## Integração acadêmica e legado

`GradesRepository` filtra resultados publicados para o aluno e para `NativeAcademicProvider`. Avaliações são os mesmos registros de `grades`, sem duplicação. `assessments` representa avaliações individuais; não alimenta automaticamente médias, exame, aprovação ou nota final. Valores agregados e frequência continuam ausentes com os avisos da Etapa6. Native aplica a mesma visibilidade de atividades do aluno e acrescenta metadados opcionais de publicação/instruções/critérios/prioridade/atraso. Não infere entrega por data.

O modo demo acadêmico usa dados sintéticos e fica separado da persistência operacional de atividades.

Na migration, atividades existentes ficam `published`, `workflow_enabled=false`, revisão1; notas existentes ficam publicadas. Somente o estado **atual** das notas legadas é registrado no histórico inicial; não se reconstrói um passado inexistente. Novas atividades têm workflow habilitado e começam rascunho. Não há criação de matrícula, mapeamento de turma ou associação automática do legado.

PUT legado continua aceitando o corpo anterior sem `expectedVersion`. Para atividade nova, sua ausência retorna409 `ACTIVITY_VERSION_REQUIRED`. POST antigo passa a criar rascunho: clientes de autoria precisarão publicar explicitamente. O endpoint antigo de notas preserva o DTO e a autorização; para atividade nova sem entrega usa RPC transacional de lançamento manual e auditoria. Com entrega, exige correção vinculada à versão. Uma nota já existente impede criar entrega para evitar duas fontes concorrentes.

### Itens do plano N1/N2

Os contratos existentes de criação e edição aceitam o objeto opcional `assessment`. Exemplo para um trabalho:

```json
{ "stage": "N1", "category": "activity", "maxPoints": "1.50" }
```

As etapas são `N1` e `N2` e as categorias são `exam` e `activity`. Envie o objeto completo com pontos em string decimal de até duas casas. Omitir `assessment` preserva os dados na edição. Enviar `assessment: null` remove o vínculo de um rascunho. Atividades sem vínculo continuam sem esse campo na resposta.

O teto é de 7,00 para provas e 3,00 para atividades em cada etapa e oferta do tenant. Rascunhos e itens encerrados contam na distribuição. A transação usa um lock consultivo comum à oferta e revalida a soma em `READ COMMITTED`. Após a publicação de uma atividade ou abertura da pauta de uma prova, os metadados ficam fixos e o item permanece no plano.

A migration [`activity_assessment_plan`](../supabase/migrations/20261103185100_activity_assessment_plan.sql) é pré-requisito para implantar a API com esse contrato. O ensaio de concorrência está no runner descartável abaixo, com a opção adicional `--with-assessment-plan`, e depende de autorização específica para executar migrations nesse ambiente.

### Notas de provas presenciais

O prefixo das rotas abaixo é `/api/v1/tenants/:slug/activities/:activityId/exam`. A criação da prova usa o contrato de atividades com `assessment.category: "exam"`. A prova permanece em `draft` no ciclo de atividades textuais. Abrir a pauta registra `gradingOpenedAt`, incrementa a revisão da prova e fixa seus metadados acadêmicos.

| Método e rota | Requisição e retorno |
| --- | --- |
| `POST /activate` | Docente atribuído. Corpo `{"expectedVersion":1}`. Retorna `examId`, `revision` e `gradingOpenedAt`. |
| `GET /grades?page=1&limit=20` | Docente atribuído. Retorna metadados da prova, `data` e `meta` de paginação. Cada item contém `studentId` institucional, `studentName` e `result` nulo ou com a nota e o estado atual. |
| `PUT /grades/:studentId` | Salva rascunho. Corpo inicial `{"expectedRevision":0,"points":"5.50"}`. Para editar, use a revisão atual. |
| `POST /grades/:studentId/publish` | Publica o rascunho existente com `{"expectedRevision":1}`. Para corrigir uma nota já publicada, envie a revisão atual e a nova pontuação, por exemplo `{"expectedRevision":2,"points":"0.00"}`. |
| `GET /grades/me` | Aluno elegível. Retorna `examId`, `stage`, `maxPoints` e `result`. O aluno vem da sessão. Nota ausente ou em rascunho retorna `result: null`. |

Exemplo de resultado de publicação:

```json
{"points":"5.50","unit":"exam_points","publicationState":"published","revision":2,"gradedAt":"2026-11-03T19:00:00Z"}
```

Pontuações usam strings decimais com até duas casas, de zero ao máximo da prova. O banco resolve o aluno institucional da matrícula ativa ou concluída para o UUID Auth usado por `grades`. Docentes com atribuição vigente à mesma oferta consultam a pauta compartilhada. Um conflito de revisão ou estado retorna 409. Publicar ou corrigir preserva a autoria, a data e o histórico em `grade_revisions`. A leitura discente filtra notas publicadas antes de montar o resultado. Notas de prova ficam fora das listas e notificações legadas de atividades.

A [migration de notas de provas](../supabase/migrations/20261103190038_in_person_exam_grades.sql) deve preceder a nova API. Para um ensaio descartável autorizado, com a imagem `postgres:16-alpine` já disponível:

```powershell
node scripts/activity-workflow-database-test.cjs --allow-local-migrations --with-communication --with-assessment-plan --with-exam-grades
```

### Boletim e fechamento de N1/N2

O prefixo é `/api/v1/tenants/:slug/classes/:classId/report-card`.

| Método e rota | Contrato |
| --- | --- |
| `GET /me` | Boletim do aluno da sessão. |
| `GET /students/:studentId` | Boletim individual para docente atribuído. O ID é institucional. |
| `GET /?page=1&limit=20` | Resumo paginado para docente atribuído. Inclui totais, situação e contagem de pendências por aluno. |
| `GET /stages/N1?page=1&limit=20` | Estado e pendências paginadas de N1. Também aceita `N2`. Inclui `closure`, `eligibleCount`, `assessmentCount`, `blockers`, `data` e `meta`. |
| `POST /stages/N1/close` | Fecha N1. Aceita corpo vazio ou `{}`. Também aceita `N2`. Retorna o estado fechado com responsável e horário. Retorna 409 se a etapa já estiver fechada ou tiver bloqueios. |

Exemplo abreviado de um boletim parcial:

```json
{
  "status": "partial",
  "average": null,
  "stages": {
    "N1": {
      "applies": true,
      "closure": {"state": "closed", "closedAt": "2026-11-03T19:00:00Z"},
      "status": "definitive",
      "examPoints": "5.50",
      "activityPoints": "1.20",
      "total": "6.70",
      "pendingCount": 0
    }
  }
}
```

O detalhe inclui `publishedItems` e `pendingItemIds`. Itens ainda indisponíveis entram apenas na contagem de pendências. O aluno não recebe valor, estado ou revisão de uma nota em rascunho. A média e a classificação semestral saem do motor N1/N2 quando as duas etapas estiverem fechadas e se aplicarem ao aluno.

O fechamento exige pelo menos um item e um aluno elegível. A pauta inclui membros ativos com matrícula ativa ou concluída no instante da validação. Cada combinação de aluno e item exige avaliação disponível e nota numérica publicada. Uma prova fica disponível quando a pauta é aberta, e uma atividade fica disponível quando publicada ou encerrada. Zero publicado é válido, e os tetos de distribuição podem ficar parcialmente preenchidos. O professor consulta pendências por `assessment_unavailable`, `draft_grade` ou `missing_grade`. A ausência exige lançamento explícito pelo fluxo correspondente.

A pauta fica registrada no fechamento de cada etapa. Uma matrícula posterior não entra retroativamente na etapa já fechada e recebe `applies: false` para essa etapa. Um aluno que fazia parte da pauta mantém acesso ao seu resultado histórico enquanto seu vínculo institucional permitir autenticação, mesmo após cancelar a matrícula naquela oferta. A etapa aberta continua condicionada à elegibilidade atual.

A [migration de fechamento](../supabase/migrations/20261103190622_academic_report_cards.sql) deve preceder a nova API. Os triggers do banco usam o mesmo lock por oferta do plano avaliativo e bloqueiam gravações de notas ou alterações do plano da etapa fechada, inclusive pelos fluxos legados. Atividades sem etapa continuam fora do boletim. Para um ensaio autorizado com PostgreSQL descartável:

```powershell
node scripts/activity-workflow-database-test.cjs --allow-local-migrations --with-communication --with-assessment-plan --with-exam-grades --with-report-cards
```

## SQL, segurança e operação

Migration incremental: `supabase/migrations/20261026000004_activity_workflow.sql`. Ordem: migrations base →00001 segurança →00002 estrutura →00003 gestão institucional →00004 workflow. Anteriores não foram reescritas nesta etapa. Aplicação remota de toda a cadeia continua pendente e requer revisão/autorização; não há aplicação automática no startup.

Seis RPCs privadas: `manage_academic_activity`, `submit_activity_answer`, `review_activity_submission`, `publish_activity_review`, `record_activity_grade`, `list_academic_activities`. O ator é o ID institucional obtido pelo middleware, nunca o ID selecionado pelo aluno. Funções de mutação revalidam autor/vínculos após locks; `SECURITY DEFINER` com `search_path` fixo e execução apenas por `service_role`. Tabelas de histórico/entregas têm RLS e privilégios privados. Triggers validam identidade, estado, versão e histórico mesmo em operações diretas. A chave `service_role` continua sendo uma credencial privilegiada confiável, exclusiva do servidor.

A migration é transacional, não remove registros, possui timeouts e locks: pode falhar com segurança se o legado violar uma nova invariante ou houver contenção. Planejar janela, backup e validação do legado no ambiente de destino. Não usar DROP das novas tabelas como rollback de aplicação: preservar entregas e avaliações. Não se comprovou a aplicação em um Supabase real nem seu schema/configuração remotos nesta tarefa.

O runner local cria um container PostgreSQL16 com senha/porta efêmeras, vinculado somente a127.0.0.1, aplica a cadeia a dados sintéticos e remove apenas esse container ao final. Não lê URL remota de ambiente. Requer Docker e autorização explícita pela flag:

```powershell
node scripts/activity-workflow-database-test.cjs --allow-local-migrations
```

Não há storage privado configurado. Apenas texto é aceito; uploads, caminhos e URLs de anexos são rejeitados no corpo estrito. Extensão futura deverá ter bucket privado, autorização de download e contratos versionados. Nenhum bucket foi criado.

## Erros, logs e limites

Respostas sensíveis mantêm `Cache-Control: no-store, private`. Logs registram template de rota, método, status, duração, tenant seguro, categoria/código e `requestId`; não registram resposta textual, feedback, corpos completos, credenciais ou IDs dinâmicos da URL. `X-Request-Id` correlaciona a resposta com o log. Ver [observabilidade](observability.md).

```json
{
  "error": {
    "code": "DATA_CONFLICT",
    "message": "A operacao conflita com os registros existentes.",
    "requestId": "identificador-da-requisicao"
  }
}
```

| HTTP | Exemplos |
| --- | --- |
|400| JSON/UUID/payload/data/paginação inválidos. |
|401| Sessão ausente ou inválida. |
|403| Papel/vínculo docente/matrícula de envio não autorizados, membro inativo. |
|404| Recurso inexistente, de outro tenant ou entrega de outro aluno; rascunho não visível. |
|409| Versão antiga, duplicata, prazo vencido, estado incompatível, reenvio corrigido, DELETE com histórico. |
|429| Limite de requisições. |
|502| Resposta inválida do serviço de dados, inclusive linha de atividade malformada/fora do escopo. |
|503| Dependência indisponível; novas RPCs/schema ausentes retornam `DATABASE_MIGRATION_REQUIRED` quando identificados. |
|500| Erro interno inesperado, sem mensagens SQL/stack. |

O estado do banco precisa ser migrado antes de ativar esta versão; endpoints antigos podem falhar por schema incompatível. Não usar ausência de migration como modo de compatibilidade. Não há médias institucionais, frequência, anexos, chat, WebSocket, notificações ou alterações de frontend nesta etapa. Consultas compostas de Native/histórico não constituem um snapshot transacional único; uma atualização concorrente pode exigir nova consulta. Auditoria persistida não substitui política institucional de retenção/backup.

## Validação

Node22.23.4:345 testes em26 suítes aprovados; runner PostgreSQL16:235 verificações aprovadas, incluindo FKs, RLS/privilégios, rollback da migration/transações, escrita legada, zero/null, histórico imutável, corridas de primeira entrega/reenvio/correção/publicação/nota manual e alteração de vínculo/estado/prazo durante locks. SDK real usa fetch sintético para erros PostgREST; nenhum teste acessa portal ou Supabase remoto. Inventário e evidência de typecheck/build em stage-7-report.md.
