---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-10-25
scope_description: "Upload e processamento de vídeos: object storage S3-compatível, fila e worker FFmpeg, upload de até 10GB sem passar pela API, URL única, streaming, download e ciclo de status do vídeo."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend: módulo de vídeos, orquestração do upload, publicação de jobs na fila, endpoints de streaming/download e o worker de vídeo (entrypoint próprio, mesmo código-base).
- `next-frontend/` — **sem decisão aberta neste documento.** A interface de vídeo está fora do escopo desta fase. Os TDs Cross-layer (TD-03, TD-07, TD-08) definem o contrato HTTP que o frontend consumirá numa fase futura.

_Restrições herdadas:_ nenhum TD anterior em `docs/decisions/` trata de fila, storage ou vídeo, então nada é reaberto. Valem as decisões de stack da Fase 01/02 (`@nestjs/config` + Joi + `registerAs`; `class-validator`; envelope de erro padrão). O object storage é dado como S3-compatível (`docs/diagrams/software-arch.mermaid`, `docs/project-plan.md`); TD-02 decide **qual servidor S3-compatível** rodar localmente, porque a premissa de usar MinIO mudou (ver TD-02).

_Verificação de fontes:_ o MCP context7 exigido pelo `CLAUDE.md` não estava disponível na sessão que gerou este documento. As afirmações abaixo vêm de documentação oficial acessada pela web e de verificações locais (`docker manifest inspect`). Os pontos marcados como **a validar** devem ser confirmados via context7 no `/plan-resolve`, que fixa as versões em `library-refs.md`.

---

## TD-01: Tecnologia da fila de processamento

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O plano deixa a fila como "TBD" (`software-arch.mermaid`). A API publica o job após o upload; o worker consome, processa vídeos de até 10GB (minutos a dezenas de minutos) e atualiza banco e storage. Precisa de retry com backoff, deduplicação por vídeo e tolerância a jobs longos. É a principal decisão de stack da fase.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Fila sobre Redis, com integração oficial no NestJS (a doc do Nest recomenda BullMQ e marca o Bull antigo como em manutenção). Retry via `attempts` + `backoff`, `jobId` para deduplicação, detecção de job travado por lock.
- **Pros:** Caminho documentado pelo NestJS; retry/backoff/stalled nativos; muito usado, então fácil de achar exemplos; processor separável em outro processo.
- **Cons:** Adiciona um serviço novo (Redis ou Valkey) ao Compose; o commit no Postgres e a publicação no Redis não são atômicos (precisa de reconciliação para jobs perdidos); Redis passa a ser dependência de produção.

### Option B: pg-boss (fila sobre PostgreSQL)
- Fila em tabelas do próprio Postgres usando `SKIP LOCKED`. Não exige serviço novo.
- **Pros:** Zero infraestrutura extra (Postgres já existe); permite **enfileirar na mesma transação** que muda o status do vídeo, eliminando o problema de dual-write; retry e expiração nativos.
- **Cons:** Sem integração oficial com o Nest (módulo próprio de wrapper); menos recursos que BullMQ (fontes secundárias indicam sem progresso de job e sem dashboard equivalente ao Bull Board, **a validar**); `expireIn` precisa ser configurado para jobs longos; coloca carga de fila no banco principal; o diagrama de arquitetura pede um componente de fila separado.

### Option C: RabbitMQ (`@nestjs/microservices`, transporte RMQ)
- Broker de mensagens dedicado, com ack/nack, dead-letter exchange e filas duráveis.
- **Pros:** Semântica de mensageria robusta; DLQ nativa; desacopla bem produtores e consumidores; suportado pelo Nest.
- **Cons:** Serviço mais pesado para o escopo; retry com backoff exige configurar DLX/TTL manualmente; ack de mensagens longas exige cuidado com `consumer_timeout`; mais conceitos operacionais para um único tipo de job.

**Recommendation:** Option A (BullMQ + Redis) — integração oficial com o NestJS 11, retry/backoff/dedup prontos e topologia que bate com o diagrama (fila como container próprio); aceita-se o custo de um serviço novo e de uma reconciliação para o dual-write (ver TD-09). Se você priorizar menos infraestrutura e atomicidade do enqueue, Option B é uma alternativa legítima: a diferença não é grande para este volume.

**Decision:** A (BullMQ + Redis)
**Libraries:** `@nestjs/bullmq`, `bullmq`

---

## TD-02: Servidor S3-compatível para o object storage (Docker)

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O plano e o enunciado apontam para MinIO. **Verificação feita em 2026-10-25:** o repositório `minio/minio` está arquivado ("THIS REPOSITORY IS NO LONGER MAINTAINED", arquivado em 25/04/2026), a edição community é distribuída **só como código-fonte**, e `docker manifest inspect` não encontrou `minio/minio:latest` nem `quay.io/minio/minio:latest` neste ambiente (resultado inconclusivo sobre o motivo: pode ser remoção ou falta de acesso). Subir MinIO no Compose agora exigiria build a partir do fonte ou imagem antiga sem patches. O aplicativo fala S3 via SDK, então a troca do servidor é questão de configuração, não de código. Como o enunciado tratava o MinIO como dado, esta decisão precisa da sua confirmação.

**Options:**

### Option A: MinIO construído do código-fonte (ou imagem legada fixada)
- Mantém o que o enunciado e o plano dizem. Exige `docker build` do repositório arquivado ou uso de uma imagem antiga fixada por digest.
- **Pros:** Alinha literalmente com plano e enunciado; comportamento S3 bem conhecido (presigned multipart, CORS, notificações).
- **Cons:** Projeto sem manutenção e sem correções de segurança; build do fonte aumenta o tempo e a fragilidade do setup; fere a boa prática de não basear infraestrutura nova em projeto arquivado.

### Option B: SeaweedFS (`weed server -s3`)
- Servidor ativo, em Go, com API S3. A documentação lista multipart, URLs pré-assinadas, CORS por bucket e Range.
- **Pros:** Mantido; sobe com um comando; suporte documentado ao conjunto de operações que o TD-03 e o TD-07 usam; imagem `chrislusf/seaweedfs` disponível (verificado).
- **Cons:** Compatibilidade de presigned multipart + CORS no endpoint S3 **precisa de spike** (uma discussão antiga relatou erro 405 em upload pré-assinado; pode estar resolvido); modelo operacional (master/volume/filer) é mais complexo que o do MinIO.

### Option C: Garage
- Servidor S3 leve, binário único, em Rust. Multipart é documentado; operações não implementadas retornam 501.
- **Pros:** Muito leve; imagem `dxflrs/garage` disponível (verificado); simples de rodar em um nó.
- **Cons:** Exige configuração inicial (TOML e `garage layout assign/apply`) que complica o Compose; CORS no endpoint S3 não está claro na documentação consultada (a menção é a headers do endpoint web); S3 parcial (lifecycle limitado).

### Option D: RustFS
- Servidor S3 em Rust sob Apache-2.0, que anunciou a versão 1.0 GA.
- **Pros:** Posicionado como substituto direto do MinIO; imagem `rustfs/rustfs` disponível (verificado).
- **Cons:** Projeto jovem; nenhuma fonte consultada confirma CORS nem presigned multipart; não assumir paridade de recursos com MinIO.

**Recommendation:** Option B (SeaweedFS), **condicionada a um spike** no início da implementação que prove, com o SDK da AWS e a partir de uma origem de navegador: multipart pré-assinado, ETag exposto via CORS e GET com Range. Se o spike falhar, Option D é o segundo candidato. A Option A só se justifica se você quiser manter o MinIO por exigência do exercício, assumindo o risco de projeto arquivado.

**Decision:** B (SeaweedFS, sujeito a spike de presigned multipart + CORS + Range)

---

## TD-03: Estratégia e protocolo de upload (10GB sem travar a API)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"; "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Passar 10GB pela API ocupa conexões, memória e banda do processo Nest e é reprovação automática no enunciado. O plano também exige retomada em caso de queda de conexão. O contrato envolve backend (inicia, assina, finaliza) e cliente (envia as partes), por isso é Cross-layer. O pré-cadastro como rascunho acontece no início do handshake.

**Options:**

### Option A: Multipart S3 com URLs pré-assinadas (upload direto ao storage)
- A API cria o rascunho e o multipart upload, devolve URLs pré-assinadas por parte; o cliente envia cada parte direto ao storage e chama a API para finalizar (`CompleteMultipartUpload`). O estado das partes fica no próprio storage (`ListParts`), o que permite retomar.
- **Pros:** Zero bytes de vídeo pela API; retomada por parte; paralelismo no cliente; bate com o diagrama (frontend → storage); limites do S3 (5 MiB–5 GiB por parte, até 10.000 partes) comportam 10GB com partes de 64–128 MiB (**a validar na doc oficial**).
- **Cons:** O cliente precisa implementar o fluxo de partes e expor o ETag via CORS; o limite de 10GB não é imposto pelo storage, então a API precisa validar tamanho declarado e conferir o tamanho final (`HeadObject`) ao finalizar; exige limpeza de uploads abandonados (ver TD-09).

### Option B: Protocolo tus (`@tus/server` + `@tus/s3-store`)
- Protocolo aberto de upload retomável (POST/PATCH/HEAD). Um servidor tus, hospedado junto à API, repassa os bytes ao storage S3.
- **Pros:** Retomada padronizada, clientes prontos (tus-js-client, Uppy); hooks para validar cada requisição.
- **Cons:** Os bytes **passam pelo servidor tus**, ou seja, a banda e as conexões de 10GB ficam no seu processo; é uma dependência e um protocolo a mais; escala pior que o direto ao storage.

### Option C: Streaming multipart pela API até o S3
- A API recebe `multipart/form-data` em stream (sem buffer) e envia ao S3 com `Upload` da lib-storage.
- **Pros:** Cliente simples (um POST); controle total no servidor.
- **Cons:** Segura a API durante todo o envio (exatamente o que o enunciado proíbe); sem retomada; um proxy ou timeout no meio derruba os 10GB.

**Recommendation:** Option A — é a única que tira o arquivo da API, atende retomada e usa a capacidade que o storage já oferece; o custo é validação de tamanho na finalização e o handshake de três chamadas (iniciar → partes → finalizar). A finalização (`POST /videos/:id/complete`, chamada pelo cliente) também dispara o enfileiramento do processamento, por ser o único ponto em que a API sabe que o objeto está inteiro.

**Decision:** A (Multipart S3 com URLs pré-assinadas, upload direto ao storage)
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
**Revisions:**
- 2026-10-25 — Esclarece que "sem impacto na performance" significa que a API não recebe bytes de vídeo (só o handshake de iniciar, assinar e finalizar) e permanece responsiva durante o upload. Verificação: teste automatizado com arquivo grande porém viável (cerca de 100–500MB) que prova o fluxo e a API responsiva; o teste real de 10GB fica como roteiro manual documentado. Rationale: dá critério verificável ao requisito de 10GB (AMB-1 do validation.md da fase).

---

## TD-04: Execução do worker e extração de metadados/thumbnail

**Scope:** Repo-wide

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O diagrama prevê um "Video Worker (FFmpeg)" separado, que consome a fila, lê e grava no storage e atualiza o banco. A imagem atual (`Dockerfile.dev`, `node:25.6.0-slim`) não tem FFmpeg. A decisão afeta Compose, Dockerfile, variáveis de ambiente e o contrato de fila.

**Options:**

### Option A: Mesmo código-base NestJS, entrypoint de worker, serviço próprio no Compose
- Um `src/worker.ts` sobe `NestFactory.createApplicationContext` com o módulo do processor, reutilizando entidades, repositórios e config do backend. O Compose ganha um serviço `video-worker` com FFmpeg instalado na imagem. `ffprobe` extrai duração e metadados; `ffmpeg` extrai um frame.
- **Pros:** Reuso total de entidades, config (Joi) e repositórios; um único `package.json`; processo isolado da API, então o processamento pesado não afeta as requisições.
- **Cons:** O worker herda as dependências da API (imagem maior); exige um segundo comando de start e uma imagem com FFmpeg (separada ou compartilhada com a API).

### Option B: Pacote/projeto separado (`video-worker/`) com seu próprio `package.json`
- Subprojeto independente, que fala com banco e storage por conta própria.
- **Pros:** Imagem enxuta; fronteira de deploy nítida.
- **Cons:** Duplica entidades/config ou exige um pacote compartilhado; novo subprojeto fora do monorepo atual e das regras `.claude/rules`; mais retrabalho para o mesmo resultado.

### Option C: Processamento dentro do processo da API (processor in-process)
- O processor da fila roda no mesmo processo Nest da API.
- **Pros:** Nenhuma infra nova de execução.
- **Cons:** FFmpeg compete por CPU com a API; contradiz o diagrama e o requisito de não impactar a performance.

**Recommendation:** Option A — o reuso do código-base do Nest é o menor caminho com a separação de processo exigida; o FFmpeg entra numa imagem de worker dedicada (Dockerfile próprio) para não inflar a imagem da API.

**Decision:** A (Mesmo código-base NestJS, entrypoint de worker, serviço próprio no Compose)

---

## TD-05: Origem dos bytes do vídeo para o FFmpeg no worker

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O arquivo pode ter 10GB. O worker precisa de duração, metadados e um frame. A forma de entregar o arquivo ao FFmpeg define consumo de disco, tempo e falhas.

**Options:**

### Option A: FFmpeg/ffprobe lendo direto de uma URL pré-assinada (HTTP Range)
- O worker gera uma URL de leitura temporária e passa ao `ffprobe`/`ffmpeg` como entrada; o FFmpeg lê só os trechos necessários por requisições Range.
- **Pros:** Nenhum download de 10GB; sem disco temporário grande; rápido para extrair um frame.
- **Cons:** Depende do storage responder bem a Range; arquivos com `moov` no fim exigem leituras extras; a URL precisa valer mais que o job; o worker roda na rede do Compose, então assina e lê com o endpoint **interno** do TD-08 (`S3_ENDPOINT`), nunca com o endpoint público, que só serve a URLs entregues ao cliente.

### Option B: Baixar o arquivo para disco temporário e processar localmente
- O worker baixa o objeto inteiro, roda o `ffprobe`/`ffmpeg` no arquivo local e apaga depois.
- **Pros:** Comportamento previsível; sem dependência de Range.
- **Cons:** 10GB de disco por job simultâneo e minutos de download antes de começar; falha se o volume encher; custo desnecessário para extrair metadados e um frame.

**Recommendation:** Option A — o objetivo é só metadados e um frame, que não exigem o arquivo inteiro; reduz disco e latência. Mantém-se a Option B como fallback se o spike do TD-02 mostrar Range instável.

**Decision:** A (FFmpeg/ffprobe lendo de URL pré-assinada com Range)

---

## TD-06: Esquema da URL única por vídeo

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** O plano pede uma URL **curta** e única, que nunca conflite com outra (Pontos de Atenção). O identificador aparece em rotas públicas e é independente do `id` interno.

**Options:**

### Option A: ID curto aleatório (base62, ~11 caracteres) com índice único e retry
- Coluna `public_id` única, gerada com bytes criptograficamente aleatórios; em colisão (improvável) o insert falha pela constraint e é refeito.
- **Pros:** Curto e não enumerável; unicidade garantida pelo banco, não pela probabilidade.
- **Cons:** Exige tratar a violação de unicidade com retry; um campo a mais além do `id`.

### Option B: UUID v4 como identificador público
- Reaproveita o `id` uuid da entidade na URL.
- **Pros:** Nenhum campo extra; sem lógica de colisão.
- **Cons:** 36 caracteres, não é "curta"; expõe a chave primária.

### Option C: ID sequencial codificado (Hashids/Sqids)
- Codifica o `id` numérico em string curta reversível.
- **Pros:** Curto; sem colisão por construção.
- **Cons:** Enumerável por quem descobrir o salt; exige chave sequencial (hoje as entidades usam uuid); acopla a URL ao banco.

**Recommendation:** Option A — atende "curta" e "sem conflito" com a unicidade garantida pelo banco, e não expõe o id interno; o retry cobre o caso raro de colisão.

**Decision:** A (ID curto aleatório base62 com índice único e retry)

---

## TD-07: Entrega de streaming e download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)"; "Download do vídeo pelo usuário"

**Context:** O player precisa de requisições Range (`206 Partial Content`) para começar sem baixar tudo. O diagrama mostra o frontend lendo do storage ("Streams"). O download precisa de `Content-Disposition: attachment`. O contrato envolve o endpoint da API e o comportamento do player.

**Options:**

### Option A: API devolve URL pré-assinada de leitura (redirect ou JSON); o storage serve os bytes
- `GET /videos/:publicId/stream` valida o vídeo (status `ready`) e responde com redirect 302 (ou a URL) para um GET pré-assinado de curta duração; o storage trata Range nativamente. O download usa a mesma ideia com `response-content-disposition=attachment`.
- **Pros:** Os bytes não passam pela API; Range e cache ficam com o storage; coerente com o diagrama.
- **Cons:** URL expira (o player precisa renovar em vídeos longos); depende do TD-08 para o host; a autorização é verificada só ao emitir a URL.

### Option B: API faz proxy do stream com suporte a Range
- A API lê do S3 com `Range` e repassa `206` ao cliente.
- **Pros:** Autorização em cada requisição; esconde o storage do cliente.
- **Cons:** Todo o tráfego de vídeo passa pelo Node (CPU, conexões, banda); contradiz "Frontend → Storage" do diagrama.

### Option C: Transcodificar para HLS/DASH
- O worker gera segmentos adaptativos e playlist.
- **Pros:** Streaming adaptativo.
- **Cons:** Transcodificação está **fora do escopo** das capacidades da fase (só metadados e thumbnail); custo alto de CPU e armazenamento.

**Recommendation:** Option A — mantém os bytes fora da API e usa o Range nativo do storage; a Option C é uma evolução futura e não faz parte das capacidades desta fase.

**Decision:** A (URL pré-assinada de leitura; o storage serve os bytes)
**Revisions:**
- 2026-10-25 — Esclarece que streaming e download só respondem para vídeos `ready` (leitura anônima livre, como no projeto). Vídeos em `draft`, `processing` ou `error` retornam não encontrado ao público; o dono do canal, autenticado, consulta o status e o erro do próprio vídeo. Visibilidade pública/não listada fica na Fase 04. Rationale: fixa a regra de acesso que a Authorization Matrix precisa (AMB-3 do validation.md da fase).

---

## TD-08: Endereçamento do storage em URLs pré-assinadas (host interno vs público)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"; "Reprodução via streaming (sem necessidade de download completo)"; "Download do vídeo pelo usuário"

**Context:** Pelo `CLAUDE.md`, os serviços falam entre si pelo nome do serviço do Compose (por exemplo `storage:9000`). Mas URLs pré-assinadas **incluem o host na assinatura** e são abertas pelo navegador, que não resolve `storage`. É um contrato entre `.env`, Joi, `compose.yaml` e o cliente.

**Options:**

### Option A: Dois endpoints configuráveis (interno e público)
- `S3_ENDPOINT` (nome do serviço, usado por API e worker) e `S3_PUBLIC_ENDPOINT` (por exemplo `http://localhost:9000`, usado só para assinar URLs entregues ao cliente), com dois clientes S3.
- **Pros:** Respeita a regra de Docker para tráfego servidor↔servidor; em produção os dois podem coincidir; mudança só de configuração.
- **Cons:** Dois clientes e duas variáveis a manter; o endpoint público do storage precisa estar publicado no host.

### Option B: Um endpoint só, resolvendo o nome do serviço no host (`/etc/hosts`)
- Mapeia `storage` para `127.0.0.1` na máquina do desenvolvedor.
- **Pros:** Uma configuração só.
- **Cons:** Exige edição manual fora do repositório; frágil entre máquinas e no CI.

### Option C: Tudo via proxy da API
- O navegador nunca fala com o storage.
- **Pros:** Sem problema de host.
- **Cons:** Anula TD-03 e TD-07 (bytes passam pela API).

**Recommendation:** Option A — é o padrão para presigned URLs em ambientes containerizados e preserva a regra do `CLAUDE.md` para o tráfego interno.

**Decision:** A (Dois endpoints: interno e público)

---

## TD-09: Ciclo de status do vídeo e tratamento de falhas

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"; "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O enunciado pede o ciclo rascunho → processando → pronto/erro refletido no banco, e que a fase decida o que ocorre numa falha. Há três riscos: job que falha, upload abandonado (partes órfãs no storage) e job perdido entre o commit no banco e a publicação na fila. Publicação, edição e visibilidade pertencem à Fase 04 e ficam fora.

**Options:**

### Option A: Enum único `draft → processing → ready | error`, retry na fila e rotina de reconciliação
- `draft` ao iniciar o upload; `processing` ao finalizar e enfileirar; `ready` quando metadados e thumbnail estão gravados; `error` (com `error_reason`) após esgotar as tentativas (por exemplo 3, com backoff exponencial). Uma rotina periódica reenfileira vídeos presos em `processing` sem job e aborta uploads em `draft` mais velhos que um TTL (`AbortMultipartUpload`).
- **Pros:** Bate com o enunciado; falha visível e diagnosticável; cobre os três riscos; jobs idempotentes por `jobId = id do vídeo`.
- **Cons:** `draft` mistura "aguardando upload" e "rascunho de publicação" que a Fase 04 vai usar; a rotina de reconciliação é código a mais.

### Option B: Dois eixos — estado de upload/processamento separado do estado de publicação
- `upload_status` (`pending_upload → uploaded → processing → ready | failed`) mais um campo de publicação reservado à Fase 04.
- **Pros:** Sem sobrecarga semântica de `draft`.
- **Cons:** Antecipa o modelo de publicação da Fase 04; mais campos agora; diverge do ciclo descrito no enunciado.

### Option C: Status mínimo (`processing | ready | error`), sem reconciliação
- Sem `draft` explícito e sem limpeza de uploads abandonados.
- **Pros:** Mais simples.
- **Cons:** Não atende "pré-cadastro como rascunho"; deixa partes órfãs ocupando storage e jobs perdidos sem recuperação.

**Recommendation:** Option A — segue o ciclo pedido, cobre falha, upload abandonado e job perdido; a ambiguidade de `draft` é aceita e fica registrada para a Fase 04 decidir se separa os eixos.

**Decision:** A (Enum único draft→processing→ready|error, retry na fila e reconciliação)
**Revisions:**
- 2026-10-25 — Esclarece que o `draft` da Fase 03 é apenas o registro e o status do pipeline: status inicial `draft`, título provisório igual ao nome do arquivo e dono igual ao canal. Visibilidade, descrição editável e publicação ficam na Fase 04. Rationale: delimita a fronteira com o fluxo de rascunho e publicação da Fase 04 (AMB-2 do validation.md da fase).

---

## TD-10: Política de formatos aceitos no upload

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** No handshake do TD-03 o cliente declara nome e tipo do arquivo antes de enviar as partes, e a API assina as URLs com base nisso. Nenhuma decisão define o que é aceito: sem uma política, um arquivo qualquer de 10GB seria enviado ao storage e só falharia no worker. A política afeta o contrato de iniciar o upload (validação do tipo declarado), o `Content-Type` assinado nas URLs e o tratamento de arquivo que não é vídeo (estado `error` do TD-09).

**Options:**

### Option A: Lista permitida de tipos na API + confirmação pelo `ffprobe` no worker
- Ao iniciar o upload, a API valida a extensão e o MIME declarados contra uma lista configurável (por exemplo `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`) e rejeita o resto com erro de validação, antes de criar o multipart. Depois, o worker usa o `ffprobe` e marca `error` se não houver stream de vídeo.
- **Pros:** Falha cedo e barato para o caso comum (tipo errado); o `ffprobe` cobre o declarado que não corresponde ao conteúdo; a lista fica em configuração, sem mudar código.
- **Cons:** O tipo declarado pelo cliente é falsificável, então a checagem inicial é só um filtro; a lista precisa de manutenção e de uma decisão sobre quais formatos entram.

### Option B: Aceitar qualquer arquivo e deixar o `ffprobe` decidir
- A API não valida o tipo; o worker rejeita o que não for vídeo.
- **Pros:** Nada para configurar; nenhum formato legítimo é bloqueado por engano.
- **Cons:** Arquivos de até 10GB que não são vídeo percorrem upload e fila antes de falhar; o erro só aparece depois do processamento; abre o storage para qualquer conteúdo.

### Option C: Lista permitida + inspeção dos primeiros bytes (assinatura do arquivo) antes de enfileirar
- Além da Option A, ao finalizar o upload a API lê os primeiros bytes do objeto por Range e confere a assinatura do formato.
- **Pros:** Não depende do tipo declarado; rejeita antes de ocupar o worker.
- **Cons:** Mais código e uma leitura extra no storage na finalização; a verificação por assinatura cobre menos formatos que o `ffprobe`, então ainda é preciso confirmar no worker.

**Recommendation:** Option A — filtra cedo o caso comum, mantém a lista em configuração e usa o `ffprobe`, que já existe no worker (TD-04), como verificação definitiva. O custo de falsificar o tipo declarado é só ocupar uma vaga do worker até o job falhar para `error`.

**Decision:** A (Lista permitida na API + confirmação pelo ffprobe no worker)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia da fila | A (BullMQ + Redis) | A (BullMQ + Redis) |
| TD-02 | Repo-wide | Servidor S3-compatível (Docker) | B (SeaweedFS, após spike) | B (SeaweedFS) |
| TD-03 | Cross-layer | Estratégia e protocolo de upload | A (multipart pré-assinado direto ao storage) | A (Multipart pré-assinado) |
| TD-04 | Repo-wide | Execução do worker | A (mesmo código-base, serviço próprio) | A (Mesmo código-base, serviço próprio) |
| TD-05 | Backend | Origem dos bytes para o FFmpeg | A (leitura por URL pré-assinada, Range) | A (URL pré-assinada com Range) |
| TD-06 | Backend | URL única por vídeo | A (ID curto aleatório + unique) | A (ID curto aleatório) |
| TD-07 | Cross-layer | Streaming e download | A (URL pré-assinada, storage serve os bytes) | A (URL pré-assinada de leitura) |
| TD-08 | Cross-layer | Host do storage em URLs pré-assinadas | A (endpoint interno + público) | A (Dois endpoints) |
| TD-09 | Backend | Ciclo de status e falhas | A (enum único + retry + reconciliação) | A (Enum único + retry + reconciliação) |
| TD-10 | Backend | Política de formatos aceitos no upload | A (lista permitida na API + `ffprobe` no worker) | A (Lista permitida + ffprobe) |
