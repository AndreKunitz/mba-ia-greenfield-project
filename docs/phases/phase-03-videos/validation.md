---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-25T16:15:00-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-25T16:11:17-0300"
issues:
  - id: AMB-1
    status: resolved
    summary: "'Sem impacto na performance' no upload de 10GB não tem critério verificável"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Fronteira entre rascunho (Fase 03) e fluxo de rascunho/publicação (Fase 04)"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Quem pode fazer streaming/download de vídeo que não está pronto"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "Política de formatos e tipos de arquivo aceitos no upload"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-1
    status: resolved
    summary: "phase-03-videos/TD-01 pendente — tecnologia da fila"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "phase-03-videos/TD-02 pendente — servidor S3-compatível"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "phase-03-videos/TD-03 pendente — estratégia e protocolo de upload"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "phase-03-videos/TD-04 pendente — execução do worker"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "phase-03-videos/TD-05 pendente — origem dos bytes para o FFmpeg"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "phase-03-videos/TD-06 pendente — URL única por vídeo"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "phase-03-videos/TD-07 pendente — streaming e download"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "phase-03-videos/TD-08 pendente — host do storage em URLs pré-assinadas"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "phase-03-videos/TD-09 pendente — ciclo de status e falhas"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "phase-03-videos/TD-10 pendente — política de formatos aceitos no upload"
    resolved_by: phase-03-videos/TD-10
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — "Sem impacto na performance" no upload de 10GB. Esclarecimento do usuário: "sem impacto" significa que a API não recebe bytes de vídeo (só o handshake de iniciar/assinar/finalizar) e continua respondendo durante o upload. Verificação: teste automatizado com arquivo grande porém viável (cerca de 100–500MB) que prova o fluxo e a API responsiva; o teste real de 10GB fica como roteiro manual documentado. Registrado também como Revision do TD-03.
- **AMB-2** _(resolved_by clarification)_ — Fronteira entre rascunho (Fase 03) e fluxo de rascunho/publicação (Fase 04). Esclarecimento do usuário: a Fase 03 entrega só o registro e o status do pipeline (status inicial `draft`, título provisório como o nome do arquivo, dono = canal). Visibilidade, descrição editável e publicação ficam na Fase 04. Registrado também como Revision do TD-09.
- **AMB-3** _(resolved_by clarification)_ — Acesso a vídeo que não está pronto. Esclarecimento do usuário: streaming e download só respondem para vídeos `ready` (leitura anônima livre, como no projeto). Vídeos em `draft`, `processing` ou `error` retornam não encontrado ao público; o dono do canal, autenticado, consulta o status e o erro do próprio vídeo. Visibilidade pública/não listada fica na Fase 04. Registrado também como Revision do TD-07.
- **MD-1** _(resolved_by phase-03-videos/TD-10)_ — Política de formatos e tipos de arquivo aceitos no upload.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — Tecnologia da fila: A (BullMQ + Redis).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — Servidor S3-compatível: B (SeaweedFS, sujeito a spike).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — Upload: A (multipart pré-assinado direto ao storage).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — Worker: A (mesmo código-base, serviço próprio).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — Entrada do FFmpeg: A (URL pré-assinada com Range).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — URL única: A (ID curto aleatório base62).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — Streaming/download: A (URL pré-assinada de leitura).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — Host do storage: A (dois endpoints, interno e público).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — Status e falhas: A (enum único, retry e reconciliação).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — Formatos: A (lista permitida na API + ffprobe no worker).
