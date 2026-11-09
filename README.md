# UniConnect · API

API REST multi-instituição do TCC UniConnect. Centraliza autenticação, autorização e dados acadêmicos para o aplicativo Flutter e o painel administrativo React. Referência técnica da consolidação local em **09/11/2026**. Veja o [relatório de publicação e validação](docs/handoff-api-2026-11-04.md) e o [contrato HTTP + Realtime do chat para Flutter](docs/chat-realtime.md).

## Stack e arquitetura

- **Node.js 22.x**, conforme `engines`. O `package-lock.json` resolve Express **4.22.3**, TypeScript **5.9.3**, Zod **4.6.7**, `@supabase/supabase-js` **2.106.2** e `pg` **8.21.0**. Desenvolvimento com `tsx` e testes com Jest **30.4.2** e Supertest **7.2.2**.
- **Supabase Auth (GoTrue)** para credenciais e sessões. **PostgreSQL**, acessado por PostgREST e RPCs, para dados persistidos e operações acadêmicas transacionais. O Flutter atende alunos e professores. O painel web atende a administração institucional. Ambos usam a API Express. Os dados acadêmicos da demonstração são sintéticos e não contêm registros pessoais de instituições usadas como referência de estrutura.
- [`src/modules/`](src/modules/) contém rotas, validações, serviços e repositórios. [`src/routes.ts`](src/routes.ts) monta os módulos. [`src/middleware/`](src/middleware/) concentra contexto, autenticação e erros. [`supabase/`](supabase/) contém a base SQL e as migrations. [`scripts/`](scripts/) reúne rotinas operacionais e de teste.
- A API valida dados de entrada, aplica limites a rotas sensíveis e inclui um identificador de requisição nos erros para correlação. Consulte o [guia de observabilidade](docs/observability.md).

## Autenticação e isolamento

O Supabase Auth emite o access token JWT e o refresh token. Use o JWT nas chamadas protegidas e envie o refresh token somente à rota de renovação correspondente. Depois de renovar, substitua o par de tokens. O cliente envia `x-tenant-slug` para identificar a instituição. Nas rotas protegidas, envia também `Authorization: Bearer …`. A API resolve o tenant, verifica a sessão no Auth e confere o usuário ativo e seus vínculos. Em rotas com slug na URL, o contexto deve corresponder ao slug da chamada. Operações acadêmicas também verificam a oferta, a atribuição do professor ou a matrícula do aluno.

O login acadêmico atende o Flutter. O login administrativo institucional usa rotas próprias e admite os papéis internos `coordinator`, `admin` e `owner`, representados publicamente como `gestor` ou `admin`. O principal global de plataforma usa outra família de rotas e uma lista de IDs autorizados no servidor. A autorização global e a institucional têm escopos próprios.

Para renovar a sessão acadêmica, envie o corpo JSON `{refreshToken}` a `POST /api/v1/auth/refresh` com `x-tenant-slug`. O Supabase Auth renova a sessão, e a API revalida o usuário e o vínculo antes de devolver o novo par e `expiresAt`. Rejeições reconhecidas de sessão inválida, expirada ou reutilizada retornam `401 INVALID_SESSION`. O logout usa o Bearer e retorna `204`. JWTs já emitidos podem continuar válidos até a expiração conforme o provedor. A API também oferece recuperação de senha e ativação por convite. Renovação real, redirecionamentos e políticas do Auth precisam ser verificados no ambiente de destino. Veja [contas e sessões](docs/accounts-and-sessions.md), [segurança](docs/backend-security.md) e [autenticação de plataforma](docs/platform-auth.md).

## Rotas e capacidades

Os caminhos abaixo são relativos a `/api/v1`. Nas linhas acadêmicas e institucionais, os caminhos da segunda coluna também usam o prefixo `/tenants/:slug`.

| Área | Rotas principais | Comportamento implementado |
| --- | --- | --- |
| Saúde e sessão | `GET /health`, `POST /auth/login`, `GET /auth/me`, `POST /auth/refresh` e `POST /auth/logout` | Saúde da API, autenticação e ciclo da sessão acadêmica |
| Administração | `POST /auth/admin/login`, `GET /auth/admin/me`, `GET /auth/capabilities`, `/auth/platform/*` e `/platform/institutions` | Sessão administrativa, capacidades por papel e gestão global separada |
| Estrutura institucional | `/courses`, `/classes`, `/users`, `/academic-periods`, `/subjects`, `/offerings`, `/enrollments`, `/teaching-assignments` e `/invites` | Cursos, turmas, usuários, períodos, ofertas, matrículas, vínculos e convites, de acordo com o perfil |
| Atividades | `GET/POST /classes/:classId/activities`, `GET/PUT /activities/:id`, `POST /activities/:id/publish` e `POST /activities/:id/close` | Criação de rascunho, consulta, edição, publicação e encerramento |
| Entregas e correção | `GET/POST /activities/:activityId/submissions`, `GET /activities/:activityId/submissions/me`, `GET /submissions/:id`, `PUT /submissions/:id/review` e `POST /submissions/:id/review/publish` | Entrega e reenvio versionados, correção privada até publicação, nota individual e devolutiva |
| Provas presenciais | `POST /activities/:activityId/exam/activate`, `GET /activities/:activityId/exam/grades`, `PUT /activities/:activityId/exam/grades/:studentId` e `POST /activities/:activityId/exam/grades/:studentId/publish` | Abertura da pauta, lançamento, publicação e revisão de notas N1/N2 |
| Boletim e etapas | `GET /classes/:classId/report-card`, `GET /classes/:classId/report-card/me`, `GET /classes/:classId/report-card/students/:studentId`, `GET /classes/:classId/report-card/stages/:stage` e `POST /classes/:classId/report-card/stages/:stage/close` | Composição oficial, média, situação acadêmica e fechamento condicionado à avaliação da API |
| Comunicação | `/notices`, `/conversations`, `/conversations/:id/messages` e `/notifications` | Avisos, conversas autorizadas, mensagens persistidas e notificações internas via HTTP |

O prefixo acadêmico também oferece `/academic` para leitura pelo provider configurado. O painel web usa a autenticação administrativa real, enquanto a visão geral e as tabelas do MVP são demonstrativas. O Flutter integra trabalhos, entregas, provas e boletim. As rotas de comunicação ainda não compõem um chat operacional no Flutter.

O calculador do servidor separa trabalhos (até 3 pontos) e prova presencial (até 7 pontos) em cada etapa N1/N2. Preserva zero, ausência de nota e resultados ainda parciais. Com as etapas definitivas, a média a partir de 7 indica aprovação direta, e a faixa de 5 a menos de 7 indica elegibilidade à prova final. O fluxo da prova final permanece pendente.

## Instalação e execução local

Use Node.js 22 e npm. Na raiz da API, use os comandos abaixo. Para desenvolvimento com um banco local já preparado, configure um `.env` privado a partir de [`.env.example`](.env.example) e inicie:

```bash
npm ci
npm run dev
```

Por padrão, a porta é `3333`, o prefixo é `/api/v1` e o health check local é `http://127.0.0.1:3333/api/v1/health`. O servidor usa `HOST=0.0.0.0` por padrão. Para acesso exclusivamente local, configure `HOST=127.0.0.1`. O build compilado usa `npm run build` seguido de `npm start`.

| Configuração | Finalidade |
| --- | --- |
| `NODE_ENV`, `HOST`, `PORT`, `API_VERSION` | Ambiente, escuta e prefixo |
| `APP_ORIGIN` | Lista de origens CORS separadas por vírgula. Em produção, configure explicitamente as origens dos clientes. O fallback de loopback fica restrito a desenvolvimento e teste |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Conexão com o Supabase do ambiente escolhido. Mantenha a chave privilegiada exclusivamente no servidor |
| `AUTH_RECOVERY_REDIRECT_URL`, `AUTH_INVITE_REDIRECT_URL` | Destinos de recuperação e ativação. HTTPS em produção |
| `PLATFORM_ADMIN_AUTH_USER_IDS` | IDs do Auth autorizados para a administração global |
| `ACADEMIC_PROVIDER`, `ACADEMIC_DEMO_TENANT_SLUG` | Provider `disabled`, `demo` ou `native` e tenant da demonstração. O padrão é `disabled` |

### Demonstração descartável

O script local usa terminal interativo Windows, Node 22 e Docker Desktop com engine Linux. Solicita uma senha sintética sem eco, cria um ambiente efêmero em loopback e imprime a URL dinâmica da API e o tenant `uniconnect-local`. Execute somente com autorização para migrations no banco efêmero:

```bash
npm run build
node scripts/demo-local.cjs --allow-local-migrations
```

Na validação local, o manifesto original do harness não continha quatro migrations acadêmicas existentes neste checkout. A listagem docente retornou `500 ACTIVITIES_LIST_FAILED`. Um ensaio anterior usou essas quatro fontes em uma cópia temporária autorizada. O manifesto versionado continua com o escopo histórico. A reprodução de toda a jornada depende de um schema compatível e de autorização específica para preparar o ambiente. Com GoTrue **v2.197.0**, PostgREST **12.2.3** e PostgreSQL **16.15**, o Flutter Web comprovou autenticação, criação e publicação de trabalho, envio e reenvio e leitura docente da mesma entrega. A evidência consultada termina antes de salvar e publicar a devolutiva.

## Testes

```bash
npm test -- --runInBand
npm run typecheck
npm run build
npm run test:academic-build
```

A suíte usa Jest e Supertest para exercitar regras e contratos HTTP. Scripts de smoke, seed e segurança de banco têm pré-requisitos próprios. Confira o destino e a configuração antes de executá-los. Resultados unitários e do harness local não comprovam que a mesma cadeia esteja instalada ou operacional em ambiente hospedado.

## Ambientes e operação

| Ambiente | Estado e procedimento |
| --- | --- |
| Local | Configuração privada e base separada, ou harness descartável em loopback. A inicialização normal da API não aplica migrations automaticamente |
| Homologação | O rollout segue em **NO-GO**. As quatro migrations acadêmicas adicionais foram revisadas estaticamente e continuam pendentes de validação neste ambiente. Qualquer conexão, ensaio ou aplicação depende do procedimento e da autorização do ambiente |
| Produção | A implantação informada pelo operador utiliza Portainer. [`Dockerfile`](Dockerfile), [`.dockerignore`](.dockerignore) e [`docker-compose.yml`](docker-compose.yml) são preservados da `main`. `render.yaml` e `railway.json` são configurações legadas; sua presença não comprova implantação nesses serviços. Commit e imagem em execução precisam ser conferidos no Portainer antes de qualquer atualização |

### Docker / Portainer

O Compose mantém o serviço `uniconnect-api`, build local com Node 22, usuário de runtime `node` e mapeamento `${API_EXTERNAL_PORT:-3333}:3333`. A porta interna continua sendo 3333. O Docker healthcheck usa `GET /api/v1/health` (liveness). `GET /api/v1/health/ready` executa somente uma consulta de disponibilidade em `tenants`, responde 200 com `database.status=ok` ou 503 sem detalhes internos da dependência.

As variáveis da stack são `API_EXTERNAL_PORT` (padrão 3333), `NODE_ENV` (padrão production), `API_VERSION` (padrão v1), `APP_ORIGIN` e as três variáveis obrigatórias `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY`. Configure as origens reais explicitamente; a chave privilegiada fica somente no servidor. Nenhum segredo é incluído nos exemplos versionados.

O Compose atual não encaminha `PLATFORM_ADMIN_AUTH_USER_IDS`, `ACADEMIC_PROVIDER`, `ACADEMIC_DEMO_TENANT_SLUG`, `AUTH_RECOVERY_REDIRECT_URL` ou `AUTH_INVITE_REDIRECT_URL`. Se essas capacidades forem necessárias no destino, a passagem de configuração requer revisão e autorização separadas. Não altere a stack para validar esta branch.

Antes de um deploy futuro, conferir a branch monitorada, webhooks/atualização automática, imagem e configuração do projeto de destino. Publicar ou integrar código não autoriza deploy ou SQL. O envio do chat exige o script versionado `supabase/scripts/chat-realtime-broadcast.sql` no banco de destino; sua aplicação na base de teste não comprova disponibilidade em produção. Inicializar a API ou construir a imagem não aplica migrations.

### Lista administrativa de alunos

`GET /api/v1/tenants/:slug/users?role=aluno&page=1&limit=20&search=nome` usa Bearer e `x-tenant-slug` correspondentes. Admite `owner`, `admin` e `coordinator`; professor e aluno não têm acesso ao diretório administrativo. A resposta é `{ data, meta: { page, limit, total } }`, com limite máximo de 100. Busca por nome/e-mail e papel são os filtros existentes. `courseId` e `classId` não são filtros dessa rota. Matrículas por turma usam `/tenants/:slug/enrollments?classId=<UUID>` e retornam identificadores institucionais, sem ampliar a autorização do diretório.

### Seed de homologação

O seed exige um arquivo de ambiente privado explícito, separado do `.env` padrão. O script valida ambiente e identidade do projeto, o destino do DSN PostgreSQL, TLS com verificação de certificado e hostname e acesso administrativo ao Auth. Configure os valores de `UNICONNECT_ENVIRONMENT`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` e as senhas sintéticas exigidas pelo script nesse arquivo. Use `SUPABASE_DB_CA_FILE` se o ambiente exigir CA própria. O usuário do DSN deve corresponder à conexão direta ou ao pooler autorizado. Mantenha o arquivo fora do Git.

```bash
npm run seed:demo -- --env-file .env.seed-homologation --preflight
npm run seed:demo -- --env-file .env.seed-homologation
```

O primeiro comando faz a verificação de destino e leituras. O segundo cria ou atualiza contas de demonstração e executa `supabase/seed_demo.sql`. Use cada um somente com autorização correspondente. O preflight não libera a execução de escrita.

## Referências

- [Handoff, segurança e testes](docs/handoff-api-2026-11-04.md).
- [Modelo acadêmico](docs/academic-model.md), [providers](docs/academic-providers.md), [provider nativo](docs/native-academic-provider.md) e [gestão institucional](docs/institutional-management.md).
- [Atividades e entregas](docs/activity-workflow.md), [comunicação](docs/academic-communication.md) e [gestão de instituições](docs/platform-institutions.md).
