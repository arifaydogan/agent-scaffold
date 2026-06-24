# Agent Scaffold Kullanim Kilavuzu

## 1. Iki Ayri Katmani Ayir

Bu repoda iki ayri katman vardir.

### Katman A - Orchestration protokolu

Zorunlu ve ana katmandir.

Dosyalar:

- `ORCHESTRATION.md`
- `core/personas/`
- `core/agents/`
- `core/rules/`
- `packs/`

Framework veya JavaScript gerektirmez. Codex, Antigravity, Claude Code veya
Copilot'a bu dosyalar verilerek kullanilabilir.

### Katman B - Otomasyon runtime'i

Opsiyoneldir ve halen MVP asamasindadir.

Dosyalar:

- `bin/agentctl.js`
- `lib/`
- `agent-scaffold.example.json`
- `test/`

Jira polling, task lock, worktree ve Codex CLI cagrisini otomatiklestirir.

## 2. Manuel Orchestration Kullanimi

### Adim 1 - Objective yaz

```text
Objective:
Constraints:
Success criteria:
```

Objective ne istendigini soyler. Cozum seklini bastan zorlamaz.

### Adim 2 - Persona sec

Ayni fazda yalnizca bir persona secilir.

| Is | Persona |
| --- | --- |
| Gereksinim ve Jira refinement | product-manager |
| Teknik tasarim ve uygulama karari | startup-cto |
| CI/CD ve operasyon | devops-engineer |
| MVP kapsam/zaman trade-off'u | solo-founder |

Persona dosyasini yukle:

```text
Load core/personas/startup-cto.md
```

### Adim 3 - Skill stack sec

Birden fazla skill ayni anda kullanilabilir.

Ornek:

```text
Load skills:
- core/agents/architect/skills/senior-architect/SKILL.md
- core/agents/backend-engineer/skills/senior-backend/SKILL.md
- core/agents/qa-engineer/skills/tdd-guide/SKILL.md
```

Skill klasorlerinde yalnizca `SKILL.md` yoktur. Upstream'den gelen:

- `scripts/`
- `references/`
- `profiles/`
- `assets/`

dosyalari da bulunur. Skill yonergesi ihtiyac duydugunda bunlari kullanir.

### Adim 4 - Task agent sec

Task agent tek domain icinde calisir.

```text
Task agent: backend-engineer
Scope:
- src/api/events.ts
- test/api/events.test.ts
Do not touch:
- frontend/
- deployment/
Verification:
- npm test
```

### Adim 5 - Phase handoff yaz

Her faz sonunda:

```text
Phase [N] complete.
Objective: [...]
Persona: [...]
Skills: [...]
Task agent: [...]
Decisions: [...]
Artifacts: [...]
Verification: [...]
Open items: [...]
Switching to: [...]
Human approval needed: [...]
```

Handoff olmadan persona degistirilmez.

## 3. Jira Task Akisi

### Faz 0 - PM refinement

1. Issue description ve tum yorumlari oku.
2. Parent epic'i kontrol et.
3. Acceptance criteria var mi kontrol et.
4. Scope disi ve non-goal alanlarini yaz.
5. Dependency ve blocker'lari belirle.

Persona: `product-manager`

Skills:

- senior-pm
- jira-expert
- confluence-expert

Task agent: `pm-analyst`

### Faz 1 - Teknik plan

Persona: `startup-cto`

Skill secimi task tipine gore:

- Backend: senior-backend
- Frontend: senior-frontend
- CV: senior-computer-vision
- Data: senior-data-engineer
- DevOps: senior-devops
- Mimari: senior-architect

### Faz 2 - Uygulama

En dar task agent secilir. Worktree veya ayri branch kullanilir.

### Faz 3 - Review

Persona: `startup-cto`

Skills:

- tdd-guide
- code-review
- risk varsa security-pen-testing

### Faz 4 - Raporlama

Persona: `product-manager`

Task agent: `pm-analyst`

Jira yorumu:

- Ne yapildi?
- Hangi dosyalar degisti?
- Hangi testler calisti?
- Bilinen limitler neler?
- Hangi insan onayi gerekiyor?

Issue en fazla `In Review` durumuna getirilir. Done yapilmaz.

## 4. Antigravity Kurulumu

Installer seciminde Antigravity secildiginde:

```text
.agents/
  AGENTS.md
  agents/
  rules/
  skills/
```

olusur.

Antigravity icin beklenen kullanim:

1. `.agents/AGENTS.md` ana kurallari yukler.
2. `ORCHESTRATION.md` proje kokunden okunur.
3. Persona `core/personas/` altindan secilir.
4. Skill `.agents/skills/` altindan yuklenir.

## 5. Claude Code Kurulumu

Claude Code adapter'i:

```text
CLAUDE.md
.claude/agents/
.claude/skills/
```

olusturur.

Claude Code'a verilecek baslangic komutu:

```text
Read ORCHESTRATION.md.
Objective: PACE-123 taskini refine et ve teknik faza hazirla.
Start with product-manager persona.
Load senior-pm and jira-expert.
Stop after Phase 0 handoff.
```

## 6. Copilot Kullanimi

Copilot adapter'i `.github/copilot-instructions.md` olusturur.

Copilot tek basina tam orchestration motoru degildir. Builder olarak kullan:

```text
Active phase: Implementation
Persona: startup-cto
Task agent: backend-engineer
Skills: senior-backend, backend-testing
Scope: PACE-123
```

## 7. Opsiyonel agentctl Runtime

### Gereksinim

- Node.js 22.5+
- Git
- Codex CLI
- Jira icin environment credential'lari

Config olustur:

```powershell
Copy-Item agent-scaffold.example.json agent-scaffold.json
```

Environment:

```powershell
$env:ATLASSIAN_EMAIL = "mail@example.com"
$env:ATLASSIAN_API_TOKEN = "..."
```

Kontrol:

```powershell
node bin/agentctl.js --config agent-scaffold.json doctor
```

Task plani:

```powershell
node bin/agentctl.js --config agent-scaffold.json plan PACE-123
```

Dry-run:

```powershell
node bin/agentctl.js --config agent-scaffold.json run PACE-123
```

Gercek execute:

```powershell
node bin/agentctl.js --config agent-scaffold.json run PACE-123 --execute
```

### Runtime'in bugunku siniri

Runtime su anda orchestration prompt paketini tam olarak faz faz calistirmiyor.
Jira intake, eligibility, route onerisi, lock, worktree ve executor temelini
sagliyor. Phase engine, reviewer ve reporting PACE-135/PACE-136 kapsaminda
tamamlanacak.

Bu nedenle ilk pilotlarda:

1. `plan` ciktisini insan kontrol eder.
2. Persona ve skill secimi `ORCHESTRATION.md` ile karsilastirilir.
3. Sonra `--execute` kullanilir.

## 8. Yeni Projeye Uyarlama

1. Core scaffold'u kur.
2. Projeye ozel `packs/<proje>/` olustur.
3. Jira project key ve human-only kurallarini tanimla.
4. Yalnizca gerekli ek task agent ve skill'leri pack'e koy.
5. Persona katalogunu gereksiz yere buyutme.
6. Ilk pilotu dusuk riskli bes task ile yap.

## 9. Sik Yapilan Hatalar

- Ayni promptta iki persona kullanmak
- Persona ile task agent'i ayni sanmak
- Tum skill'leri her taskta yuklemek
- Handoff yazmadan faz degistirmek
- Jira acceptance criteria okumadan kodlamak
- Runtime'i orchestration protokolunun kendisi sanmak
- Agent'a merge veya Done yetkisi vermek
