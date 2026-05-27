# UniConnect API

Microsserviço backend responsável por disponibilizar autenticação, contexto de tenant e endpoints iniciais para o SaaS acadêmico UniConnect.

![Node.js](https://img.shields.io/badge/Node.js-Backend-green)
![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)
![Express](https://img.shields.io/badge/Express-REST-black)
![Zod](https://img.shields.io/badge/Validation-Zod-purple)
![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ECF8E)

---

## Sobre o Projeto

Esta API centraliza a comunicação entre o aplicativo mobile, o futuro painel web e os dados acadêmicos da plataforma.

No estágio atual, a API usa Supabase Auth para autenticação e Supabase Postgres para persistir tenants e usuários do MVP. A estrutura já foi separada em módulos, middlewares, repositórios e tipos para evoluir depois com permissões, dados acadêmicos e assinatura.

---

## Responsabilidades do Microsserviço

* Identificar a instituição atual por tenant
* Autenticar usuários do app mobile e do futuro painel web
* Retornar dados do usuário logado
* Servir endpoints JSON versionados
* Validar payloads de entrada com Zod
* Aplicar middlewares globais de segurança e erro
* Preparar a base para dados acadêmicos e assinatura

---

## Tecnologias Utilizadas

* Node.js
* TypeScript
* Express
* Zod
* Supabase Auth
* Supabase Postgres
* Supabase JS
* Helmet
* CORS
* Dotenv
* TSX
* npm

---

## Estrutura do Repositório

| Pasta | Finalidade |
| ----- | ---------- |
| `src/config` | Configuração de ambiente e Supabase |
| `src/middleware` | Middlewares de tenant e erro |
| `src/modules/auth` | Rotas, serviço e repositório de autenticação |
| `src/modules/tenants` | Rotas e repositório de instituição/tenant |
| `src/shared` | Tipos e erros compartilhados |
| `supabase` | SQL de schema e seed inicial |
| `src/app.ts` | Configuração do Express |
| `src/routes.ts` | Registro das rotas versionadas |
| `src/server.ts` | Inicialização do servidor |

---

## Requisitos

Antes de executar o projeto, instale:

* Node.js
* npm
* Git

---

## Instalação

Instale as dependências:

```bash
npm install
```

Crie o arquivo `.env`:

```bash
copy .env.example .env
```

---

## Variáveis de Ambiente

Principais variáveis usadas pelo projeto:

| Variável | Descrição |
| -------- | --------- |
| `NODE_ENV` | Ambiente da aplicação |
| `PORT` | Porta local da API |
| `API_VERSION` | Versão exposta nas rotas |
| `APP_ORIGIN` | Origem permitida no CORS |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY` | Chave pública anon usada no login |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave privada usada apenas no backend |

Exemplo:

```env
NODE_ENV=development
PORT=3333
API_VERSION=v1
APP_ORIGIN=http://127.0.0.1:8080
SUPABASE_URL=https://kpwofazhpiqrxjyxkozl.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

---

## Banco de Dados

Execute os arquivos SQL no SQL Editor do Supabase:

| Arquivo | Finalidade |
| ------- | ---------- |
| `supabase/schema.sql` | Cria tabelas, constraints e políticas RLS para service role |
| `supabase/seed.sql` | Insere o tenant demo e vincula usuários do Supabase Auth |

Antes de rodar `seed.sql`, crie os usuários no Supabase Auth:

| E-mail | Senha |
| ------ | ----- |
| `aluno@uni.com` | `123456` |
| `professor@uni.com` | `123456` |

---

## Executando o Projeto

Inicie o servidor em desenvolvimento:

```bash
npm run dev
```

A aplicação ficará disponível em:

```text
http://localhost:3333/api/v1
```

Scripts disponíveis:

| Script | Descrição |
| ------ | --------- |
| `npm run dev` | Inicia a API em modo desenvolvimento |
| `npm run build` | Compila o TypeScript |
| `npm run start` | Executa a versão compilada |
| `npm run typecheck` | Valida tipos sem gerar build |

---

## Autenticação

A autenticação usa Supabase Auth por e-mail e senha. A API recebe as credenciais, autentica no Supabase e retorna o `accessToken`, `refreshToken`, usuário do UniConnect e tenant atual.

Requisições com contexto de instituição devem enviar:

```http
x-tenant-slug: universidade-norte
Accept: application/json
```

A `SUPABASE_SERVICE_ROLE_KEY` deve ficar somente no backend. Ela nunca deve ser usada no app Flutter.

---

## Rotas da API

| Método | Endpoint | Descrição | Autenticação |
| ------ | -------- | --------- | ------------ |
| GET | `/api/v1/health` | Verifica a disponibilidade da API | Não |
| GET | `/api/v1/tenants/current` | Retorna o tenant atual | Tenant header |
| POST | `/api/v1/auth/login` | Realiza login via Supabase Auth | Tenant header |
| GET | `/api/v1/auth/me` | Retorna usuário e tenant atuais | Bearer token + tenant header |

---

## Exemplos de Requisição

Healthcheck:

```http
GET /api/v1/health HTTP/1.1
Host: localhost:3333
Accept: application/json
x-tenant-slug: universidade-norte
```

Sessão atual:

```http
GET /api/v1/auth/me HTTP/1.1
Host: localhost:3333
Accept: application/json
Authorization: Bearer SEU_TOKEN_SUPABASE
x-tenant-slug: universidade-norte
```

Login:

```http
POST /api/v1/auth/login HTTP/1.1
Host: localhost:3333
Accept: application/json
Content-Type: application/json
x-tenant-slug: universidade-norte

{
  "email": "aluno@uni.com",
  "password": "123456"
}
```

---

## Exemplo de Resposta

```json
{
  "accessToken": "supabase-access-token",
  "refreshToken": "supabase-refresh-token",
  "expiresAt": 1760000000,
  "user": {
    "id": "6e1f0ab2-0000-0000-0000-000000000000",
    "tenantId": "4b08fdf0-0000-0000-0000-000000000000",
    "authUserId": "9d27b16b-0000-0000-0000-000000000000",
    "name": "Lucas Oliveira",
    "email": "aluno@uni.com",
    "role": "student",
    "course": "Engenharia de Software",
    "registration": "2024021845",
    "semester": 4
  },
  "tenant": {
    "id": "4b08fdf0-0000-0000-0000-000000000000",
    "name": "Universidade Norte",
    "slug": "universidade-norte",
    "plan": "growth",
    "status": "trialing",
    "activeUsers": 384
  }
}
```

---

## Retornos Esperados

| Código | Situação | Exemplo |
| ------ | -------- | ------- |
| 200 | Requisição concluída com sucesso | Dados JSON |
| 400 | Payload inválido | Erro de validação do Zod |
| 401 | Credenciais inválidas | `Credenciais inválidas.` |
| 404 | Tenant não encontrado | `Instituição não encontrada.` |
| 500 | Erro inesperado no servidor | `Erro interno do servidor.` |

---

## Testes e Validação

Valide os tipos:

```bash
npm run typecheck
```

Compile o projeto:

```bash
npm run build
```

---

## Integração com o App Mobile

O app Flutter deve:

1. enviar o header `x-tenant-slug`;
2. chamar `/api/v1/auth/login`;
3. armazenar o usuário, token e tenant;
4. usar o perfil retornado para direcionar aluno ou professor;
5. consumir os endpoints acadêmicos futuros.

---

## Dados do Serviço

Atualmente os dados ficam no Supabase Postgres.

| Entidade | Descrição |
| -------- | --------- |
| `tenants` | Instituições cadastradas no SaaS |
| `app_users` | Perfis do UniConnect vinculados ao Supabase Auth |
| `courses` | Cursos por instituição |
| `classes` | Turmas por curso/instituição |
| `activities` | Atividades acadêmicas |
| `grades` | Notas dos alunos |
| `messages` | Mensagens acadêmicas |

---

## Fluxo Principal

1. O consumidor envia uma requisição com `x-tenant-slug`.
2. O middleware localiza a instituição.
3. A rota processa a requisição.
4. A API retorna dados JSON.
5. O app mobile atualiza sua interface conforme o perfil do usuário.

---

## Arquivos da Entrega

Este microsserviço contém:

* `README.md`
* `.env.example`
* `package.json`
* `package-lock.json`
* `tsconfig.json`
* código-fonte em `src/`

A pasta `node_modules/` não deve ser enviada para o GitHub.

---

## Contato

Microsserviço acadêmico desenvolvido como base backend do ecossistema UniConnect.
