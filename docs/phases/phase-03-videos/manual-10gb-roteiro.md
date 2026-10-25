# Roteiro manual — upload de 10GB

Prova o requisito central da Fase 03: um arquivo de até 10GB sobe **direto para o storage**, sem passar pela API. Os testes automáticos cobrem ~335 MB; este roteiro cobre o tamanho real do limite.

**Premissas:** ambiente no ar (`docker compose up -d` em `nestjs-project/`, com `nestjs-api`, `db`, `redis`, `storage` e `video-worker` saudáveis), API em `http://localhost:3000`, ~25 GB livres em disco (o arquivo + o objeto no volume `storage-data`) e um usuário confirmado com canal (`access_token` válido).

## 1. Gerar o arquivo de 10GB

O conteúdo precisa ser um vídeo válido para chegar a `ready`. Um arquivo de zeros só prova o upload (terminaria em `error`/`invalid_media`, o que também é um resultado válido para este teste).

```bash
# Opção A — só o upload (rápido): 10 GiB de zeros
head -c 10737418240 /dev/zero > /tmp/big.mp4

# Opção C — vídeo válido de 10 GiB, rápido: um mp4 pequeno (moov no início) estendido com
# truncate. O ffprobe lê a duração do mp4 e o tamanho total; o arquivo é esparso no disco.
ffmpeg -f lavfi -i testsrc=duration=20:size=640x360:rate=25 -f lavfi -i sine=duration=20 \
  -c:v libx264 -c:a aac -movflags +faststart /tmp/big.mp4 && truncate -s 10737418240 /tmp/big.mp4

# Opção B — vídeo real (lento): ruído H.264 até ~10 GiB
ffmpeg -f lavfi -i "nullsrc=size=1920x1080:rate=30,geq=random(1)*255:128:128" \
  -t 1800 -c:v libx264 -crf 8 -pix_fmt yuv420p /tmp/big.mp4
stat -f%z /tmp/big.mp4   # tamanho exato em bytes (macOS); no Linux: stat -c%s
```

Anote o tamanho exato em bytes (`SIZE`). Para chegar a 160 partes de 64 MiB, `SIZE` deve ficar entre 159×64 MiB e 160×64 MiB (10 GiB = 10 737 418 240 B = 160 partes exatas).

## 2. Criar o rascunho

```bash
curl -s -X POST http://localhost:3000/videos \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"filename\":\"big.mp4\",\"content_type\":\"video/mp4\",\"size_bytes\":$SIZE}"
```

Esperado: `201`, `part_size_bytes` = 67108864, `part_count` = 160. Guarde `public_id`.

## 3. Enviar as 160 partes direto ao storage

Peça **todas** as URLs numa única chamada (a API assina, o `curl` envia os bytes ao storage). O `ThrottlerGuard` global limita a 10 requisições por minuto por IP e `upload-urls` não é isento: assinar em lotes de 10 partes dá 16 chamadas e a 11ª recebe `429` (aconteceu na execução registrada abaixo). O DTO aceita até 10 000 partes por chamada.

```bash
curl -s -X POST http://localhost:3000/videos/$PUBLIC_ID/upload-urls \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"part_numbers\":[$(seq -s, 1 160)]}" > urls.json
```

As URLs valem 15 min (`VIDEO_UPLOAD_URL_TTL_SECONDS`); numa rede lenta, assine de novo as partes que faltarem.

Para cada parte `N` (`1..160`): extraia o trecho `dd if=/tmp/big.mp4 bs=67108864 skip=$((N-1)) count=1` e envie com
`curl -X PUT -T <trecho> -D - "<url da parte N>"`. **Guarde o header `ETag` de cada resposta** — o `complete` exige a lista `{part_number, etag}` completa.

Se o envio for interrompido, `GET /videos/$PUBLIC_ID/upload` mostra as partes já recebidas; reenvie só as que faltam (as URLs duram 15 min; peça novas se vencerem).

**Durante o envio, em outro terminal**, confirme que a API segue viva e leve:

```bash
while true; do curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" http://localhost:3000/; sleep 1; done
docker stats --no-stream nestjs-api   # memória da API
```

## 4. Finalizar e acompanhar

```bash
curl -s -X POST http://localhost:3000/videos/$PUBLIC_ID/complete \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"parts":[{"part_number":1,"etag":"..."}, ... ,{"part_number":160,"etag":"..."}]}'   # 202

watch -n 2 "curl -s http://localhost:3000/videos/$PUBLIC_ID/status -H 'Authorization: Bearer $TOKEN'"
docker compose logs -f video-worker
```

Esperado: `processing` → `ready` (opção B) com `duration_seconds` e thumbnail; o `ffprobe` lê o objeto por `Range`, sem baixar os 10GB. Depois: `GET /videos/$PUBLIC_ID/stream` (302) e um `curl -H "Range: bytes=0-99"` na URL devolvida (206).

## 5. Resultado registrado

Execução de 2026-10-25, dentro do container `nestjs-api` (Docker Desktop no macOS, stack recém-criada com `docker compose down -v && up -d`), arquivo da opção C. Os `curl` rodaram no mesmo container com `--connect-to localhost:8333:storage:8333`, para a assinatura (feita para `localhost:8333`) continuar válida.

| Item | Resultado |
|------|-----------|
| Tamanho do arquivo / partes | 10 737 418 240 bytes (10 GiB) / 160 partes de 64 MiB |
| Tempo do upload | partes 1–100 em 24 s e 101–160 em 14 s (≈ 38 s no total; disco local, sem rede real); houve uma pausa de ≈ 60 s porque a 11ª assinatura levou `429` (ver item 3) |
| `GET /` durante o upload | 206 sondagens (1 por segundo): todas `200`, pior tempo 3,1 ms |
| Memória de `nestjs-api` | amostras de `docker stats` (não contínuas): ≈ 716 MiB antes e durante o início do envio, ≈ 552 MiB logo depois. Nenhum crescimento perto dos 10 GiB enviados |
| `complete` | `202` com as 160 partes; `ready` na 2ª consulta de `status` (< 2 s) |
| Duração e metadados | `duration_seconds` = 20; h264 640×360 + aac; `size_bytes` = 10737418240 (lido pelo `ffprobe` por `Range`) |
| `stream` com `Range: bytes=0-99` | `302` → `206`, 100 bytes |
| `thumbnail` | `302` → `200 image/jpeg`, 19 816 bytes |
| `download` | `302` com `attachment; filename="big.mp4"` → `206` ao pedir 1 byte |
| Observações | o arquivo é esparso e o conteúdo além do mp4 original são zeros; vale como prova de upload, enfileiramento e leitura por `Range` de 10 GiB, não de decodificação de 10 GiB de vídeo. O espaço no storage foi liberado ao final |

## 6. Limpeza

```bash
rm /tmp/big.mp4 urls.json
# Remove o objeto de 10GB do storage (escolha uma):
docker compose down -v        # apaga TODOS os volumes, inclusive o banco
# ou apague só o vídeo via S3 (aws cli / mc) apontando para http://localhost:8333
```
