# UniConnect · API

API REST multi-instituição do TCC UniConnect. Centraliza autenticação, autorização e dados acadêmicos para o aplicativo Flutter e o painel administrativo React. Documentação revisada em **13/11/2026**, sobre a entrega FCM `b633bdb` e o cliente Android `d4d8e3d`. Evidências antigas continuam nos documentos de handoff, com o contexto e a data originais.

Clientes e instruções de execução: [uniconnect-clients](https://github.com/ykiakao/uniconnect-clients). API pública utilizada na entrega: `https://api-uni.juancjc.com.br/api/v1`. O endereço público da API não identifica, por si só, o projeto Supabase conectado: a validação da entrega usou **TEST**, não o projeto de produção.

## Stack e arquitetura

- **Node.js 22.x**, conforme `engines`. O `package-lock.json` resolve Express **4.22.3**, TypeScript **5.9.3**, Zod **4.6.7**, `@supabase/supabase-js` **2.106.2** e `pg` **8.21.0**. Desenvolvimento com `tsx` e testes com Jest **30.4.2** e Supertest **7.2.2**.
- **Supabase Auth (GoTrue)** para credenciais e sessões. **PostgreSQL**, acessado por PostgREST e RPCs, para dados persistidos e operações acadêmicas transacionais. O Flutter atende alunos e professores. O painel web atende a administração institucional. Ambos usam a API Express. Os dados acadêmicos da demonstração são sintéticos e não contêm registros pessoais de instituições usadas como referência de estrutura.
- [`src/modules/`](src/modules/) contém rotas, validações, serviços e repositórios. [`src/routes.ts`](src/routes.ts) monta os módulos. [`src/middleware/`](src/middleware/) concentra contexto, autenticação e erros. [`supabase/`](supabase/) contém a base SQL e as migrations. [`scripts/`](scripts/) reúne rotinas operacionais e de teste.
- A API valida dados de entrada, aplica limites a rotas sensíveis e inclui um identificador de requisição nos erros para correlação. Consulte o [guia de observabilidade](docs/observability.md).
- **Supabase Realtime Broadcast privado** sinaliza mudanças no chat; HTTP e PostgreSQL continuam como fonte de verdade. **Supabase Storage privado** armazena os anexos sob autorização da API. **Firebase Admin SDK 14.5.1** envia o evento push `activity_published` aos dispositivos Android registrados. São três integrações independentes.

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
| Anexos | `/activities/:id/attachment-uploads`, `/attachment-uploads/:id`, `POST /attachments/:id/download-url` | Reserva, confirmação, consulta, vínculo e download assinado; ver contrato específico abaixo |
| Dispositivos push | `POST/DELETE /notifications/devices` | Registro/desvinculação do token FCM do usuário autenticado; resposta 204 |

O prefixo acadêmico também oferece `/academic` para leitura pelo provider configurado. O Flutter integra trabalhos, entregas textuais versionadas, materiais e anexos de versões, correção/publicação, provas presenciais, boletim e chat HTTP com sinais Realtime. O painel integra usuários, convites, estrutura acadêmica, matrículas, vínculos, avisos e relatórios; a autorização institucional e a global continuam separadas. A presença do código não comprova que todas as dependências estejam habilitadas em uma stack remota.

O calculador do servidor separa trabalhos (até 3 pontos) e prova presencial (até 7 pontos) em cada etapa N1/N2. Preserva zero, ausência de nota e resultados ainda parciais. Com as etapas definitivas, a média a partir de 7 indica aprovação direta, e a faixa de 5 a menos de 7 indica elegibilidade à prova final. O fluxo da prova final permanece pendente.

## Instalação e execução local

Use **Node.js 22.x** e npm, conforme `package.json` e Dockerfile. Após clonar o repositório, na raiz da API:

```bash
npm ci
cp .env.example .env
```

No PowerShell, o segundo comando pode ser `Copy-Item .env.example .env`. Não sobrescreva um `.env` privado existente. Preencha-o fora do Git com valores fornecidos pelo operador para uma base **já preparada e autorizada**. Confirme o projeto de destino; não use produção para avaliação. Para a entrega, o projeto TEST de referência é `pvacwfypqsstdrfxajkg`, tenant `edukmais`. Não há senha padrão publicada.

```bash
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
| `ACADEMIC_ATTACHMENTS_MODE`, `ACADEMIC_ATTACHMENTS_BUCKET`, `ACADEMIC_ATTACHMENT_DOWNLOAD_TTL_SECONDS` | Modos `disabled`/`read_only`/`enabled`; bucket padrão `academic-attachments`; URL de download de 15–60 s, padrão 60 |
| `FCM_ENABLED`, `FIREBASE_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | Push desligado por padrão; projeto da entrega `uniconnect-b9c75`; caminho privado de credenciais ADC, nunca conteúdo JSON no `.env` ou Git |

Para os fluxos acadêmicos reais, configure `ACADEMIC_PROVIDER=native` e uma base compatível. Iniciar o servidor não cria contas, schema, bucket ou policies. `SUPABASE_SERVICE_ROLE_KEY` pertence exclusivamente ao servidor; não a envie ao Flutter ou Vite. Desative FCM e anexos se o ambiente autorizado não possui suas dependências.

Para executar o compilado:

```bash
npm run build
npm start
```

Verificações somente de leitura: `GET /api/v1/health` é liveness; `GET /api/v1/health/ready` consulta a disponibilidade de `tenants` e pode retornar 503. Exemplo: `curl http://127.0.0.1:3333/api/v1/health`. Readiness não comprova Auth, Storage ou Firebase.

### CORS e clientes locais

`APP_ORIGIN` contém origens exatas separadas por vírgula, sem caminhos: por exemplo, `http://localhost:5173,http://localhost:8080`. Fora de `production`, o middleware de [src/app.ts](src/app.ts) também admite HTTP em `localhost`, `127.0.0.1` e `10.0.2.2` com portas dinâmicas. Em `production`, é necessária allowlist explícita, inclusive para testes locais contra uma API remota. GitHub Pages usa a origem `https://ykiakao.github.io`, sem `/uniconnect-clients/`. Não liberar `*`. CORS da API e do Storage são verificações distintas.

## Integrações da entrega

### Chat — HTTP e Broadcast privado

Mensagens e recibos são enviados pela API; o cliente obtém o tópico autorizado em `GET /tenants/:slug/conversations/:id/realtime`. Usa o JWT da sessão Supabase Auth para assinar um canal privado e recebe `message.created` e `conversation.read`. Broadcast é sinal best effort: o histórico por sequência e a reconciliação HTTP recuperam lacunas. O Flutter já possui esse consumidor e não publica mensagens diretamente no socket. Horário de atendimento e participação são validados no servidor.

A base precisa das tabelas/RPCs e das policies do patch histórico `supabase/scripts/chat-realtime-broadcast.sql`, aplicado anteriormente em TEST. Não reaplicar para seguir este README. Ver [contrato e evidências históricas](docs/chat-realtime.md). Isso é independente de notificações Android FCM.

### Anexos — Supabase Storage privado

Professor anexa materiais à atividade; aluno anexa arquivos a versões elegíveis de entrega; leitura e correção respeitam matrícula, vínculo docente e tenant. O limite é **10.000.000 bytes por arquivo**, até **5 anexos** por atividade/versão, formatos PDF, DOCX, PNG e JPEG. O servidor valida conteúdo real e estrutura, além de extensão/MIME; documentos com recursos ativos ou estruturas não suportadas podem ser recusados. Não equivale a antivírus.

Fluxo: reservar com `Idempotency-Key` → transferir bytes ao Storage usando o descritor assinado → confirmar → consultar até estado `ready` → vincular ao material ou à versão da entrega. Timeout não significa cancelamento: consultar o upload antes de repetir. URLs são capacidades temporárias; não registrar nem persistir seus tokens. Upload assinado vale até duas horas; download usa TTL curto e não oferece revogação individual imediata.

Dependências: migration `20261112210356_academic_attachments.sql`, metadados/RPCs, bucket **privado** com limite de 10.000.000 bytes e allowlist exata dos quatro MIME, credencial de servidor e modo habilitado. Não são criados no startup. `read_only` permite leitura; nova versão textual sem anexos exige confirmação no Flutter e preserva o histórico anterior. Limpeza de órfãos usa rotina controlada, fora do caminho de inicialização; não executar limpeza global.

Ver [contrato de anexos e recuperação](docs/academic-attachments-api.md). O fluxo foi validado com dados sintéticos em TEST em rodada anterior; isso não garante a disponibilidade atual em qualquer stack. `ATTACHMENT_STORAGE_UNAVAILABLE` exige conferir configuração do bucket, permissões, conectividade e logs pelo requestId; não demonstra sozinho a causa raiz.

### Push Android — Firebase FCM

Registro/desvinculação: `POST`/`DELETE /api/v1/tenants/:slug/notifications/devices`, corpo `{token}`, Bearer e `x-tenant-slug`. Somente a **publicação de atividade** dispara `activity_published` para dispositivos de alunos matriculados. Notas, avisos e chat não geram push FCM nesta entrega; notificações internas da API são outro mecanismo.

O envio é best effort e não desfaz a publicação acadêmica. O registro de dispositivos é **em memória**, exige uma única instância/processo e é perdido no reinício da API; o cliente deve registrar novamente após login/restauração. Não há fila durável ou retentativa persistente. O Flutter coordena registro, token refresh, desvinculação antes do logout e navegação para a atividade, com verificações de sessão e tenant. Falhas de rede não impedem o logout; não há promessa de revogar mensagens já em trânsito.

Evidência de 13/11/2026: publicação acadêmica pela API já testada em TEST; APK release recebeu push real em foreground/background e o operador confirmou abertura da atividade correta pelo toque. O teste final do APK foi direto pela API Firebase, reutilizando a atividade existente, sem nova escrita acadêmica. Processo realmente encerrado, rotação real de token e supressão após logout não foram concluídos fisicamente. Ver [FCM no Portainer](docs/fcm-portainer.md).

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
npm run test:push
npm run test:attachments
npm run test:attachments:cleanup
```

A suíte Jest/Supertest usa mocks do Supabase para regras, autorização, isolamento e contratos HTTP. `test:push` e `test:attachments` selecionam esses módulos; `test:attachments:cleanup` usa fakes, sem limpar Storage real. `npm run test:watch` acompanha os testes. Esses comandos não comprovam entrega de push ou upload remoto.

`test:attachments:db` usa PGlite efêmero e executa SQL de preparação/migrations somente nesse banco em memória; não foi executado nesta revisão documental. Scripts `test:auth`, `test:academic`, `test:invites`, `test:academic-build`, `test:security-db`, `setup:supabase` e `seed:demo` não são pré-requisitos de leitura: podem precisar de serviços reais e executar operações. Inspecione-os e obtenha autorização específica antes de usar. Não executar seeds/migrations para avaliar o README.

## Ambientes e operação

O deploy atual é feito por **Portainer/Docker Compose**, não por Render ou Railway. Os arquivos de configuração específicos desses provedores foram removidos. A documentação histórica pode citar provedores ou estados anteriores; não deve ser usada como fonte única da configuração ativa.

| Ambiente | Estado e procedimento |
| --- | --- |
| Local | Configuração privada e base separada, ou harness descartável em loopback. A inicialização normal da API não aplica migrations automaticamente |
| Base de teste (`uniconnect-test`) | Projeto Supabase de teste usado na demonstração (`edukmais`). Mudanças de schema, seeds e policies exigem autorização própria; a implantação da API não executa migrations automaticamente |
| API pública (Portainer) | `https://api-uni.juancjc.com.br/api/v1` é o endereço utilizado pelos clientes. A stack usa [`Dockerfile`](Dockerfile), [`.dockerignore`](.dockerignore) e [`docker-compose.yml`](docker-compose.yml). A instância atualmente configurada utiliza o projeto Supabase de teste; isso **não** significa implantação no projeto Supabase de produção. Antes de atualizar a stack, verificar commit, imagem, variáveis e destino efetivos no Portainer |

### Docker / Portainer

A preparação de FCM, os endpoints de dispositivo, a credencial privada montada somente para leitura e os passos manuais estão em [FCM no Portainer](docs/fcm-portainer.md). Antes de atualizar para esse Compose, configurar o caminho do arquivo no host; publicar código não autoriza deploy.

**Referência do Compose publicado (`b633bdb`):** bind mount de `FIREBASE_ADMIN_CREDENTIALS_HOST_PATH` para `/run/secrets/firebase-admin.json`, somente leitura, inclusive quando FCM está desligado. Há uma adaptação local ainda não publicada para o volume externo `uniconnect-firebase-secrets` em `/run/secrets`; ela não faz parte desta atualização exclusivamente documental. Não presumir que o arquivo local, o Git e a stack ativa são idênticos: conferir revisão e montagem efetivas sem exibir credenciais. `GOOGLE_APPLICATION_CREDENTIALS` permanece `/run/secrets/firebase-admin.json` em ambas as variantes.

O Compose mantém o serviço `uniconnect-api`, build local com Node 22, usuário de runtime `node` e mapeamento `${API_EXTERNAL_PORT:-3333}:3333`. A porta interna continua sendo 3333. O Docker healthcheck usa `GET /api/v1/health` (liveness). `GET /api/v1/health/ready` executa somente uma consulta de disponibilidade em `tenants`, responde 200 com `database.status=ok` ou 503 sem detalhes internos da dependência.

As variáveis da stack incluem `API_EXTERNAL_PORT` (padrão 3333), `NODE_ENV` (padrão production), `API_VERSION` (padrão v1), `APP_ORIGIN`, `PLATFORM_ADMIN_AUTH_USER_IDS`, `ACADEMIC_PROVIDER` e as três variáveis obrigatórias `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY`. Configure as origens reais explicitamente; a chave privilegiada fica somente no servidor. Nenhum segredo é incluído nos exemplos versionados.

O Compose atual encaminha `PLATFORM_ADMIN_AUTH_USER_IDS` e `ACADEMIC_PROVIDER` (padrão `disabled`); na stack de demonstração, `ACADEMIC_PROVIDER=native` foi configurado no Portainer. O Compose **não** encaminha explicitamente `ACADEMIC_DEMO_TENANT_SLUG`, `AUTH_RECOVERY_REDIRECT_URL` ou `AUTH_INVITE_REDIRECT_URL`. Se necessárias, essas variáveis exigem revisão e autorização antes de alterar a stack.

Antes de um deploy futuro, conferir a branch monitorada, webhooks/atualização automática, imagem e configuração do projeto de destino. Publicar ou integrar código não autoriza deploy ou SQL. O envio do chat exige o script versionado `supabase/scripts/chat-realtime-broadcast.sql` no banco de destino; sua aplicação na base de teste não comprova disponibilidade em produção. Inicializar a API ou construir a imagem não aplica migrations.

### Lista administrativa de alunos

`GET /api/v1/tenants/:slug/users?role=aluno&page=1&limit=20&search=nome` usa Bearer e `x-tenant-slug` correspondentes. Admite `owner`, `admin` e `coordinator`; professor e aluno não têm acesso ao diretório administrativo. A resposta é `{ data, meta: { page, limit, total } }`, com limite máximo de 100. Busca por nome/e-mail e papel são os filtros existentes. `courseId` e `classId` não são filtros dessa rota. Matrículas por turma usam `/tenants/:slug/enrollments?classId=<UUID>` e retornam identificadores institucionais, sem ampliar a autorização do diretório.

### Seed de ambiente de teste (script histórico)

O seed exige um arquivo de ambiente privado explícito, separado do `.env` padrão. O script valida ambiente e identidade do projeto, o destino do DSN PostgreSQL, TLS com verificação de certificado e hostname e acesso administrativo ao Auth. Configure os valores de `UNICONNECT_ENVIRONMENT`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` e as senhas sintéticas exigidas pelo script nesse arquivo. Use `SUPABASE_DB_CA_FILE` se o ambiente exigir CA própria. O usuário do DSN deve corresponder à conexão direta ou ao pooler autorizado. Mantenha o arquivo fora do Git.

```bash
npm run seed:demo -- --env-file .env.seed-homologation --preflight
npm run seed:demo -- --env-file .env.seed-homologation
```

O primeiro comando faz a verificação de destino e leituras. O segundo cria ou atualiza contas de demonstração e executa `supabase/seed_demo.sql`. Use cada um somente com autorização correspondente. O preflight não libera a execução de escrita.

## Referências

- [Clientes Flutter e painel React](https://github.com/ykiakao/uniconnect-clients), [anexos](docs/academic-attachments-api.md), [chat Realtime](docs/chat-realtime.md) e [FCM](docs/fcm-portainer.md).
- [Handoff, segurança e testes](docs/handoff-api-2026-11-04.md).
- [Modelo acadêmico](docs/academic-model.md), [providers](docs/academic-providers.md), [provider nativo](docs/native-academic-provider.md) e [gestão institucional](docs/institutional-management.md).
- [Atividades e entregas](docs/activity-workflow.md), [comunicação](docs/academic-communication.md) e [gestão de instituições](docs/platform-institutions.md).
