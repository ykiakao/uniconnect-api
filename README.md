# UniConnect API

Backend inicial para o SaaS mobile-first UniConnect.

Esta base expõe uma API REST versionada para autenticação, tenant atual e healthcheck. Por enquanto os dados usam um store em memória para acelerar o MVP; a estrutura já separa módulos para evoluir depois para banco de dados, autenticação real e assinaturas.

## Tecnologias

- Node.js
- TypeScript
- Express
- Zod
- Helmet
- CORS

## Como rodar

```bash
cd api_backend
npm install
copy .env.example .env
npm run dev
```

API local:

```txt
http://localhost:3333/api/v1
```

## Endpoints iniciais

```txt
GET  /api/v1/health
GET  /api/v1/tenants/current
POST /api/v1/auth/login
GET  /api/v1/auth/me
```

Header de tenant:

```txt
x-tenant-slug: universidade-norte
```

Body de login:

```json
{
  "email": "aluno@uni.com",
  "password": "123456"
}
```

## Estrutura

```txt
src/
  config/
  data/
  middleware/
  modules/
    auth/
    tenants/
  shared/
  app.ts
  routes.ts
  server.ts
```

## Próximos passos

- Adicionar banco PostgreSQL.
- Criar autenticação com JWT.
- Persistir instituições, usuários, cursos, turmas, atividades e notas.
- Adicionar permissões por perfil.
- Criar módulo de assinaturas e cobrança.
