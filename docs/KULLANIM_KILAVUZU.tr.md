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

## 6. Codex Kurulumu

Codex adapter'i:

```text
AGENTS.md
.codex/agents/
.codex/personas/
.codex/skills/
.codex/rules/
```

olusturur.

Codex icin beklenen baslangic akisi:

```text
Read AGENTS.md and ORCHESTRATION.md.
Objective: PACE-123 taskini refine et ve teknik faza hazirla.
Start with product-manager persona.
Load only the needed files from .codex/.
Stop after Phase 0 handoff.
```

`AGENTS.md` giris noktasi, `.codex/` ise secmeli inventory klasorudur.

## 7. Copilot Kullanimi

Copilot adapter'i `.github/copilot-instructions.md` olusturur.

Copilot tek basina tam orchestration motoru degildir. Builder olarak kullan:

```text
Active phase: Implementation
Persona: startup-cto
Task agent: backend-engineer
Skills: senior-backend, backend-testing
Scope: PACE-123
```

## 8. Opsiyonel agentctl Runtime

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

Paralel dispatch planini Jira'ya veya repoya yazmadan gor:

```powershell
node bin/agentctl.js --config agent-scaffold.json dispatch --limit 10 --concurrency 3
```

Plani calistir:

```powershell
node bin/agentctl.js --config agent-scaffold.json dispatch --limit 10 --concurrency 3 --execute
```

Dispatcher `policy.maxConcurrency` degerini asamaz. Ayni provider icin
`policy.providerConcurrency` limiti uygulanir. Ayni dosya sahiplik alanina
ornegin `frontend/**` yazacak iki task ayni dalgada calistirilmaz. Cross-service
tasklar tek basina bir dalgaya alinir.

### Resident Supervisor

Supervisor, surdurulebilir bir poll/dispatch dongusu calistirir. Varsayilan mod
**plan-only** (dry-run) dur, execute etmez.

```powershell
# Plan-only modda supervisor basalt (guvenli, hicbir sey calistirmaz).
node bin/agentctl.js --config agent-scaffold.json supervise

# Tam olarak bir dongu calistir, sonra dur.
node bin/agentctl.js --config agent-scaffold.json supervise --once

# En fazla 5 dongu calistir.
node bin/agentctl.js --config agent-scaffold.json supervise --max-cycles 5

# Execute modunda calistir (config'de supervisor.executeEnabled = true olmali).
node bin/agentctl.js --config agent-scaffold.json supervise --execute

# Supervisor durumunu ve lifecycle event'lerini goster (yerel, Jira gerektirmez).
node bin/agentctl.js --config agent-scaffold.json supervisor-status

# Graceful stop talep et (yerel, Jira gerektirmez). Aktif dongu tamamlanana kadar beklenir.
node bin/agentctl.js --config agent-scaffold.json supervisor-stop
```

**Execute gate:** `--execute` fail-closed'dir. Config dosyasinda
`supervisor.executeEnabled = true` olmadan etkisi yoktur. Ornek config
`executeEnabled: false` ile gelir.

**Graceful shutdown:** SIGINT ve SIGTERM graceful stop talep eder. Supervisor
aktif dispatch dongusunu tamamladiktan sonra cikar. `supervisor-stop` komutu
veritabanina stop talebi yazar; calisan process bunu heartbeat araliklarinda
algilar.

**Insan onayi gerektiren islemler degismedi.** Supervisor hicbir kosulda
PR merge etmez, Jira issue'sunu Done'a gecirmez, Jira'ya yazi yazmaz, epic
degistirmez veya aktif issue lock'larini serbest birakmaz. Bu sinirlar
orchestration protokolu tarafindan korunur ve yapilandirilamaz.

### Jira Intake Modları

- **Tercih edilen orkestre yol (Preferred orchestrated path):** Codex, Atlassian Rovo MCP kullanarak Jira'yı okur, `{key, summary, description, issueType, status, labels}` formatında normalize eder ve bu JSON'ı `node bin/agentctl.js --config agent-scaffold.json local-run --stdin` (opsiyonel `--execute` ile) komutuna pipe eder. Bu yol yerel `ATLASSIAN_EMAIL` veya `ATLASSIAN_API_TOKEN` gerektirmez.
- **Opsiyonel yerleşik REST poller (Optional resident REST poller):** `supervise`/`poll` komutu `JiraClient` kullanır ve `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` gerektirir. Supervisor Node süreci, Codex/Rovo OAuth token'larını içermez veya miras almaz.
- **Read-only sınırı:** Rovo intake, harici onaylı Jira yazma yetkisi verilene kadar read-only kalır; merge, Done durumuna geçiş ve epic değişiklikleri insan onayına tabidir.

PowerShell örneği:

```powershell
$issueJson = '{"key":"PACE-123","summary":"Orkestre gorev","description":"Detaylar","issueType":"Task","status":"To Do","labels":["agent-ready"]}'
$issueJson | node bin/agentctl.js --config agent-scaffold.json local-run --stdin --execute
```

Run ve lock durumlarini izle:

```powershell
node bin/agentctl.js --config agent-scaffold.json runs --limit 20
node bin/agentctl.js --config agent-scaffold.json report RUN_ID
```

Bir process yarida kesildiyse veya insan incelemesi sonrasinda ayni issue'nun
yeniden alinmasi gerekiyorsa lock acikca serbest birakilir:

```powershell
node bin/agentctl.js --config agent-scaffold.json unlock RUN_ID
```

`dispatch` varsayilan olarak dry-run'dir. Gercek worktree ve executor cagrisini
yalnizca `--execute` baslatir. Jira yazmalari ayri bir policy gate'idir.

### Agent Operations Console

Gercek runtime verisini localhost uzerinde salt-okunur izle:

```powershell
node bin/agentctl.js --config agent-scaffold.json dashboard
```

Henuz run yoksa arayuzun aktif, review ve blocked durumlarini ornek veriyle gor:

```powershell
node bin/agentctl.js --config agent-scaffold.json dashboard --demo
```

Varsayilan adres `http://127.0.0.1:4317`'dir. Port degistirilebilir:

```powershell
node bin/agentctl.js --config agent-scaffold.json dashboard --port 4417
```

Console yalnizca localhost'a bind olur ve sadece GET/HEAD kabul eder. Prompt,
Jira aciklamasi, token degeri veya log govdesi API'ye cikmaz. Ekran task ozeti,
persona, skill, provider/model, state, sure, token sayaci, worktree ve blocker
metadata'sini 2.5 saniyede bir yeniler.

### Runtime'in bugunku siniri

Runtime su anda orchestration prompt paketini tam olarak faz faz calistirmiyor.
Jira intake, eligibility, route onerisi, lock, worktree ve executor temelini
sagliyor. Phase engine, reviewer ve reporting PACE-135/PACE-136 kapsaminda
tamamlanacak.

Bu nedenle ilk pilotlarda:

1. `plan` ciktisini insan kontrol eder.
2. Persona ve skill secimi `ORCHESTRATION.md` ile karsilastirilir.
3. Sonra `--execute` kullanilir.

## 9. Yeni Projeye Uyarlama

1. Core scaffold'u kur.
2. Projeye ozel `packs/<proje>/` olustur.
3. Jira project key ve human-only kurallarini tanimla.
4. Yalnizca gerekli ek task agent ve skill'leri pack'e koy.
5. Persona katalogunu gereksiz yere buyutme.
6. Ilk pilotu dusuk riskli bes task ile yap.

## 10. Sik Yapilan Hatalar

- Ayni promptta iki persona kullanmak
- Persona ile task agent'i ayni sanmak
- Tum skill'leri her taskta yuklemek
- Handoff yazmadan faz degistirmek
- Jira acceptance criteria okumadan kodlamak
- Runtime'i orchestration protokolunun kendisi sanmak
- Agent'a merge veya Done yetkisi vermek

## 11. Scaffold Guncelleme

Installer hedef projeye yerel bir kurulum profili ve updater kopyalar:

```text
.agent-scaffold/
  profile.env
  update.ps1
  update.sh
  last-update.env
```

Bu klasor hedef reponun `.git/info/exclude` dosyasina eklenir; proje ile push
edilmez.

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .agent-scaffold\update.ps1
```

Linux/macOS:

```bash
bash .agent-scaffold/update.sh
```

Updater:

1. `agent-scaffold` reposunun guncel `master` branch'ini gecici klasore klonlar.
2. Daha once kurulan pack ve adapter secimlerini `profile.env` dosyasindan okur.
3. Antigravity, Copilot ve/veya Claude dosyalarini `-Force` ile yeniler.
4. Git hook'larini yeniden kurmaz.
5. `.vscode/mcp.json` gibi credential/OAuth durumunu tasiyan yerel dosyalara
   dokunmaz.
6. Kurulan commit'i `last-update.env` dosyasina kaydeder.
