**Anexos acadêmicos — contrato de integração HTTP (Fase A)**

Implementado exclusivamente no backend. Não houve integração Flutter/React nem ativação remota. Este contrato estende a entrega textual existente; o frontend pode implementá-lo sem acessar tabelas, bucket ou credenciais administrativas.

**1. Base, autenticação e limites**

Base dos exemplos: `/api/v1/tenants/edukmais`. Substituir o slug pelo tenant da sessão e o host pela API autorizada. Todos os endpoints deste documento exigem:

```http
Authorization: Bearer <accessToken emitido pelo login UniConnect>
x-tenant-slug: edukmais
Content-Type: application/json
```

`Content-Type` é necessário para corpos JSON; GET/DELETE não enviam corpo. O slug da rota deve corresponder ao header e ao vínculo institucional autenticado. Não enviar `studentId`, `tenantId`, autor, bucket, caminho ou URL no corpo. São resolvidos pelo servidor. IDs de arquivo/atividade/entrega são UUID; exemplos com `<...>` são marcadores a substituir por IDs retornados.

PDF, DOCX, PNG e JPEG. Arquivo não vazio, até **10.000.000 bytes**. Até cinco materiais ativos por atividade e cinco arquivos por versão de entrega. Existem também cinco reservas/arquivos ainda não vinculados por atividade/aluno, controle de reservas docentes, quota institucional acumulada de 1.000.000.000 bytes e limites de requisições/processamento. Versões anteriores não são apagadas para liberar quota.

O nome é limitado a 180 caracteres e normalizado em NFC, sem caminhos, controles, aspas ou marcadores bidirecionais. Nome e MIME declarado precisam corresponder: `.pdf`, `.docx`, `.png`, `.jpg`/`.jpeg`. Tamanho declarado é inteiro. MIME/extensão não provam segurança: o backend inspeciona os bytes antes de aceitar.

MIME canônico: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `image/png`, `image/jpeg`.

Política inicial restritiva: recusar PDF criptografado, scripts, ações externas, formulários ativos e arquivos embutidos; DOCX com macros, conteúdo ativo, relações externas, XML/ZIP inválido ou expansão excessiva; imagens inválidas, animadas ou maiores que 25 milhões de pixels/16.384 pixels por dimensão. Em Word, aceitar somente campos automáticos PAGE, NUMPAGES, SECTION e SECTIONPAGES com formatos limitados; outros campos, inclusive sumários/datas automáticas, campos aninhados ou ambíguos, são recusados nesta fase. Partes XML precisam usar UTF-8; nomes internos ZIP devem ser ASCII ou UTF-8 consistente. Isso pode recusar documentos legítimos com recursos não suportados. Não equivale a antivírus.

**2. Modos de disponibilidade**

| Modo do servidor | Comportamento |
|---|---|
| `disabled` (padrão) | Novas rotas retornam 503 após autenticação; entregas textuais e respostas históricas mantêm o contrato antigo sem depender das tabelas novas. IDs não vazios no envio são recusados. |
| `read_only` | Mantém listagem, estado e download dos anexos existentes; bloqueia reserva, conclusão, cancelamento e alteração de materiais. Entrega textual continua permitida se elegível; não aceita IDs não vazios. |
| `enabled` | Habilita o ciclo de anexos e a RPC de envio atômico. Recibos/histórico acrescentam `attachments`. |

O frontend deve aceitar a ausência de `attachments` em respostas antigas como lista vazia. Não tratar 503 como confirmação de sucesso; consultar o estado quando uma resposta de operação puder ter se perdido.

**3. Permissões**

| Ação | Perfil e condições |
|---|---|
| Reservar, confirmar ou vincular material | Docente com atribuição ativa na oferta, ou gestor com poderes institucionais já existentes; oferta ativa; atividade comum com workflow, em rascunho ou publicada sem entregas. |
| Listar/baixar material | Usuário que pode consultar a atividade no workflow atual. Aluno não lê rascunho; matrícula concluída/histórico seguem as regras acadêmicas de leitura existentes. |
| Remover material | Autoridade de edição atual e revisão esperada. Não permitido após primeira entrega nem em atividade encerrada. |
| Reservar/confirmar arquivo de entrega | Aluno da sessão, matrícula ativa, oferta elegível, atividade publicada recebendo entregas, prazo válido ou atraso permitido e nenhuma avaliação/nota bloqueando reenvio. |
| Ler arquivos de versões | Próprio aluno ou docente atribuído/gestor institucional autorizado. Outro aluno não tem acesso. O histórico pessoal existente continua acessível conforme regras atuais mesmo após cancelamento de matrícula; novos envios continuam bloqueados. |
| Cancelar reserva | Somente seu dono, sem qualquer vínculo e sem validação em processamento. Isso não remove arquivos de versões enviadas. |

Provas presenciais (`assessment.category=exam`) e atividades legadas sem workflow não recebem anexos nesta fase. A autorização é reavaliada no momento de concluir, vincular e enviar; reservar antes do prazo não garante uma entrega posterior elegível.

**4. Preparar upload**

Professor/material:

```http
POST /api/v1/tenants/edukmais/activities/<activityId>/attachment-uploads
Idempotency-Key: <UUID novo para esta intenção>

{"fileName":"roteiro.pdf","sizeBytes":12345,"contentType":"application/pdf"}
```

Aluno/entrega:

```http
POST /api/v1/tenants/edukmais/activities/<activityId>/submissions/attachment-uploads
Idempotency-Key: <UUID novo para esta intenção>

{"fileName":"resposta.pdf","sizeBytes":12345,"contentType":"application/pdf","expectedVersion":0}
```

`expectedVersion` é zero para a primeira entrega; no reenvio, a versão atual retornada pela API. A preparação não cria uma versão de entrega nem altera a revisão da atividade. A chave de idempotência é obrigatória, ASCII, de 8–128 caracteres entre letras, números, `.`, `_`, `:` e `-`. Mesma chave, contexto e corpo retornam a mesma reserva; corpo diferente dá 409. Uma chave não pode ser compartilhada entre arquivos distintos.

Resposta 201 inicial:

```json
{
  "id":"<fileId>",
  "state":"pending",
  "expiresAt":"2026-11-12T23:00:00.000Z",
  "maxSizeBytes":10000000,
  "nextAction":"upload_or_cancel_and_reserve_again",
  "upload":{
    "url":"<URL temporária assinada>",
    "method":"PUT",
    "headers":{"Content-Type":"application/pdf","x-upsert":"false","cache-control":"max-age=0"},
    "expiresAt":"2026-11-12T23:00:00.000Z"
  }
}
```

A URL e o token não são armazenados como vínculo de negócio. Uma repetição pode responder 201 **sem `upload`**, com `id`, estado e próximo passo. Isso não é uma nova autorização de transferência. Se a capacidade original se perdeu, consultar o estado; se ainda não houver bytes recuperáveis, cancelar a reserva e criar outra com nova chave. Falha de assinatura também exige essa recuperação conservadora, pois não é possível provar que um token não chegou a ser emitido.

Erros adicionais desta etapa: 400 (contrato, MIME/nome ou chave), 403/404 (permissão/escopo), 409 (versão, estado ou quota), 413 (tamanho declarado excedido), 429 e 503 (modo, configuração ou Storage).

**5. Transferir os bytes**

Enviar os bytes diretamente para `upload.url` usando **exatamente** o método e os headers do descritor:

```http
PUT <upload.url>
Content-Type: application/pdf
x-upsert: false
cache-control: max-age=0

<bytes binários do arquivo, sem JSON e sem base64>
```

Não concatenar essa URL à base da API. Não usar o cliente JSON da API para o corpo binário. Não enviar o Bearer UniConnect, `x-tenant-slug`, refresh token ou chave de serviço ao Storage. Validar o host esperado do descritor e não seguir redirecionamentos arbitrários com credenciais. A própria URL é uma capacidade sensível: não registrar em logs/analytics nem persistir como URL de material.

O Storage normalmente confirma PUT com 200. Uma confirmação do Storage ainda **não** significa anexo aceito. A URL de upload tem validade documentada de duas horas e não é imediatamente revogável pelo cancelamento na API. Reservas descartadas nunca poderão publicar/vincular os bytes, mesmo se a transferência tardia ocorrer. Não usar `upsert` nem tentar escolher o caminho.

Se a transferência se interromper, consultar o estado e tentar confirmar: o backend distingue ausência de objeto. Se for necessário reiniciar, cancelar e reservar outro arquivo/caminho; não assumir sobrescrita ou retomada byte a byte. TUS e retomada parcial não fazem parte da implementação inicial; arquivos de 10 MB e redes instáveis ainda exigem ensaio real no ambiente autorizado.

**6. Confirmar e consultar upload**

```http
POST /api/v1/tenants/edukmais/attachment-uploads/<fileId>/complete

{}
```

Resposta 200 depois de verificar existência, tamanho e estrutura dos bytes, calcular hash e gravar o mesmo conteúdo em caminho final imutável:

```json
{
  "id":"<fileId>","state":"ready","expiresAt":"2026-11-12T23:00:00.000Z",
  "attachment":{"id":"<fileId>","name":"resposta.pdf","contentType":"application/pdf","sizeBytes":12345,"createdAt":"2026-11-12T21:00:00.000Z"}
}
```

`ready` ainda não cria um material visível nem uma entrega. Repetir a confirmação de um arquivo pronto do mesmo dono devolve 200 sem nova escrita. Se outra confirmação detém a lease ou o processamento local está ocupado, retorna 202, estado atual e `Retry-After: 2`; consultar o estado e repetir respeitando espera/backoff. Não enviar anexos enquanto o arquivo selecionado não estiver `ready`.

```http
GET /api/v1/tenants/edukmais/attachment-uploads/<fileId>
```

Resposta 200: `{id,state,expiresAt}` e, quando pronto, `attachment`. Somente o dono consulta. Nunca contém bucket, paths, lease ou hash. Estados persistidos: `pending`, `validating`, `ready`, `rejected`, `cancelled`, `expired`, `deleting`, `deleted`. Uma reserva pendente pode já ter passado de `expiresAt` antes da varredura atualizar seu estado; não tentar renová-la. `expiresAt` refere-se à reserva, não à retenção do histórico.

Erros da conclusão: 409 `ATTACHMENT_UPLOAD_NOT_FOUND` (objeto ausente, pode concluir transferência e repetir), 409 `ATTACHMENT_UPLOAD_INELIGIBLE` ou `DATA_CONFLICT` (cancelamento, expiração, lease/estado), 413 `ATTACHMENT_TOO_LARGE`, 415 `ATTACHMENT_FORMAT_REJECTED`/`ATTACHMENT_SIZE_MISMATCH`, 429 ou 503. Falha temporária libera a lease quando possível; falha definitiva de bytes marca rejeição. Se o commit final tiver ocorrido mas sua resposta se perder, o GET recupera `ready`. Nunca publicar com base apenas no sucesso do PUT.

**7. Vincular, listar e remover materiais**

Criar/salvar a atividade em rascunho pelo contrato existente antes de reservar materiais. O frontend pode selecionar arquivos antes, mas só transfere após receber `activityId` real.

```http
POST /api/v1/tenants/edukmais/activities/<activityId>/attachments

{"fileId":"<fileId pronto>","expectedVersion":2}
```

Resposta 201: `{"attachment":{"id":"<fileId>","name":"roteiro.pdf","contentType":"application/pdf","sizeBytes":12345,"createdAt":"2026-11-12T21:00:00.000Z"},"revision":3}`.

`expectedVersion` é a revisão da atividade, diferente da versão da entrega. Vínculo/remoção incrementam a revisão. Preparação/conclusão não incrementam. Somente arquivo próprio de finalidade material e da mesma atividade pode ser vinculado. Uma repetição do vínculo já concluído devolve a relação/revisão originais, inclusive após congelamento, desde que a autorização atual permaneça. Antes de outra mutação, buscar a revisão atual da atividade; um replay não necessariamente contém sua revisão mais recente.

```http
GET /api/v1/tenants/edukmais/activities/<activityId>/attachments
```

Resposta 200: `{"data":[{"id":"<fileId>","name":"roteiro.pdf","contentType":"application/pdf","sizeBytes":12345,"createdAt":"2026-11-12T21:00:00.000Z"}]}`. Somente materiais prontos e com vínculo ativo; nenhuma URL é emitida nessa listagem.

```http
DELETE /api/v1/tenants/edukmais/activities/<activityId>/attachments/<fileId>?expectedVersion=3
```

Resposta 200: `{"id":"<fileId>","revision":4}`. A remoção é lógica e mantém auditoria/objeto conforme retenção. A repetição da mesma remoção já concluída devolve a revisão original sob autorização atual. Depois da primeira entrega ou do encerramento, novas alterações de material retornam 409. Um arquivo removido não pode ser reativado por um novo add; reservar outro arquivo.

Vincular/listar/remover pode retornar 403/404 (escopo/papel), 409 (revisão, arquivo não pronto, estado ou limite), 429/503, além de 400 por dados inválidos. A exclusão autorizada de um rascunho preserva os tombstones dos uploads e marca seus materiais removidos; não deixa o rascunho permanentemente preso por FK.

**8. Entregar texto e arquivos na mesma transação**

Usar a rota de entrega existente:

```http
POST /api/v1/tenants/edukmais/activities/<activityId>/submissions

{"answer":"Minha resposta textual","expectedVersion":0,"attachmentIds":["<fileId pronto>"]}
```

Texto continua obrigatório, de 1–20.000 caracteres após trim; não existe entrega só com arquivo nesta fase. `attachmentIds` é opcional, máximo cinco, sem duplicatas. Omitido ou `[]` significa **conjunto vazio para a nova versão**, preservando compatibilidade com clientes antigos. Para manter arquivos no reenvio, enviar o conjunto completo desejado; arquivos próprios de versões anteriores da mesma atividade podem ser reutilizados.

Resposta 201 mantém os campos existentes e acrescenta anexos quando o modo está habilitado:

```json
{
  "id":"<submissionId>","activityId":"<activityId>","studentId":"<ID institucional resolvido pelo servidor>",
  "version":1,"answer":"Minha resposta textual","submittedAt":"2026-11-12T21:05:00.000Z","isLate":false,
  "status":"submitted","result":null,
  "attachments":[{"id":"<fileId>","name":"resposta.pdf","contentType":"application/pdf","sizeBytes":12345,"createdAt":"2026-11-12T21:00:00.000Z"}]
}
```

No reenvio, `expectedVersion` deve ser a versão atual. A nova versão recebe texto e conjunto de anexos em uma única transação. Um ID de outro aluno, tenant, atividade, finalidade ou arquivo ainda não confirmado impede todo o envio; não fica uma versão textual parcial. Avaliação/nota existente, mesmo em rascunho ou com nota zero, continua bloqueando reenvio. Não alterar anexos de uma versão enviada; criar nova versão enquanto o workflow permitir.

Se a resposta do POST se perder ou houver 503 após possível commit, consultar `GET /activities/<activityId>/submissions/me` e, se necessário, histórico antes de repetir. Versão esperada antiga retorna 409 e não cria outra entrega. Os metadados do recibo são consultados após o commit; uma falha nessa consulta não reverte uma versão já gravada. `GET /submissions/<submissionId>` e listagem docente de entregas acrescentam os anexos da versão atual, mantendo a filtragem existente de notas publicadas.

Erros: 400 por texto/IDs/versão inválidos, 401 por sessão, 403 por papel/matrícula, 404 por arquivo/recurso inacessível, 409 por prazo/estado/avaliação/concorrência, 429 e 503 por indisponibilidade/migration pendente/modo. Nenhum cliente escolhe o aluno proprietário.

**9. Consultar versões e corrigir**

```http
GET /api/v1/tenants/edukmais/submissions/<submissionId>/versions/1/attachments
```

Resposta 200: `{"data":[Attachment]}` com o mesmo formato da listagem de materiais. O próprio aluno e o docente/gestor autorizado conseguem consultar. Versão inexistente, outra entrega privada ou outro tenant não revela anexos. Uma versão válida sem arquivos retorna `data:[]`.

O endpoint existente `GET /submissions/<submissionId>/history?page=1&limit=20` mantém paginação e resultados existentes; os itens de `versions` acrescentam `attachments`. O frontend deve abrir os arquivos de **submissionVersion** que está corrigindo, sem substituir pelos arquivos de outra versão. Rotas e corpos de salvar/publicar correção permanecem iguais, assim como regras de precisão, nota zero e privacidade de feedback em rascunho.

**10. Download autorizado por arquivo**

```http
POST /api/v1/tenants/edukmais/attachments/<fileId>/download-url

{}
```

Resposta 200: `{"url":"<URL assinada de download>","expiresAt":"2026-11-12T21:06:00.000Z"}`. A API verifica o vínculo material ativo ou alguma versão histórica acessível. Reserva/arquivo pronto ainda sem vínculo não tem download. O link usa somente o objeto final; o temporário nunca é servido pela API. Prazo configurável de 15–60 segundos, padrão 60, com nome de download seguro.

Pedir o link ao clicar e consumi-lo sem Bearer UniConnect. Se expirar, solicitar outro à API. Não persistir o link no modelo nem assinar todos os downloads em lote na listagem. Materiais removidos deixam de receber links novos; arquivos de versões anteriores continuam acessíveis aos perfis autorizados. 403/404 para negação; 429/503/502 conforme limites/dependências.

URLs assinadas são capacidades: podem continuar utilizáveis até o vencimento depois de logout, retirada de matrícula ou negação posterior da API. Não há revogação individual imediata; cópias baixadas não podem ser recolhidas. Não rotacionar chaves nem apagar evidência acadêmica para simular cancelamento. Cache/CDN e expiração reais precisam ser validados no ensaio autorizado. [Referência oficial de URLs assinadas](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl).

**11. Cancelamento, falhas e estado local do cliente**

```http
DELETE /api/v1/tenants/edukmais/attachment-uploads/<fileId>
```

Resposta 204, sem corpo. Só o dono cancela um arquivo sem vínculos; validação com lease ativa ou qualquer versão/vínculo preservado retorna 409. Repetir cancelamento concluído é seguro. `read_only`/`disabled` recusam a mutação com 503. Cancelamento não executa delete físico síncrono nem revoga URL emitida.

Manter `fileId` e a chave da reserva enquanto a operação pertence à sessão/tenant. Na troca de usuário/tenant e logout, limpar seleção e descritores, sem interferir no chat. Um PUT em curso pode continuar válido por sua janela; os bytes não se tornam publicação/entrega por isso. Não mostrar sucesso de publicação de atividade ou entrega antes de receber a confirmação da API correspondente. Não reenviar automaticamente um POST de entrega após timeout sem consultar o recibo.

**12. Erros e limites operacionais**

Envelope comum:

```json
{"error":{"code":"ATTACHMENT_FORMAT_REJECTED","message":"Arquivo invalido, protegido ou com recursos nao permitidos.","requestId":"<UUID>"}}
```

| HTTP | Códigos relevantes / ação |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`: corrigir corpo/header/query; nunca mandar arquivo binário a uma rota JSON. |
| 401 | `AUTH_TOKEN_REQUIRED`, `INVALID_SESSION`: seguir o fluxo de sessão existente. |
| 403 | `FORBIDDEN`, `TENANT_SUSPENDED`: não repetir com outro slug/identidade; atualizar contexto autorizado. |
| 404 | `ACTIVITY_RECORD_NOT_FOUND`, `TENANT_NOT_FOUND` e negações equivalentes: recurso ausente ou fora de escopo. |
| 409 | `DATA_CONFLICT`, `ATTACHMENT_LIMIT_EXCEEDED`, `ATTACHMENT_UPLOAD_NOT_FOUND`, `ATTACHMENT_UPLOAD_INELIGIBLE`: consultar estado/versão, corrigir conjunto ou reservar novamente conforme caso. |
| 413 | `ATTACHMENT_TOO_LARGE`, `PAYLOAD_TOO_LARGE`: arquivo ou JSON excede o limite. |
| 415 | `ATTACHMENT_FORMAT_REJECTED`, `ATTACHMENT_SIZE_MISMATCH`: selecionar outro arquivo; a reserva é rejeitada. |
| 429 | `ATTACHMENT_RATE_LIMIT`, `RATE_LIMIT_EXCEEDED`, `ATTACHMENT_PROCESSING_LIMIT`: respeitar `Retry-After` quando presente e aplicar backoff. |
| 502 | `DEPENDENCY_INVALID_RESPONSE`: resposta de dependência inválida; não inferir sucesso. |
| 503 | `ACADEMIC_ATTACHMENTS_UNAVAILABLE`, `ATTACHMENT_STORAGE_UNAVAILABLE`, `DATABASE_MIGRATION_REQUIRED`, `DEPENDENCY_UNAVAILABLE`: consultar estado antes de repetir mutações e aguardar operador quando houver configuração pendente. |

Limites atuais das rotas novas: 30 requisições/minuto por usuário institucional e 120/minuto por IP por processo; validação simultânea de no máximo dois arquivos por processo e um por ator nesse processo. Leases SQL de 90 segundos coordenam instâncias. Limites em memória não são controle distribuído de tráfego; quotas e conjunto de anexos também são protegidos no banco. As rotas existentes de entrega mantêm seu limitador atual.

**13. Operação, retenção e ativação futura**

Migration preparada: `supabase/migrations/20261112210356_academic_attachments.sql`. Três tabelas com RLS, FKs compostas e RPCs restritas ao servidor; sem grants de cliente. O fluxo textual histórico continua disponível, e a RPC nova incorpora arquivos na mesma transação. O tombstone conserva `activity_scope_id` para auditoria/limpeza após exclusão autorizada da atividade; `activity_id` pode ficar nulo sem apagar o registro do arquivo.

Antes de habilitar em TEST, são necessárias autorização específica, confirmação do projeto/revisão/schema, revisão de ACL/policies existentes, aplicação da migration incremental e preparação do bucket **privado** `academic-attachments`, `file_size_limit=10000000`, allowlist exata dos quatro MIME e nenhuma policy direta de cliente que abra esse bucket. O backend recusa Storage público ou com configuração incompatível antes de assinar/transferir. Não há criação automática de bucket ou schema no startup. Não reduzir limites globais de outros buckets nem alterar policies do Realtime.

Variáveis: `ACADEMIC_ATTACHMENTS_MODE=disabled|read_only|enabled`, `ACADEMIC_ATTACHMENTS_BUCKET`, `ACADEMIC_ATTACHMENT_DOWNLOAD_TTL_SECONDS`. O Compose versionado apenas encaminha valores com padrão desligado; nenhum Portainer foi alterado. A configuração Supabase e a chave privilegiada permanecem no servidor. Validar CORS da API e do PUT direto ao Storage nas origens autorizadas; um preflight da API não comprova CORS do Storage.

O processamento usa worker encerrável em oito segundos. DOCX: ZIP até 50 MB expandidos, 2.000 entradas, razão 100:1 e XML até 2 MB por parte; rejeita travessia, divergência entre headers, CRC e descriptors inconsistentes. PDF: até 5.000 páginas/100.000 objetos percorridos e orçamento explícito do decodificador de 16 MiB por stream/32 MiB de alocações acumuladas; esse adaptador depende da versão fixada `pdf-lib@1.17.1` e exige nova revisão ao atualizar. O limite de heap do worker não é apresentado como teto de memória externa. PDFs complexos podem ser recusados por essa política inicial.

Arquivos prontos sem vínculo são candidatos a descarte após 24 horas; temporários somente após o maior vencimento conservador de token/reserva mais uma hora. Tombstones e nova varredura posterior tratam uploads tardios. Arquivos de qualquer versão histórica são protegidos. Materiais removidos mantêm evidência, sem purga automática de seus objetos finais. A quota acumulada de 1 GB e a política de retenção devem ser revisadas antes da ativação; não apagar versões para contornar quota.

O script `scripts/academic-attachments-cleanup.cjs` é manual e **dry-run por padrão**, exige URL loopback explícita e recusa destinos remotos inclusive TEST/produção. Execução física só existe como `--execute-local` para laboratório novo e autorizado. Esta fase testou sua lógica com fakes; não executou limpeza física nem agendou trabalho.

Rollback operacional futuro: mudar para `read_only`, preservando tabelas, bytes, referências, leitura e entrega textual elegível; corrigir código e retestar. Não usar DROP, truncamento, esvaziamento de bucket ou reescrita de migrations aplicadas. Backup/restauração precisam cobrir metadados e objetos.

**14. Evidência e pendências**

Testes locais cobrem validação real de bytes, contratos HTTP, fakes de Storage, falhas/recuperação, ACL/RLS e funções transacionais em PostgreSQL 18.6 embarcado descartável (PGlite). O ambiente não usa URL de banco nem credenciais remotas; não modifica o laboratório PG17. O Docker local estava indisponível.

Pendente para ativação: Storage/CDN real, CORS, expiração/replay do token emitido pelo serviço, rede instável de 10 MB, construção/execução da imagem Linux e concorrência entre conexões PostgreSQL independentes. Testes PGlite sequenciais não comprovam MVCC/locks entre conexões ou políticas reais do projeto hospedado. Nenhum frontend foi modificado ou testado. Fase B, TEST remoto, merge e deploy dependem de autorização posterior.
