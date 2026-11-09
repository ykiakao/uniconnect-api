# Chat acadêmico — contrato HTTP + Broadcast privado

Contrato de integração de 05/11/2026, branch `codex/integration-chat-realtime`, base `888744ecf4dc1f7b220ea9850c0f2bca0fa41c35`. O patch SQL já foi aplicado uma única vez em `uniconnect-test`; não reaplicar. API local, autenticação real, dois canais privados e recusa de tópico de outro destinatário foram validados. Envio, entrega de mensagens e recibos reais ainda não foram ensaiados. Isso não constitui aprovação de deploy. O consumidor Flutter ainda precisa ser implementado.

## Fluxo e fonte de verdade

Os comandos e dados continuam na API Express do Portainer, relativos a `/api/v1`, com `x-tenant-slug` e Bearer convencional Supabase Auth:

| Operação | HTTP | Corpo/parâmetros |
|---|---|---|
| Criar/reutilizar conversa | POST `/tenants/:slug/conversations` | `{classId,participantId}`; IDs institucionais existentes |
| Listar conversas | GET `/tenants/:slug/conversations` | `page`, `limit` |
| Assinatura autorizada | GET `/tenants/:slug/conversations/:id/realtime` | Sem parâmetros extras; responde somente após `conversation_get` autorizado |
| Enviar | POST `/tenants/:slug/conversations/:id/messages` | `{content,clientMessageId}`; UUID estável por tentativa; resposta 201 |
| Histórico | GET `/tenants/:slug/conversations/:id/messages` | `afterSequence` exclusivo, `limit` 1–100 |
| Leitura | POST `/tenants/:slug/conversations/:id/read` | `{upToSequence}`; watermark monotônico |

O endpoint novo retorna este contrato, sem tokens/chaves:

```json
{
  "transport": "supabase-broadcast",
  "private": true,
  "topic": "uc:chat:<tenant-uuid>:<conversation-uuid>:<authenticated-auth-user-uuid>",
  "events": ["message.created", "conversation.read"],
  "lastSequence": 42,
  "serverTime": "2026-11-05T19:00:00.000Z",
  "serviceWindow": {
    "timeZone": "America/Rio_Branco",
    "weekdays": [1, 2, 3, 4, 5],
    "opensAt": "13:00",
    "closesAt": "18:00",
    "canSendNow": true
  }
}
```

O cliente usa o tópico retornado; não escolhe tenant, interlocutor ou Auth UID no endpoint. Os dois participantes recebem tópicos distintos. O UUID final identifica o usuário Auth; `participantId`/`readerId` identificam `public.app_users`, não `auth.users`. O slug sozinho não autoriza a assinatura.

## Eventos e persistência

O SQL acrescenta triggers aos INSERTs de mensagens e aos avanços de recibos. Cada sinal é enfileirado via `realtime.send(..., true)` na transação que persiste o registro. WAL só disponibiliza os sinais após COMMIT; rollback não deixa sinal de mensagem inexistente. Repetição idempotente sem INSERT e recibo sem avanço não produzem outro sinal.

Payloads lógicos, dentro do envelope Broadcast do SDK:

```json
{"version":1,"tenantId":"<uuid>","conversationId":"<uuid>","messageId":"<uuid>","sequence":43}
```

Evento `message.created`. Não contém texto, email, nome ou token. Buscar o registro no histórico HTTP autorizado.

```json
{"version":1,"tenantId":"<uuid>","conversationId":"<uuid>","readerId":"<app-user-uuid>","upToSequence":43}
```

Evento `conversation.read`. A confirmação de leitura continua sendo um comando HTTP; cliente não publica Broadcast. Conferir versão, evento e IDs da conversa/tenant antes de consumir qualquer sinal.

Broadcast é sinal **best effort**, não armazenamento nem exactly-once. A função gerenciada `realtime.send` pode registrar WARNING em vez de propagar falha de enqueue. Por isso não se promete rollback da mensagem quando o transporte falha; recuperação HTTP periódica é obrigatória, mesmo com socket conectado. Ver [Broadcast](https://supabase.com/docs/guides/realtime/broadcast) e [implementação gerenciada](https://github.com/supabase/realtime/blob/main/lib/realtime/tenants/repo/migrations/20260605120000_rename_broadcast_send_warning.ex).

## Autorização e isolamento

- `chat_can_receive_topic(text)` é um predicado SECURITY DEFINER com `search_path` vazio, retornando apenas booleano. Confere formato exato, Auth UID do JWT, tenant, conversa, participação ativa e instituição operacional.
- Apenas `authenticated` executa esse predicado; não recebe SELECT direto em mensagens, conversas, recibos ou membros.
- `uc_chat_receive` permite somente Broadcast autorizado. Policies restritivas protegem o prefixo `uc:chat:` contra outras policies permissivas; INSERT/UPDATE/DELETE de cliente nesse prefixo ficam proibidos.
- O emissor consulta os participantes atuais antes de cada sinal e usa um tópico por destinatário Auth. Um membro desativado não recebe novos sinais mesmo que a autorização do seu canal anterior esteja em cache. O conteúdo sempre depende da autorização HTTP atual.
- Histórico segue o contrato existente: encerramento de matrícula/docência bloqueia novos envios, mas não apaga histórico dos participantes ativos. Não se abre uma sala por instituição inteira.
- Realtime recalcula acesso na assinatura/atualização de JWT, não por mensagem. Remover canais no logout, troca de tenant/usuário e perda de autorização continua obrigatório. [Autorização oficial](https://supabase.com/docs/guides/realtime/authorization).

## Horário no servidor e compatibilidade

Segunda a sexta (ISO 1–5), 13:00 inclusivo até 18:00 exclusivo em `America/Rio_Branco`, sem regra de feriados neste recorte. A interface pode usar `canSendNow`, mas a decisão é do relógio PostgreSQL no BEFORE INSERT, depois dos locks existentes. Histórico, assinatura e confirmação de leitura continuam disponíveis fora da janela.

Somente inserções novas são bloqueadas. Se a resposta HTTP se perdeu às 17:59, repetir a mesma tentativa após 18:00 retorna a mensagem já persistida, sem avançar sequência nem emitir outro sinal. Continua valendo a autorização atual e o mesmo conteúdo da tentativa; conteúdo divergente permanece conflito. Se não houve persistência, o envio fora da janela retorna `403 CHAT_OUTSIDE_SERVICE_HOURS`. Não agendar envio automático para o próximo dia.

A API usa a RPC service-only `academic_chat_send(uuid,uuid,jsonb)` para enviar. Ela preserva a RPC histórica de comunicação e exige que o SQL novo tenha sido instalado atomicamente; ausência gera `503 DATABASE_MIGRATION_REQUIRED`, sem fallback para envio desprotegido. A API traduz `PCH01` para o erro de horário. A função histórica, constraints, locks, sequência, cursor e demais endpoints não são reescritos.

## Integração Flutter

Configurações a alinhar no cliente: `API_BASE_URL` da API no Portainer, `TENANT_SLUG`, URL do MESMO projeto Supabase usado pela API e chave pública publishable/anon desse projeto. Nunca usar `service_role`, segredo JWT ou credenciais de banco no Flutter. Confirmar a associação API/projeto antes do teste; não misturar produção e `uniconnect-test`.

Na preparação atual, `API_BASE_URL` é a API local; a configuração Portainer continua dependendo de comprovação da revisão e do projeto da implantação ativa. Todos os caminhos abaixo são relativos à base `/api/v1`; enviar `x-tenant-slug: edukmais` e `Content-Type: application/json` nos comandos JSON.

| Autenticação acadêmica | Corpo/headers | Resposta |
|---|---|---|
| POST `/auth/login` | `{email,password}`, sem Bearer | `accessToken`, `refreshToken`, `expiresAt`, `user`, `tenant` |
| POST `/auth/refresh` | Somente `{refreshToken}` no JSON; sem Authorization, headers de refresh ou query | Novo par de tokens, `expiresAt`, `user`, `tenant`; substituir o par anterior |
| GET `/auth/me` | `Authorization: Bearer <accessToken>` | Usuário institucional e `tenant` |
| POST `/auth/logout` | Bearer atual | 204 sem corpo; remover o canal e o estado local |

Conversas, mensagens, histórico, descritor e leitura exigem Bearer e contexto do tenant. Não anexar automaticamente o Bearer ao refresh: o contrato atual rejeita esse header nessa rota. Senhas e refresh tokens não são enviados ao Realtime; usar somente o access JWT atual em `setAuth`.

1. Autenticar pelos endpoints HTTP existentes (`/auth/login`, `/auth/refresh`, `/auth/me`, `/auth/logout`). Não criar um segundo fluxo de login/auto-refresh no SDK Supabase. Somente o access JWT atual vai para `supabase.realtime.setAuth(accessToken)`; o refresh token permanece no fluxo HTTP.
2. Obter o descritor autorizado e assinar com `RealtimeChannelConfig(private: true)` e os dois eventos. Manter estados visíveis de conexão, erro e sincronização; SUBSCRIBED não significa histórico sincronizado.
3. Instalar callbacks antes de assinar. Ao receber SUBSCRIBED, iniciar catch-up HTTP; sinais que chegam durante a consulta marcam nova sincronização pendente. Executar uma consulta por conversa de cada vez, com flag de trabalho pendente para não perder o último sinal.
4. Manter cursor do maior `sequence` **contíguo confirmado pelo histórico**, separado do maior número visto. Nunca avançar cursor a partir de evento, resposta de envio fora de ordem ou `lastSequence` do descritor.
5. Buscar páginas por `afterSequence=cursor`; consumir `hasMore` até completar a lacuna. Mesclar por ID e `(conversationId,sequence)`, reconciliando o envio otimista por `clientMessageId`. Só atualizar o cursor contíguo após validar a página; erro não pode virar lista vazia nem avançar cursor.
6. Todo sinal de mensagem solicita catch-up. Repetições e eventos fora de ordem não criam outra mensagem visual. Resposta HTTP e sinal próprio também convergem para um único registro.
7. Em reconexão, retomada do app e refresh do JWT: reautenticar/reassinar, verificar novamente o descritor e fazer catch-up. Fazer também reconciliação HTTP periódica em foreground (referência inicial: 30 segundos), pois um sinal pode se perder sem desconexão. O timer é recuperação, não substituto do Realtime.
8. Recibo do outro participante permite atualizar monotonicamente `readByRecipient` até `upToSequence`. Reconsultar também a página visível do histórico na reconciliação periódica para reparar perda de sinais de leitura: somente buscar mensagens novas não atualiza recibos antigos.
9. Em timeout de envio, manter o mesmo UUID/conteúdo até resolver a tentativa. Consultar histórico e/ou repetir o mesmo HTTP quando permitido; não gerar novo UUID por retry. Nunca enviar texto via Broadcast.
10. Em 401, seguir o refresh convencional e atualizar o JWT do Realtime. Em 403/404 ou troca de sessão/tenant, remover o canal e invalidar consultas pendentes por geração da sessão para não incorporar respostas antigas. Em falha de transporte, preservar histórico e cursor, mostrar erro e tentar reconciliação com backoff.

O aceite futuro deve testar duas sessões reais existentes, respostas HTTP perdidas, sinal repetido/perdido, ordem invertida, retomada com lacuna e refresh/logout, além de rejeições de outra instituição, não participante, tópico de outro destinatário, envio Broadcast pelo cliente e envio fora de horário. Nenhum ciclo de atividades/entregas precisa ser reauditado.

## SQL versionado, testes e autorizações remotas

`supabase/scripts/chat-realtime-broadcast.sql` é um patch transacional versionado, já aplicado em `uniconnect-test` e não inserido automaticamente no manifesto do PG17. SHA-256 preservado: `31e9ad4d8dceae53f5ec75df4231d7e72a7ff7eda83b807183c17dd3bce7bd63`. Cria cinco funções (`chat_service_open`, `chat_enforce_service_window`, `chat_can_receive_topic`, `chat_broadcast_change`, `academic_chat_send`), três triggers e cinco policies `uc_chat_*`, conferidos após a aplicação. Exige executor com BYPASSRLS, tabelas/RPCs históricas, Realtime disponível, SELECT já existente de `authenticated` em `realtime.messages` e autorização suportada para gerenciar suas policies. No projeto de teste, o executor `postgres` utiliza a delegação `supautils.policy_grants`; não é necessário alterar owner ou habilitar RLS novamente. Não altera publicações, tabelas internas gerenciadas ou a cadeia SQL histórica. Aplicação única: rerun falha e reverte a transação; não apagar objetos para contornar falha. O arquivo original permanece intacto para preservar o hash aprovado.

Testes Jest de serviço/HTTP usam o dublê de banco já existente; cobrem contrato, autorização de descritor, horário, cursor, replay e falhas. Testes do artefato SQL são **estáticos**, não prova de RLS/commit em PostgreSQL.

Probes SQL versionados para execução separadamente autorizada; não são parte da inicialização da API:

- `supabase/tests/chat-realtime-authorization.sql`: transação read-only, limites de horário, ACL e predicado real executado como `authenticated`, para professor/aluno existentes e recusas de tenant/conversa/destinatário/não participante.
- `supabase/tests/chat-realtime-transaction.sql`: exige autorização de escrita transitória e janela aberta; mensagens/recibos sintéticos e observação da fila em transação com ROLLBACK, sem contas novas. Verifica sequência, idempotência e rollback de mensagem/sinal. Não prova entrega após COMMIT: o ensaio de dois clientes é separado.

Ambos recebem `fixture_json` contendo UUIDs existentes: `tenantId`, `conversationId`, `studentAuthId`, `teacherAuthId`, `outsiderAuthId`, `otherTenantId`, `otherConversationId`. As relações são conferidas antes do teste; se faltarem fixtures, parar e apresentar a pendência, sem criar usuários/instituições. Não fornecer senhas nessa variável. O arquivo completo de autorização e o probe transacional não foram executados; verificações pontuais de autorização e os canais reais têm escopo próprio, descrito no estado operacional abaixo. Não tratar um UUID de tenant inexistente como prova de isolamento entre duas instituições reais.

Estado das autorizações e pendências:

1. Patch aplicado e objetos conferidos em `uniconnect-test` (`pvacwfypqsstdrfxajkg`): concluído; não reaplicar.
2. Não alterar a opção Allow public access, limites ou publicações durante a integração Flutter. Qualquer mudança de configuração exige aprovação própria. O teste de canais com `private: true` não comprova sozinho que a opção de acesso público esteja desativada. Broadcast não requer publicar tabelas acadêmicas em `supabase_realtime`.
3. Mensagens, deduplicação, reconexão com lacuna e recibos reais: pendentes. A autorização existente de envio exige a janela aberta e `canSendNow: true`; uma exceção fora dela exige nova aprovação explícita. O probe transacional SQL mantém autorização independente e sua própria precondição de horário.
4. Publicação da branch, implantação no Portainer e configuração/build dos clientes: aguardam autorização própria; a API pública não foi comprovada como executando esta revisão local.

Estado operacional: GO para o desenvolvedor iniciar a integração pelo contrato HTTP/Realtime; NO-GO para declarar concluído o ciclo real de mensagens. API local em `http://127.0.0.1:3334/api/v1`, Node 22.23.4, apontando para o mesmo projeto de teste dos canais. Professor e aluno existentes autenticaram e confirmaram `/auth/me`; uma conversa da turma existente foi criada, os descritores e históricos HTTP passaram e duas instâncias independentes chegaram a SUBSCRIBED. O JWT do aluno foi recusado no tópico destinado ao professor. Não foram criadas mensagens ou recibos. O Flutter não deve tratar a API local como URL pública: Android Emulator utiliza `http://10.0.2.2:3334/api/v1`; dispositivo físico exige acesso de rede autorizado separadamente, pois o binding atual é loopback.

No primeiro join ocorreu MissingPartition durante a criação automática das partições diárias do serviço. SELECTs de metadados/logs confirmaram a cobertura da data e o reteste dos dois canais passou, sem DDL manual ou alteração das policies. Não incluir reparo de partições no cliente ou no fluxo de login.

Os perfis privados existentes, senhas e sessões em memória não integram a entrega Git. O limite absoluto de sessão de 30 dias permanece fora do escopo. Laboratório PG17 congelado e worktrees preservados. A proposta de publicação e a avaliação da exceção temporária estão em `docs/codex-kit/plans/2026-11-05-chat-realtime.md`.

## Resultado da finalização local — 05/11/2026

Executados com Node 22.23.4 no checkout de integração, sem banco, Docker ou serviços remotos:

```text
node node_modules/jest/bin/jest.js --runInBand src/modules/communication src/modules/auth src/test/permissions.test.ts src/test/security-regressions.test.ts
260 testes aprovados / 14 suítes / 0 falhas

node node_modules/typescript/bin/tsc --noEmit
PASS

node node_modules/typescript/bin/tsc -p tsconfig.build.json
PASS

git diff --check
PASS
```

A revisão independente de segurança/código foi concluída em leitura e não identificou novos problemas impeditivos no estado final. Foram corrigidos o bloqueio indevido de replay após 18h, a afirmação de propagação garantida de falhas do `realtime.send` e o tipo do evento `readerId`.

O teste HTTP cobre recusas por falta de JWT, não participação, tenant diferente e tentativa de selecionar tópico arbitrário, além de histórico/recibos fora da janela, replay, ordenação e recuperação paginada. Os testes de calendário cobrem abertura, fechamento, fim de semana e conversão de UTC para Rio Branco. Ausência da RPC nova retorna 503 sem fallback. Os probes SQL completos continuam **não executados**. O reteste remoto comprovou joins privados de duas sessões e recusa por destinatário, mas ainda não entrega após commit, recibos, reconexão com mensagens ou troca real de mensagens entre as sessões. A implementação do consumidor Flutter segue como próxima tarefa, orientada por este contrato.
