# UniConnect API

API backend do UniConnect estruturada como microsserviço REST para autenticação, contexto de tenant e dados acadêmicos.

![Node.js](https://img.shields.io/badge/Node.js-API-green)
![TypeScript](https://img.shields.io/badge/TypeScript-Backend-blue)
![Express](https://img.shields.io/badge/Express-REST-black)
![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ECF8E)
![SaaS](https://img.shields.io/badge/Architecture-Multi--tenant-purple)

---

## Sobre o Projeto

O UniConnect API centraliza as regras de backend do ecossistema UniConnect.

Este repositório contém apenas a API Node.js com TypeScript, Express e Supabase. O app Flutter e o painel web ficam no repositório separado `uniconnect-clients` e consomem este serviço exclusivamente via HTTP.

---

## Responsabilidades da API

* Expor endpoints REST versionados
* Autenticar usuários com Supabase Auth
* Resolver o tenant atual por instituição
* Retornar usuário, perfil e contexto institucional
* Centralizar integrações com Supabase Postgres
* Manter a base preparada para dados acadêmicos, permissões e assinatura
* Servir como backend compartilhado para app mobile e painel web

---

## Tecnologias Utilizadas

| Camada | Tecnologias |
| ------ | ----------- |
| Runtime | Node.js |
| Linguagem | TypeScript |
| API | Express, Helmet, CORS |
| Validação | Zod |
| Banco e Auth | Supabase Auth, Supabase Postgres, Supabase JS |
| Desenvolvimento | TSX, Dotenv, npm |
| Arquitetura | REST API, multi-tenant, SaaS |

---

## Estrutura do Repositório

| Pasta/Arquivo | Finalidade |
| ------------- | ---------- |
| `src/app.ts` | Configuração do Express e middlewares globais |
| `src/server.ts` | Inicialização do servidor HTTP |
| `src/routes.ts` | Registro das rotas versionadas |
| `src/config/` | Configuração de ambiente e cliente Supabase |
| `src/middleware/` | Contexto de tenant e tratamento de erros |
| `src/modules/auth/` | Rotas, serviço e repositório de autenticação |
| `src/modules/tenants/` | Rotas e repositório de tenant |
| `src/shared/` | Tipos e erros compartilhados |
| `scripts/` | Scripts auxiliares de setup e validação |
| `supabase/` | Schema e seed SQL do Supabase |

---

## Requisitos

Antes de executar o projeto, instale:

* Git
* Node.js
* npm
* Conta/projeto Supabase

---

## Instalação

```bash
npm install
copy .env.example .env
```

Configure o arquivo `.env` com as chaves do Supabase antes de rodar a API.

Para desenvolvimento local, rode a API na sua maquina e aponte para o mesmo projeto Supabase usado no Railway. Copie do Railway ou do painel do Supabase:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

Sem essas variaveis a API nao inicializa, porque tenant e autenticacao dependem do Supabase.

Se a `SUPABASE_DB_URL` ainda nao estiver correta, mas as chaves HTTP do Supabase estiverem funcionando, voce pode preparar os usuarios e vinculos basicos via API:

```powershell
$env:SETUP_API_ONLY='true'
npm run setup:supabase
Remove-Item Env:\SETUP_API_ONLY
```

Esse modo cria os usuarios demo no Supabase Auth e vincula `coordenador@uni.com` e `dono@uni.com` ao tenant com permissao administrativa.

---

## Variáveis de Ambiente

| Variável | Descrição |
| -------- | --------- |
| `NODE_ENV` | Ambiente da aplicação |
| `PORT` | Porta local da API |
| `API_VERSION` | Versão exposta nas rotas |
| `APP_ORIGIN` | Lista de origens permitidas no CORS, separadas por virgula. Inclua a origem do painel web, como `http://localhost:3000` ou `http://127.0.0.1:5173`. |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY` | Chave pública anon usada no login |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave privada usada apenas no backend |
| `SUPABASE_DB_URL` | URL de conexão usada por scripts |
| `DEMO_STUDENT_PASSWORD` | Senha do aluno demo |
| `DEMO_TEACHER_PASSWORD` | Senha do professor demo |
| `DEMO_UNIVERSITY_PASSWORD` | Senha padrao dos usuarios do seed demo da universidade |

---

## Executando a API

```bash
npm run dev
```

A API ficará disponível em:

```text
http://localhost:3333/api/v1
```

---

## Validação e Build

```bash
npm run typecheck
npm run build
```

Para executar a versão compilada:

```bash
npm run start
```

---

## Rotas Iniciais da API

| Método | Endpoint | Descrição |
| ------ | -------- | --------- |
| GET | `/api/v1/health` | Verifica a disponibilidade da API |
| GET | `/api/v1/tenants/current` | Retorna o tenant atual |
| POST | `/api/v1/auth/login` | Realiza login via Supabase Auth |
| GET | `/api/v1/auth/me` | Retorna usuário e tenant atuais |

Header de tenant usado no MVP:

```http
x-tenant-slug: universidade-norte
Accept: application/json
```

---

## Banco de Dados

Execute os arquivos SQL no SQL Editor do Supabase:

| Arquivo | Finalidade |
| ------- | ---------- |
| `supabase/schema.sql` | Cria tabelas, constraints e políticas RLS |
| `supabase/seed.sql` | Insere tenant demo e vincula usuários do Supabase Auth |
| `supabase/seed_demo.sql` | Popula uma universidade demo com cursos, turmas, atividades, notas e mensagens ficticias |

Usuários demo esperados:

| Perfil | E-mail | Senha |
| ------ | ------ | ----- |
| Aluno | `aluno@uni.com` | `123456` |
| Professor | `professor@uni.com` | `123456` |

Para preparar a base realista da demo do TCC, configure `SUPABASE_DB_URL`
e rode:

```bash
npm run seed:demo
```

O script cria usuarios ficticios no Supabase Auth e executa
`supabase/seed_demo.sql`. A senha padrao local e `Demo@2026`, configuravel
por `DEMO_UNIVERSITY_PASSWORD`.

Usuarios principais do seed demo:

| Perfil | E-mail |
| ------ | ------ |
| Admin | `admin@uniconnect.app` |
| Gestor | `gestor@universidade-norte.edu.br` |
| Coordenador | `coordenador@universidade-norte.edu.br` |
| Professor | `professor.eng@universidade-norte.edu.br` |
| Aluno | `aluno01@universidade-norte.edu.br` |

---

## Integração com os Clientes

O app Flutter e o painel web ficam no repositório:

```text
uniconnect-clients
```

Os clientes devem consumir a API via HTTP usando:

```text
http://localhost:3333/api/v1
```

---

## Roadmap Técnico

### Concluído

* API Node/Express isolada em repositório próprio
* TypeScript configurado
* Supabase Auth e Postgres integrados
* Login real via API
* `/auth/me` validando Bearer token
* Contexto de tenant por header

### Pendente

* Criar endpoints acadêmicos de atividades, notas, turmas e chat
* Adicionar permissões por perfil nas rotas
* Evoluir schema Supabase com dados reais
* Adicionar testes automatizados de integração
* Preparar pipeline de CI/CD
* Avaliar Docker para padronizar execução local

---

## Arquivos da Entrega

Este repositório contém:

* `README.md`
* `.gitignore`
* `.env.example`
* `package.json`
* `package-lock.json`
* `tsconfig.json`
* `src/`
* `scripts/`
* `supabase/`

As pastas `node_modules/`, `dist/`, `.supabase/` e arquivos `.env` locais não devem ser enviados para o GitHub.

---

## Contato

API acadêmica em evolução como backend do ecossistema UniConnect.
