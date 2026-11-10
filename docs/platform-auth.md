# P0.1 — autenticação da plataforma e capacidades

Atualiza??o P0.3: [sess?es e contas](accounts-and-sessions.md) acrescenta refresh institucional/admin/plataforma, recupera??o/ativa??o p?blicas e duas capacidades globais administrativas. Login/me e isolamento institucional permanecem.


Atualização P0.2: o contexto e os contratos de sessão abaixo permanecem; a lista global de capacidades foi ampliada aditivamente para gestão de instituições, bootstrap e leitura de auditoria. O estado atual está em [platform-institutions.md](platform-institutions.md). As referências a uma única capability e à ausência de gestão abaixo descrevem o recorte original P0.1.

Contrato da API em31/10/2026. Prefixo padrão `/api/v1`, conforme API_VERSION. Sem novas dependências, credenciais, variáveis obrigatórias ou migrations. Supabase Auth e as chaves já configuradas continuam necessários ao servidor; nenhuma conexão remota foi usada na validação desta etapa.

## Fronteiras de autorização

`PlatformPrincipal` contém apenas `scope: platform` e `authUserId`. O middleware valida Bearer por `auth.getUser`, verifica PLATFORM_ADMIN_AUTH_USER_IDS e não consulta tenants/app_users. Metadados Auth, papéis institucionais, headers de papel, query e corpo não concedem autorização global. `owner` continua dono institucional; `admin` e `coordinator` também são institucionais.

As rotas globais são montadas antes do tenantContext: x-tenant-slug é irrelevante nelas, inclusive se desconhecido. Não seleciona instituição nem inclui tenantId no log de plataforma. Rotas institucionais continuam usando seu middleware, vínculo ativo e correspondência de tenant. A allowlist não concede acesso acadêmico automático, não fabrica app_users e não promove papel de vínculo existente.

Uma conta pode ter ambos os contextos. Deve solicitar cada endpoint apropriado; capacidades institucionais derivam somente do vínculo no tenant informado. Desativar esse vínculo bloqueia o acesso institucional, sem revogar uma autorização global independente. A configuração da allowlist continua exclusivamente do servidor; mudança na variável de ambiente exige recarregar/reiniciar o processo conforme a hospedagem. Não há endpoint para editar essa lista nesta etapa.

## Endpoints

| Método/caminho | Autorização/entrada | Resposta |
| --- | --- | --- |
| POST `/auth/platform/login` | email/password em JSON estrito; email normalizado; senha6–128 caracteres; sem query | accessToken, refreshToken, expiresAt e authorization de plataforma |
| GET `/auth/platform/me` | Bearer válido e allowlist; sem query/corpo de seleção | `{ authorization: ... }` de plataforma |
| GET `/auth/capabilities` | Bearer e x-tenant-slug, vínculo ativo; sem query/corpo de seleção | `{ authorization: ... }` institucional |
| GET `/admin/reports/global` | Bearer válido e allowlist; sem dependência de app_users/tenant | JSON anterior preservado: totalTenants, totalUsers, activeTenants |

O login novo compartilha o limite existente de30 tentativas/IP/15 minutos com login e admin/login. Limite em memória por processo; política de proxy/distribuição existente não foi modificada. Todos os endpoints mantêm Cache-Control no-store, private, X-Request-Id, ausência de ETag e erros sanitizados. Não salvar tokens em logs, exemplos ou repositório.

Exemplo sintético da autorização retornada por `/auth/platform/me` e no login de plataforma:

```json
{
  "authorization": {
    "scope": "platform",
    "profile": "platform_superadmin",
    "authUserId": "dddddddd-dddd-dddd-dddd-dddddddddddd",
    "capabilities": ["platform.reports.read"]
  }
}
```

Não são anunciadas capabilities de cadastro, suspensão ou exclusão de instituições, pois essas funcionalidades não foram implementadas. `/platform` e `/admin` são áreas futuras do painel, não novas páginas entregues pela API.

Exemplo sintético para admin institucional:

```json
{
  "authorization": {
    "scope": "institution",
    "profile": "institution_admin",
    "userId": "synthetic-institutional-user",
    "tenant": { "id": "synthetic-tenant", "slug": "synthetic" },
    "institutionalRole": "admin",
    "academicScope": "institution",
    "capabilities": [
      "academic.catalog.read", "academic.classes.read", "academic.activities.read",
      "institution.users.manage", "institution.invites.manage", "institution.academic.manage",
      "institution.courses.manage", "institution.classes.manage", "institution.reports.read",
      "academic.activities.manage", "academic.grades.read", "academic.grades.record", "academic.submissions.read"
    ],
    "assignableRoles": ["student", "teacher", "coordinator"]
  }
}
```

userId é identificador de vínculo institucional; authUserId é identificador Supabase Auth. Não são intercambiáveis. UUIDs/IDs acima são apenas sintéticos. Nome, email, plano, métricas e registros acadêmicos não fazem parte do endpoint novo de capacidades.

## Perfis e capabilities

Capabilities são uma projeção de autorização para navegação e habilitação de ações. Não são um token, não são aceitas de volta como autorização e não substituem os guards por registro. O backend relê o vínculo institucional; a plataforma verifica Auth e a allowlist por requisição. Estado do provider, versões, autoria, matrícula, publicação, prazos, hierarquia e invariantes do banco continuam podendo impedir uma operação.

| Perfil | Papel interno / academicScope | Capabilities |
| --- | --- | --- |
| platform_superadmin | Sem papel institucional / sem academicScope | platform.reports.read exclusivamente |
| institution_admin | owner/admin/coordinator / institution | Treze capabilities do exemplo acima; assignableRoles varia pela hierarquia |
| teacher | teacher / assigned_classes | academic.catalog.read, academic.classes.read, academic.activities.read, academic.self.read, academic.activities.manage, academic.activities.publish, academic.grades.read, academic.grades.record, academic.submissions.read, academic.submissions.review |
| student | student / own_records | academic.catalog.read, academic.classes.read, academic.activities.read, academic.self.read, academic.grades.read, academic.submissions.own.read, academic.submissions.submit |

Catálogo é institucional para membros autenticados; scope próprio/atribuído aplica-se a ofertas, atividades, notas e entregas conforme cada endpoint. `academic.self.read` corresponde à consulta pessoal pelo provider, sem garantir provider habilitado ou dados existentes. `activities.manage` cobre criar/editar/encerrar/excluir onde permitido; publicação é capability separada e exclusiva docente. `submissions.review` cobre correção e publicação do resultado, exclusiva docente atribuído. `grades.record` representa lançamento manual sem entrega elegível, preservando a regra legada; não concede a gestores a correção de entregas. Conteúdo com histórico não se torna apagável pela presença de uma capability.

`institution.users.manage` e `institution.invites.manage` respeitam hierarquia e destinatário. assignableRoles descreve somente papéis inferiores potencialmente concedíveis; não permite autoalteração, alteração de pares/superiores ou violar histórico:

Nesta versão, users.manage cobre lista/detalhe/cadastro/perfil/status/papel, sem exclusão de usuário ou reset de senha; invites.manage cobre criação de convite direcionado, sem nova operação de revogação. academic.manage cobre cadastro/edição/status de períodos, disciplinas, ofertas, matrículas e atribuições, preservando seus limites de exclusão. courses/classes.manage cobre os CRUDs existentes, sem autorizar apagar histórico. A capability não anuncia endpoints novos.

| Papel | assignableRoles |
| --- | --- |
| owner | student, teacher, coordinator, admin |
| admin | student, teacher, coordinator |
| coordinator | student, teacher |
| teacher/student | vazio |

O catálogo de capabilities desta etapa cobre gestão institucional e operações acadêmicas centrais. Não redefine as permissões de comunicação privada nem substitui os contratos/guards de avisos, conversas e notificações já existentes. Ampliações futuras devem ser aditivas e testadas.

## Compatibilidade e erros

Login/me/admin institucionais e seus JSONs permanecem iguais; nenhuma authorization nova foi injetada nessas respostas. Clientes atuais podem continuar usando-os. O relatório global mantém caminho/JSON e agora aceita Auth autorizado sem vínculo. O header de tenant deixou de ser resolvido nesse recurso global; clientes não devem usá-lo para selecionar escopo global.

- Token ausente/inválido:401 com envelope existente. Conta autenticada fora da allowlist:403 FORBIDDEN, sem devolver accessToken/refreshToken do login recusado.
- Parâmetros extras nos novos endpoints:400 VALIDATION_ERROR; JSON malformado:400 INVALID_JSON.
- Institucional com token mas sem tenant:400 TENANT_REQUIRED; desconhecido/divergente:404; sem vínculo:403 USER_NOT_LINKED_TO_TENANT; inativo:403 USER_INACTIVE.
- Dependência Auth indisponível:503 DEPENDENCY_UNAVAILABLE; erros inesperados continuam sanitizados e correlacionados por requestId.

## Limites e próximos passos

Nenhuma gestão de instituições, bootstrap de primeiro admin, suspensão institucional, novo papel/grant persistido, refresh token ou recuperação de senha foi implementado. `/auth/refresh` continua501, como antes. Logout existente pode ser usado com Bearer sem header de tenant.

Nenhuma migration é necessária para o código P0.1. O relatório usa as tabelas existentes e as rotas institucionais continuam dependendo do schema anterior; isso não dispensa o inventário10.2 nem autoriza migrations/10.3. Testes de Auth nesta etapa são sintéticos, não homologação de GoTrue ou ambiente remoto. Operação com credenciais e banco reais exige validação autorizada posterior.

Plano, evidências e revisão: plano, validação, revisão. Encerrar após validação P0.1; P0.2 exige nova autorização.
