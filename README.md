# UniConnect API

API REST do UniConnect, responsavel por autenticacao, contexto de tenant e endpoints iniciais do SaaS academico.

O app Flutter e o painel web ficam em outro repositorio: `uniconnect-clients`.

## Tecnologias

| Area | Stack |
| --- | --- |
| Runtime | Node.js |
| Linguagem | TypeScript |
| HTTP | Express |
| Validacao | Zod |
| Banco/Auth | Supabase Auth e Supabase Postgres |
| Seguranca | Helmet, CORS |
| Dev | TSX, npm |

## Estrutura

| Caminho | Finalidade |
| --- | --- |
| `src/app.ts` | Configuracao do Express |
| `src/server.ts` | Inicializacao do servidor |
| `src/routes.ts` | Registro das rotas versionadas |
| `src/config/` | Ambiente e cliente Supabase |
| `src/middleware/` | Tenant context e tratamento de erros |
| `src/modules/auth/` | Login e usuario atual |
| `src/modules/tenants/` | Tenant atual |
| `src/shared/` | Tipos e erros compartilhados |
| `scripts/` | Scripts auxiliares |
| `supabase/` | Schema e seed SQL |

## Variaveis de Ambiente

Crie um arquivo `.env` a partir de `.env.example`.

| Variavel | Descricao |
| --- | --- |
| `NODE_ENV` | Ambiente da aplicacao |
| `PORT` | Porta HTTP local |
| `API_VERSION` | Versao das rotas, por exemplo `v1` |
| `APP_ORIGIN` | Origem permitida no CORS |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY` | Chave anonima publica do Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave privada usada somente no backend |
| `SUPABASE_DB_URL` | URL de conexao com o banco, usada por scripts |
| `DEMO_STUDENT_PASSWORD` | Senha do usuario demo aluno |
| `DEMO_TEACHER_PASSWORD` | Senha do usuario demo professor |

## Instalacao

```bash
npm install
copy .env.example .env
```

## Desenvolvimento

```bash
npm run dev
```

URL local:

```text
http://localhost:3333/api/v1
```

## Validacao e Build

```bash
npm run typecheck
npm run build
```

Para executar a versao compilada:

```bash
npm run start
```

## Endpoints Atuais

| Metodo | Endpoint | Descricao | Autenticacao |
| --- | --- | --- | --- |
| `GET` | `/api/v1/health` | Healthcheck da API | Nao |
| `GET` | `/api/v1/tenants/current` | Retorna o tenant atual | Header `x-tenant-slug` |
| `POST` | `/api/v1/auth/login` | Login via Supabase Auth | Header `x-tenant-slug` |
| `GET` | `/api/v1/auth/me` | Retorna usuario e tenant atuais | Bearer token + header `x-tenant-slug` |

Header de tenant usado no MVP:

```http
x-tenant-slug: universidade-norte
Accept: application/json
```

## Supabase

Execute os arquivos SQL no Supabase quando precisar recriar a base demo:

| Arquivo | Finalidade |
| --- | --- |
| `supabase/schema.sql` | Tabelas, constraints e politicas |
| `supabase/seed.sql` | Tenant demo e vinculos de usuarios |

Usuarios demo esperados no Supabase Auth:

| Perfil | Email | Senha |
| --- | --- | --- |
| Aluno | `aluno@uni.com` | `123456` |
| Professor | `professor@uni.com` | `123456` |

## Separacao de Responsabilidades

Este repositorio contem apenas a API Node.js/TypeScript. Nao deve conter app Flutter, painel web ou dependencias dos clientes.

Os clientes consomem esta API via HTTP usando a base local:

```text
http://localhost:3333/api/v1
```
