# Dados acadêmicos por provedores — Etapas 2 e 6

O backend continua sendo UniConnect: Node.js 22, TypeScript, Express e autenticação/contexto pelo Supabase existente. A leitura acadêmica usa `AcademicProvider`, com contratos próprios para instituição, período, disciplina, notas, frequência e atividades. O provedor demo funciona sem rede ou credenciais de portais externos.

## Executar localmente

Na pasta `uniconnect-api`, use Node.js 22 e a configuração Supabase que já autentica seus usuários. O login exige um vínculo institucional ativo no tenant escolhido. A versão das Etapas4–6 exige as migrations preparadas de segurança/estrutura/gestão revisadas e aplicadas manualmente em execução futura autorizada; nenhuma é aplicada ao iniciar a API. Não há seed ou consulta de portal automática.

```powershell
npm ci
$env:ACADEMIC_PROVIDER = 'demo'
$env:ACADEMIC_DEMO_TENANT_SLUG = 'edukmais'
npm run dev
```

`ACADEMIC_PROVIDER` aceita `disabled` (padrão seguro), `demo` ou `native`. `ACADEMIC_DEMO_TENANT_SLUG` limita somente o dataset fictício à instituição configurada pelo servidor. Native usa os vínculos persistidos do usuário/tenant autenticados; consulte o [guia nativo](native-academic-provider.md). A configuração não é recebida do aplicativo. Para produção use `npm run build` e `npm start`; a plataforma precisa instalar o diretório `packages/` junto com a API. Não há dependência de arquivos acima de `uniconnect-api/`.

Em outro PowerShell, autentique pelo endpoint existente. O exemplo solicita a senha sem imprimi-la e não mostra o token:

```powershell
$baseDemo = 'http://127.0.0.1:3333/api/v1'
$tenantDemo = 'edukmais'
$credDemo = Get-Credential -UserName 'aluno@edukmais.edu.br' -Message 'Usuário UniConnect existente'
try {
    $bodyDemo = @{ email = $credDemo.UserName; password = $credDemo.GetNetworkCredential().Password } | ConvertTo-Json
    $sessionDemo = Invoke-RestMethod -Method Post -Uri "$baseDemo/auth/login" -ContentType 'application/json' -Headers @{ 'x-tenant-slug' = $tenantDemo } -Body $bodyDemo
    $headersDemo = @{ 'x-tenant-slug' = $tenantDemo; Authorization = "Bearer $($sessionDemo.accessToken)" }
    $overviewDemo = Invoke-RestMethod -Uri "$baseDemo/tenants/$tenantDemo/academic/overview" -Headers $headersDemo
    $overviewDemo | ConvertTo-Json -Depth 15
} finally {
    Remove-Variable bodyDemo, sessionDemo, headersDemo, credDemo -ErrorAction SilentlyContinue
}
```

Para o TCC, use o usuário de teste já configurado na instituição fictícia. A senha desta conta é a configuração existente do ambiente; não são credenciais do portal externo. Não foi criada uma autenticação alternativa ou um token de demonstração em produção. O Supabase ainda é necessário para autenticação e resolução do tenant, como antes; somente os dados acadêmicos demo independem de serviços externos.

## Endpoints

Prefixo padrão `/api/v1/tenants/:slug/academic` (`v1` segue `API_VERSION`). Todos exigem `Authorization: Bearer ...` e `x-tenant-slug`; slug da rota e tenant resolvido precisam coincidir. O usuário é obtido de `request.currentUser`, nunca de query ou corpo.

| Método | Caminho | Entrada |
| --- | --- | --- |
| GET | `/periods` | Sem query/corpo |
| GET | `/overview` | `periodId` opcional, retornado por `/periods`; sem corpo |
| GET | `/history` | Sem query/corpo |

Exemplo de seleção: `/overview?periodId=demo-2026-1`. Sem seleção, retorna `demo-2026-2`. Histórico inclui os dois períodos, cada um com cinco disciplinas e quatro atividades. Não há paginação para este dataset fixo. Não há endpoints de portais externos nem parâmetros `provider`, `institution`, `userId`, URL ou credenciais. Parâmetros extras/duplicados, corpos e períodos indisponíveis são rejeitados.

## Formato genérico

Todos os envelopes contêm:

```json
{
  "source": {
    "providerId": "demo",
    "demonstration": true,
    "label": "Dados fictícios para demonstração — sem consulta a portais"
  },
  "scope": { "userId": "usuario-autenticado", "tenantId": "tenant-autenticado" },
  "institution": { "id": "tenant-autenticado", "name": "EduKMais", "slug": "edukmais" },
  "complete": true,
  "warnings": []
}
```

`/periods` acrescenta `periods`; `/overview`, `period` e `subjects`; `/history`, `periods` com um overview completo ou explicitamente parcial por período. Os identificadores do exemplo acima são ilustrativos; o escopo real vem exclusivamente da autenticação existente.

Disciplina: `id`, `offeringId`, `periodId`, `name`, `status`/`statusLabel`, `grades`, `attendance`, `activities`. Notas agregadas incluem `assessment1`, `assessment2`, `average`, `exam`, `finalAverage`. A Etapa6 acrescenta `assessments` opcional para avaliações individuais com `activityId`, `title`, `grade`, `feedback`, `gradedAt`; não converte uma nota por atividade em média institucional. Atividades admitem `title` opcional. Frequência inclui `absences` e `absencePercentage`; o adaptador externo preserva frequência do boletim em `attendance.bulletin`, separada da API, e sua situação em `bulletinStatus`/`bulletinStatusLabel`. IDs acadêmicos podem ser strings ou números de cada sistema. Rótulos originais preservam diferenças entre fontes; status desconhecido permanece `unknown`, sem deduzir aprovação.

Zero permanece zero, inclusive média final. `null` significa valor não informado/interpretável. Campos ausentes não são preenchidos. Atividades mantêm IDs, tipo, situação, disponibilidade e prazos; `validated` não comprova entrega ou nota. Não são calculadas médias. A demonstração contém exemplos de decimal, zero, `null` e ausência; todos os registros foram criados sinteticamente, com IDs `demo-*`, sem copiar dados acadêmicos pessoais.

## Autorização, erros e limites

O middleware existente `requireTenantUser` confirma token e vínculo. O serviço verifica novamente usuário/tenant e os envelopes retornados, inclusive períodos aninhados do histórico. Cada execução recebe nova instância; fechamento ocorre em `finally`. Respostas de sucesso e erro destas rotas usam `no-store, private`, sem ETag ou 304 condicional. Não são persistidos credenciais, cookies, PDFs ou histórico; não há logger de corpos/credenciais.

Limites locais por processo: 30 consultas/minuto por usuário+tenant, quatro consultas concorrentes e até 10 mil chaves de rate limit com expiração em um minuto. Excesso retorna 429 e `Retry-After`, sem fila ilimitada. A admissão libera vaga em término/desconexão. Para múltiplas réplicas e futura ativação externa via HTTP será necessário limitador distribuído e controle do ciclo completo da consulta. Os providers HTTP habilitáveis são demo e native.

Erros seguem `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`, com mensagens estáticas seguras; o mesmo identificador é enviado em `X-Request-Id`:

| HTTP | Situação |
| --- | --- |
| 400 | Filtros/corpo inválidos ou contexto de tenant ausente |
| 401 | Token UniConnect ausente/inválido |
| 403/404 | Vínculo/tenant/escopo não permitido, ou período inexistente |
| 429 | Limite de consultas |
| 503 | Provedor desativado ou fonte indisponível |
| 424 | Credenciais/sessão externa inválidas, sem confundir com login UniConnect |
| 502 | Resposta/PDF incompatível ou falha do adaptador |
| 504 | Timeout da fonte externa |

Dados parcialmente interpretados usam 200 com `complete:false` e avisos codificados; não é declarado sucesso completo. Nenhum corpo bruto de erro do portal é repassado.

## Extensão do contrato

Os providers configuráveis são `disabled`, `demo` e `native`. Uma nova fonte precisa implementar `AcademicProvider` e ter política de acesso definida no servidor. A demonstração usa dados sintéticos e opera independentemente de portais acadêmicos externos.

## Testes e build

Em Node.js 22:

```bash
npm test -- --runInBand --roots src
npm run typecheck
npm run build
npm run test:academic-build
```

Os testes usam dados sintéticos e mocks para validar contratos, isolamento, autenticação, erros, cache e limites. O smoke compilado verifica health, autorização e os providers acadêmicos em loopback com chamadas externas bloqueadas.
