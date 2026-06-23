# Reset para ambiente limpo — Plano de Execução (Evolution @ Railway)

> **For agentic workers:** Este é um runbook operacional sobre **produção**, não um plano de código com TDD. Execução **inline com checkpoints** (NÃO subagentes): cada task é destrutiva/irreversível e o passo do QR exige interação humana. Steps usam checkbox (`- [ ]`).

**Goal:** Zerar dados/sessões da Evolution API em produção, regenerar a API key e entregar um arquivo de credenciais, mantendo infra/config/versão.

**Architecture:** Conecta aos bancos via TCP proxy público do Railway (`DATABASE_PUBLIC_URL`, `REDIS_PUBLIC_URL`). Limpa Redis (`FLUSHALL`) e dropa o schema `public` do Postgres. O redeploy do serviço `evolution-api` recria o schema limpo no boot (`ENTRYPOINT` roda `deploy_database.sh` → `prisma migrate deploy`).

**Tech Stack:** Railway CLI 4.40 (project token), `psql`, `redis-cli`, `curl`, `openssl`.

## Global Constraints

- **Projeto Railway:** `d7f1036e-5a26-4490-8622-26ace6896e4d`, env `production`. Token via `export RAILWAY_TOKEN=103f4091-db8e-4606-8eea-091a5afbd05b` em toda chamada `railway`.
- **API URL pública:** `https://evolution-api-production-ff74.up.railway.app`
- **NUNCA imprimir segredos no terminal** (URLs com senha, API key). Sempre capturar em variável de shell e usar por referência. Conferir valores só via mascaramento.
- **Sem backup** — descarte total, por decisão do usuário.
- **Operação irreversível em produção.** Confirmar com o usuário no checkpoint antes da primeira escrita destrutiva.

---

### Task 1: Capturar credenciais e validar conectividade

**Files:** nenhum (sessão de shell).

**Interfaces:**
- Produces: variáveis de shell `PGURL` (DATABASE_PUBLIC_URL), `RURL` (REDIS_PUBLIC_URL), `APIURL`, exportadas no shell de execução.

- [ ] **Step 1: Exportar token e capturar URLs públicas (sem imprimir valores)**

```bash
cd /Users/eduardocosta/Projetos/Git-PESSOAL/evolution-api
export RAILWAY_TOKEN=103f4091-db8e-4606-8eea-091a5afbd05b
export PGURL=$(railway variables --service Postgres --kv 2>/dev/null | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
export RURL=$(railway variables --service Redis --kv 2>/dev/null | grep '^REDIS_PUBLIC_URL=' | cut -d= -f2-)
export APIURL=https://evolution-api-production-ff74.up.railway.app
echo "PGURL set: ${PGURL:+yes}  RURL set: ${RURL:+yes}"
```

Expected: `PGURL set: yes  RURL set: yes`

- [ ] **Step 2: Validar conectividade Postgres (read-only, sem alterar nada)**

```bash
psql "$PGURL" -tAc "select count(*) from information_schema.tables where table_schema='public';"
```

Expected: um número (qtd de tabelas atuais, p.ex. `20`+). Se erro de conexão → revisar proxy/URL antes de prosseguir.

- [ ] **Step 3: Validar conectividade Redis (read-only)**

```bash
redis-cli -u "$RURL" DBSIZE
```

Expected: `(integer) N` (número de chaves atuais). Se erro → revisar URL antes de prosseguir.

---

### Task 2: CHECKPOINT — confirmar reset destrutivo

- [ ] **Step 1: Apresentar ao usuário o estado atual e pedir GO**

Mostrar: nº de tabelas no Postgres e nº de chaves no Redis (de Task 1). Confirmar explicitamente:
> "Vou apagar TUDO: schema do Postgres + todas as chaves do Redis, e regenerar a API key. Sem backup. Confirma?"

Aguardar confirmação do usuário antes da Task 3. **Não prosseguir sem GO.**

---

### Task 3: Limpar Redis

**Interfaces:** Consumes `RURL`.

- [ ] **Step 1: FLUSHALL**

```bash
redis-cli -u "$RURL" FLUSHALL
```

Expected: `OK`

- [ ] **Step 2: Verificar vazio**

```bash
redis-cli -u "$RURL" DBSIZE
```

Expected: `(integer) 0`

---

### Task 4: Resetar Postgres (drop schema)

**Interfaces:** Consumes `PGURL`.

- [ ] **Step 1: Dropar e recriar o schema public**

```bash
psql "$PGURL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
```

Expected: `DROP SCHEMA` seguido de `CREATE SCHEMA`.

- [ ] **Step 2: Verificar schema vazio**

```bash
psql "$PGURL" -tAc "select count(*) from information_schema.tables where table_schema='public';"
```

Expected: `0`

> O schema será recriado no boot do app (Task 6), via `prisma migrate deploy` no ENTRYPOINT.

---

### Task 5: Regenerar a API key

**Interfaces:** Produces `NEWKEY` (variável de shell).

- [ ] **Step 1: Gerar key forte (não imprimir)**

```bash
export NEWKEY=$(openssl rand -hex 32)
echo "NEWKEY length: ${#NEWKEY}"
```

Expected: `NEWKEY length: 64`

- [ ] **Step 2: Aplicar no serviço evolution-api**

```bash
railway variables --service evolution-api --set "AUTHENTICATION_API_KEY=$NEWKEY" 2>&1 | tail -3
```

Expected: confirmação de variável atualizada. Isso normalmente **dispara um redeploy** automático.

---

### Task 6: Redeploy e validar boot limpo

**Interfaces:** Consumes `NEWKEY`, `APIURL`.

- [ ] **Step 1: Garantir redeploy (caso o set não tenha disparado)**

```bash
railway redeploy --service evolution-api -y 2>&1 | tail -5
```

Expected: redeploy iniciado. (Se a CLI exigir confirmação interativa e o `-y` não bastar, disparar redeploy pelo dashboard.)

- [ ] **Step 2: Aguardar o serviço subir e o schema ser recriado**

Aguardar ~60–120s. Então:

```bash
export RAILWAY_TOKEN=103f4091-db8e-4606-8eea-091a5afbd05b
psql "$PGURL" -tAc "select count(*) from information_schema.tables where table_schema='public';"
```

Expected: número > 0 (tabelas recriadas pelas migrations). Se ainda `0`, aguardar mais e repetir.

- [ ] **Step 3: API responde e está vazia (nova key funciona)**

```bash
curl -s -H "apikey: $NEWKEY" "$APIURL/instance/fetchInstances"
```

Expected: `[]` (lista vazia).

- [ ] **Step 4: Key antiga é rejeitada (confirma rotação)**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: CHAVE_ANTIGA_QUALQUER" "$APIURL/instance/fetchInstances"
```

Expected: `401` (ou `403`) — só a nova key autentica.

---

### Task 7: Teste ponta-a-ponta (instância + QR) — CHECKPOINT

**Interfaces:** Consumes `NEWKEY`, `APIURL`.

- [ ] **Step 1: Criar instância de teste**

```bash
curl -s -H "apikey: $NEWKEY" -H "Content-Type: application/json" \
  -d '{"instanceName":"teste-reset","integration":"WHATSAPP-BAILEYS","qrcode":true}' \
  "$APIURL/instance/create"
```

Expected: JSON com a instância criada e um campo `qrcode`/`base64` com o QR.

- [ ] **Step 2: Entregar o QR ao usuário e aguardar scan**

Renderizar/entregar o QR (base64) para o usuário escanear no WhatsApp. **Checkpoint:** aguardar o usuário confirmar que escaneou.

- [ ] **Step 3: Confirmar conexão**

```bash
curl -s -H "apikey: $NEWKEY" "$APIURL/instance/connectionState/teste-reset"
```

Expected: `state: "open"`.

- [ ] **Step 4: (Opcional) remover instância de teste**

```bash
curl -s -X DELETE -H "apikey: $NEWKEY" "$APIURL/instance/logout/teste-reset"; \
curl -s -X DELETE -H "apikey: $NEWKEY" "$APIURL/instance/delete/teste-reset"
```

Expected: confirmações de logout/delete. (Manter a instância se o usuário quiser usá-la.)

---

### Task 8: Gerar arquivo de credenciais

**Files:**
- Create: `evolution-connection.env` (raiz — coberto por `*.env` no `.gitignore`, fora do git).

- [ ] **Step 1: Confirmar que o caminho está gitignored**

```bash
cd /Users/eduardocosta/Projetos/Git-PESSOAL/evolution-api
git check-ignore evolution-connection.env
```

Expected: `evolution-connection.env` (= está ignorado).

- [ ] **Step 2: Escrever o arquivo de credenciais**

```bash
cat > evolution-connection.env <<EOF
# Evolution API — credenciais de conexão para sistemas externos
# Gerado em 2026-06-23. NÃO commitar (arquivo .env é gitignored).

EVOLUTION_API_URL=$APIURL
EVOLUTION_API_KEY=$NEWKEY

# Exemplo de uso:
#   curl -H "apikey: \$EVOLUTION_API_KEY" \$EVOLUTION_API_URL/instance/fetchInstances
EOF
echo "arquivo criado: $(ls -la evolution-connection.env | awk '{print $NF}')"
```

Expected: `arquivo criado: evolution-connection.env`

- [ ] **Step 3: Conferir conteúdo (a key aparece aqui — é o destino pretendido, arquivo local seguro)**

```bash
cat evolution-connection.env
```

Expected: arquivo com `EVOLUTION_API_URL` e `EVOLUTION_API_KEY` preenchidos.

---

### Task 9: Resumo final

- [ ] **Step 1: Reportar ao usuário**

- Redis e Postgres zerados; schema recriado limpo no redeploy.
- API key rotacionada (antiga inválida).
- `fetchInstances` vazio; instância de teste conectou via QR (se executada).
- Credenciais em `evolution-connection.env` (fora do git).
- Lembrar: qualquer sistema integrado precisa atualizar para a **nova** API key.

## Self-Review (cobertura do spec)

- Zerar Postgres → Task 4 ✓
- Zerar Redis → Task 3 ✓
- Regenerar API key → Task 5 ✓
- Redeploy/boot limpo → Task 6 ✓
- Validação ponta-a-ponta (QR) → Task 7 ✓
- Arquivo de credenciais (gitignored) → Task 8 ✓
- Sem backup, irreversível, checkpoint de confirmação → Task 2 ✓
- Acesso via proxy público (não interno) → Task 1 ✓
