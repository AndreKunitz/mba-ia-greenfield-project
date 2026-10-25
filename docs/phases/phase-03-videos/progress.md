# phase-03-videos — Progress

**Status:** completed
**SIs:** 11/11 completed

### SI-03.1 — Dependências, namespaces de configuração e variáveis de ambiente
- **Status:** completed
- **Tests:** 13/13 passing (env.validation.integration-spec.ts: 9 novos + 4 existentes); e2e app.e2e-spec.ts `GET /` 1/1 passing; `tsc --noEmit` exit 0
- **Observations:**
  - `npm install` reportou 43 vulnerabilidades no `npm audit` do projeto inteiro; nenhuma foi tratada (fora do escopo do SI).
  - Variáveis novas também no `.env` local (não versionado), necessário para a aplicação e os testes subirem; o `.env.example` versionado traz os mesmos valores.
  - Mantidos os 2 erros de lint do teste antigo de `SWAGGER_ENABLED` em `env.validation.integration-spec.ts` (passivo anterior à fase); o código novo do SI passa no eslint e no prettier.
  - `.env.example` ainda tem `MAIL_FROM` sem aspas externas (problema anterior à fase, não alterado).
  - Testes rodados diretamente no container (saída curta filtrada), sem subagente.

### SI-03.2 — Infra: storage S3, Redis e worker no Compose
- **Status:** completed
- **Tests:** no tests (Infra); critérios verificados manualmente: 6 serviços `running`, `ListBuckets` autenticado via SDK no endpoint interno (credencial errada recusada com 403), `redis-cli ping` = PONG, `ffprobe`/`ffmpeg` 5.1.9 em `nestjs-api` e `video-worker`; e2e `GET /` 1/1 passing após reconstruir a imagem
- **Observations:**
  - SeaweedFS 4.50 (imagem `chrislusf/seaweedfs:latest`, arm64 nativo): S3 na porta 8333, credenciais geradas em `/tmp/s3.json` a partir de `S3_ACCESS_KEY`/`S3_SECRET_KEY` no startup (as chaves ficam só no `.env`), `-s3.allowedOrigins` aplica o CORS global. O CORS por bucket com `ExposeHeaders: ETag` é aplicado no SI-03.3 (`ensureBucket`) e ainda precisa ser provado.
  - Healthcheck do storage é `curl -s -o /dev/null http://localhost:8333` (sai 0 com qualquer resposta HTTP, inclusive 403); `nc -z` não funciona nessa imagem.
  - Tag `latest` não fixada: recomendável fixar a versão antes de produção (follow-up, fora do escopo).
  - `video-worker` sobe ocioso (comando padrão da imagem); o comando real entra no SI-03.7.
  - Os serviços `nestjs-api` e `video-worker` leem `S3_*`/`REDIS_*` do `.env` montado no volume do código (o `ConfigModule` o carrega), sem `environment:` no compose; só o `storage` recebe as chaves por interpolação do `.env`.
  - O Redis não publica porta no host (só a rede do Compose precisa dele).
  - Parte da verificação foi feita com um container de teste do SeaweedFS, removido em seguida.

### SI-03.3 — Módulo de storage com clientes S3 interno e público
- **Status:** completed
- **Tests:** 21/21 passing (storage.service.integration-spec.ts: 11 contra o SeaweedFS real; storage.service.spec.ts: 9; storage.module.spec.ts: 1); `tsc --noEmit` exit 0; eslint e prettier sem apontamentos nos arquivos do SI
- **Observations:**
  - Condições do `TD-02` provadas com o SeaweedFS real: multipart com URLs pré-assinadas, `Range` com 206, `Content-Disposition` na URL assinada, CORS por bucket com `ExposeHeaders: ETag` e `ETag` exposto numa requisição cross-origin de verdade. Não é preciso trocar para o RustFS.
  - Controle feito à mão: sem `Origin` a resposta não traz cabeçalhos de CORS; com `Origin` vêm `Access-Control-Expose-Headers: ETag` e `Allow-Methods: PUT, GET, HEAD`. O teste discrimina.
  - Os clientes S3 usam `requestChecksumCalculation`/`responseChecksumValidation` = `WHEN_REQUIRED`, para o SDK recente não assinar cabeçalhos de checksum que servidores não-AWS podem recusar.
  - Com `S3_CORS_ALLOWED_ORIGINS=*` (padrão de dev) o storage aceita qualquer origem (inclusive devolve `Access-Control-Allow-Credentials: true`). Em produção a variável deve listar só o domínio do frontend (follow-up de configuração, fora do escopo).
  - Erros 4xx do S3 propagam intactos (o chamador decide: `NoSuchUpload`, `InvalidPart`, `NotFound`); só rede e 5xx viram `STORAGE_UNAVAILABLE`.
  - `StorageModule` faz `ensureBucket()` no `onModuleInit`; a API/worker falham no boot se o storage estiver fora (fail-fast). `Test...compile()` não dispara o `onModuleInit`, então o teste de compilação não depende do storage.
  - Nos testes de integração `S3_PUBLIC_ENDPOINT` é igualado a `S3_ENDPOINT` (o container não alcança `localhost:8333`); a escolha de host público vs interno é coberta no teste unitário.
  - Teste de integração limpa os objetos que cria; usa o bucket real de desenvolvimento sob o prefixo `integration-tests/<uuid>/`.

### SI-03.4 — Entidade Video, migration, exceções de domínio e identificador público
- **Status:** completed
- **Tests:** video.entity.integration-spec 8/8, public-id.util.spec 4/4, migrations.integration-spec 2/2 (reescrita para 3 migrations), channels.service.integration-spec com `findByUserId` +2; suíte unit+integração completa 188/188 em 5 execuções seguidas; e2e 52/52; `tsc --noEmit` exit 0; prettier e eslint sem apontamentos nos arquivos do SI
- **Observations:**
  - Migration `CreateVideos1792957546676` gerada pela CLI, formatada com prettier (como as anteriores) e aplicada ao banco de dev; SQL confere com o Data Model do plano.
  - **Desvio do plano:** criei já um `VideosModule` mínimo (só `TypeOrmModule.forFeature([Video])`) e o importei no `AppModule`. `Channel` agora referencia `Video`; sem a entidade registrada em algum módulo a aplicação não sobe, e a regra do projeto manda registrar a entidade ao criá-la. O SI-03.5 completa o módulo (controller, service, DTOs).
  - Efeito colateral necessário: os 10 specs que montam `DataSource` de teste com `ALL_ENTITIES` passaram a incluir `Video` (a relação bidirecional exige). Não refatorei a lista duplicada para uma constante compartilhada (fora do escopo). `cleanAllTables` agora apaga `videos` antes de `channels` (FK).
  - **Instabilidade encontrada e corrigida:** a spec de migrations dropava tabelas com `Promise.all` (`DROP TABLE ... CASCADE` concorrentes sobre tabelas com FK) e dava `deadlock detected` com frequência após a tabela `videos`; um drop abortado deixava tabelas/enums e gerava `type ... already exists`. Passou a dropar em sequência e a dropar também os enums. Esse problema já existia em estado latente (apareceu na linha de base como `verification_tokens_type_enum already exists`).
  - `size_bytes` (bigint) e `duration_seconds` (numeric) usam transformer para voltar como `number` (o driver devolve string); 10 GiB cabe com folga em `Number`.
  - `ChannelsService.findByUserId` usa `dataSource.getRepository(Channel)`, sem novo parâmetro de construtor, para não quebrar os testes existentes do serviço.
  - Lint: restam só os 7 erros antigos (6 em `channels.service.ts`, 1 em `create-test-data-source.ts`), em código que não escrevi.
  - As 6 exceções de domínio novas (`VIDEO_NOT_FOUND` etc.) não têm teste próprio neste SI; são exercitadas pelos e2e dos SIs 03.5, 03.6 e 03.8.

### SI-03.5 — Upload: pré-cadastro, estado e URLs assinadas
- **Status:** completed
- **Tests:** videos.service.spec 17/17, videos.module.spec 1/1, videos.service.integration-spec 4/4 (banco e storage reais), videos-upload.e2e-spec 12/12; suíte unit+integração completa 210/210; e2e completo 64/64 em 3 execuções seguidas; `tsc --noEmit` exit 0; eslint e prettier sem apontamentos nos arquivos do SI
- **Observations:**
  - **Correção fora da lista do SI, necessária para a Definição de Pronto:** o script `test:e2e` do `package.json` não tinha `--runInBand`, embora o `CLAUDE.md` do backend diga que está configurado. Com 4 suítes e2e compartilhando um banco, a execução paralela falhava com `violates foreign key constraint` (uma suíte apagava usuários que outra usava); em série passou 3/3. Adicionei `--runInBand` ao script (1 linha).
  - Criei `src/common/database/unique-violation.util.ts` (detecta violação de unicidade por coluna) e `InvalidUploadPartsException` (código `VALIDATION_ERROR`, 400) para número de parte fora de `1..part_count`, que só o serviço sabe validar e serviços não lançam exceções HTTP do Nest. `ChannelsService` tem função privada parecida; não a refatorei (fora do escopo, possível follow-up).
  - O tamanho da parte cresce sozinho se `size_bytes / part_size` passaria de 10.000 partes (limite do S3), em vez de falhar.
  - Se o `INSERT` do rascunho falha por outro motivo ou esgota as 5 tentativas de `public_id`, o multipart é abortado em *best effort* (falha do abort só é logada, o erro original sobe). Um multipart órfão nesse caso não tem linha no banco e a reconciliação do SI-03.9 não o enxerga.
  - A extensão do arquivo só é checada contra o tipo para os 4 tipos conhecidos (`CONTENT_TYPE_EXTENSIONS`); um tipo liberado por configuração fora dessa tabela pula a checagem.
  - **Risco encontrado, ainda não provado em teste:** o `ThrottlerGuard` é registrado como `APP_GUARD` (global) no `AuthModule` com limite de 10 requisições por minuto por IP. Por leitura do código, isso vale também para `/videos`, inclusive para as rotas públicas de streaming do SI-03.8. Os testes deste SI limpam o armazenamento do throttler a cada teste. Tratar no SI-03.8 (ex.: `@SkipThrottle()` nas rotas de leitura públicas) depois de confirmar com teste.
  - `VideosModule` agora tem controller e service; exporta `TypeOrmModule` e `VideosService`. A conexão global do BullMQ ainda não foi adicionada ao `AppModule` (entra no SI-03.6).
  - Tipo do MIME/extensão e `title` provisório seguem o plano: `title` = `filename`; `storage_key` = `videos/{id}/source{ext}`.

### SI-03.6 — Finalizar o upload e enfileirar o processamento
- **Status:** completed
- **Tests:** videos.service.spec +11 (completeUpload), video-queue.producer.spec 3/3, videos-complete.integration-spec 4/4 (banco, storage e Redis reais), videos-complete.e2e-spec 5/5; suíte unit+integração completa 228/228; e2e completo 69/69; `tsc --noEmit` exit 0; eslint e prettier sem apontamentos
- **Observations:**
  - **Conflito do plano com a realidade, resolvido:** `@nestjs/bullmq@12.0.0` (fixado no `library-refs.md` e no SI-03.1) é só ESM e o Jest CommonJS do projeto não o carrega (`Unexpected token 'export'`). Troquei para `@nestjs/bullmq@^11.0.5` + `bullmq@^5.81.5` (CommonJS, peer `bullmq` ^3–^5, compatível com NestJS 11). `library-refs.md` e o texto do SI-03.1 no plano foram atualizados; isso torna o `sources_mtime` do plano mais antigo que o `library-refs.md` (relevante só se `/plan-build` for rodado de novo).
  - **Prova real do critério de Redis indisponível:** com o container `redis` parado, `POST /videos/:id/complete` respondeu 202 em ~3 s e o vídeo ficou em `processing` no banco (teste temporário, removido). O BullMQ não falha quando o Redis cai: ele espera; por isso o produtor tem timeout de 3 s (`ENQUEUE_TIMEOUT_MS`) e o serviço só registra o aviso. A recuperação desses vídeos depende do SI-03.9.
  - `completeUpload` valida as partes antes de chamar o storage (precisa listar exatamente 1..part_count), traduz qualquer 4xx do storage em `UPLOAD_INCOMPLETE`, confere `headObject` e faz a transição com `UPDATE ... WHERE status = 'draft'` (duas chamadas concorrentes só transicionam uma vez).
  - Divergência de tamanho: grava `error`/`upload_size_mismatch` antes de apagar o objeto (a limpeza do objeto é best effort, só logada), e devolve 422.
  - Criei `src/storage/storage.errors.ts` (`isStorageClientError`) e passei o `StorageService` a usá-lo, em vez de duplicar a leitura do status HTTP.
  - A conexão BullMQ (`BullModule.forRootAsync`) ficou no `AppModule`; o registro da fila e o produtor, no `VideosModule`. Helper de teste `src/test/bull-root-module.ts` evita repetir a conexão nas specs.
  - Os testes de integração/e2e limpam a fila (`obliterate`) antes de cada teste; não usam o worker (que só chega no SI-03.7).

### SI-03.7 — Worker de vídeo: metadados, thumbnail e ciclo de status
- **Status:** completed
- **Tests:** media-probe.service.integration-spec 5/5 (ffprobe real), thumbnail.service.integration-spec 4/4 (ffmpeg real), video.processor.integration-spec 13 (banco, storage, ffmpeg e Worker BullMQ reais), worker.module.spec 1/1 = 23/23; suíte unit+integração completa 251/251; e2e completo 69/69; `tsc --noEmit` exit 0; eslint e prettier sem apontamentos
- **Observations:**
  - **Prova no container real:** um teste temporário (removido) levou um vídeo de `processing` a `ready` pelo container `video-worker` em ~310 ms, com duração, 2 streams nos metadados e thumbnail gravada.
  - **Isolamento dos testes:** como o container consome a fila de verdade, os testes que enfileiram usam um prefixo próprio (`bull-test`, helper `bullRootForTests` e `QUEUE_PREFIX` no e2e); o worker usa `QUEUE_PREFIX=bull` (padrão, nova variável em Joi/`queue.config`/`.env.example`). Sem isso o worker roubaria os jobs dos testes do SI-03.6.
  - **Desligamento gracioso:** com `npm run` como processo principal o container saía com código 1 (o `npm` cai com o sinal); com o Node direto (`node -r ts-node/register -r tsconfig-paths/register src/worker.ts` no compose) sai com 0, então `enableShutdownHooks()` + BullMQ fecham limpo. O script `start:worker` do `package.json` continua para uso manual.
  - **Classificação de falha:** `ffprobe` com "Invalid data found" / "moov atom not found", ou sem stream de vídeo, é mídia inválida: grava `error`/`invalid_media` e lança `UnrecoverableError` (1 tentativa, sem retry). Qualquer outra falha (404 do storage, rede, timeout) é transitória e usa as tentativas da fila; esgotadas, o handler `failed` grava `processing_failed` por UPDATE condicional (não sobrescreve `invalid_media`). Provado com Worker BullMQ real: retry com backoff até `ready`, esgotamento e não-retry.
  - **Segurança de log:** a mensagem de erro do ffprobe/ffmpeg incluiria a URL assinada do storage (com a assinatura na query); `describeToolFailure` troca qualquer URL por `<url>`, coberto por teste.
  - O `WorkerModule` lista `entities: [User, Channel, Video]` explicitamente: `Video` referencia `Channel`, que referencia `User`, e o worker não tem módulos HTTP que os registrem.
  - O instante do frame é 10% da duração (escolha de implementação, constante `THUMBNAIL_POSITION`), com largura máxima de 1280 px.
  - Unitário do `VideoProcessor.process` roda direto (sem o worker do BullMQ) nos casos de regra; só os 3 cenários de fila usam o Worker real. O job `reconcile-videos` ainda não existe: `process()` rejeita nomes desconhecidos como `UnrecoverableError`; o SI-03.9 acrescenta o ramo.
  - `describeToolFailure`/`InvalidMediaError` em `media.errors.ts`; helper de fixtures reais (`generateTestVideo`/`generateTestAudio`) em `src/test/media-fixtures.ts` (usam o `ffmpeg` da própria imagem).

### SI-03.8 — Leitura: metadados, status, streaming, download e thumbnail
- **Status:** completed
- **Tests:** public-id.pipe.spec 11/11, content-disposition.util.spec 8/8, videos-read.integration-spec 11/11 (banco e storage reais), videos-read.e2e-spec 15/15, +1 no videos-upload.e2e (rate limit do upload continua); suíte unit+integração completa 275/275; e2e completo 85/85 em 3 execuções seguidas; `tsc --noEmit` exit 0; eslint e prettier sem apontamentos no código do SI
- **Observations:**
  - **Risco do SI-03.5 confirmado em teste e corrigido:** o `ThrottlerGuard` global (10 req/min por IP) também valia para `/videos`. Os testes "não limita 15 requisições seguidas de streaming / de consulta de status" falharam (vermelho) antes da correção; depois de `@SkipThrottle()` nas 5 rotas de leitura (status, metadados, stream, download, thumbnail) passaram. As rotas de upload (criar, assinar, finalizar) seguem limitadas, e um teste prova isso (11ª criação de rascunho recebe 429).
  - Streaming, download e thumbnail são `302` com `Cache-Control: no-store` para URL assinada com o endpoint público; o storage atende `Range` (prova: `206` com `Content-Range: bytes 0-99/1000` e corpo igual aos bytes pedidos). A API não toca nos bytes do vídeo.
  - `PublicIdPipe` aplicado a todas as rotas com `:publicId`, inclusive as de upload do SI-03.5; id malformado responde 404 `VIDEO_NOT_FOUND`, igual a um id desconhecido.
  - `buildContentDisposition` usa `filename` ASCII + `filename*=UTF-8''` (RFC 6266/5987), tira diretórios (barra e barra invertida), caracteres de controle e aspas, e limita a 255 caracteres. Teste cobre injeção de cabeçalho.
  - `duration_seconds` ficou nulável no DTO público (o `ffprobe` pode não informar). O endpoint de status do dono devolve `error_reason` e vale para qualquer estado.
  - Um teste meu errou a expectativa (barra invertida é separador de diretório e o nome vira o último trecho); corrigi o teste, não o código.
  - Lint: 1 erro do código antigo permanece em `create-test-data-source.ts` (já registrado); o `no-control-regex` do meu utilitário foi trocado por um filtro por código de caractere.

### SI-03.9 — Reconciliação de jobs presos e uploads abandonados
- **Status:** completed
- **Tests:** video-reconciliation.service.spec 7/7, video-reconciliation.service.integration-spec 5/5 (banco, Redis e storage reais), reconciliation.scheduler.integration-spec 1/1, video-queue.producer.spec +7 (`reenqueueProcessing`), video.processor.integration-spec +1 (despacho de `reconcile-videos`), worker.module.spec atualizado; suíte unit+integração 295/295; e2e 85/85; `tsc --noEmit` exit 0; eslint e prettier sem apontamentos em `src/videos` e `src/worker`
- **Observations:**
  - **Prova real:** ao reiniciar o container `video-worker`, o log mostra `Reconciliation scheduled every 300000 ms` e o Redis contém `bull:video-processing:repeat:reconcile-videos-schedule`.
  - O BullMQ ignora `add()` com `jobId` existente enquanto um job concluído/falho está retido (confirmado em sonda); por isso `reenqueueProcessing` remove jobs `completed`/`failed` antes de reenfileirar e deixa em paz jobs em andamento (`waiting`/`active`/`delayed`).
  - Reconciliação em lote de até 100 vídeos por rodada (`RECONCILE_BATCH_SIZE`); falha em um vídeo é logada e o próximo segue (contexto de background, único lugar onde engolir erro é permitido).
  - Draft abandonado: 4xx do storage (ex.: `NoSuchUpload`) é tratado como multipart já inexistente e o vídeo vai a `error`/`upload_abandoned`; erro não-4xx deixa o draft para a próxima rodada.
  - Num teste meu a chave do multipart diferia do `storage_key` salvo e o teste passava pelo motivo errado; corrigido antes de fechar o SI.
  - Multipart órfão sem linha no banco (falha do INSERT do rascunho, SI-03.2) continua fora do alcance da reconciliação; fica como follow-up (política de lifecycle do bucket).

### SI-03.10 — Fluxo completo e prova de que a API não segura o upload
- **Status:** completed
- **Tests:** videos-flow.e2e-spec 1/1 (API, banco, storage, Redis e container `video-worker` reais), videos-upload-responsiveness.e2e-spec 1/1; os dois rodaram 2 vezes seguidas sem falha; `tsc --noEmit` exit 0
- **Observations:**
  - **Fluxo:** arquivo H.264 de ruído (~13 MB, 3 partes de 5 MiB), `complete` → o worker real leva a `ready` com `duration_seconds` ≈ 4, metadados do `ffprobe` (h264, 640 de largura), thumbnail JPEG servida, `stream` com `Range: bytes=0-99` → 206 com 100 bytes e `download` com `attachment` devolvendo o tamanho exato. Este teste usa o prefixo de fila padrão (`bull`), compartilhado com o `video-worker`; por isso precisa do container no ar.
  - **Responsividade:** 5 partes de 64 MiB (~335 MB) enviadas por processos `curl` separados direto ao storage; durante o envio a API (no processo do teste) respondeu `GET /` com 200 e o crescimento de RSS ficou abaixo de 1/4 do volume enviado. Usei `curl` externo de propósito: um `Buffer` de 64 MiB criado no próprio processo contaminaria a medida de memória.
  - Erros meus corrigidos nos testes: `POST /upload-urls` responde 200 (não 201); os metadados ficam em `streams[]`, não na raiz.
  - Roteiro manual em `manual-10gb-roteiro.md` com a tabela para registrar o resultado. **O teste manual de 10GB não foi executado nesta sessão** (precisa de ~25 GB de disco e tempo); fica para o usuário.

### SI-03.11 — Documentação: OpenAPI, api.http e CLAUDE.md
- **Status:** completed
- **Tests:** swagger.e2e-spec 7/7 (+1: as 9 rotas de vídeos e respostas 202/404/409/422 de `complete` constam no documento); `openapi.json` regenerado com as 9 rotas e respostas por status
- **Observations:**
  - `CLAUDE.md` da raiz: nova seção de vídeos, storage SeaweedFS e fila Redis/BullMQ no diagrama; removida a afirmação de que `next-frontend/` não foi inicializado (a pasta existe e tem commits da fase 02 de front-end).
  - `nestjs-project/CLAUDE.md`: serviços `redis`/`storage`/`video-worker`, `ffmpeg` na imagem, `start:worker`, `openapi:export`, regra do prefixo de fila `bull-test` e a exceção deliberada do `videos-flow.e2e-spec`.
  - `api.http`: fluxo de vídeos (requests 10–19). O PUT da parte ao storage é só descrito (o REST Client não consegue encadear o ETag); **não executei o `api.http` de ponta a ponta**, o critério foi coberto pelos e2e equivalentes.

## Verificação final
- Unit + integração: 43 suítes, 295/295. E2E: 8 suítes, 88/88. `npx tsc --noEmit`: exit 0.
- `npm run lint`: 150 erros / 40 avisos, todos dívida anterior à fase (registrada como tarefa separada). ESLint sem auto-fix no código da fase: só 2 erros, em linhas antigas de `SWAGGER_ENABLED` em `env.validation.integration-spec.ts`.
- **Upload manual de 10GB executado** em 2026-10-25 (resultado em `manual-10gb-roteiro.md`): 160 partes de 64 MiB direto ao storage, `GET /` sempre 200 (pior 3,1 ms), `ready` em < 2 s, `Range` → 206, thumbnail e download ok.
- **Não verificado:** `api.http` ponta a ponta (coberto pelos e2e equivalentes).

### Follow-ups (fora do escopo)
- **Achado do teste de 10GB:** `POST /videos/:publicId/upload-urls` está sujeito ao limite global de 10 req/min por IP; assinar 160 partes em lotes de 10 leva `429` na 11ª chamada. Contornável assinando tudo numa chamada (o DTO aceita até 10 000 partes), mas um cliente que retoma upload várias vezes por minuto esbarra nisso. Decidir se `upload-urls`/`upload` merecem limite próprio.
- Os e2e deixam objetos de 2 KB no bucket (`videos/*/source.mp4` de testes que fazem `complete`): faltou limpar o storage nessas suítes.
- Dívida de lint (150 erros) e `Function` type em `create-test-data-source.ts`.
- Listas `ALL_ENTITIES` duplicadas em ~10 specs; `isPgUniqueViolationOnColumn` duplicado no `ChannelsService`.
- Imagem `chrislusf/seaweedfs:latest` sem versão fixada; `S3_CORS_ALLOWED_ORIGINS=*` só para dev.
- `npm audit` com vulnerabilidades; multipart órfão sem linha no banco (política de lifecycle do bucket).
