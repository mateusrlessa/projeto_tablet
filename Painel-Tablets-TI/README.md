# HubSync - Painel Tablets TI

Aplicação full-stack para monitoramento de tablets com interface em Vite, API em Express e banco Postgres no Docker.

## Funcionalidades

- Dashboard com totais de monitoramento
- Lista de ativos com busca
- Cadastro de novo ativo
- Login e cadastro de usuários
- Renovação individual e em lote dos vencidos
- Exportação em XLSX
- Banco de dados em Docker via PostgreSQL

## Requisitos

- Node.js 20+
- Docker e Docker Compose

## Como executar localmente

1. Crie o arquivo `.env` com base em `.env.example`.
2. Instale dependências:

```bash
npm install
```

3. Suba o banco:

```bash
docker compose up -d db
```

4. Inicialize a estrutura e os dados iniciais:

```bash
npm run db:init
```

5. Inicie a aplicação:

```bash
npm run dev
```

A interface fica em `http://localhost:5173` e a API em `http://localhost:3002`.
O Postgres fica exposto em `localhost:5433`.

### Acesso inicial

- E-mail: `admin@hubsync.local`
- Senha: `123456`

## Como executar com Docker

```bash
docker compose up --build
```

A aplicação sobe em `http://localhost:3002`.
