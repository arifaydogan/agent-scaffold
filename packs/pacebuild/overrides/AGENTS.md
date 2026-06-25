# PaceBuild Agent Extension

Bu dosya ana `ORCHESTRATION.md` protokolunu degistirmez.
PaceBuild'e ozel task agent, skill, risk ve faz baglamini ekler.

## Zorunlu Calisma Sirasi

1. Istek bir `PACE-XX`, Jira task/epic basligi veya Jira isi iceriyorsa
   repository kokundeki `PACEBUILD_ORCHESTRATOR.md` dosyasini oku ve uygula.
2. Adapter destekliyorsa `pacebuild-orchestrator` wrapper skill/agent'ini
   yukle; workflow kurallarini wrapper'dan degil kanonik dosyadan al.
3. Ana `ORCHESTRATION.md` dosyasini oku.
4. Her faz icin tek persona sec.
5. Gerekli skill'leri birlikte yukle.
6. En dar kapsamli task agent'i sec.
7. Zorunlu phase handoff formatini kullan.
8. Kanonik dosyadaki exact approval token olmadan sonraki faza gecme.

## PaceBuild Ek Task Agenti

| Task agent | Scope |
| --- | --- |
| `cv-engineer` | YOLO, ByteTrack, OpenCV, frame dedup, bounding box ve MJPEG |

## PaceBuild Skill'leri

- `senior-computer-vision`
- `cv-pipeline-checks`
- `yolo-bytetrack`
- `opencv-patterns`
- `fastapi-timescale`
- `demo-reliability-guard`

## Persona Secimi

| Faz | Persona | Gerekce |
| --- | --- | --- |
| Jira refinement, acceptance criteria | `product-manager` | Scope ve olculebilir cikti |
| CV/backend/frontend teknik karar | `startup-cto` | Teknik trade-off ve MVP sadeligi |
| Docker, CI/CD, servis readiness | `devops-engineer` | Operasyon ve geri alinabilirlik |
| Demo kapsami ve zaman trade-off'u | `solo-founder` | Tek kisilik ekip ve zaman korumasi |

## Faz A Orchestration Ornegi

### Phase 0 - Walking Skeleton Scope

```text
Persona: product-manager
Skills: senior-pm, jira-expert, confluence-expert
Task agent: pm-analyst
Output: Net acceptance criteria, dependency sirasi, non-goals
```

### Phase 1 - Uctan Uca Teknik Tasarim

```text
Persona: startup-cto
Skills: senior-architect, senior-backend, senior-computer-vision
Task agent: architect
Output: Kamera -> CV -> backend -> TSDB -> frontend kontrati
```

### Phase 2A - CV Uygulama

```text
Persona: startup-cto
Skills: senior-computer-vision, cv-pipeline-checks, yolo-bytetrack
Task agent: cv-engineer
Output: Detection/tracking/event/stream degisiklikleri ve test kaniti
```

### Phase 2B - Backend ve Data

```text
Persona: startup-cto
Skills: senior-backend, fastapi-timescale, senior-data-engineer
Task agent: backend-engineer veya data-engineer
Output: API, migration, dedup ve query degisiklikleri
```

### Phase 2C - Frontend

```text
Persona: startup-cto
Skills: senior-frontend, stream-integration, frontend-testing
Task agent: frontend-engineer
Output: Gercek API/stream entegrasyonu ve gorunur hata durumlari
```

### Phase 3 - Demo Reliability Review

```text
Persona: startup-cto
Skills: tdd-guide, code-review, demo-reliability-guard
Task agent: qa-engineer
Output: Acceptance criteria sonucu, unhappy path ve blocker listesi
```

### Phase 4 - Jira ve Confluence Handoff

```text
Persona: product-manager
Skills: jira-expert, confluence-expert
Task agent: pm-analyst
Output: Jira comment, In Review handoff, proje hafizasi guncellemesi
```

## PaceBuild Kritik Kurallari

- Sessiz mock fallback yasaktir.
- Eksik config veya model dosyasi baslamadan dogrulanir.
- Ayni frame/event tekrar yazilamaz; dedup acik olmalidir.
- Kamera kopmasi, stream gecikmesi ve servis erisilemezligi gorunur olmalidir.
- Epic, Done ve merge insana aittir.
- Faz B backlog'u insan onayi olmadan alinmaz.
