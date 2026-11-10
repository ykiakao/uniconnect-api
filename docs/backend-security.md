# Etapa 3 — Segurança e integridade do backend

As correções ficam exclusivamente na API. Esta etapa se concentra na proteção das rotas e dos dados da API. Nenhuma migration é executada ao iniciar a API.

## Autorização institucional e global

Todos os papéis de `app_users` são institucionais. `owner` é dono da instituição, não administrador global da plataforma.

| Ator institucional | Pode criar/convidar/conceder | Pode alterar usuários existentes |
| --- | --- | --- |
| student / teacher | Nenhum papel | Nenhum |
| coordinator | student, teacher | student, teacher |
| admin | student, teacher, coordinator | student, teacher, coordinator |
| owner | student, teacher, coordinator, admin | student, teacher, coordinator, admin |

Nenhum usuário altera o próprio papel por HTTP, mesmo para rebaixá-lo. Não é possível modificar pares/superiores ou conceder `owner` pelas rotas existentes. Coordenadores continuam cadastrando alunos/professores; administradores continuam gerenciando os papéis inferiores. A atualização inclui o papel anterior no filtro de escrita para recusar uma alteração concorrente do destinatário.

As mesmas regras de concessão valem para convites. Convites antigos privilegiados não são apagados automaticamente; a etapa de consumo de convites ainda não existe e precisará revalidar concessão/expiração/uso.

`GET /api/v1/admin/reports/global` exige que o UUID de **Supabase Auth** do usuário autenticado esteja em `PLATFORM_ADMIN_AUTH_USER_IDS`. A lista é vazia por padrão, usa UUIDs separados por vírgula e existe apenas no ambiente do servidor. Nenhum corpo/header/query ou papel institucional altera essa lista. A autenticação ainda exige um usuário vinculado à aplicação. `/auth/admin/login` continua sendo o login administrativo institucional e não concede acesso global.

**Compatibilidade:** operadores que antes acessavam relatórios globais somente por terem papel admin/owner precisam ter seus UUIDs Auth autorizados no servidor. Não preencher automaticamente a lista com todos os administradores institucionais. O login, acesso institucional e tokens existentes permanecem válidos; o acesso global depende dessa configuração explícita.

## Notas e docentes

Destinatários de notas são resolvidos contra `app_users` com **tenant e papel student**. IDs públicos e IDs Auth continuam aceitos, mas ambos precisam corresponder ao mesmo vínculo válido. Ausência, papel incorreto, vínculo em outro tenant, UUID inválido ou associação ambígua retornam 404. Falhas operacionais da consulta não são tratadas como identidade válida. O fallback para um ID arbitrário foi removido tanto da escrita quanto da consulta de notas.

A autorização atual para lançar uma nota combina permissão do ator sobre a atividade com o vínculo institucional do aluno. **Não comprova matrícula na turma:** esse modelo ainda não existe. O ponto de resolução `GradesRepository.resolveStudentAuthUserId`/`UsersRepository.findAcademicMember` deve ser complementado pela política de matrícula/oferta da Etapa 4 antes de usar essa autorização como elegibilidade formal. Não foram criadas matrículas sintéticas nem inferidas matrículas a partir do nome do curso.

Turmas só aceitam professores com vínculo `teacher` na mesma instituição. A atualização também revalida o professor existente quando `teacherId` é omitido, preservando-o. Coordenador/admin/owner não são aceitos como docentes apenas por terem poder administrativo. A ausência de professor continua permitida na criação.

A política compartilhada `shared/class-access.ts` governa consulta direta, lista e turmas embutidas em cursos: gestores veem as turmas institucionais; professores veem somente as atribuídas a seu ID Auth; alunos conservam provisoriamente o acesso pelo nome do curso cadastrado. Curso sem correspondência retorna metadados do catálogo com `classes: []`. Essa associação textual continua uma limitação a substituir por matrícula formal.

## Migration pendente e ordem de atualização

Arquivo: `supabase/migrations/20261026000001_security_integrity.sql`.

A migration foi preparada e verificada em PostgreSQL 16 descartável. **Não foi aplicada ao Supabase remoto.** Ela pressupõe o schema e as três migrations anteriores já aplicados. Os nomes/renomeações anteriores existentes no workspace foram preservados.

Ela adiciona:

- Unicidade de notas por `(tenant_id, activity_id, student_id)` e faixa de notas 0–10, preservando `null` no schema e zero explícito.
- FKs compostas para curso/turma, turma/atividade, atividade/nota, professor/instituição e aluno/instituição.
- Triggers de validação de papel docente/discente na escrita, inclusive alterações, com bloqueio compartilhado do vínculo durante a operação.
- Proteção contra mudança de papel que invalidaria notas ou atribuições docentes existentes.
- Preflight que aborta diante de duplicatas, vínculos inválidos, atividades fora do tenant ou notas fora da faixa. Não remove nem corrige registros silenciosamente.

O arquivo usa transação, `lock_timeout=5s` e `statement_timeout=60s`. Requer janela de manutenção: bloqueia escritas nas tabelas envolvidas durante validação e criação dos índices/constraints. Não é uma migration repetível; deve ser aplicada uma vez e registrada pelo operador. O runner administrativo legado não possui ledger de migrations e não deve ser usado como ferramenta de atualização incremental.

Ordem recomendada para aplicação futura, após revisão/backup e autorização do operador:

1. Avaliar o preflight em uma cópia local dos dados e revisar manualmente qualquer inconsistência. Não escolher arbitrariamente qual nota duplicada manter.
2. Aplicar **somente esta migration pendente** com ferramenta de migrations/SQL aprovada, preservando a transação do arquivo; registrar sua execução. Se o cliente mantiver transação abortada após falha, executar rollback antes de reutilizar a sessão.
3. Verificar constraints, triggers, fluxos legítimos e atualizar o cache de schema do PostgREST conforme a operação do ambiente exigir.
4. Implantar a API atualizada em uma etapa posterior explicitamente autorizada.

**Dependência de compatibilidade:** a escrita atômica de notas usa `upsert` com a nova chave de conflito. Sem a migration, PostgreSQL retorna `42P10`, convertido em HTTP 503 `DATABASE_MIGRATION_REQUIRED`. Não há fallback para escrita insegura. Leituras, login e o provedor demo não dependem dessa constraint. Conflitos de integridade durante escrita de nota retornam 409 `GRADE_INTEGRITY_CONFLICT`; mudanças de papel incompatíveis com registros existentes retornam 409 `ROLE_INTEGRITY_CONFLICT`. Antes de mudar o papel de um docente com turmas, a instituição precisa reatribuir suas turmas; notas históricas não são apagadas para viabilizar mudança de papel.

As FKs preservam os cascades já existentes de curso → turma → atividade → nota; não foi criada política de arquivamento nem corrigido o risco preexistente de exclusão administrativa em cascata. Exclusão direta do vínculo institucional de aluno/docente com referências passa a ser recusada. As políticas RLS existentes permanecem iguais; a API ainda usa `service_role` e depende das verificações por tenant. Não foram criadas novas políticas RLS nesta etapa.

## HTTP, cache e limites

Todas as respostas sob `/api/v1` recebem `Cache-Control: no-store, private`, `Pragma: no-cache`, `Surrogate-Control: no-store` e variam por autenticação e tenant. ETag fica desabilitado na aplicação; cabeçalhos condicionais de cache são descartados, inclusive em erros e autenticação. JSON sintaticamente inválido retorna 400 `INVALID_JSON`, sem refletir o corpo ou detalhes do parser.

Limites em memória por IP observado pelo Express, antes de consultar o Supabase:

| Rotas | Limite por processo/IP |
| --- | --- |
| `/auth/login`, `/auth/admin/login` (contador compartilhado) | 30 / 15 minutos |
| `/invites/*` | 60 / minuto |
| `/tenants/:slug/invites` | 30 / minuto |

Respostas 429 incluem `Retry-After`. Cada contador admite no máximo 10.000 IPs ativos e recusa novas chaves quando cheio. Não armazena senhas, e-mails ou tokens. Os limites de consultas acadêmicas da Etapa 2 continuam funcionando.

`trust proxy` permanece desabilitado: `X-Forwarded-For` do cliente não contorna o limite. Atrás de proxy reverso, os usuários podem compartilhar o IP do proxy; configurar limites adicionais na borda e avaliar uma lista precisa de proxies confiáveis antes de habilitar leitura de IP encaminhado. Em múltiplas instâncias os contadores não são compartilhados; reiniciar o processo os zera. Um limitador distribuído e proteção por conta são melhorias posteriores, não garantias desta implementação.

## TLS do script administrativo

`setup-supabase.ts` agora exige validação de certificado por padrão. `SUPABASE_DB_SSL_MODE=verify-full` é o padrão. Para certificados privados, informar `SUPABASE_DB_CA_FILE` com caminho para a CA confiável em PEM; não desabilitar a validação. O script continua sendo uma operação administrativa com efeitos de banco e não é executado nos testes ou no startup.

Uma URL com `sslmode=require` é normalizada para a verificação completa; `sslmode=verify-full` também é aceito. Modos inseguros e parâmetros SSL/certificado na URL são recusados para evitar que o parser de conexão substitua as opções seguras. `host`/`hostaddr` na query também são recusados: o destino deve estar na autoridade da URL.

`SUPABASE_DB_SSL_MODE=disable` só é aceito explicitamente para `localhost`, `127.0.0.1` ou `[::1]`, sem CA. Certificados privados antes aceitos com `rejectUnauthorized:false` exigem a CA correta; não há tentativa automática sem verificação.

## Verificação local

Requer Node.js 22; testes de banco também exigem Docker Desktop/Engine ativo e imagem `postgres:16-alpine` disponível (`docker pull postgres:16-alpine`, se necessário).

```powershell
npm test -- --runInBand --no-cache
npm run typecheck
npm run build
npm run test:academic-build
npm run test:security-db
```

O teste de banco cria um container com porta aleatória ligada somente a `127.0.0.1`, senha aleatória em memória, dados sintéticos e remoção em `finally`. Ignora qualquer URL/credencial Supabase do ambiente. Testa constraints, papéis, alterações de vínculo, oito conexões concorrentes de upsert, disputas entre lançamento de nota e mudança de papel nos dois sentidos, RLS atual para papel não privilegiado e rollback do preflight com dados inconsistentes. O modo `--baseline` serve para demonstrar a falha sem a migration e termina com erro esperado.

Esse teste usa o motor PostgreSQL real, não mocks de constraints. O schema mínimo de `auth.users` e `auth.role()` é um suporte local sintético: não reproduz todo o serviço Supabase Auth/PostgREST nem comprova o estado/políticas efetivamente aplicados no ambiente remoto. Os testes HTTP continuam usando o mock Supabase e são evidência de autorização da aplicação, não de integridade remota.

## Arquivos da Etapa 3

- Configuração e autorização: `.env.example`, `src/config/env.ts`, `src/shared/roles.ts`, `src/modules/users/users.service.ts`, `src/modules/users/users.repository.ts`, `src/modules/invites/invites.service.ts`, `src/modules/reports/reports.service.ts`.
- Dados acadêmicos: `src/modules/grades/grades.repository.ts`, `src/modules/classes/classes.service.ts`, `src/modules/courses/courses.service.ts`, `src/shared/class-access.ts`.
- HTTP/TLS: `src/app.ts`, `src/middleware/error-handler.ts`, `src/middleware/sensitive-response.ts`, `src/middleware/rate-limit.ts`, `src/config/admin-database.ts`, `scripts/setup-supabase.ts`.
- Verificação: `src/test/security-regressions.test.ts`, `src/shared/roles.test.ts`, `src/modules/users/users.repository.test.ts`, `src/modules/grades/grades.repository.test.ts`, `src/middleware/security-protection.test.ts`, `src/test/setup.ts`, `src/test/supabase-mock.ts`, `scripts/security-database-test.cjs`, `package.json`.
- Schema e documentação: a migration acima, este documento, `README.md`, `docs/codex-kit/plans/2026-10-26-backend-security.md`, `docs/reviews/2026-10-26-backend-security.md`.

## Dependências da Etapa 4

Permanecem pendentes matrículas formais/ofertas/períodos/disciplinas, associação de aluno por ID e não nome do curso, política de elegibilidade de nota por matrícula, suporte a múltiplos vínculos acadêmicos e papéis por pessoa, arquivamento/histórico de alterações, consumo seguro de convites e autorização RLS independente da chave administrativa. O modelo de papel único hoje impede converter aluno com notas históricas em professor sem uma decisão sobre preservação de vínculos; isso deve ser tratado pelo modelo formal, sem remover o histórico.

Refresh token, recuperação de senha, limitação distribuída/por conta, auditoria persistente e controles de operação continuam fora deste recorte. As correções não implementam entregas, avisos, chat ou novas funcionalidades acadêmicas.
