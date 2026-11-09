# Gestão institucional — Etapa 5

Conta Supabase Auth, vínculo `app_users` e matrícula `enrollments` são entidades distintas. Desativar um vínculo não desativa a conta Auth, não encerra sessões globais e não afeta outros tenants. Toda requisição institucional relê o vínculo e rejeita `active=false` com403 `USER_INACTIVE`. A allowlist administrativa global permanece independente.

## Endpoints

Todos preservam `Cache-Control: no-store`, envelope de erros e `X-Request-Id`. Os caminhos institucionais exigem Bearer e `x-tenant-slug` coerente com `:slug`.

| Método/caminho | Regra |
| --- | --- |
| POST `/api/v1/tenants/:slug/users` | Cadastro existente; gestor só concede papel inferior ao seu. Campos adicionais opcionais `courseId` UUID, `registration`, `semester`. Curso deve pertencer ao tenant. Conta Auth existente é reutilizada sem substituir a senha. |
| GET `/api/v1/tenants/:slug/users` e `/:id` | Administração existente; respostas acrescentam `active`, `courseId`, `registration`, `semester` quando disponíveis. |
| PATCH `/api/v1/tenants/:slug/users/:id/profile` | Campos `name`, `courseId` (ou null), `registration` (ou null), `semester` (ou null); pelo menos um campo. Gestor só altera vínculo inferior; não altera a si próprio. |
| PATCH `/api/v1/tenants/:slug/users/:id/status` | `{ "active": false }` ou true; mesmas regras de hierarquia e proibição de autoalteração. Preserva histórico. |
| POST `/api/v1/tenants/:slug/invites` | `{ "role": "aluno", "recipientEmail": "synthetic@example.invalid", "expiresIn": 7 }`; e-mail obrigatório, expiração1–30 dias, papel inferior ao emissor. |
| GET `/api/v1/invites/:code` | Resolução pública existente: somente instituição/papel; não revela destinatário. |
| POST `/api/v1/invites/:code/register` | Primeiro acesso: `{ "name": "Pessoa sintética", "email": "synthetic@example.invalid", "password": "<SENHA_DEFINIDA_PELO_OPERADOR>" }`. Somente conta Auth nova; retorna vínculo201. Conta existente retorna409. |
| POST `/api/v1/invites/:code/accept` | Bearer de uma conta Auth com e-mail confirmado e `{ "name": "Pessoa sintética" }`; não exige vínculo prévio. Retorna vínculo201. |
| POST `/api/v1/invites/:code/login` | Mesmo corpo de register, mas autentica uma conta existente e aceita o convite; retorna201 com `accessToken`, `refreshToken`, `expiresAt`, `user`. Recupera falhas entre criação Auth e aceitação. |

O valor `<SENHA_DEFINIDA_PELO_OPERADOR>` é um placeholder documental. Substitua-o apenas no ambiente autorizado, sem registrar a senha real em documentos, logs ou Git.

Os três POST públicos não aceitam tenant, usuário ou papel no corpo. O código determina a instituição; se um header de tenant for enviado, deve corresponder. Os campos desconhecidos são rejeitados. Matrículas e vínculos docentes usam os endpoints da Etapa4, com IDs institucionais, sem gerar matrículas pelo curso textual. Novos vínculos ativos exigem membro ativo; desativação preserva as matrículas existentes.

## Segurança e operação

Convites novos contêm192 bits aleatórios; são segredos de primeiro acesso, entregues por canal privado pela instituição. Não há envio de e-mails nesta etapa. A posse desse segredo específico para o destinatário autoriza a criação de uma conta nova com e-mail confirmado pelo fluxo institucional. Para conta existente, exige senha ou sessão confirmada; nunca redefine senha. Não publicar códigos em URLs abertas, relatórios ou logs de proxies. Os logs da API usam o template `:code`, sem seu valor, senha, token ou corpo.

O consumo usa `accept_institution_invite`, RPC transacional restrita a service_role. Revalida destinatário, Auth/email confirmado, expiração e autoridade atual/ativa do emissor sob locks. Insere vínculo e marca o convite usado na mesma transação. Duplicata retorna409 sem alterar papel/status nem consumir convite. Um vínculo inativo existente precisa ser reativado pelo gestor; convite não o reativa.

Criação Auth e RPC não são uma transação distribuída. Se Auth for criada e RPC falhar, pode restar conta sem vínculo. Não há exclusão compensatória destrutiva: usar `/invites/:code/login` com a senha definida, enquanto o convite permanecer válido. Se expirado, solicitar novo convite. Nenhum acesso institucional é concedido antes do commit da RPC. Se o commit ocorrer e a resposta se perder, login institucional normal funciona; o código já estará consumido.

Rate limiting existente permanece: login institucional30/15min, convites públicos60/min, emissão30/min; `/invites/:code/login` também30/15min por IP. São limites em memória por processo; múltiplas réplicas exigem limitação compartilhada no gateway em evolução futura.

## Compatibilidade e banco pendente

Ordem manual futura: migrations base → `20261026000001_security_integrity.sql` → `20261026000002_academic_structure.sql` → `20261026000003_institutional_management.sql`. Não executar o script administrativo para aplicá-las implicitamente. A migration nova é incremental, transacional, não remove registros e acrescenta active=true aos vínculos anteriores. Curso por ID começa nulo; não se infere pelo texto. Convites legados sem destinatário continuam resolvíveis, mas sua aceitação é proibida; emitir outro convite direcionado.

Mudança de contrato: emissão passa a exigir `recipientEmail` e gera código maior (até80 caracteres aceitos). Frontends precisam enviar esse campo e não fixar comprimento8. Respostas de usuário ganham campos; os campos existentes e o login institucional permanecem.

Jest testa os fluxos com fixtures sintéticas; isoladamente, não comprova constraints/locks/RPC no banco real. Após o esclarecimento do usuário autorizando somente PostgreSQL local descartável, `scripts/institutional-management-database-test.cjs --allow-local-migrations` foi executado com Node22 e PostgreSQL16: **86 verificações aprovadas, exit0**. Foram validados destinatário/Auth, hierarquia atual, consumo único, rollback, corridas de aceitação, desativação do emissor/membros, expiração durante locks, FK institucional de curso e privilégios restritos da RPC. O container usou apenas127.0.0.1, dados sintéticos e limpeza automática. Nenhum código ou SQL precisou ser corrigido.

A autorização não inclui Supabase remoto nem deploy. O suporte local de Auth é sintético; esse resultado não comprova a configuração efetivamente aplicada em um ambiente Supabase existente. As migrations continuam pendentes remotamente, com revisão do legado/preflight e aplicação manual ainda necessárias.
