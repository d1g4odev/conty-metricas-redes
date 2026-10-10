# metricas-redes

Serviço que recebe uma conexão de rede social já autorizada (token fake), sincroniza métricas diárias de posts a partir de um provedor simulado e expõe os totais por API. Sobrevive a timeout, respostas duplicadas e rate limit; janelas sobrepostas nunca contam em dobro.

Stack: Node 20+, TypeScript estrito, Fastify, Zod, Vitest. Armazenamento em memória.

## Como rodar

```bash
npm install
npm test            # 52 testes
npm run typecheck
npm run dev         # http://localhost:3000, com a conta demo acct_demo / fake-token-demo
```

## API

| Método | Rota | O que faz |
| --- | --- | --- |
| `POST` | `/connections` | registra uma conexão já autorizada |
| `GET` | `/connections/:id` | estado da conexão (token nunca é devolvido) |
| `POST` | `/connections/:id/syncs` | sincroniza a janela `{from, to}` (inclusiva, máx. 92 dias, não futura) |
| `GET` | `/connections/:id/syncs` | histórico de execuções |
| `GET` | `/connections/:id/metrics?from&to` | totais por post e por dia, com `fetchedAt` |
| `POST` | `/_simulator/faults` | só com o provedor simulado: enfileira falhas para as próximas chamadas |
| `POST` | `/_simulator/revisions` | só com o provedor simulado: revisa o valor de um post/dia |
| `GET` | `/_simulator/calls` | só com o provedor simulado: log das chamadas recebidas |

### Exemplos

```http
POST /connections
{"platform":"instagram","accountId":"acct_demo","accessToken":"fake-token-demo"}

201
{"id":"041d…","platform":"instagram","accountId":"acct_demo","status":"active",
 "createdAt":"2026-10-10T06:37:58.057Z","rateLimitedUntil":null,"lastSyncedAt":null,"tokenHint":"…demo"}
```

```http
POST /connections/041d…/syncs
{"from":"2026-10-03","to":"2026-10-10"}

200   (com faults 429 Retry-After 2s + timeout injetados antes)
{"id":"3538…","connectionId":"041d…","window":{"from":"2026-10-03","to":"2026-10-10"},"status":"succeeded",
 "startedAt":"2026-10-10T06:38:53.040Z","finishedAt":"2026-10-10T06:38:58.052Z",
 "providerCalls":4,"pages":2,"waitedMs":3000,
 "waits":[{"reason":"rate_limited","ms":2000},{"reason":"timeout","ms":1000}],
 "stats":{"received":20,"inserted":20,"updated":0,"unchanged":0,"stale":0,"duplicates":0,"rejected":0,"replayedPages":0},
 "retryAt":null,"error":null}
```

Códigos de `POST /syncs`: `200` sucesso; `202` + `Retry-After` quando o provedor pediu uma espera acima do teto (a execução fica `rate_limited` com `retryAt`); `502` quando o provedor falhou de vez (`error` diz o motivo: `timeout_attempts_exhausted`, `unauthorized`…); `429` + `Retry-After` se a conexão ainda está dentro de um `Retry-After` anterior; `409` para sync em andamento ou conexão que precisa reautorizar; `400` para entrada inválida.

```http
GET /connections/041d…/metrics?from=2026-10-03&to=2026-10-10   (depois de um segundo sync em 10-08..10-10)

200
{"connectionId":"041d…","window":{"from":"2026-10-03","to":"2026-10-10"},
 "totals":{"views":41435,"likes":3474,"comments":449,"shares":213},
 "lastFetchedAt":"2026-10-10T06:38:58.067Z",
 "posts":[{"postId":"post_a","totals":{"views":6841,"likes":583,"comments":85,"shares":36},
   "lastFetchedAt":"2026-10-10T06:38:58.067Z",
   "days":[{"date":"2026-10-03","views":848,"likes":93,"comments":11,"shares":5,
            "fetchedAt":"2026-10-10T06:38:58.050Z","firstFetchedAt":"2026-10-10T06:38:58.050Z",
            "providerUpdatedAt":"2026-10-03T00:00:00.000Z"},
           …,
           {"date":"2026-10-10","views":696,"likes":41,"comments":7,"shares":5,
            "fetchedAt":"2026-10-10T06:38:58.067Z","firstFetchedAt":"2026-10-10T06:38:58.051Z",
            "providerUpdatedAt":"2026-10-10T00:00:00.000Z"}]}, …]}
```

Os totais são os mesmos antes e depois do segundo sync sobreposto.

Simulando falhas manualmente:

```http
POST /_simulator/faults
{"faults":[{"kind":"rate_limit","retryAfter":"2"},{"kind":"timeout"},{"kind":"ok"},{"kind":"duplicate_page"}]}
```

Tipos: `ok`, `rate_limit` (com `retryAfter` em segundos, data HTTP ou ausente), `timeout` (a requisição fica pendurada até ser abortada), `server_error`, `duplicate_page` (devolve de novo a última resposta 200), `duplicate_items`, `malformed_row`, `unauthorized`.

## Decisões

- **Fronteira provedor x regra de negócio.** `src/domain` não sabe nada de HTTP nem do simulador: define a porta `MetricsProvider` e erros de domínio (`ProviderRateLimitedError`, `ProviderAuthError`…). `src/provider/platform-metrics-provider.ts` é o adapter que traduz status/headers/payload snake_case em linhas e erros de domínio; `src/provider/simulated-platform-api.ts` é só o "servidor" fake (transporte HTTP-like com dados determinísticos e injeção de falhas). Trocar por uma plataforma real é implementar `PlatformTransport` (ou `MetricsProvider`) — as rotas `/_simulator` nem são registradas nesse caso.
- **Sem dupla contagem.** A unidade armazenada é a métrica diária de um post, chave `(conexão, post, dia)`. Upsert substitui, nunca soma; totais são sempre calculados na leitura. Janelas sobrepostas, re-sync da mesma janela, itens repetidos e páginas repetidas convergem para o mesmo estado.
- **Respostas duplicadas/fora de ordem.** Itens repetidos são contados em `duplicates` e gravados uma vez. Uma página repetida (o `next_cursor` aponta para algo já processado) não é ingerida e a página é pedida de novo com backoff. Cada linha carrega `updated_time` do provedor; uma versão mais antiga que a gravada é ignorada (`stale`).
- **Quando foi buscada.** Cada linha guarda `fetchedAt` (última vez que o serviço confirmou o valor), `firstFetchedAt`, `providerUpdatedAt` e o `syncRunId`. O relatório expõe `lastFetchedAt` por post e geral.
- **429.** `Retry-After` em segundos ou data HTTP é respeitado à risca: a próxima chamada só acontece em `agora + Retry-After`. Se a espera pedida passa do teto (`maxRetryAfterMs`, padrão 60s) ou do orçamento total de espera da execução (`maxTotalWaitMs`, 120s), o serviço não dorme: encerra como `rate_limited`, grava `retryAt` na conexão e recusa novos syncs (429) até lá. Sem header válido, usa backoff exponencial com teto. Tentativas por página limitadas (`maxAttempts`, padrão 4, compartilhadas entre 429 e falhas transitórias da mesma página).
- **Timeout.** Cada chamada tem timeout (`requestTimeoutMs`, padrão 10s) com `AbortSignal`; o timer é cancelado quando a resposta chega. Timeout, 5xx/408, payload inválido e página repetida são transitórios; 401/403 e outros 4xx não são re-tentados (401/403 marcam a conexão como `reauthorization_required`).
- **Relógio controlável.** Todo tempo passa por `Clock` (`now`, `sleep` abortável). Os testes usam `FakeClock`, que avança só até o próximo timer — dá para afirmar o instante exato de cada chamada ao provedor sem esperar de verdade.
- **Falha parcial.** Páginas já processadas ficam gravadas; como o upsert é idempotente, rodar o sync de novo completa o que faltou sem contar em dobro.
- **Concorrência.** Um sync por conexão por vez (409). Mesmo que dois rodassem, o upsert manteria o resultado correto.

## Testes

`test/sync.test.ts` (idempotência, janelas sobrepostas, duplicatas, página repetida, falha parcial, `fetchedAt`, 429 com relógio controlado: espera exata, data HTTP, teto, bloqueio até `retryAt`, limite de tentativas, backoff sem header, orçamento de espera; timeout, 5xx, 401), `test/retry.test.ts`, `test/stores.test.ts`, `test/platform-metrics-provider.test.ts` e `test/api.test.ts` (via `fastify.inject`).

## O que ficou de fora

- Persistência real (Postgres com `UNIQUE (connection_id, post_id, date)` e `ON CONFLICT`) — hoje é tudo em memória e some ao reiniciar.
- O lock de sync é por processo; com várias instâncias precisaria de lock no banco/fila.
- Sync é síncrono na requisição; em produção seria um job em fila com agendamento a partir de `retryAt`.
- Sem jitter no backoff (determinístico de propósito para os testes).
- Sem OAuth/refresh de token, sem criptografia do token em repouso, sem autenticação da própria API.
- Métricas só diárias por post (views, likes, comments, shares); sem métricas de conta nem séries intradiárias.

## Uso de IA

Código gerado com assistência de IA (Claude Code). O que a IA fez:

- desenho da arquitetura (domínio, porta do provedor, adapter, provedor simulado, API);
- implementação do serviço de sync, política de retry/429/timeout, store idempotente e rotas HTTP;
- provedor simulado com injeção de falhas e `FakeClock`;
- testes (incluindo uma checagem por mutação de que os testes de dupla contagem falham se o upsert somar);
- este README.

Revisao humana: [Rodrigo completa]
