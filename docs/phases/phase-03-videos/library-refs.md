---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "unavailable — fetched from official web docs (docs.nestjs.com)"
    fetched_at: "2026-10-25T16:11:19-0300"
  "bullmq":
    version: "^6.4.2"
    context7_id: "unavailable — fetched from official web docs (docs.bullmq.io)"
    fetched_at: "2026-10-25T16:11:19-0300"
  "@aws-sdk/client-s3":
    version: "^3.1156.0"
    context7_id: "unavailable — fetched from official web docs (docs.aws.amazon.com)"
    fetched_at: "2026-10-25T16:11:19-0300"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1156.0"
    context7_id: "unavailable — official page did not load; excerpt from SDK knowledge, UNVERIFIED"
    fetched_at: "2026-10-25T16:11:19-0300"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-25T16:11:17-0300"
---

# Library references — phase-03-videos

> **Proveniência.** O MCP context7, exigido pelo `CLAUDE.md`, não estava disponível na sessão que gerou este arquivo. O conteúdo vem da documentação oficial acessada pela web (com a ressalva do `@aws-sdk/s3-request-presigner` abaixo) e as versões vêm de `npm view` em 2026-10-25. Recomenda-se refazer a consulta pelo context7 quando ele estiver configurado e conferir se algo diverge.

## Versões e compatibilidade

| Pacote | Versão fixada | Observação |
|---|---|---|
| `@nestjs/bullmq` | `^12.0.0` | Peer: `@nestjs/core` e `@nestjs/common` `^10 \|\| ^11 \|\| ^12` e `bullmq` `^3 \|\| ^4 \|\| ^5 \|\| ^6`. Compatível com o NestJS 11 instalado no projeto. |
| `bullmq` | `^6.4.2` | `engines.node >= 14.17`. |
| `@aws-sdk/client-s3` | `^3.1156.0` | `engines.node >= 20`. |
| `@aws-sdk/s3-request-presigner` | `^3.1156.0` | Mesma linha de versão do `client-s3`. |

Nenhuma delas está instalada ainda (`nestjs-project/package.json`). A instalação é parte da implementação.

### @nestjs/bullmq

Fonte: <https://docs.nestjs.com/techniques/queues>

Instalação: `npm install --save @nestjs/bullmq bullmq`.

Conexão (preferir `forRootAsync` com `ConfigService`, como o resto do projeto usa `registerAs`):

```ts
BullModule.forRoot({ connection: { host: 'localhost', port: 6379 } }),
// ou
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({ /* connection: { host, port } */ }),
}),
```

Atenção ao `CLAUDE.md`: o host real é o nome do serviço do Compose (por exemplo `redis`), nunca `localhost`.

Registro de fila e produção de job:

```ts
BullModule.registerQueue({ name: 'video-processing' }),

await this.queue.add('process', { videoId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  jobId: `video-${videoId}`,
});
```

Opções relevantes (doc oficial): `attempts` ("número total de tentativas, padrão 1"), `backoff` (número ou objeto `BackoffOptions`), `jobId` (substitui o id gerado; um job com id já existente **não é adicionado**).

Consumidor:

```ts
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* ... */ }
}
```

O `process()` roda quando o worker está ocioso e há jobs esperando. O processor é um provider do módulo. A doc também descreve rodar o processor em processo separado por arquivo (`processors: [path]`), mas nesse modo **a injeção de dependência não está disponível**. O TD-04 escolhe o outro caminho: o mesmo código-base Nest num entrypoint próprio (`createApplicationContext`), que mantém a DI.

### bullmq

Fontes: <https://docs.bullmq.io/guide/retrying-failing-jobs> e <https://docs.bullmq.io/guide/jobs/job-ids>

Retry e backoff:
- Retry vem desligado; `attempts > 1` o ativa. Sem `backoff`, a nova tentativa é imediata.
- `exponential`: espera `2^(tentativa-1) * delay` ms (com `delay: 1000` e `attempts: 3`, cerca de 1s, 2s e 4s). `fixed`: espera `delay` constante. Ambos aceitam `jitter` entre 0 e 1.
- Estratégia `custom` via `backoffStrategy` no Worker; retornar `-1` encerra as tentativas e move o job para `failed`.
- `attempts` e `backoff` podem ir em `defaultJobOptions` da fila.
- O job vai para `failed` quando o processor lança exceção, ou quando trava e excede o máximo de travamentos. A doc consultada não detalha o instante exato em que as tentativas se esgotam; o TD-09 deve tratar o evento `failed` para gravar `error` e `error_reason`.

`jobId` e deduplicação:
- Um `jobId` já existente na fila faz o novo job ser **ignorado** (usado para deduplicar). O escopo é por fila.
- Job removido (manual ou por `removeOnComplete`/`removeOnFail`) deixa de contar como duplicado e o id pode ser reutilizado.
- Não usar `:` no id (separador de chave do Redis) e não usar string só de dígitos (lança `Custom Id cannot be integers`). Usar um prefixo, por exemplo `video-<uuid>`.

Consequência para o TD-09: a idempotência por `jobId = video-<id>` vale enquanto o job existir. Se `removeOnComplete`/`removeOnFail` estiverem ligados, um reenfileiramento da reconciliação cria um job novo, o que é o comportamento desejado para um vídeo preso.

### @aws-sdk/client-s3

Fonte dos limites: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html> (confirmado)

Limites do multipart upload:

| Item | Valor |
|---|---|
| Tamanho máximo do objeto | 48,8 TiB |
| Máximo de partes por upload | 10.000 |
| Numeração das partes | 1 a 10.000 |
| Tamanho da parte | 5 MiB a 5 GiB (a última parte não tem mínimo) |
| Máximo de partes numa resposta de `ListParts` | 1.000 |

Consequência para o TD-03: 10GB com partes de 64–128 MiB resulta em cerca de 80–160 partes, bem abaixo do teto de 10.000 e acima do mínimo de 5 MiB. O limite de 10GB do produto **não é imposto pelo S3** (o teto dele é muito maior); a API valida o tamanho declarado ao iniciar e confere o tamanho real com `HeadObject` ao finalizar.

Comandos usados no fluxo (nomes da API S3): `CreateMultipartUploadCommand`, `UploadPartCommand` (assinado, não executado pela API), `ListPartsCommand` (retomada), `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `HeadObjectCommand`, `GetObjectCommand` (leitura assinada e Range).

### @aws-sdk/s3-request-presigner

> **NÃO VERIFICADO.** A página oficial do pacote não carregou o conteúdo na consulta; o trecho abaixo vem do conhecimento do SDK e precisa ser conferido no context7 ou na doc oficial antes da implementação.

```ts
import { S3Client, GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });

const partUrl = await getSignedUrl(
  client,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: 1 }),
  { expiresIn: 900 },
);
```

- `expiresIn` é em segundos (padrão 900; máximo 604800 no SigV4).
- Cada URL de parte é assinada de forma independente; o presigner não impõe o tamanho total, então o teto de 10GB é regra da API.
- `signableHeaders` e `unhoistableHeaders` existem no presigner de nível mais baixo, e a disponibilidade depende da versão.
- A assinatura inclui o host do endpoint do cliente. Por isso o TD-08 usa dois clientes: o **interno** (nome do serviço do Compose, para API e worker) e o **público** (apenas para assinar URLs entregues ao navegador).
- Pontos a validar no spike do TD-02: o SeaweedFS aceitar a assinatura gerada contra o endpoint público, expor o `ETag` por CORS e responder `206` a requisições com `Range`.
