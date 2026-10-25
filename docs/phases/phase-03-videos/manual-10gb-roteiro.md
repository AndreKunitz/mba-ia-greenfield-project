# Roteiro manual — upload de 10GB

Prova o requisito central da Fase 03: um arquivo de até 10GB sobe **direto para o storage**, sem passar pela API. Os testes automáticos cobrem ~335 MB; este roteiro cobre o tamanho real do limite.

**Premissas:** ambiente no ar (`docker compose up -d` em `nestjs-project/`, com `nestjs-api`, `db`, `redis`, `storage` e `video-worker` saudáveis), API em `http://localhost:3000`, ~25 GB livres em disco (o arquivo + o objeto no volume `storage-data`) e um usuário confirmado com canal (`access_token` válido).

## 1. Gerar o arquivo de 10GB

O conteúdo precisa ser um vídeo válido para chegar a `ready`. Um arquivo de zeros só prova o upload (terminaria em `error`/`invalid_media`, o que também é um resultado válido para este teste).

```bash
# Opção A — só o upload (rápido): 10 GiB de zeros
head -c 10737418240 /dev/zero > /tmp/big.mp4

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

Pegue as URLs em lotes (a API assina, o `curl` envia os bytes ao storage):

```bash
for batch in $(seq 0 15); do
  start=$((batch*10+1)); end=$((batch*10+10))
  curl -s -X POST http://localhost:3000/videos/$PUBLIC_ID/upload-urls \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"part_numbers\":[$(seq -s, $start $end)]}" > urls-$batch.json
done
```

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

## 5. Registrar o resultado

Preencha abaixo e comite junto da fase.

| Item | Resultado |
|------|-----------|
| Data / máquina / disco |  |
| Tamanho do arquivo (bytes) / partes |  |
| Tempo total do upload |  |
| `GET /` durante o upload (todos 200? maior tempo) |  |
| Memória de `nestjs-api` antes → pico durante o upload |  |
| Status final / tempo até `ready` |  |
| Range `bytes=0-99` → 206? |  |
| Observações |  |

## 6. Limpeza

```bash
rm /tmp/big.mp4 urls-*.json
# Remove o objeto de 10GB do storage (escolha uma):
docker compose down -v        # apaga TODOS os volumes, inclusive o banco
# ou apague só o vídeo via S3 (aws cli / mc) apontando para http://localhost:8333
```
