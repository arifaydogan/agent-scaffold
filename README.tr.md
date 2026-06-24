# agent-scaffold

Jira'dan gelen yazilim islerini persona, skill ve task agent katmanlariyla
yonetmek icin tasarlanmis, tekrar kullanilabilir AI ekip scaffold'u.

Bu reponun ana fikri JavaScript runtime degildir. Ana calisma modeli:
[ORCHESTRATION.md](ORCHESTRATION.md).

Model, `alirezarezvani/claude-skills` reposundaki hafif orchestration
protokolunu temel alir:

- Persona: O fazda kim dusunuyor?
- Skill: Is nasil yapiliyor?
- Task agent: Hangi sinirli is yapiliyor?
- Phase: Hangi cikti tamamlanacak?
- Handoff: Sonraki faza ne aktarilacak?

## Neler Var?

- Her fazda tek aktif persona
- Birlikte yuklenebilen birden fazla skill
- Backend, frontend, QA, security, data ve CV task agentlari
- Zorunlu phase handoff formati
- Jira ve Confluence calisma kurallari
- Git worktree modeli
- Antigravity, Claude Code ve Copilot adapter'lari
- PaceBuild extension pack
- Opsiyonel Jira/worktree/Codex otomasyon runtime'i

## Hizli Baslangic

### 1. Orchestration modelini oku

[ORCHESTRATION.md](ORCHESTRATION.md)

### 2. Hedefi tanimla

```text
Objective: PACE-123 taskini acceptance criteria'ya uygun teslim et.
Constraints: Epic degistirme, Done yapma, merge etme.
Success criteria: Testler gecer, PR ve Jira handoff hazir.
```

### 3. Ilk fazi sec

```text
Phase 0: Intake ve Scope
Persona: product-manager
Skills:
  - senior-pm
  - jira-expert
  - confluence-expert
Task agent: pm-analyst
```

### 4. Faz sonunda handoff yaz

```text
Phase 0 complete.
Objective: PACE-123 kapsam ve kabul kriterlerini netlestirmek.
Persona: product-manager
Skills: senior-pm, jira-expert
Task agent: pm-analyst
Decisions: [...]
Artifacts: [...]
Verification: [...]
Open items: [...]
Switching to: startup-cto + senior-architect, senior-backend
Human approval needed: hayir
```

## Persona Katalogu

| Persona | Ne zaman kullanilir? |
| --- | --- |
| `product-manager` | Scope, PRD, Jira, kabul kriteri, oncelik |
| `startup-cto` | Mimari, teknik trade-off, uygulama ve review |
| `devops-engineer` | CI/CD, container, deployment, monitoring |
| `solo-founder` | Tek kisilik MVP, zaman ve kapsam kararlari |

Dosyalar: `core/personas/`

## Task Agentlar

| Task agent | Sorumluluk |
| --- | --- |
| `architect` | Sistem tasarimi ve ADR |
| `backend-engineer` | API, domain, veritabani |
| `frontend-engineer` | UI, stream, client entegrasyonu |
| `devops-engineer` | Container, CI/CD, operasyon |
| `qa-engineer` | Test ve bagimsiz verification |
| `pm-analyst` | Jira, Confluence, gereksinim |
| `security-engineer` | Guvenlik review |
| `data-engineer` | Pipeline ve zaman serisi |
| `cv-engineer` | PaceBuild CV pipeline |

## Gercek Upstream Skill'ler

`SKILL_SOURCE.md` stub'lari kaldirildi. Asagidaki skill'ler script, reference,
profile ve asset dosyalariyla birlikte repo icindedir:

- senior-architect
- senior-backend
- senior-frontend
- senior-devops
- senior-data-engineer
- senior-computer-vision
- tdd-guide
- security-pen-testing
- senior-pm
- jira-expert
- confluence-expert

Kaynak ve lisans:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## Kurulum

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/arifaydogan/agent-scaffold/master/install.ps1 | iex
```

Linux/macOS/WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/arifaydogan/agent-scaffold/master/install.sh | bash
```

Kurulum secenekleri:

- Core veya Core + PaceBuild
- Antigravity, Claude Code, Copilot veya tum adapter'lar
- Git hook kurulumu

## JavaScript Dosyalari Ne Yapiyor?

`bin/`, `lib/`, `package.json` ve `test/` altindaki dosyalar opsiyonel otomasyon
MVP'sidir. Su isleri otomatiklestirmek icin eklendi:

- Jira'dan `agent-ready` task arama
- Epic, label ve acceptance criteria kontrolu
- Ayni taskin iki kez alinmasini engelleyen SQLite lock
- Persona ve skill route onerisi
- Git worktree plani
- Codex CLI calistirma
- Run durumunu kaydetme

Bu runtime olmadan da orchestration modeli kullanilabilir. Detayli kullanim:
[docs/KULLANIM_KILAVUZU.tr.md](docs/KULLANIM_KILAVUZU.tr.md)

## Dogrulama

```powershell
npm.cmd run check
```

Bu komut:

- Agent, persona ve skill envanterini kontrol eder
- `SKILL_SOURCE.md` kalmadigini dogrular
- Runtime testlerini calistirir

## Insan Onayi Gereken Islemler

Agentlar otomatik olarak sunlari yapamaz:

- Epic degistirmek
- Jira taskini Done yapmak
- Pull request merge etmek
- Etiketsiz backlog taski almak
- Production credential degistirmek
- Basarisiz testi atlamak
