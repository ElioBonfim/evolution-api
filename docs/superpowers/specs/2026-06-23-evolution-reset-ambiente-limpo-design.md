# Reset para ambiente limpo — Evolution API @ Railway

**Data:** 2026-06-23
**Tipo:** Operação destrutiva em produção (runbook)
**Status:** Aprovado para implementação

## Contexto

A Evolution API roda em produção no Railway:

- **Projeto:** `Evolution API` (`d7f1036e-5a26-4490-8622-26ace6896e4d`), ambiente `production`, workspace "Elio Bonfim Júnior's Projects".
- **Serviços:**
  - `evolution-api` — build via **Dockerfile** do repo `ElioBonfim/evolution-api`, branch `main` (HEAD `12da657a`). Deploy automático no push.
  - `Postgres` — `ghcr.io/railwayapp-templates/postgres-ssl:17`, volume `/var/lib/postgresql/data`.
  - `Redis` — `redis:8.2.1`, volume `/data`, persistência ativa (`--save 60 1`).
- **Stack (já moderna):** Node 24-alpine, Baileys 7.0.0-rc.9, Prisma 6.16, Express 4.21, redis client 4.7. Versão do app `2.3.7` + 4 fixes próprios do fork (monitor/redis/evolution-state).
- **URL pública:** `https://evolution-api-production-ff74.up.railway.app`
- **DB provider:** `postgresql`. Cache Redis habilitado com `CACHE_REDIS_SAVE_INSTANCES` ativo.

A stack **não precisa de upgrade de versão** — já está no HEAD do fork e com dependências recentes.

## Objetivo

Zerar completamente os dados/sessões da instância de produção, deixando um **ambiente limpo**, mantendo a infraestrutura e a configuração atuais. Não há problema a diagnosticar — é uma limpeza desejada ("base limpa total").

## Escopo

### Permanece inalterado
- Os 3 serviços Railway, seus volumes e domínio público.
- Todas as env vars de configuração (webhooks, flags de DATABASE_SAVE_*, CORS, etc.), **exceto** a API key (ver abaixo).
- Código / versão da aplicação (sem upgrade, sem redeploy de código novo).

### É zerado
- **Postgres:** todas as tabelas do Evolution (instâncias, mensagens, contatos, chats, settings, integrações, labels). Resultado: schema limpo recriado pelas migrations.
- **Redis:** `FLUSHALL` — limpa cache e sessões de instância salvas (`CACHE_REDIS_SAVE_INSTANCES`), evitando ressuscitar instâncias antigas.
- **Sessões WhatsApp:** consequência natural — todas exigirão novo QR code.

### É regenerado
- **`AUTHENTICATION_API_KEY`:** novo valor seguro gerado e aplicado via `railway variables`.

## Procedimento

> Sem backup (descarte total, por decisão do usuário).

1. **Confirmar método de acesso aos bancos.** As URIs internas (`*.railway.internal`) não resolvem fora da rede Railway. Usar o TCP proxy público (`railway connect Postgres` / `railway connect Redis`) ou as `*_PUBLIC_URL`/`RAILWAY_TCP_PROXY_*` correspondentes. Validar conectividade antes de qualquer escrita.

2. **Limpar Redis:** `FLUSHALL` (ou `FLUSHDB` no índice usado pelo prefixo `CACHE_REDIS_PREFIX_KEY`).

3. **Resetar Postgres:** dropar todas as tabelas do schema do Evolution. Forma preferida: `prisma migrate reset --force` apontando para o banco; alternativa: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` deixando o boot do app reaplicar as migrations (`db:deploy`).

4. **Regenerar a API key:** gerar um token aleatório forte e aplicar com `railway variables --service evolution-api --set "AUTHENTICATION_API_KEY=<novo>"`.

5. **Redeploy** do serviço `evolution-api` para boot limpo (recria schema se necessário, sobe sem instâncias). A mudança de variável já pode disparar o redeploy; caso contrário, forçar.

6. **Validação ponta-a-ponta:**
   - API responde na URL pública com a nova key.
   - `GET /instance/fetchInstances` retorna lista vazia.
   - Criar 1 instância de teste, escanear QR, confirmar status `open`.
   - (Limpar a instância de teste se desejado.)

7. **Gerar arquivo de credenciais** para conexão de outros sistemas (ver abaixo).

## Arquivo de credenciais

Criar `evolution-connection.env` na raiz do projeto (coberto por `*.env` no `.gitignore` → **não vai para o git**), contendo o necessário para integrar outros sistemas:

```
EVOLUTION_API_URL=https://evolution-api-production-ff74.up.railway.app
EVOLUTION_API_KEY=<nova AUTHENTICATION_API_KEY>
# Exemplo de uso:
#   curl -H "apikey: $EVOLUTION_API_KEY" $EVOLUTION_API_URL/instance/fetchInstances
```

Incluir apenas o que é necessário para integração externa (URL + API key global). Credenciais de banco/redis não entram nesse arquivo (são internas do Railway).

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Apagar dados é irreversível | É o objetivo declarado; sem dados a preservar. |
| Limpar DB com app ainda escrevendo | Redeploy/limpeza ordenados; reset seguido de boot limpo. |
| URIs internas não acessíveis de fora | Usar TCP proxy público / `railway connect`; validar no passo 1. |
| Vazar a nova API key | Arquivo de credenciais é `*.env` (gitignored); nunca commitar nem colar em logs. |
| Redeploy não disparar sozinho | Forçar redeploy explícito após setar a variável. |

## Critério de conclusão

- `fetchInstances` vazio logo após o reset.
- Nova API key ativa (a antiga deixa de autenticar).
- Uma instância de teste conecta via QR com sucesso.
- `evolution-connection.env` criado e fora do controle de versão.
