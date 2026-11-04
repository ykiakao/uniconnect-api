# Observabilidade, logs e erros — Etapa 3.1

## Execução e configuração

Requer Node.js 22 e a configuração Supabase da API existente. Não há novas dependências npm, variáveis obrigatórias, tabelas ou migrations nesta etapa.

```powershell
npm run dev
```

Em desenvolvimento, `NODE_ENV=development` imprime eventos JSON indentados em stdout. Para executar a saída compilada em produção:

```powershell
npm run build
$env:NODE_ENV = 'production'
npm start
```

Em produção, cada evento é uma linha JSON compacta, adequada à coleta pelo ambiente de hospedagem. Com `NODE_ENV=test`, o logger padrão é silencioso; testes de logs usam um destino explícito em memória. Não existe configuração `LOG_LEVEL` ou `LOG_FORMAT` nesta implementação. O startup emite `server_started`, sem credenciais ou endereço de conexão.

## Evento de requisição

O middleware inicia a observação antes de CORS, parsing de JSON, rate limiting, autenticação e rotas. Gera um UUID próprio, ignorando `X-Request-Id` fornecido pelo cliente, e devolve `X-Request-Id` na resposta. Respostas CORS permitidas expõem esse header ao JavaScript do navegador.

Uma requisição concluída emite um único evento `http_request`:

```json
{"timestamp":"2026-10-26T15:00:00.000Z","level":"info","service":"uniconnect-api","environment":"production","event":"http_request","requestId":"8ce657b4-551d-4e22-85dc-c49c18f29023","method":"GET","route":"/api/v1/tenants/:slug/courses","status":200,"durationMs":12.4,"tenantId":"11111111-1111-1111-1111-111111111111"}
```

Exemplo sintético de erro:

```json
{"timestamp":"2026-10-26T15:00:01.000Z","level":"warn","service":"uniconnect-api","environment":"production","event":"http_request","requestId":"5aa79ff8-c954-4564-ac06-cdf392ec782c","method":"GET","route":"/api/v1/tenants/:slug/courses","status":401,"durationMs":2.1,"errorCategory":"authentication","errorCode":"AUTH_TOKEN_REQUIRED"}
```

| Campo | Significado |
| --- | --- |
| `timestamp` | Horário UTC de emissão do evento |
| `requestId` | UUID gerado para essa requisição, sem identidade pessoal |
| `method` | Método HTTP conhecido; métodos desconhecidos aparecem como `OTHER` |
| `route` | Modelo registrado da rota, com parâmetros como `:slug`/`:id`; `unmatched` quando não há correspondência |
| `status` | Status final; 499 nos logs quando a conexão termina antes da conclusão da resposta |
| `durationMs` | Duração medida com relógio monotônico, em milissegundos, arredondada a duas casas |
| `tenantId` | UUID institucional, somente quando `currentUser.tenantId` coincide com o tenant resolvido |
| `errorCategory` | Categoria do erro, quando houver |
| `errorCode` | Código controlado da API, quando disponível; mensagens e detalhes não são registrados |

Os níveis são `info` para respostas abaixo de 400, `warn` para 4xx e `error` para 5xx. Categorias: `validation`, `authentication`, `authorization`, `not_found`, `conflict`, `rate_limit`, `unavailable`, `not_implemented`, `internal` e `request_aborted`.

O tenant não é copiado de headers ou parâmetros. Requisições sem autenticação institucional concluída, como login, lookup público, convite ou rejeição antecipada, podem não conter `tenantId`. A correlação usa um objeto de requisição local; não existe variável global com tenant/usuário corrente.

O registro de rotas é construído a partir dos modelos dos routers montados e da rota de health. Ele permite reconhecer modelos mesmo quando a falha acontece antes do handler, como JSON inválido ou bloqueio pelo limitador. Novos routers devem usar a montagem existente em `routes.ts`; rotas adicionadas diretamente ao app precisam ser registradas explicitamente, como o health.

### Conexões interrompidas

Quando o cliente fecha a conexão antes de `response.writableFinished`, o evento registra `status: 499`, `level: warn` e `errorCategory: request_aborted`. Os eventos `finish` e `close` compartilham uma guarda para impedir emissão duplicada.

499 é uma classificação do log, não uma resposta adicional enviada ao cliente. Se a resposta já começou com 200 e o cliente cancela, ele pode ter recebido o header 200 e um fragmento; o log final ainda registra a interrupção. O teste automatizado usa um servidor HTTP real em loopback, lê o primeiro fragmento, encerra o cliente e verifica o ID original e o evento único. Nenhuma mudança de arquitetura foi necessária.

## Privacidade dos logs

Os eventos são montados por lista explícita de campos. Não incluem:

- URL bruta, query string, valores dos parâmetros ou códigos de convite.
- Authorization, cookies, senhas, tokens ou headers completos.
- Corpo de requisição/resposta, notas, matrícula, nomes ou e-mails pessoais.
- Mensagens do Supabase, SQL, detalhes de erro ou stack traces.

Por exemplo, `/api/v1/invites/CODIGO-PRIVADO?token=segredo` aparece apenas como `/api/v1/invites/:code`. Um caminho desconhecido aparece como `unmatched`; o caminho original não é usado como fallback.

Logs são informação operacional restrita ao servidor, não um endpoint acessível por usuários institucionais. O UUID de tenant também deve ser tratado como metadado interno no coletor. O `requestId` não autentica, não autoriza e não permite escolher instituição ou acessar dados de outro usuário.

## Contrato de erros

Respostas de sucesso mantêm os payloads existentes. Erros preservam o envelope `error`, os códigos/mensagens existentes quando corretos, e acrescentam `error.requestId`. O mesmo ID é devolvido em `X-Request-Id`:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Cache-Control: no-store, private
X-Request-Id: 8ce657b4-551d-4e22-85dc-c49c18f29023
```

```json
{"error":{"code":"INVALID_JSON","message":"JSON invalido.","requestId":"8ce657b4-551d-4e22-85dc-c49c18f29023"}}
```

```json
{"error":{"code":"DEPENDENCY_UNAVAILABLE","message":"O servico de dados esta temporariamente indisponivel. Tente novamente mais tarde.","requestId":"5aa79ff8-c954-4564-ac06-cdf392ec782c"}}
```

| Situação | Status/código exemplificativo |
| --- | --- |
| JSON malformado | 400 `INVALID_JSON` |
| Entrada inválida | 400 `VALIDATION_ERROR` |
| Corpo acima do limite do parser | 413 `PAYLOAD_TOO_LARGE` |
| Credenciais inválidas ou sessão inválida | 401 `INVALID_CREDENTIALS` / `INVALID_SESSION` |
| Token ausente | 401 `AUTH_TOKEN_REQUIRED` |
| Sem autorização ou CORS rejeitado | 403 `FORBIDDEN` / `CORS_ORIGIN_FORBIDDEN` |
| Vínculo institucional ausente | 403 `USER_NOT_LINKED_TO_TENANT` |
| Recurso ausente | 404 com o código específico existente; rota desconhecida usa `NOT_FOUND` |
| Conflito | 409 `DATA_CONFLICT`, `USER_ALREADY_EXISTS`, `ROLE_INTEGRITY_CONFLICT` ou `GRADE_INTEGRITY_CONFLICT` |
| Limite local ou de autenticação upstream | 429 `RATE_LIMIT_EXCEEDED`, `ACADEMIC_RATE_LIMIT` ou `AUTH_RATE_LIMIT` |
| Sessão sem renovação válida | 401 `INVALID_SESSION` na rota de refresh |
| Resposta de dados inesperada | 502 `DEPENDENCY_INVALID_RESPONSE` |
| Serviço de dados indisponível | 503 `DEPENDENCY_UNAVAILABLE` |
| Migration de integridade anterior ausente | 503 `DATABASE_MIGRATION_REQUIRED` |
| Erro inesperado | 500 `INTERNAL_ERROR`, `DATABASE_QUERY_FAILED` ou código específico seguro da operação |

Os códigos acadêmicos específicos da Etapa 2 continuam válidos, incluindo os de fonte externa e timeout. O handler não devolve `HttpError.details`, objetos SQL/Supabase, stacks nem o corpo do parser. Mensagens de `HttpError` são textos controlados pela aplicação; não criar erros com mensagens upstream ou conteúdo do usuário.

Se um erro ocorrer após o envio dos headers, o handler encerra a conexão em vez de tentar enviar outro JSON ou encaminhar o erro bruto ao handler padrão do Express. Nesse caso, pode existir apenas o header de correlação já enviado e o evento de interrupção.

## Respostas do Supabase

Repositories verificam tanto o erro quanto o status HTTP do resultado PostgREST. Isso cobre respostas não JSON de proxies, nas quais o SDK pode retornar apenas uma mensagem dentro de `error`, deixando o status fora desse objeto. Falhas de conexão, códigos conhecidos de indisponibilidade e respostas HTTP 5xx são classificadas como indisponibilidade; falhas inesperadas restantes não viram “não encontrado”.

Consultas opcionais de um registro usam `maybeSingle`: zero registros sem erro mantém 404/403 conforme o contrato; múltiplos registros ou falha de consulta não são tratados como ausência. A busca de aluno/docente preserva a regra anterior de 404 para vínculo inválido/ambíguo e UUID inválido; outras consultas podem retornar 400 para identificador inválido.

Listas precisam ser arrays; contagens solicitadas precisam ser inteiros não negativos. `[]` e zero explícito continuam válidos. `null` em lista ou contagem não vira sucesso vazio nem zero inventado. Não há mudança no significado de células acadêmicas nulas ou zeros dos provedores.

Falhas de autenticação do serviço são separadas de credenciais rejeitadas. O helper reconhece `AuthSessionMissingError` usando o guard do SDK real. Logout continua retornando 204 para sessão já inválida, mas uma falha inesperada de revogação é propagada. O cadastro só tenta localizar uma conta Auth existente quando o erro indica duplicidade conhecida; uma falha de criação não autoriza reutilização silenciosa.

Os testes de integração do SDK usam `fetch` simulado e nunca acessam o Supabase. O spy que desativa retries tem uma interface local explícita para `select`/`retry`, evitando instanciar o parser genérico de tipos do SDK no Jest. A consulta executada continua sendo o objeto real do SDK; cada caso 502/503/504 confirma uma chamada ao fetch simulado.

## Operação e diagnóstico

1. Obter o `X-Request-Id` ou `error.requestId` da resposta com falha.
2. Procurar esse UUID no coletor de stdout do ambiente correto.
3. Conferir modelo da rota, status, categoria, código e duração. Se houver tenant autenticado, conferir o UUID institucional sem publicar os demais eventos desse tenant.
4. Para 503, verificar a disponibilidade/configuração do serviço de dados por canais operacionais autorizados. Para `DATABASE_MIGRATION_REQUIRED`, seguir o procedimento manual já documentado da Etapa 3.
5. Para 499, investigar cancelamento do cliente, timeout ou proxy antes de atribuir o resultado a erro da API.

O logger não persiste arquivos nem grava no Supabase. Coleta, retenção, rotação, controle de acesso e alertas são responsabilidades do ambiente de execução. Não disponibilizar dumps integrais de logs a uma instituição para investigar uma requisição individual.

O logger captura exceções síncronas do destino de escrita para não mudar a resposta HTTP. Não oferece fila durável, garantia de entrega, controle de backpressure ou monitoramento do coletor; uma falha de coleta pode perder eventos. Não substitui trilha de auditoria de alterações acadêmicas. Métricas agregadas, tracing distribuído, alertas e auditoria persistente permanecem fora desta etapa.

## Compatibilidade e segurança

`error.requestId` é um acréscimo ao contrato. Clientes que ignoram campos desconhecidos podem continuar usando `error.code` e `error.message`; decodificadores estritos precisam aceitar o novo campo. O status de falhas antes mascaradas como 401/403/404 ou sucesso vazio pode agora ser 500/502/503. Logout pode retornar erro quando a revogação não acontece. Rotas desconhecidas recebem JSON em vez da resposta HTML padrão; CORS rejeitado retorna 403 com mensagem segura.

Autorização multi-tenant, validação de papéis, limitadores existentes e `Cache-Control: no-store, private` permanecem ativos. O header de correlação não substitui Authorization ou `x-tenant-slug`. Nenhum aplicativo Flutter ou painel web foi alterado.

### Migration anterior

Esta etapa não exige mudança de schema e não executa migrations. `supabase/migrations/20261026000001_security_integrity.sql` permanece pendente de aplicação manual ao ambiente remoto, conforme [o guia da Etapa 3](backend-security.md). Ela continua necessária antes de usar a escrita atômica de notas no ambiente atualizado. Observabilidade, login, consultas existentes e provedor demo não adicionam nova dependência de banco.

## Validação local

```powershell
npm test -- --runInBand --no-cache
npm run typecheck
npm run build
npm run test:academic-build
```

Não executar `setup:supabase`, migrations, smokes com credenciais reais ou `test:security-db` para validar esta etapa. A suíte Jest usa dados sintéticos, mocks Supabase e fetch simulado; o teste de interrupção abre apenas um servidor HTTP temporário em `127.0.0.1` e fecha cliente, conexões, timer e servidor em `finally`.

Evidências e resultado de revisão: relatório da Etapa 3.1.

## Arquivos da Etapa 3.1

- Criados: `src/observability/logger.ts`, `src/observability/http-observability.ts`, `src/observability/route-registry.ts`, `src/observability/http-observability.test.ts`, `src/shared/supabase-errors.ts`, `src/shared/supabase-errors.test.ts`, `src/test/supabase-failures.test.ts`.
- Modificados: `src/app.ts`, `src/routes.ts`, `src/server.ts`, `src/middleware/error-handler.ts`, `src/middleware/auth-context.ts`, `src/modules/auth/auth.routes.ts`, `src/modules/auth/auth.service.ts`, `src/modules/users/users.service.ts`.
- Repositories modificados: `auth`, `users`, `courses`, `classes`, `activities`, `invites`, `tenants`, `grades` e `reports`, cada um em `src/modules/<modulo>/<modulo>.repository.ts` (tenant usa `tenants/tenant.repository.ts`).
- Testes de suporte modificados: `src/test/supabase-mock.ts`, `src/modules/users/users.repository.test.ts`, `src/modules/grades/grades.repository.test.ts`.
- Documentação: `README.md`, este guia, `docs/codex-kit/plans/2026-10-26-observability.md` e `docs/reviews/2026-10-26-observability.md`.

Na finalização foram alterados somente o spy em `src/test/supabase-failures.test.ts`, os testes em `src/observability/http-observability.test.ts` e a documentação. A lógica de produção já implementada na etapa foi preservada.
