---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-25T16:15:00-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-25T16:11:41-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-25T16:11:17-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-25T13:22:16-0300"
  docs/project-plan.md: "2026-10-25T13:22:16-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB sem passar os bytes pela API (multipart pré-assinado direto ao object storage), com pré-cadastro do vídeo como rascunho, processamento automático em segundo plano (fila + worker FFmpeg) que extrai duração, metadados e thumbnail, URL única por vídeo, reprodução por streaming e download.

---

## Step Implementations

### SI-03.1 — Dependências, namespaces de configuração e variáveis de ambiente

**Description:** Instala as bibliotecas de fila e de storage, cria os namespaces de configuração `storage`, `queue` e `videos` no padrão `registerAs` da Fase 01 e estende o schema Joi, para que o resto da fase leia configuração tipada.

**Technical actions:**

1. Instalar em `nestjs-project`: `@nestjs/bullmq@^11.0.5` e `bullmq@^5.81.5` (per `phase-03-videos/TD-01`; a linha 12 do `@nestjs/bullmq` é só ESM e não carrega no Jest CommonJS do projeto, ver `library-refs.md`), `@aws-sdk/client-s3@^3.1156.0` e `@aws-sdk/s3-request-presigner@^3.1156.0` (per `phase-03-videos/TD-03`); versões e compatibilidade com o NestJS 11 em `library-refs.md`
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT` (endpoint interno, nome do serviço do Compose), `S3_PUBLIC_ENDPOINT` (usado só para assinar URLs entregues ao navegador), `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` e `S3_CORS_ALLOWED_ORIGINS` (per `phase-03-videos/TD-08`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (padrão `redis`) e `REDIS_PORT` (padrão 6379) (per `phase-03-videos/TD-01`)
4. Criar `src/config/videos.config.ts` — `registerAs('videos', ...)` com `VIDEO_MAX_SIZE_BYTES` (10737418240), `VIDEO_PART_SIZE_BYTES` (67108864), `VIDEO_ALLOWED_CONTENT_TYPES`, `VIDEO_UPLOAD_URL_TTL_SECONDS` (900), `VIDEO_URL_TTL_SECONDS` (3600), `VIDEO_JOB_ATTEMPTS` (3), `VIDEO_JOB_BACKOFF_MS` (5000), `VIDEO_RECONCILE_INTERVAL_SECONDS` (300), `VIDEO_PROCESSING_STALE_SECONDS` (3600) e `VIDEO_UPLOAD_TTL_HOURS` (24), com os padrões entre parênteses (per `phase-03-videos/TD-03`, `TD-09` e `TD-10`)
5. Atualizar `src/config/env.validation.ts` (Joi: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` e `S3_BUCKET` obrigatórias; demais com padrão), registrar os três namespaces no `load` do `AppModule` e atualizar `.env.example` com hosts pelo nome do serviço do Compose, nunca `localhost` (exceção: `S3_PUBLIC_ENDPOINT`, que é o endereço que o navegador enxerga)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: variáveis obrigatórias ausentes falham; padrões aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A aplicação inicia com as novas variáveis definidas e `GET /` continua retornando `200`
- Iniciar sem `S3_ACCESS_KEY` faz o bootstrap falhar com erro de validação do Joi
- Sem definir as variáveis opcionais, `VIDEO_MAX_SIZE_BYTES` vale `10737418240` e `VIDEO_PART_SIZE_BYTES` vale `67108864`
- O `.env.example` lista todas as variáveis novas e não aponta serviços internos para `localhost`

---

### SI-03.2 — Infra: storage S3, Redis e worker no Compose

**Description:** Sobe a infraestrutura nova da fase no `compose.yaml` (object storage S3-compatível, Redis e o serviço do worker) e instala o FFmpeg na imagem de desenvolvimento, para que o restante da fase seja exercitado contra serviços reais.

**Technical actions:**

1. Adicionar ao `compose.yaml` o serviço de storage com SeaweedFS em modo S3 (`weed server -s3`), com volume de dados, healthcheck e a porta do S3 publicada no host para servir de endpoint público (porta padrão do SeaweedFS; conferir no SI-03.3) (per `phase-03-videos/TD-02`)
2. Adicionar o serviço `redis` com healthcheck (per `phase-03-videos/TD-01`)
3. Instalar `ffmpeg` (que inclui o `ffprobe`) em `Dockerfile.dev` — a imagem de desenvolvimento é única e compartilhada pela API e pelo worker, porque os testes do worker rodam no container `nestjs-api` (regra do `CLAUDE.md` do backend); imagem separada do worker fica para produção (per `phase-03-videos/TD-04`)
4. Adicionar o serviço `video-worker` — mesma imagem e mesmo volume do código, `depends_on` de `db`, `redis` e do storage saudáveis; comando ocioso por ora, o comando real entra no SI-03.7 (per `phase-03-videos/TD-04`)
5. Passar as variáveis `S3_*` e `REDIS_*` a `nestjs-api` e `video-worker` e fazer `nestjs-api` depender de `redis` e do storage

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — variáveis de ambiente e dependências instaladas

**Acceptance criteria:**

- `docker compose up -d` deixa `db`, `redis`, o storage, `nestjs-api` e `video-worker` com status `running`
- O storage responde a uma listagem de buckets autenticada no endpoint interno (`S3_ENDPOINT`)
- `redis-cli ping` dentro do serviço `redis` retorna `PONG`
- `ffprobe -version` e `ffmpeg -version` executam dentro de `nestjs-api` e de `video-worker`

---

### SI-03.3 — Módulo de storage com clientes S3 interno e público

**Description:** Encapsula o object storage atrás de um `StorageService` com dois clientes S3 (interno e público) e prova, contra o storage real, as condições de que o `TD-02` depende (multipart pré-assinado, `ETag` exposto por CORS e leitura com `Range`). Se alguma delas falhar com o SeaweedFS, o `TD-02` indica o RustFS como segunda opção e este SI só fecha depois da troca.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` com dois providers `S3Client` a partir de `storageConfig` — um com `S3_ENDPOINT` (tráfego servidor↔servidor: API e worker) e outro com `S3_PUBLIC_ENDPOINT` (somente assinatura de URLs para o navegador) (per `phase-03-videos/TD-08`)
2. Criar `StorageService` com as operações do multipart — `createMultipartUpload`, `presignUploadPart` (cliente público), `listParts`, `completeMultipartUpload`, `abortMultipartUpload` e `headObject` (per `phase-03-videos/TD-03`)
3. Acrescentar a `StorageService` `presignGetObject` (cliente público, com `response-content-disposition` opcional, para stream, download e thumbnail), `presignGetObjectInternal` (cliente interno, para o `ffprobe`/`ffmpeg` do worker), `putObject` e `deleteObject` (per `phase-03-videos/TD-05` e `TD-07`)
4. Implementar `ensureBucket()` no `onModuleInit`: cria o bucket se não existir e aplica a política CORS (métodos `PUT`, `GET` e `HEAD`, origens de `S3_CORS_ALLOWED_ORIGINS`, `ExposeHeaders` com `ETag`), de forma idempotente (per `phase-03-videos/TD-02`)
5. Criar `StorageUnavailableException` (`STORAGE_UNAVAILABLE`, 503) em `src/common/exceptions/domain.exception.ts` e converter falhas de comunicação com o storage nessa exceção

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: ciclo multipart real, `Range` e CORS contra o storage do Compose (nos testes, `S3_PUBLIC_ENDPOINT` aponta para o mesmo host interno, porque o container não enxerga o endereço do navegador) | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` | Unit: host da URL assinada (público vs interno) e conversão de falhas em `STORAGE_UNAVAILABLE` | `src/storage/storage.service.spec.ts` |
| `StorageModule` | Unit: compilação do módulo (DI) | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2 — os testes de integração usam o storage real

**Acceptance criteria:**

- Criar um multipart, enviar duas partes por `PUT` nas URLs assinadas e completar produz um objeto cujo `headObject` informa a soma dos tamanhos
- `listParts` depois do envio da primeira parte devolve essa parte com `part_number`, `etag` e tamanho
- Um `GET` na URL assinada do objeto com `Range: bytes=0-9` retorna `206` com 10 bytes
- A URL assinada para o navegador tem o host de `S3_PUBLIC_ENDPOINT` e a URL do worker tem o host de `S3_ENDPOINT`
- Uma requisição `OPTIONS` ao storage com `Origin` listado em `S3_CORS_ALLOWED_ORIGINS` devolve `Access-Control-Expose-Headers` incluindo `ETag`
- Chamar `ensureBucket()` duas vezes não falha e não duplica configuração
- Uma falha de conexão com o storage vira `STORAGE_UNAVAILABLE` (`503`)

---

### SI-03.4 — Entidade Video, migration, exceções de domínio e identificador público

**Description:** Cria a entidade `Video` ligada ao canal, a migration da tabela `videos`, as exceções de domínio do módulo, o gerador do identificador público único e a busca de canal por usuário, que servirão de base para os endpoints.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme `### Data Model → Video` (enum `VideoStatus` com `draft`, `processing`, `ready`, `error`) e adicionar a relação `videos` (one-to-many) em `Channel` (per `phase-03-videos/TD-09`)
2. Gerar a migration `CreateVideos` com `migration:generate`, revisar o SQL e conferir o `down` (tabela `videos`, enum `video_status`, FK para `channels`, índice único em `public_id`, índices em `channel_id` e `(status, created_at)`)
3. Criar as exceções de domínio de `### Error Catalog` em `src/common/exceptions/domain.exception.ts`: `VideoNotFoundException`, `UnsupportedVideoFormatException`, `VideoTooLargeException`, `VideoNotUploadableException`, `UploadIncompleteException` e `UploadSizeMismatchException`
4. Criar `src/videos/public-id.util.ts` — gera 11 caracteres base62 com `crypto.randomBytes` e amostragem por rejeição, sem viés de módulo (per `phase-03-videos/TD-06`)
5. Adicionar `ChannelsService.findByUserId(userId)` em `src/channels/channels.service.ts` e exportar o service em `ChannelsModule` (a busca de canal pertence ao módulo de canais, não ao de vídeos)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unicidade de `public_id`, `status` padrão `draft`, FK para `channels`, enum | `src/videos/entities/video.entity.integration-spec.ts` |
| migration `CreateVideos` | Integration: `up` e `down` no banco real | `src/database/migrations.integration-spec.ts` |
| `generatePublicId` | Unit: comprimento 11, alfabeto base62, valores distintos | `src/videos/public-id.util.spec.ts` |
| `ChannelsService.findByUserId` | Integration: devolve o canal do usuário e `null` quando não há | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A migration `CreateVideos` cria a tabela `videos` com PK `uuid`, o enum `video_status` e a FK para `channels`
- Inserir dois vídeos com o mesmo `public_id` viola a unicidade
- Um vídeo inserido sem `status` fica com `status = 'draft'`
- Inserir um vídeo com `channel_id` inexistente viola a FK
- `generatePublicId()` retorna 11 caracteres, todos em `[0-9A-Za-z]`
- `ChannelsService.findByUserId` devolve o canal do usuário e `null` para um usuário sem canal
- Reverter a migration remove a tabela `videos` e o enum `video_status`

---

### SI-03.5 — Upload: pré-cadastro, estado e URLs assinadas

**Description:** Entrega os três endpoints que iniciam e conduzem o upload direto ao storage — pré-cadastro do vídeo como rascunho, consulta do estado para retomar e assinatura das partes — sem que nenhum byte de vídeo passe pela API.

**Technical actions:**

1. Criar `VideosService.createDraft(userId, dto)` em `src/videos/videos.service.ts` — busca o canal por `ChannelsService.findByUserId`, valida tipo e tamanho contra `videosConfig` (`UnsupportedVideoFormatException`, `VideoTooLargeException`), calcula `part_count`, gera o `public_id` com nova tentativa em violação de unicidade, cria o multipart no storage e persiste o vídeo com `status = 'draft'` e título igual ao nome do arquivo (per `phase-03-videos/TD-03`, `TD-06`, `TD-09` e `TD-10`)
2. Criar `VideosService.getUploadState(userId, publicId)` e `signUploadParts(userId, publicId, partNumbers)` — ambos exigem dono e `draft` (`VideoNotFoundException` para vídeo alheio, `VideoNotUploadableException` fora de `draft`) e usam `StorageService.listParts` e `presignUploadPart`
3. Criar `src/videos/dto/create-video.dto.ts` e `src/videos/dto/sign-upload-parts.dto.ts` com `class-validator` conforme `#### Validation Rules — Videos` (per `phase-02-auth/TD-06`)
4. Criar `VideosController` em `src/videos/videos.controller.ts` com `POST /videos`, `GET /videos/:publicId/upload` e `POST /videos/:publicId/upload-urls`, usando `@CurrentUser()` e os decoradores explícitos do `@nestjs/swagger` para operações, respostas por status e envelope de erro (per `openapi-docs-nestjs/TD-01`)
5. Criar `VideosModule` (`TypeOrmModule.forFeature([Video])`, `StorageModule`, `ChannelsModule`) e importá-lo no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: formato/tamanho rejeitados, nova tentativa de `public_id`, dono e `draft` (repositório e storage simulados) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: rascunho persistido no banco real com multipart criado no storage real | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo (DI) | `src/videos/videos.module.spec.ts` |
| `POST /videos`, `GET /videos/:publicId/upload`, `POST /videos/:publicId/upload-urls` | E2E: status, validação, autenticação e dono | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.3 — `StorageService`; SI-03.4 — entidade, exceções e `findByUserId`

**Acceptance criteria:**

- `POST /videos` autenticado com `filename: "a.mp4"`, `content_type: "video/mp4"` e `size_bytes: 1048576` retorna `201` com `public_id` de 11 caracteres, `status: "draft"` e `part_count: 1`
- Depois do `201`, existe uma linha em `videos` com `status = 'draft'`, `upload_id` preenchido e `channel_id` igual ao canal do usuário
- `POST /videos` com `size_bytes: 10737418240` retorna `201` com `part_count: 160`
- `POST /videos` com `size_bytes: 10737418241` retorna `413` com `VIDEO_TOO_LARGE`
- `POST /videos` com `content_type: "application/pdf"` retorna `400` com `UNSUPPORTED_VIDEO_FORMAT`
- `POST /videos` com `size_bytes: 0` retorna `400` com `VALIDATION_ERROR`, e sem token retorna `401`
- `GET /videos/:publicId/upload` do dono retorna `200` com `uploaded_parts` vazio logo após o pré-cadastro
- `GET /videos/:publicId/upload` por outro usuário retorna `404` com `VIDEO_NOT_FOUND`
- `POST /videos/:publicId/upload-urls` com `part_numbers: [1]` retorna `200` com uma URL cujo host é o de `S3_PUBLIC_ENDPOINT`, e com `part_numbers: [0]` retorna `400`

---

### SI-03.6 — Finalizar o upload e enfileirar o processamento

**Description:** Entrega o endpoint que fecha o multipart, confere o tamanho, move o vídeo para `processing` e publica o job na fila, que é o único ponto em que a API sabe que o objeto está inteiro.

**Technical actions:**

1. Registrar a conexão com o Redis como infraestrutura global no `AppModule` com `BullModule.forRootAsync` (por `queueConfig`, host `redis`) e a fila com `BullModule.registerQueue({ name: 'video-processing' })` no `VideosModule` (per `phase-03-videos/TD-01`)
2. Criar `VideoQueueProducer.enqueueProcessing(videoId)` — adiciona o job `process-video` com `jobId` `video-<videoId>`, `attempts` de `VIDEO_JOB_ATTEMPTS` e `backoff` exponencial de `VIDEO_JOB_BACKOFF_MS` (per `phase-03-videos/TD-09`)
3. Criar `VideosService.completeUpload(userId, publicId, parts)` — exige dono e `draft`, chama `completeMultipartUpload` (falha vira `UploadIncompleteException`), confere `headObject` contra `size_bytes` (divergência apaga o objeto, grava `error` com `upload_size_mismatch` e lança `UploadSizeMismatchException`), grava `status = 'processing'`, `processing_started_at` e `upload_id = null`, e só então enfileira; falha ao enfileirar não altera a resposta (per `phase-03-videos/TD-03` e `TD-09`)
4. Criar `src/videos/dto/complete-upload.dto.ts` e a rota `POST /videos/:publicId/complete` com resposta `202` no `VideosController`, com decoradores do `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`)
5. Atualizar `VideosModule` e `.env.example` com o que a fila exige

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ramos de dono, `draft`, parte faltante e divergência de tamanho | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` + `VideoQueueProducer` | Integration: transição no banco, objeto no storage e job no Redis com o `jobId` esperado | `src/videos/videos-complete.integration-spec.ts` |
| `POST /videos/:publicId/complete` | E2E: `202`, `409` e `422` | `test/videos-complete.e2e-spec.ts` |

**Dependencies:** SI-03.5 — rascunho e módulo; SI-03.2 — Redis no Compose

**Acceptance criteria:**

- `POST /videos/:publicId/complete` com todas as partes enviadas retorna `202` com `status: "processing"`
- Depois do `202`, a linha do vídeo tem `status = 'processing'`, `processing_started_at` preenchido e `upload_id` nulo
- Depois do `202`, a fila `video-processing` contém um job `process-video` com `jobId` igual a `video-<id do vídeo>`
- Chamar `complete` uma segunda vez retorna `409` com `VIDEO_NOT_UPLOADABLE`
- `complete` com uma parte faltando retorna `409` com `UPLOAD_INCOMPLETE`
- `complete` quando o objeto final tem tamanho diferente de `size_bytes` retorna `422` com `UPLOAD_SIZE_MISMATCH` e o vídeo fica com `status = 'error'` e `error_reason = 'upload_size_mismatch'`
- `complete` por outro usuário retorna `404` com `VIDEO_NOT_FOUND`, e sem token retorna `401`
- Se o Redis estiver indisponível, `complete` ainda retorna `202` e o vídeo permanece em `processing`

---

### SI-03.7 — Worker de vídeo: metadados, thumbnail e ciclo de status

**Description:** Entrega o processo do worker, que consome a fila, extrai duração e metadados com `ffprobe`, gera a thumbnail com `ffmpeg`, grava o resultado e trata falhas e novas tentativas, sem afetar a API.

**Technical actions:**

1. Criar `src/worker.ts` — entrypoint com `NestFactory.createApplicationContext(WorkerModule)`, o script `start:worker` no `package.json` e o comando real do serviço `video-worker` no `compose.yaml` (per `phase-03-videos/TD-04`)
2. Criar `WorkerModule` (config, TypeORM, `StorageModule`, fila `video-processing`) e `VideoProcessor extends WorkerHost` que, em `process`, carrega o vídeo e sai sem erro se o status não for `processing` (per `phase-03-videos/TD-01` e `TD-09`)
3. Criar `MediaProbeService` — roda o `ffprobe` com `execFile` e saída JSON sobre a URL assinada interna (`presignGetObjectInternal`), sem baixar o arquivo; ausência de stream de vídeo vira falha definitiva sem novas tentativas (por exemplo `UnrecoverableError` do `bullmq`, a conferir na documentação) e grava `error_reason = 'invalid_media'` (per `phase-03-videos/TD-05` e `TD-10`)
4. Criar `ThumbnailService` — roda o `ffmpeg` para extrair um frame, envia o JPEG para `videos/{id}/thumbnail.jpg` com `putObject` e remove o arquivo temporário; o instante do frame é decisão de implementação (sugestão: 10% da duração) (per `phase-03-videos/TD-05`)
5. No `VideoProcessor`, gravar `duration_seconds`, `metadata`, `thumbnail_key` e `status = 'ready'`; e tratar o evento `failed` da última tentativa gravando `status = 'error'` e `error_reason = 'processing_failed'` (per `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Integration: `ffprobe` real sobre um vídeo de teste gerado com `ffmpeg` e sobre um arquivo que não é vídeo | `src/worker/media-probe.service.integration-spec.ts` |
| `ThumbnailService` | Integration: `ffmpeg` real e envio ao storage real | `src/worker/thumbnail.service.integration-spec.ts` |
| `VideoProcessor` | Integration: banco, storage e `ffmpeg` reais — sucesso, mídia inválida, nova tentativa e esgotamento | `src/worker/video.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do módulo (DI) | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.6 — fila registrada e job produzido; SI-03.3 — storage; SI-03.4 — entidade; SI-03.2 — `ffmpeg` e serviço `video-worker`

**Acceptance criteria:**

- Processar um vídeo válido em `processing` o deixa com `status = 'ready'`, `duration_seconds` próxima da duração do arquivo de teste e `metadata` preenchido
- Depois do processamento, o objeto `thumbnail_key` existe no storage e é uma imagem JPEG
- Processar um arquivo que não é vídeo deixa o vídeo com `status = 'error'` e `error_reason = 'invalid_media'`, sem novas tentativas
- Uma falha transitória no processamento é repetida com espera exponencial e, se a nova tentativa funcionar, o vídeo termina em `ready`
- Esgotadas as tentativas, o vídeo fica com `status = 'error'` e `error_reason = 'processing_failed'`
- Reprocessar o job de um vídeo já `ready` não altera a linha
- `docker compose ps` mostra `video-worker` em `running` e o log do worker registra o consumo do job

---

### SI-03.8 — Leitura: metadados, status, streaming, download e thumbnail

**Description:** Entrega os endpoints de leitura do vídeo — metadados públicos, status do dono, streaming, download e thumbnail — como redirecionamentos para URLs assinadas, de modo que os bytes saem do storage (com `Range`) e não da API, e só para vídeo `ready`.

**Technical actions:**

1. Criar em `VideosService` `findReadyByPublicId`, `getOwnerStatus(userId, publicId)` e os geradores de URL de `stream`, `download` e `thumbnail`, todos via `StorageService.presignGetObject` com validade `VIDEO_URL_TTL_SECONDS`; vídeo fora de `ready` é `VideoNotFoundException` nas rotas públicas (per `phase-03-videos/TD-07`)
2. Criar `src/videos/public-id.pipe.ts` — `:publicId` fora do formato de 11 caracteres base62 vira `VideoNotFoundException` (`404`), nunca `400`
3. Criar `src/videos/content-disposition.util.ts` — monta `attachment; filename="..."` a partir de `original_filename`, sanitizado (per `phase-03-videos/TD-07`)
4. Acrescentar ao `VideosController` `GET /videos/:publicId` (`@Public()`), `GET /videos/:publicId/status` (dono), `GET /videos/:publicId/stream`, `GET /videos/:publicId/download` e `GET /videos/:publicId/thumbnail` (`@Public()`), com `302` e `Cache-Control: no-store` nos redirecionamentos
5. Documentar as rotas com os decoradores explícitos do `@nestjs/swagger`, incluindo respostas por status e o envelope de erro (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `PublicIdPipe` | Unit: formato válido e inválido | `src/videos/public-id.pipe.spec.ts` |
| `buildContentDisposition` | Unit: nomes com aspas, barras, acentos e comprimento | `src/videos/content-disposition.util.spec.ts` |
| `VideosService` leitura | Integration: URLs assinadas contra o storage real, com `Range` e `Content-Disposition` | `src/videos/videos-read.integration-spec.ts` |
| rotas de leitura | E2E: anônimo, dono e outro usuário, por status do vídeo | `test/videos-read.e2e-spec.ts` |

**Dependencies:** SI-03.5 — módulo e controller; SI-03.3 — URLs assinadas

**Acceptance criteria:**

- `GET /videos/:publicId/stream` anônimo para um vídeo `ready` retorna `302` com `Location` apontando para o endpoint público do storage e `Cache-Control: no-store`
- Um `GET` na URL do `Location` com `Range: bytes=0-99` retorna `206` com 100 bytes
- `GET /videos/:publicId/download` retorna `302` e a URL assinada responde com `Content-Disposition` de `attachment` e o nome do arquivo original
- `GET /videos/:publicId/thumbnail` retorna `302` para uma imagem quando o vídeo está `ready` e tem thumbnail
- `GET /videos/:publicId` anônimo retorna `200` com `public_id`, `title`, `duration_seconds`, `metadata` e `created_at` para vídeo `ready`
- `stream`, `download`, `thumbnail` e `GET /videos/:publicId` retornam `404` com `VIDEO_NOT_FOUND` para vídeo em `draft`, `processing` ou `error`
- `GET /videos/:publicId/status` do dono retorna `200` com `status` e `error_reason` em qualquer estado, e por outro usuário retorna `404`
- `GET /videos/:publicId/status` sem token retorna `401`
- Um `:publicId` malformado retorna `404` com `VIDEO_NOT_FOUND`

---

### SI-03.9 — Reconciliação de jobs presos e uploads abandonados

**Description:** Entrega a rotina periódica do worker que reenfileira vídeos presos em `processing` e aborta uploads abandonados em `draft`, para que nenhum vídeo fique parado e o storage não acumule partes órfãs.

**Technical actions:**

1. Criar `VideoReconciliationService.requeueStaleProcessing()` — seleciona vídeos em `processing` com `processing_started_at` mais antigo que `VIDEO_PROCESSING_STALE_SECONDS` e chama `VideoQueueProducer.enqueueProcessing` (o `jobId` impede duplicata enquanto o job existir) (per `phase-03-videos/TD-09`)
2. Criar `VideoReconciliationService.abortAbandonedUploads()` — seleciona vídeos em `draft` com `created_at` mais antigo que `VIDEO_UPLOAD_TTL_HOURS`, chama `abortMultipartUpload` e grava `status = 'error'` com `error_reason = 'upload_abandoned'` (per `phase-03-videos/TD-09`)
3. Registrar, na subida do worker, o job repetível `reconcile-videos` a cada `VIDEO_RECONCILE_INTERVAL_SECONDS` (confirmar na documentação do `bullmq` o mecanismo de job repetível/agendador) (per `phase-03-videos/TD-09`)
4. Fazer o `VideoProcessor` despachar por `job.name`: `process-video` para o processamento e `reconcile-videos` para as duas rotinas acima

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoReconciliationService` | Unit: seleção por limite de tempo e ramos de cada rotina (repositório e storage simulados) | `src/videos/video-reconciliation.service.spec.ts` |
| `VideoReconciliationService` | Integration: banco, storage e Redis reais com datas antigas | `src/videos/video-reconciliation.service.integration-spec.ts` |

**Dependencies:** SI-03.7 — worker e processor

**Acceptance criteria:**

- Um vídeo em `processing` há mais que `VIDEO_PROCESSING_STALE_SECONDS` sem job na fila é reenfileirado com `jobId` `video-<id>`
- Um vídeo em `processing` com job já existente na fila não gera um segundo job
- Um vídeo em `draft` criado há mais que `VIDEO_UPLOAD_TTL_HOURS` fica com `status = 'error'` e `error_reason = 'upload_abandoned'`, e o multipart some do storage
- Um vídeo em `draft` dentro do prazo não é alterado
- Ao subir, o worker registra o job `reconcile-videos` com o intervalo configurado

---

### SI-03.10 — Fluxo completo e prova de que a API não segura o upload

**Description:** Fecha o requisito central da fase com testes ponta a ponta contra a infraestrutura real do Compose — o ciclo completo do vídeo até o streaming e a prova de que enviar um arquivo grande não ocupa a API — e documenta o roteiro manual do teste de 10GB.

**Technical actions:**

1. Criar `test/videos-flow.e2e-spec.ts` — cria o vídeo, envia as partes direto ao storage, finaliza, espera o `video-worker` real levar o vídeo a `ready` consultando `GET /videos/:publicId/status`, e confere metadados, thumbnail, streaming com `Range` e download (nesse teste `VIDEO_PART_SIZE_BYTES` vale 5 MiB, o mínimo do S3) (per `phase-03-videos/TD-03`)
2. Criar `test/videos-upload-responsiveness.e2e-spec.ts` — enquanto cerca de 300MB são enviados em partes direto ao storage, faz requisições repetidas a `GET /` e mede o crescimento de memória do processo da API (critério de `phase-03-videos/TD-03`, Revision de 2026-10-25)
3. Criar o arquivo `docs/phases/phase-03-videos/manual-10gb-roteiro.md` com o passo a passo manual do upload de 10GB (gerar o arquivo, `POST /videos`, enviar as 160 partes, `complete`, acompanhar `status`) e onde registrar o resultado

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| fluxo upload → processamento → streaming | E2E: infraestrutura real (API, banco, storage, Redis e `video-worker`) | `test/videos-flow.e2e-spec.ts` |
| API durante o upload | E2E: responsividade e memória | `test/videos-upload-responsiveness.e2e-spec.ts` |

**Dependencies:** SI-03.6 — finalização; SI-03.7 — worker; SI-03.8 — leitura

**Acceptance criteria:**

- Um vídeo enviado em partes de 5 MiB e finalizado chega a `status = 'ready'` em até o tempo limite do teste, com `duration_seconds` e `thumbnail_key` preenchidos
- Depois de `ready`, `GET /videos/:publicId/stream` leva a uma URL que atende `Range: bytes=0-99` com `206`
- Durante o envio de cerca de 300MB ao storage, as requisições a `GET /` retornam `200` e o crescimento de memória do processo da API fica abaixo do tamanho enviado
- O roteiro `manual-10gb-roteiro.md` existe e descreve os passos do upload de 10GB com 160 partes de 64 MiB

---

### SI-03.11 — Documentação: OpenAPI, api.http e CLAUDE.md

**Description:** Deixa a documentação coerente com o código da fase — spec OpenAPI exportada, requisições de exemplo e as seções de vídeos nos `CLAUDE.md` —, para que nenhum arquivo cite comportamento que não existe.

**Technical actions:**

1. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` e conferir que as 9 rotas de vídeos aparecem com respostas por status e o envelope de erro (per `openapi-docs-nestjs/TD-02`)
2. Acrescentar a `nestjs-project/api.http` o fluxo de vídeos: criar, assinar partes, finalizar, consultar status, metadados, streaming, download e thumbnail
3. Atualizar o `CLAUDE.md` da raiz com a seção de vídeos (módulo `videos`, os endpoints, a fila `video-processing`, o worker e o storage S3) e corrigir a linha que ainda diz que `next-frontend/` não foi inicializado
4. Atualizar `nestjs-project/CLAUDE.md` com os novos serviços do Compose (storage, `redis`, `video-worker`), o `ffmpeg` na imagem e como rodar o worker e os testes dele

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| documento OpenAPI | E2E: as rotas de vídeos constam no documento gerado | `test/swagger.e2e-spec.ts` |

**Dependencies:** SI-03.8 — todas as rotas implementadas

**Acceptance criteria:**

- `openapi.json` contém `/videos`, `/videos/{publicId}/upload`, `/videos/{publicId}/upload-urls`, `/videos/{publicId}/complete`, `/videos/{publicId}/status`, `/videos/{publicId}`, `/videos/{publicId}/stream`, `/videos/{publicId}/download` e `/videos/{publicId}/thumbnail`
- O `CLAUDE.md` da raiz descreve o módulo de vídeos, os endpoints, a fila, o worker e o storage, e cita apenas arquivos e comportamentos que existem
- O `CLAUDE.md` da raiz não afirma mais que `next-frontend/` não foi inicializado
- O fluxo de `api.http` executa de ponta a ponta contra a API em execução

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (migration em SI-03.4). Convenções herdadas de `users` e `channels`: PK `uuid` gerada, colunas em `snake_case`, `created_at`/`updated_at` como `timestamp`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(11) | unique, not null — identificador público e curto que forma a URL do vídeo, base62 aleatório com índice único e retry em colisão (per `phase-03-videos/TD-06`) |
| channel_id | uuid | FK → `channels.id`, not null — dono do vídeo |
| title | varchar(255) | not null — provisório, igual ao nome do arquivo no pré-cadastro; edição fica na Fase 04 (per `phase-03-videos/TD-09`, Revision de 2026-10-25) |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null — validado contra a lista permitida (per `phase-03-videos/TD-10`) |
| size_bytes | bigint | not null — tamanho declarado ao iniciar o upload; conferido com `HeadObject` ao finalizar (per `phase-03-videos/TD-03`) |
| status | enum `video_status` | not null, default `'draft'` — valores `draft`, `processing`, `ready`, `error` (per `phase-03-videos/TD-09`) |
| error_reason | text | nullable — preenchido quando `status = 'error'` |
| storage_key | varchar(512) | not null — chave do objeto do vídeo no bucket |
| thumbnail_key | varchar(512) | nullable — preenchida pelo worker |
| upload_id | varchar(512) | nullable — `UploadId` do multipart; nulo depois de completar ou abortar |
| part_size_bytes | integer | not null |
| part_count | integer | not null |
| duration_seconds | numeric(12,3) | nullable — preenchida pelo worker |
| metadata | jsonb | nullable — resumo do `ffprobe` (formato, codecs, resolução, bitrate) |
| processing_started_at | timestamp | nullable — marcada ao entrar em `processing`; usada pela reconciliação |
| created_at | timestamp | not null, default now() |
| updated_at | timestamp | not null, default now(), atualizada a cada alteração |

**Relations:** `Video` many-to-one `Channel` via `channel_id`; `Channel` has many `Video` (um canal tem vários vídeos). A FK segue o padrão do projeto (`ON DELETE NO ACTION`).
**Indexes:** unique em `public_id`; index em `channel_id`; index composto em `(status, created_at)` para a reconciliação.

**Status transitions** (per `phase-03-videos/TD-09`):

| From | To | Evento |
|------|----|--------|
| (novo) | `draft` | `POST /videos` — pré-cadastro e criação do multipart |
| `draft` | `processing` | `POST /videos/:publicId/complete` com sucesso |
| `draft` | `error` | reconciliação aborta upload abandonado (`error_reason = 'upload_abandoned'`) |
| `processing` | `ready` | worker grava duração, metadados e thumbnail |
| `processing` | `error` | tentativas esgotadas, arquivo sem stream de vídeo, ou tamanho final diferente do declarado |

`ready` e `error` são terminais nesta fase.

**Object storage layout** (bucket único, nome em configuração): vídeo em `videos/{id}/source{ext}` e thumbnail em `videos/{id}/thumbnail.jpg`, onde `{id}` é o `id` interno (uuid). Os valores efetivos ficam em `storage_key` e `thumbnail_key`.

### API Contracts

Rotas sob `/videos`. Em todas, `:publicId` é o identificador público do `TD-06` (`videos.public_id`); o `TD-03` escreve `/videos/:id/complete` com esse mesmo significado. O `id` interno (uuid) nunca aparece em URL nem em resposta. Respostas em JSON `snake_case`, erros no envelope `{ statusCode, error, message }` herdado de `phase-02-auth/TD-07`. Autenticação por `Authorization: Bearer <access_token>` (guard JWT global); as rotas marcadas "público" usam `@Public()`.

#### POST /videos (SI-03.5)

Pré-cadastra o vídeo como rascunho e cria o multipart upload no storage. Nenhum byte de vídeo passa pela API (per `phase-03-videos/TD-03`).

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 a 255 caracteres
- content_type: string, required — deve estar na lista permitida configurada (per `phase-03-videos/TD-10`)
- size_bytes: integer, required — mínimo 1; máximo `VIDEO_MAX_SIZE_BYTES` (padrão 10737418240, ou seja, 10 GiB)

**Response 201:**
- public_id: string (11 caracteres base62)
- title: string — provisório, igual a `filename`
- status: string — sempre `draft`
- part_size_bytes: integer
- part_count: integer
- created_at: string (ISO 8601)

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema
- 400 UNSUPPORTED_VIDEO_FORMAT: `content_type` ou extensão fora da lista permitida
- 413 VIDEO_TOO_LARGE: `size_bytes` acima do máximo
- 401: sem token ou token inválido (resposta padrão do guard)
- 503 STORAGE_UNAVAILABLE: o storage não respondeu ao criar o multipart

---

#### GET /videos/:publicId/upload (SI-03.5)

Estado do upload em andamento, para retomar depois de uma queda de conexão (per `phase-03-videos/TD-03`). Só o dono.

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- public_id: string
- status: string — `draft`
- part_size_bytes: integer
- part_count: integer
- uploaded_parts: array de `{ part_number: integer, etag: string, size_bytes: integer }` — vem do `ListParts` do storage

**Error responses:**
- 401: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_UPLOADABLE: o vídeo não está em `draft`
- 503 STORAGE_UNAVAILABLE

---

#### POST /videos/:publicId/upload-urls (SI-03.5)

Assina URLs `PUT` por parte. O cliente envia cada parte direto ao storage e guarda o cabeçalho `ETag` devolvido.

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — não vazio, sem repetição, cada valor entre 1 e `part_count`

**Response 200:**
- expires_in_seconds: integer
- urls: array de `{ part_number: integer, url: string }` — URLs assinadas com o endpoint **público** do storage (per `phase-03-videos/TD-08`)

**Error responses:**
- 400 VALIDATION_ERROR: `part_numbers` fora do intervalo, vazio ou com repetição
- 401: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_UPLOADABLE: o vídeo não está em `draft`
- 503 STORAGE_UNAVAILABLE

---

#### POST /videos/:publicId/complete (SI-03.6)

Finaliza o multipart, confere o tamanho e enfileira o processamento (per `phase-03-videos/TD-03`). A resposta é assíncrona.

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- parts: array, required, não vazio, de `{ part_number: integer, etag: string }`

**Response 202:**
- public_id: string
- status: string — `processing`

**Error responses:**
- 400 VALIDATION_ERROR: `parts` ausente, vazio ou malformado
- 401: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_UPLOADABLE: o vídeo não está em `draft` (inclui repetir a chamada depois de um sucesso)
- 409 UPLOAD_INCOMPLETE: faltam partes ou algum `etag` não confere com o storage
- 422 UPLOAD_SIZE_MISMATCH: o tamanho final do objeto difere de `size_bytes`; o objeto é apagado e o vídeo vai para `error`
- 503 STORAGE_UNAVAILABLE

Se o enfileiramento falhar depois de o vídeo já estar em `processing`, a resposta continua 202 e a reconciliação reenfileira (per `phase-03-videos/TD-09`).

---

#### GET /videos/:publicId/status (SI-03.8)

Estado do pipeline do vídeo, incluindo vídeos que ainda não estão prontos. Só o dono (per `phase-03-videos/TD-07`, Revision de 2026-10-25).

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- public_id: string
- status: string — `draft`, `processing`, `ready` ou `error`
- error_reason: string | null
- duration_seconds: number | null
- created_at: string (ISO 8601)
- updated_at: string (ISO 8601)

**Error responses:**
- 401: sem token ou token inválido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal

---

#### GET /videos/:publicId (SI-03.8)

Metadados públicos. Público; só responde para vídeo `ready`.

**Response 200:**
- public_id: string
- title: string
- duration_seconds: number
- metadata: object — resumo do `ffprobe`
- created_at: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou fora de `ready`

---

#### GET /videos/:publicId/stream (SI-03.8)

Reprodução por streaming. Público; só vídeo `ready`. A API não serve os bytes: responde com redirecionamento para uma URL assinada de leitura, e o storage atende `Range` com `206 Partial Content` (per `phase-03-videos/TD-07`).

**Response 302:**
- Location: URL assinada `GET` do objeto, com o endpoint público do storage e validade `VIDEO_URL_TTL_SECONDS` (padrão 3600)
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou fora de `ready`

---

#### GET /videos/:publicId/download (SI-03.8)

Download do arquivo original. Público; só vídeo `ready`.

**Response 302:**
- Location: URL assinada `GET` com `response-content-disposition` igual a `attachment` e o nome do arquivo derivado de `original_filename` (sanitizado)
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou fora de `ready`

---

#### GET /videos/:publicId/thumbnail (SI-03.8)

Thumbnail gerada pelo worker. Público; só vídeo `ready` com `thumbnail_key`.

**Response 302:**
- Location: URL assinada `GET` do `thumbnail_key`, validade `VIDEO_URL_TTL_SECONDS`
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente, fora de `ready` ou sem thumbnail

---

#### Validation Rules — Videos

- `filename`: obrigatório, string de 1 a 255 caracteres.
- `content_type`: obrigatório; precisa constar em `VIDEO_ALLOWED_CONTENT_TYPES` (padrão `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`) e a extensão do `filename` precisa ser coerente com ele (per `phase-03-videos/TD-10`).
- `size_bytes`: obrigatório, inteiro, de 1 até `VIDEO_MAX_SIZE_BYTES`.
- `part_numbers`: array não vazio de inteiros distintos entre 1 e `part_count`.
- `parts`: array não vazio de `{ part_number, etag }`, com `part_number` distinto.
- `:publicId`: se o valor não tiver o formato de 11 caracteres base62, a rota responde `404 VIDEO_NOT_FOUND` (não `400`), para não distinguir "mal formado" de "inexistente".
- Tamanho da parte: `VIDEO_PART_SIZE_BYTES` (padrão 67108864, ou 64 MiB). `part_count = ceil(size_bytes / part_size_bytes)`, dentro do limite de 10.000 partes e com partes de pelo menos 5 MiB, exceto a última (limites do S3 confirmados em `library-refs.md`).

### Authorization Matrix

"Dono" é o usuário autenticado cujo canal (`channels.user_id` igual ao `sub` do JWT) é o `channel_id` do vídeo. Não há papéis nesta fase. Streaming, download, thumbnail e metadados são leitura pública, mas só de vídeo `ready` (per `phase-03-videos/TD-07`, Revision de 2026-10-25); visibilidade pública ou não listada fica na Fase 04.

| Endpoint | Anonymous | Authenticated (não dono) | Owner |
|----------|-----------|--------------------------|-------|
| POST /videos | ✗ | ✓ (cria no próprio canal) | ✓ |
| GET /videos/:publicId/upload | ✗ | ✗ | ✓ (só em `draft`) |
| POST /videos/:publicId/upload-urls | ✗ | ✗ | ✓ (só em `draft`) |
| POST /videos/:publicId/complete | ✗ | ✗ | ✓ (só em `draft`) |
| GET /videos/:publicId/status | ✗ | ✗ | ✓ (qualquer status) |
| GET /videos/:publicId | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |
| GET /videos/:publicId/stream | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |
| GET /videos/:publicId/download | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |
| GET /videos/:publicId/thumbnail | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |

Quando o autenticado não é o dono de um vídeo existente, as rotas de dono respondem `404 VIDEO_NOT_FOUND` (e não `403`), para não revelar a existência do vídeo.

### Error Catalog

Mesmo envelope de `phase-02-auth/TD-07`: `{ statusCode, error, message }`, em que `error` é o `errorCode`. Cada código vira uma subclasse de `DomainException` em `src/common/exceptions/domain.exception.ts`. `VALIDATION_ERROR` e o `401` do guard já existem e são reaproveitados.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `:publicId` inexistente, mal formado, de outro canal (rotas de dono) ou fora de `ready` (rotas públicas) |
| UNSUPPORTED_VIDEO_FORMAT | 400 | `content_type` ou extensão fora de `VIDEO_ALLOWED_CONTENT_TYPES` ao iniciar o upload |
| VIDEO_TOO_LARGE | 413 | `size_bytes` acima de `VIDEO_MAX_SIZE_BYTES` |
| VIDEO_NOT_UPLOADABLE | 409 | operação de upload (consultar, assinar, finalizar) em vídeo que não está em `draft` |
| UPLOAD_INCOMPLETE | 409 | ao finalizar: faltam partes ou algum `etag` não confere com o storage |
| UPLOAD_SIZE_MISMATCH | 422 | ao finalizar: o tamanho do objeto no storage difere de `size_bytes` |
| STORAGE_UNAVAILABLE | 503 | falha de comunicação com o storage ao criar, listar, assinar, completar ou conferir o multipart |

**Valores de `videos.error_reason`** (gravados no banco, não são respostas HTTP):

| error_reason | Quando |
|--------------|--------|
| `invalid_media` | o `ffprobe` não encontrou stream de vídeo no arquivo (per `phase-03-videos/TD-10`) |
| `processing_failed` | tentativas da fila esgotadas por erro no processamento (per `phase-03-videos/TD-09`) |
| `upload_size_mismatch` | tamanho final diferente do declarado |
| `upload_abandoned` | upload em `draft` além do TTL, abortado pela reconciliação |

### Events/Messages

Fila BullMQ sobre Redis (per `phase-03-videos/TD-01`), consumida pelo worker, que roda como serviço próprio do Compose no mesmo código-base (per `phase-03-videos/TD-04`). Os eventos são internos (backend), sem contrato com o frontend.

#### video.process

Fila `video-processing`, job `process-video`.

**Payload:**

```json
{ "videoId": "uuid" }
```

`videoId` é o `id` interno do vídeo. O worker relê o registro no banco; o payload não carrega metadados.

**Job options:** `jobId` igual a `video-<videoId>` (BullMQ rejeita `:` e ids só numéricos, ver `library-refs.md`), `attempts` configurável (`VIDEO_JOB_ATTEMPTS`, padrão 3) e `backoff` exponencial (`VIDEO_JOB_BACKOFF_MS`, padrão 5000 ms) (per `phase-03-videos/TD-09`).

**Producer:** `VideosService`, em `POST /videos/:publicId/complete` (per `phase-03-videos/TD-03`), e a rotina de reconciliação (per `phase-03-videos/TD-09`)
**Consumer:** `VideoProcessor` no worker (per `phase-03-videos/TD-04`)
**Trigger:** o vídeo acabou de ir de `draft` para `processing`, ou a reconciliação achou um vídeo preso em `processing`
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`). O `jobId` evita duplicata enquanto o job existir. O processor é idempotente: se o vídeo já estiver `ready`, não faz nada; se estiver `error`, descarta.

**Fluxo do processor** (leitura por URL assinada com `Range`, per `phase-03-videos/TD-05`; endpoint interno do storage, per `phase-03-videos/TD-08`):
1. Carrega o vídeo; sai sem erro se o status não for `processing`.
2. Assina uma URL de leitura do objeto e roda o `ffprobe`; sem stream de vídeo, grava `error` com `error_reason = 'invalid_media'` e **não** tenta de novo.
3. Roda o `ffmpeg` para extrair um frame (instante do frame: decisão de implementação; sugestão 10% da duração) e envia o JPEG para `thumbnail_key`.
4. Grava `duration_seconds`, `metadata`, `thumbnail_key` e `status = 'ready'`.
5. Se o processor lançar erro, a fila tenta de novo até `attempts`; na última falha, o handler do evento `failed` grava `error` com `error_reason = 'processing_failed'`.

#### video.reconcile

Fila `video-processing`, job repetível `reconcile-videos`, a cada `VIDEO_RECONCILE_INTERVAL_SECONDS` (padrão 300).

**Payload:**

```json
{}
```

**Producer:** o próprio worker, ao subir, registra o job repetível (per `phase-03-videos/TD-09`)
**Consumer:** `VideoProcessor` no worker (per `phase-03-videos/TD-04`)
**Trigger:** temporizador
**Delivery semantics:** best-effort e idempotente (per `phase-03-videos/TD-09`). Cada execução:
1. Vídeos em `processing` com `processing_started_at` mais antigo que `VIDEO_PROCESSING_STALE_SECONDS` (padrão 3600) são reenfileirados em `video.process`; o `jobId` impede duplicata se o job ainda existir.
2. Vídeos em `draft` com `created_at` mais antigo que `VIDEO_UPLOAD_TTL_HOURS` (padrão 24) têm o multipart abortado (`AbortMultipartUpload`) e vão para `error` com `error_reason = 'upload_abandoned'`.

---

## Dependency Map

SI-03.1 (root)
└── SI-03.2 — depende de SI-03.1 (variáveis de ambiente e dependências antes de subir a infraestrutura)
    └── SI-03.3 — depende de SI-03.2 (o storage precisa estar no ar para os testes de integração)
SI-03.4 (root, independente)

SI-03.5 — depende de SI-03.3 (`StorageService`) e SI-03.4 (entidade, exceções e `findByUserId`)
├── SI-03.6 — depende de SI-03.5 (rascunho) e SI-03.2 (Redis)
│   └── SI-03.7 — depende de SI-03.6 (fila e job), SI-03.3 (storage), SI-03.4 (entidade) e SI-03.2 (`ffmpeg`, `video-worker`)
│       ├── SI-03.9 — depende de SI-03.7 (worker e processor)
│       └── SI-03.10 — depende também de SI-03.6 e SI-03.8 (fluxo completo exige finalização, worker e leitura)
└── SI-03.8 — depende de SI-03.5 (módulo e controller) e SI-03.3 (URLs assinadas)
    ├── SI-03.10 — (ver acima)
    └── SI-03.11 — depende de SI-03.8 (todas as rotas implementadas)

---

## Deliverables

- [ ] SI-03.1 — Dependências, namespaces de configuração e variáveis de ambiente
- [ ] SI-03.2 — Infra: storage S3, Redis e worker no Compose
- [ ] SI-03.3 — Módulo de storage com clientes S3 interno e público
- [ ] SI-03.4 — Entidade Video, migration, exceções de domínio e identificador público
- [ ] SI-03.5 — Upload: pré-cadastro, estado e URLs assinadas
- [ ] SI-03.6 — Finalizar o upload e enfileirar o processamento
- [ ] SI-03.7 — Worker de vídeo: metadados, thumbnail e ciclo de status
- [ ] SI-03.8 — Leitura: metadados, status, streaming, download e thumbnail
- [ ] SI-03.9 — Reconciliação de jobs presos e uploads abandonados
- [ ] SI-03.10 — Fluxo completo e prova de que a API não segura o upload
- [ ] SI-03.11 — Documentação: OpenAPI, api.http e CLAUDE.md

**Entregáveis da fase** (`docs/project-plan.md`):

- [ ] Upload de até 10GB funcional (partes enviadas direto ao storage; roteiro manual de 10GB executado e registrado)
- [ ] Processamento automático do vídeo (duração, metadados e thumbnail pelo `video-worker`)
- [ ] Streaming funcionando (`Range` com `206` pelo storage)
- [ ] URLs únicas geradas (`public_id` de 11 caracteres, único no banco)
- [ ] `docker compose up -d` sobe `db`, `redis`, o storage, `nestjs-api` e `video-worker` em `running`

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`) — o passivo de lint anterior à fase (150 erros em specs e em dois arquivos) está registrado como tarefa separada; enquanto ele existir, a verificação desta fase é o lint sem erros nos arquivos criados ou alterados por ela
