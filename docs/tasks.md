Agent Scaffold — Autonomous Software Delivery Control Plane v1
1. Amaç
Bu çalışmanın amacı mevcut agent-scaffold reposunu Jira/Codex odaklı bir otomasyon runtime'ından çıkarıp aşağıdaki özelliklere sahip, provider-neutral bir Autonomous Software Delivery Control Plane haline getirmektir.
Sistem:
Jira, GitHub Issues ve ileride Linear/YouTrack/Azure Boards gibi farklı work source provider'larla çalışabilmelidir.
Ana akışı yöneten PM/Orchestrator değiştirilebilir olmalıdır.
Codex, Claude Code, Antigravity ve ileride local modeller PM veya worker olarak kullanılabilmelidir.
PM akışı manual, supervised veya autonomous modda çalışabilmelidir.
PM, task'ları analiz edip uygun persona, task agent, skill, capability, model ve executor seçebilmelidir.
Builder, reviewer, rework ve integration akışları ayrı ve izlenebilir olmalıdır.
Jira/GitHub/diğer work source state'leri ortak bir canonical workflow'a çevrilmelidir.
Review başarısız olduğunda structured feedback work source'a yazılmalı ve rework agent'ına aktarılmalıdır.
Parent Story/Epic child task'ları dependency graph üzerinden paralel/sıralı yürütülebilmelidir.
Parent seviyesinde integration branch oluşturulmalı ve child implementation'lar buraya entegre edilmelidir.
Son integration PR'ı otomatik oluşturulabilmeli ancak final merge insan kontrollü kalmalıdır.
Codebase Memory MCP gerçek code-intelligence katmanı olarak kullanılmalıdır.
Ponytail/minimal-change capability builder ve simplicity review tarafında kullanılmalıdır.
4317 Control Plane artık yalnızca dashboard değil; configuration, PM workspace, agent management, usage ve operasyon yönetim ekranı olmalıdır.
Token, context, model kullanımı ve mümkün olduğunda cost görünür olmalıdır.
Agent ekleme, disable etme, archive etme ve yapılandırma UI üzerinden yapılabilmelidir.
Tüm kritik kararlar audit edilebilir olmalıdır.
Human-only sınırlar LLM prompt'larına değil deterministic runtime policy'lerine bağlı olmalıdır.
2. Temel Mimari Prensipler
2.1 LLM hiçbir zaman sistemin güvenlik sınırı değildir
PM veya worker:
merge develop
dese bile runtime bunu yapmamalıdır.
Policy engine aşağıdaki işlemleri deterministic olarak kontrol etmelidir:
final merge
Done transition
production deployment
secret/credential mutation
destructive DB migration
destructive filesystem operations
external write permissions
agent concurrency
retry count
allowed path scope
branch policy
LLM yalnızca karar önerir.
Runtime doğrular ve uygular.
2.2 Jira sistemin merkezi değildir
Runtime aşağıdaki interface ile çalışmalıdır:
WorkSourceProvider
İlk provider'lar:
Jira
GitHub Issues
İleride provider eklemek core runtime değiştirmeyi gerektirmemelidir.
2.3 Codex sistemin merkezi değildir
Aşağıdaki kavramlar birbirinden ayrılmalıdır:
OrchestratorProvider
ExecutorProvider
CodeIntelligenceProvider
WorkSourceProvider
SourceControlProvider
Örneğin:
workSource: jira

orchestrator:
  provider: codex

executor:
  default: antigravity

reviewer:
  provider: claude

codeIntelligence:
  provider: codebase-memory

sourceControl:
  provider: github
geçerli bir yapı olmalıdır.
3. Canonical Delivery Workflow
Mevcut canonical workflow genişletilmelidir.
3.1 Yeni canonical state listesi
backlog
ready
in_progress
review
rework
human_approval
blocked
done
cancelled
unknown
review ile rework ayrı tutulmalıdır.
human_approval ayrı canonical state olmalıdır.
3.2 Normal standalone task akışı
BACKLOG
   │
   ▼
READY
   │
   ▼
IN_PROGRESS
   │
   ▼
REVIEW
   │
   ├──── review fail ────► REWORK
   │                        │
   │                        └────► REVIEW
   │
   └──── review pass ────► HUMAN_APPROVAL
                               │
                               │ human
                               ▼
                              DONE
3.3 Runtime internal state ile external state ayrılmalı
Work source yalnızca kullanıcıya anlamlı state'leri taşımalıdır.
Runtime daha detaylı state tutmalıdır.
Önerilen runtime state'leri:
discovered
eligible
claimed
planning
routed
preparing
worktree_ready
executing
verifying
review_queued
reviewing
review_failed
rework_queued
reworking
reviewed_clean
integration_queued
integrating
integration_review
waiting_human
blocked
failed_retryable
failed_terminal
completed
Canonical state ile runtime state bire bir aynı olmak zorunda değildir.
Örneğin:
runtime: executing
canonical: in_progress
4. State-Based Dispatcher
Bugünkü dispatcher yalnızca “eligible issue” mantığıyla implementation başlatmamalıdır.
Canonical state'e göre pipeline seçmelidir.
Pseudo-code:
switch (workItem.canonicalState) {
  case "ready":
    return handleReady(workItem);

  case "rework":
    return handleRework(workItem);

  case "review":
    return handleReview(workItem);

  case "human_approval":
    return observeHumanApproval(workItem);

  default:
    return skip();
}
review durumundaki bir task implementation worker'a gönderilmemelidir.
rework normal implementation gibi değerlendirilmemelidir.
human_approval durumunda agent execution yapılmamalıdır.
5. WorkSourceProvider Contract
Mevcut read-only abstraction genişletilmelidir.
Önerilen contract:
class WorkSourceProvider {
  async listWorkItems(query) {}

  async getWorkItem(id) {}

  async getComments(id) {}

  async getChildren(id) {}

  async getParent(id) {}

  async getDependencies(id) {}

  async transition(id, canonicalState, metadata) {}

  async addComment(id, comment) {}

  async addLink(id, link) {}

  async claim(id, metadata) {}

  async releaseClaim(id, metadata) {}
}
claim/releaseClaim provider desteklemiyorsa no-op olabilir.
Runtime lock sistemi yine ana concurrency mekanizması olarak kalmalıdır.
6. Work Item Packet
Her provider aynı canonical packet'i üretmelidir.
Önerilen format:
{
  "key": "PACE-412",
  "providerKey": "PACE-412",

  "summary": "Add occupancy endpoint",
  "description": "...",

  "issueType": "Story",

  "status": "Agent Ready",
  "canonicalState": "ready",

  "labels": [],

  "parentKey": "PACE-400",

  "children": [],

  "dependencies": [],

  "comments": [],

  "assignee": null,

  "acceptanceCriteria": [],

  "source": {
    "provider": "jira",
    "id": "10042",
    "url": "..."
  }
}
7. Provider-Specific Discovery
Runtime'ın:
agent-ready label
gibi provider-specific bir kavramı olmamalıdır.
Yeni API:
workSource.listWorkItems({
  canonicalStates: [
    "ready",
    "review",
    "rework"
  ],
  limit: 50
});
Provider bunu kendi sistemine çevirmelidir.
Jira
Örnek:
status IN ("Agent Ready", "Agent Review", "Agent Rework")
GitHub
Örnek:
label:agent-ready
label:agent-review
label:agent-rework
8. Work Source Read/Write Mapping
State mapping yalnızca read mapping olmamalıdır.
Provider transition'ları da tanımlanmalıdır.
Örneğin:
workflow:
  read:
    ready:
      - Agent Ready

    review:
      - Agent Review

    rework:
      - Agent Rework

  write:
    ready: Agent Ready
    in_progress: Agent In Progress
    review: Agent Review
    rework: Agent Rework
    human_approval: Human Approval
GitHub için write semantics:
write:
  ready:
    addLabel: agent-ready

  in_progress:
    addLabel: agent-working

  review:
    addLabel: agent-review

  rework:
    addLabel: agent-rework

  human_approval:
    addLabel: human-approval
Adapter bu farkı runtime'dan saklamalıdır.
9. Work Source Write Safety
Tüm writes aşağıdaki iki gate'e bağlı olmalıdır:
provider.writeEnabled
AND
policy.externalWritesEnabled
Örneğin:
if (!provider.writeEnabled) deny();
if (!policy.externalWritesEnabled) deny();
Done transition her durumda human-only kalmalıdır.
10. Review Failure Comment
Review fail olduğunda generic prose yerine structured finding saklanmalıdır.
Örnek:
{
  "reviewId": "rev-123",
  "implementationSha": "...",
  "verdict": "changes-requested",

  "findings": [
    {
      "id": "R1",
      "severity": "major",
      "file": "src/api/occupancy.js",
      "line": 82,
      "category": "correctness",
      "problem": "Empty dataset returns HTTP 500",
      "expected": "Return HTTP 200 with empty array",
      "verification": "Call endpoint with empty database"
    }
  ]
}
Work source comment:
## Agent Review Failed

Implementation: `<sha>`

### R1 — Major — Correctness

File: `src/api/occupancy.js:82`

Problem:
Empty dataset returns HTTP 500.

Expected:
Return HTTP 200 with an empty result.

Verification:
Call the endpoint with an empty database.
11. Rework Pipeline
Rework agent'a yalnızca Jira yorumunu vermek yeterli değildir.
Input:
Original WorkItemPacket
+
Original Implementation Plan
+
Previous Implementation SHA
+
ReviewFindings
+
Previous Verification Results
Rework aynı branch üzerinde devam etmelidir.
Yeni random worktree oluşturmamalıdır.
Rework tamamlanınca tekrar:
REVIEW
state'ine geçmelidir.
12. Rework Limits
Config:
review:
  maxReworkAttempts: 3
Limit aşılırsa:
BLOCKED
ve:
Human Attention Required
durumu oluşmalıdır.
Work source'a neden block edildiği yorum olarak yazılmalıdır.
13. Review Independence
Builder ile reviewer ayrı execution olmalıdır.
Reviewer:
ayrı run id
ayrı conversation
ayrı provider olabilir
ayrı agent olabilir
builder reasoning/context görmemelidir
Reviewer'a verilecek bilgiler:
WorkItemPacket
Acceptance Criteria
Base SHA
Implementation SHA
Git Diff
Test Results
Scope Results
Code Intelligence Impact
Builder conversation kesinlikle reviewer'a taşınmamalıdır.
14. Review Layers
Review tek pass olmamalıdır.
En az iki logical review türü desteklenmelidir.
Correctness Review
Kontrol eder:
acceptance criteria
behavior
test result
bugs
regression
scope
security
API contract
data integrity
Simplicity Review
Ponytail capability kullanabilir.
Kontrol eder:
gereksiz abstraction
gereksiz dependency
duplicate implementation
existing helper reuse
stdlib/native alternative
deletion opportunity
Simplicity review default olarak non-blocking olabilir.
Config:
review:
  simplicity:
    enabled: true
    blocking: false
15. PM Operating Modes
Üç mod uygulanmalıdır.
manual
supervised
autonomous
16. Manual Mode
Manual modda:
work source sync yapılabilir
otomatik dispatch yapılmaz
PM task'ları analiz edebilir
PM plan hazırlayabilir
PM dependency graph hazırlayabilir
insan chat üzerinden komut verir
execution explicit human instruction gerektirir
Örnek:
User:
PACE-412'yi incele ama çalışma başlatma.

PM:
Task backend işi.
Dependency yok.
backend-engineer öneriyorum.
Başlatılmadı.
17. Supervised Mode
Supervised mod:
task discovery otomatik
task analysis otomatik
routing otomatik
plan otomatik
agent selection otomatik
execution öncesi insan approval gerekir
Örnek:
PACE-412 ready

PM proposed:

backend-engineer
Codex
api-design
backend-testing

[Approve] [Reject] [Edit]
İnsan onayladıktan sonra implementation çalışır.
Review/rework davranışı ayrıca policy'den seçilebilir.
18. Autonomous Mode
Autonomous:
discover
analyze
route
execute
review
rework
integrate
işlemlerini kendi yapabilir.
Ancak hard human gates korunmalıdır:
final merge
Done
production deployment
credential mutation
destructive migration
19. Granular Autonomy Policy
Sadece operating mode yeterli değildir.
Config:
autonomy:
  discovery: auto
  planning: auto
  routing: auto
  implementation: auto
  review: auto
  rework: auto

  createBranch: auto
  createPullRequest: auto
  integrateChildren: auto

  finalMerge: human
  markDone: human
  productionDeploy: human
  destructiveMigration: human
  credentialChanges: human
Mode yalnızca default preset belirlemelidir.
Granular policy override edilebilir.
20. Mode Değişiklikleri
UI'dan operating mode değiştirilebilir.
Ancak çalışan run'ın davranışı değişmemelidir.
Run başladığında config snapshot tutulmalıdır:
{
  "operatingMode": "autonomous",
  "policyVersion": 7,
  "agentVersion": 12,
  "orchestratorProvider": "codex",
  "executorProvider": "antigravity"
}
Sonradan UI config değişse bile bu run aynı contract ile devam etmelidir.
21. PM / Orchestrator Provider
builtin korunmalı ancak gerçek LLM orchestrator provider'lar eklenmelidir.
İlk destek:
builtin
codex
antigravity
claude-code
generic-cli
Mümkünse:
openai-compatible
adapter extension point'i de eklenmelidir.
22. OrchestratorProvider Contract
Önerilen contract:
class OrchestratorProvider {
  async analyzeWorkItem(context) {}

  async createPlan(context) {}

  async routeWork(context) {}

  async decomposeParent(context) {}

  async buildDependencyGraph(context) {}

  async respondToHuman(context) {}

  async handleBlocker(context) {}

  async summarizeDecision(context) {}
}
Orchestrator hiçbir executor command üretmemelidir.
23. PM Structured Decision
PM çıktısı prose parse edilerek kullanılmamalıdır.
Structured schema kullanılmalıdır.
Örnek:
{
  "persona": "startup-cto",

  "taskAgent": "backend-engineer",

  "skills": [
    "api-design",
    "backend-testing",
    "minimal-change"
  ],

  "capabilities": [
    "code-intelligence",
    "git"
  ],

  "executor": {
    "provider": "codex",
    "modelProfile": "medium"
  },

  "risk": "normal",

  "parallelSafe": true,

  "allowedPaths": [
    "backend/**",
    "tests/**"
  ],

  "reasoningSummary": [
    "Backend API change",
    "No security-sensitive behavior detected"
  ]
}
Invalid output fail-closed olmalıdır.
24. Persona ve Task Agent Ayrılmalı
Şu yapı yanlış kabul edilmelidir:
persona = backend-engineer
taskAgent = backend-engineer
Yeni model:
Persona
    ↓
Task Agent
    ↓
Skills
    ↓
Capabilities
    ↓
Executor
Örnek:
persona: startup-cto

taskAgent: backend-engineer

skills:
  - api-design
  - backend-testing
  - minimal-change

capabilities:
  - code-intelligence
  - git

executor:
  provider: codex
  modelProfile: medium
25. Agent Registry
Yeni first-class Agent Registry oluşturulmalıdır.
Agent tanımı:
{
  "id": "backend-engineer",

  "displayName": "Backend Engineer",

  "status": "enabled",

  "role": "implementation",

  "defaultPersona": "startup-cto",

  "skills": [
    "api-design",
    "backend-testing",
    "minimal-change"
  ],

  "capabilities": [
    "code-intelligence",
    "git"
  ],

  "executor": {
    "provider": "codex",
    "modelProfile": "medium"
  },

  "reviewer": "correctness-reviewer",

  "risk": "normal",

  "maxConcurrency": 2,

  "allowedPaths": [
    "backend/**",
    "tests/**"
  ]
}
26. Agent Lifecycle
Agent için:
enabled
disabled
archived
durumları desteklenmelidir.
Hard delete yalnızca agent hiç kullanılmadıysa yapılmalıdır.
Geçmiş run'larda kullanılan agent kesinlikle silinmemelidir.
27. Agent Versioning
Her agent mutation yeni version üretmelidir.
Örneğin:
backend-engineer v12
Run:
{
  "agentId": "backend-engineer",
  "agentVersion": 12
}
saklamalıdır.
Run payload içine agent definition snapshot da konulmalıdır.
28. Agent Management API
Önerilen endpoint'ler:
GET    /api/agents
POST   /api/agents
GET    /api/agents/:id
PATCH  /api/agents/:id
POST   /api/agents/:id/disable
POST   /api/agents/:id/enable
POST   /api/agents/:id/archive
Credentials veya raw executable command agent mutation API üzerinden değiştirilememelidir.
29. Agent Management UI
4317:
Agents
sayfası eklenmelidir.
Göstermeli:
Name
Role
Status
Persona
Skills
Executor
Model Profile
Concurrency
Current Runs
Last Run
Token Usage
30. Add Agent UI
Form:
Agent ID

Display Name

Role

Default Persona

Skills

Capabilities

Default Executor

Model Profile

Reviewer

Risk

Concurrency

Allowed Paths
31. PM Workspace
4317 içinde:
PM
ana navigation item'i oluşturulmalıdır.
Bu bölüm iki fonksiyona sahip olmalıdır:
Conversation
Decision Journal
32. PM Conversation
Manual/Supervised modlarda gerçek human-PM chat olmalıdır.
Örnek:
User:
PACE-400'ü incele.

PM:
4 child iş buldum.

PACE-401
PACE-402
PACE-403

paralel çalışabilir.

PACE-404 bunlara bağımlı.

Henüz execution başlatılmadı.
33. Autonomous PM Journal
Autonomous modda PM conversation alanı sistem kararlarını göstermelidir.
Örnek:
10:42

Found PACE-412

Canonical state:
READY

Selected:
startup-cto
backend-engineer
Codex

Skills:
api-design
backend-testing

Dispatch started.
34. PM Conversation Source of Truth Olmamalıdır
PM chat yalnızca interaction surface olmalıdır.
Gerçek state:
SQLite/runtime
içinde tutulmalıdır.
Chat geçmişinden state reconstruct edilmeye çalışılmamalıdır.
35. PM Context Sonsuza Kadar Büyümemeli
Autonomous PM için sürekli büyüyen tek LLM conversation kullanmayın.
Kullan:
persistent structured state
+
decision journal
+
bounded recent context
+
summary
Yeni invocation gerektiğinde gerekli context yeniden oluşturulmalıdır.
36. Decision Journal
Her önemli PM kararı structured event olmalıdır.
Örnek:
{
  "type": "routing_decision",
  "workItem": "PACE-412",

  "persona": "startup-cto",
  "taskAgent": "backend-engineer",

  "skills": [
    "api-design"
  ],

  "executor": "codex",

  "risk": "normal",

  "timestamp": "..."
}
37. Token Usage Normalization
Provider-specific token verileri ortak modele dönüştürülmelidir.
{
  "inputTokens": 32000,
  "outputTokens": 8000,
  "cachedInputTokens": 12000,

  "totalTokens": 40000,

  "context": {
    "used": 52000,
    "limit": 128000,
    "source": "provider"
  },

  "cost": {
    "amount": 0.82,
    "currency": "USD",
    "estimated": true
  }
}
38. Context Usage
Context yüzdesi yalnızca gerçek limit biliniyorsa gösterilmelidir.
Doğru:
52,000 / 128,000
41%
Limit bilinmiyorsa:
Context used:
52,000 tokens

Limit:
Unknown
Sahte percentage üretmeyin.
39. Usage Categories
Her token event aşağıdaki role ile etiketlenmelidir:
pm
builder
reviewer
rework
integration
Ayrıca:
project
workItem
run
agent
provider
model
metadata'sı tutulmalıdır.
40. Usage UI
Yeni:
Usage
sayfası oluşturulmalıdır.
Göstermeli:
Today
Last 7 days
Last 30 days
Breakdown:
PM
Builders
Reviewers
Rework
Provider:
Codex
Claude
Antigravity
Local
Agent:
backend-engineer
frontend-engineer
...
41. Per-Task Usage
Task detail:
PACE-412

PM analysis          8,932
Implementation      41,402
Review              12,940
Rework               9,220
Review #2             7,113

Total                79,607
42. Cost
Cost yalnızca provider pricing config mevcutsa hesaplanmalıdır.
Config örneği:
pricing:
  codex-model-x:
    inputPerMillion: 2
    outputPerMillion: 8
UI:
Estimated Cost
ifadesini kullanmalıdır.
43. Codebase Memory MCP Gerçek Entegrasyonu
Mevcut config-only entegrasyon gerçek runtime capability'ye çevrilmelidir.
Implement:
CodeIntelligenceProvider
contract.
44. CodeIntelligenceProvider Contract
class CodeIntelligenceProvider {
  async health() {}

  async getArchitecture(scope) {}

  async searchCode(query) {}

  async tracePath(request) {}

  async detectChanges(request) {}

  async impactAnalysis(request) {}

  async checkCoverage(request) {}

  async getSnippet(request) {}
}
45. Codebase Memory Adapter
codebase-memory-mcp adapter gerçek MCP tool çağrıları yapmalıdır.
İlk tool set:
get_architecture
search_graph
trace_path
detect_changes
check_index_coverage
get_code_snippet
Exact available tool names runtime discovery ile doğrulanmalıdır.
46. Implementation Preflight
Builder çalışmadan önce:
Code Intelligence
aşağıdaki context'i hazırlamalıdır:
relevant architecture
existing related modules
call paths
similar implementation
impact radius
index coverage
PM planına eklenmelidir.
47. Review Code Intelligence
Review öncesi:
git diff
+
changed symbols
+
codebase-memory detect_changes
+
impact analysis
yapılmalıdır.
Reviewer yalnızca changed files değil downstream impact'i de görmelidir.
48. Code Intelligence Failure Policy
Codebase Memory down olduğunda sistem direkt fail olmak zorunda değildir.
Config:
codeIntelligence:
  required: false
false:
fallback to source inspection
true:
block execution
49. Index Health UI
4317 Overview veya Capabilities:
Codebase Memory

● Healthy

Repo
houndvision

Indexed SHA
abc123

Coverage
98.4%

Last Refresh
42 sec ago
50. Worktree Awareness
Codebase Memory global stale graph olarak kullanılmamalıdır.
En az:
base repo SHA
+
current worktree SHA/diff
bilgisi takip edilmelidir.
Reviewer için graph current worktree ile uyumlu değilse changed files doğrudan source'tan tekrar okunmalıdır.
51. Ponytail Capability
Mevcut minimal-change capability korunmalıdır.
Builder default:
ponytail full
High-risk:
ponytail lite
Cleanup/refactor:
ponytail ultra
yalnızca explicit policy ile kullanılmalıdır.
52. Ponytail PM'e Uygulanmamalıdır
PM:
acceptance criteria gereksiz
gibi YAGNI kararları vermemelidir.
Minimal-change builder/reviewer capability'sidir.
53. Parent / Story / Epic Orchestration
Epic'ler artık otomatik olarak human-only block edilmemelidir.
Parent work item:
coordination unit
olarak ele alınmalıdır.
54. Parent Discovery
Parent alındığında:
getChildren
getDependencies
getLinks
çağrılmalıdır.
55. Dependency Graph
Structured graph:
{
  "nodes": [
    "PACE-401",
    "PACE-402",
    "PACE-403",
    "PACE-404"
  ],

  "edges": [
    ["PACE-401", "PACE-404"],
    ["PACE-402", "PACE-404"],
    ["PACE-403", "PACE-404"]
  ]
}
56. Parallel Waves
Scheduler DAG üzerinden wave hesaplamalıdır.
Örnek:
Wave 1

PACE-401
PACE-402
PACE-403

Wave 2

PACE-404
Ayrıca existing path overlap checks korunmalıdır.
57. Integration Branch
Parent için:
story/pace-400-integration
veya:
epic/pace-400-integration
oluşturulmalıdır.
Configurable naming kullanılabilir.
58. Child Branch Base
Child branch parent integration branch'den çıkmalıdır.
develop
   │
   ▼
PACE-400 integration
   │
   ├── PACE-401
   ├── PACE-402
   └── PACE-403
59. Child Integration
Child:
implementation
review
accepted SHA
sonrası integration branch'e alınmalıdır.
Existing independently-reviewed-SHA safety logic korunmalıdır.
60. Integration Review
Bütün child'lar complete olduktan sonra parent-level review yapılmalıdır.
Kontrol:
all required children complete
dependency graph satisfied
integration branch clean
merge conflicts absent
parent acceptance criteria
API contracts
integration tests
E2E tests
61. Parent PR
Integration review geçerse:
integration branch
   ↓
target branch
PR otomatik oluşturulabilir.
Örneğin:
pace-400-integration → develop
62. Final Merge
Final merge:
HUMAN ONLY
kalmalıdır.
63. Worktree Base Fix
Standalone task'lar local HEAD'den branch almamalıdır.
Implementation başlamadan:
git fetch origin
çalışmalıdır.
Base:
origin/<defaultBranch>@SHA
olarak resolve edilmelidir.
Run metadata:
{
  "baseBranch": "develop",
  "baseSha": "..."
}
saklamalıdır.
64. 4317 Control Plane Navigation
Yeni navigation:
Overview
PM
Work
Agents
Runs
Reviews
Projects
Providers
Capabilities
Workflow
Usage
Settings
Mevcut vanilla UI korunabilir.
Bu iş için React/Next vb. dependency eklemeyin.
65. Overview
Göstermeli:
Operating Mode
Supervisor Status
Active Workers
Ready
Review
Rework
Human Approval
Blocked
Token Usage
Estimated Cost
Code Intelligence Health
66. Work Page
Kolonlar:
Ready
Running
Review
Rework
Human Approval
Blocked
Task kartında:
ID
Summary
Source
Agent
Provider
State
Parent
Runtime
Tokens
67. Providers Page
Gruplar:
Work Sources

Orchestrators

Executors

Code Intelligence

Source Control
Configured provider'lar seçilebilir olmalıdır.
68. Provider Mutation Safety
UI:
provider select
yapabilir.
Ancak şimdilik UI üzerinden:
raw executable command
credentials
secret env
değiştirilmemelidir.
69. Workflow Page
Visual state machine gösterilmelidir:
READY
 ↓
IN PROGRESS
 ↓
REVIEW
 ↙   ↘
REWORK HUMAN APPROVAL
  ↓
REVIEW
Config:
Max rework
Auto review
Simplicity review
Child integration
Final merge policy
70. Pause Autonomous Dispatch
UI:
Pause Autonomous Dispatch
butonu eklenmelidir.
Semantics:
yeni işler başlamaz
çalışan worker terminate edilmez
review/integration policy configurable olabilir
supervisor çalışmaya devam eder
71. Emergency Stop
Ayrı:
Emergency Stop
desteklenmelidir.
Bu explicit dangerous action olmalıdır.
Confirmation gerektirir.
Aktif workers için controlled termination uygular.
72. Project-Level Configuration
Her project kendi ayarına sahip olmalıdır.
Örnek:
project:
  id: pacebuild

  operatingMode: autonomous

  workSource: jira

  orchestrator: codex

  executor: antigravity

  codeIntelligence: codebase-memory

  defaultBranch: develop
73. Multi-Project Hazırlığı
İlk sürüm aynı anda bir project çalıştırabilir.
Ancak schema gelecekte multi-project'e izin vermelidir.
Hard-coded:
PACE
PaceBuild
UI metinlerinden çıkarılmalıdır.
74. Audit Trail
Aşağıdaki işlemler event journal'a yazılmalıdır:
mode changed
provider changed
agent changed
agent disabled
task claimed
routing decision
execution started
review started
review failed
rework started
integration completed
human approval entered
pause
resume
emergency stop
75. Database Changes
SQLite migration mekanizması ekleyin veya mevcut DB init ile backwards-compatible şekilde tablolar ekleyin.
Önerilen tablolar:
pm_messages

pm_decisions

agent_definitions
agent_versions

usage_events

review_findings

work_item_snapshots

configuration_events
76. pm_messages
Alanlar:
id
project_id
role
content
structured_payload
provider
conversation_id
created_at
77. pm_decisions
id
project_id
work_item
decision_type
payload
provider
model
created_at
78. usage_events
id
project_id
work_item
run_id
role
agent_id
provider
model

input_tokens
output_tokens
cached_tokens

context_used
context_limit

cost_amount
cost_currency
cost_estimated

created_at
79. review_findings
id
run_id
review_id
work_item
implementation_sha

finding_id
severity
category
file
line
problem
expected
verification

created_at
80. Agent Version Persistence
agent_versions

id
agent_id
version
definition_json
definition_hash
created_at
81. Configuration Mutation API
Existing provider mutation endpoint genişletilebilir.
Öneri:
GET   /api/config

PATCH /api/config/operating-mode
PATCH /api/config/autonomy

PATCH /api/config/providers

POST  /api/control/pause
POST  /api/control/resume
POST  /api/control/emergency-stop
82. PM API
GET  /api/pm/messages

POST /api/pm/messages

GET  /api/pm/decisions
Manual/Supervised mode human message:
POST /api/pm/messages
ile gönderilmelidir.
83. Work API
GET /api/work

GET /api/work/:id
Mümkünse filters:
state
agent
provider
parent
84. Usage API
GET /api/usage/summary

GET /api/usage/runs

GET /api/usage/work-items/:id
85. Security
Control Plane yalnızca:
127.0.0.1
bind etmeye devam etmelidir.
Existing:
Origin validation
Host validation
Content-Type validation
body limit
korunmalıdır.
86. Credentials
Hiçbir API response şunları expose etmemelidir:
API key
token
credential value
Authorization header
raw secret env value
Environment variable isimlerinin bile UI'ya çıkmasına gerek yoktur.
87. Prompts
Full PM/worker system prompt UI snapshot'ına çıkmamalıdır.
Gösterilebilecek:
persona
skills
capabilities
decision summary
88. Provider Command
Raw provider executable command public dashboard snapshot'a gönderilmemelidir.
Sadece:
configured: true
gibi metadata gösterilmelidir.
89. Safety — Human Only
Aşağıdakiler kesinlikle autonomous hale getirilmemelidir:
final merge to protected branch
Done transition
production deploy
credential/secret changes
destructive database migration
destructive infrastructure operation
90. Backward Compatibility
Aşağıdakiler çalışmaya devam etmelidir:
legacy top-level jira config
existing Codex executor config
existing Antigravity executor config
existing SQLite runtime history
existing CLI commands
dry-run default behavior
91. Existing Review/Integration Safety'yi Bozmayın
Özellikle korunmalı:
reviewed implementation SHA requirement
reviewer identity requirement
review evidence requirement
integration SHA ancestry validation
npm run check before integration commit
92. CLI
Mevcut CLI korunmalı.
Yeni optional commands:
agentctl pm
agentctl agents
agentctl work
agentctl usage

agentctl pause
agentctl resume
Eklenebilir.
Ancak Control Plane API primary management surface olabilir.
93. Test Strategy
Yeni kod test olmadan kabul edilmemelidir.
Workflow Tests
Test:
ready → implementation

review → reviewer
NOT implementation

rework → rework worker

human_approval → no agent execution

done → no execution

unknown → fail closed
WorkSource Tests
Jira:
Agent Ready mapping
Agent Review mapping
Agent Rework mapping
Human Approval mapping
transition
comment
children
dependencies
GitHub:
labels → canonical state
canonical transition → labels
comments
PR filtering
PM Mode Tests
Manual:
poll allowed
auto dispatch denied
explicit approved execution allowed
Supervised:
planning automatic
execution waits approval
Autonomous:
ready task auto dispatched
Agent Registry Tests
create
update
version increment
disable
enable
archive

used agent cannot hard delete
Token Tests
Provider telemetry normalize edilmelidir.
Test:
known context limit
unknown context limit
cached tokens
estimated cost
Review Tests
builder cannot self-review same run
review requires SHA
review requires evidence
review fail creates structured findings
rework receives findings
max retry blocks
DAG Tests
Test:
A
B
C
↓
D
Scheduler:
wave1 A B C
wave2 D
Cycle tespit edilirse:
blocked
Integration Tests
reviewed SHA only
merge conflict
failing npm check
success integration
parent integration review
Control Plane Security Tests
non-loopback denied

hostile Origin denied

wrong content-type denied

disabled mutations denied

unknown provider denied

raw command mutation denied

credentials never in snapshot
94. End-to-End Acceptance Scenario 1
Standalone task.
Jira
PACE-501
Agent Ready
Beklenen:
PM discovers
↓
PM selects backend-engineer
↓
state Agent In Progress
↓
builder implements
↓
tests pass
↓
state Agent Review
↓
independent reviewer
↓
clean
↓
state Human Approval
Human:
merge + Done
95. End-to-End Acceptance Scenario 2
Review fail.
Agent Review
↓
reviewer finds issue
↓
structured Jira comment
↓
Agent Rework
↓
rework worker
↓
Agent Review
↓
pass
↓
Human Approval
96. End-to-End Acceptance Scenario 3
Story.
PACE-600 Story
Children:
601 backend
602 frontend
603 CV
604 integration test
Dependencies:
601 ─┐
602 ─┼─► 604
603 ─┘
Expected:
create integration branch

Wave 1:
601 602 603 parallel

each independently reviewed

integrate accepted SHAs

Wave 2:
604

parent integration review

open PR to develop

parent → Human Approval
97. End-to-End Acceptance Scenario 4
Manual PM.
UI:
Operating Mode:
Manual
User:
PACE-700'ü analiz et.
Expected:
PM analyses
PM presents plan
NO worker starts
User:
Backend task'ı başlat.
Only then execution.
98. End-to-End Acceptance Scenario 5
Supervised.
System discovers:
PACE-710
PM automatically proposes:
backend-engineer
Codex
normal risk
UI:
Approve execution
Until approval:
no worker
99. End-to-End Acceptance Scenario 6
Autonomous.
Mode:
Autonomous
No human message.
System:
discover
plan
execute
review
rework
integrate
çalışır.
Human Approval'da durur.
100. UI Acceptance Criteria
4317 açıldığında kullanıcı görebilmelidir:
Current project
Operating mode
Work source
PM provider
Executor
Reviewer
Code Intelligence

Supervisor
Workers
Review queue
Rework queue
Human approvals
Blocked

Token usage
Context usage
Estimated cost
101. Agents UI Acceptance Criteria
Kullanıcı:
Add Agent
ile yeni agent oluşturabilmelidir.
Disable
Enable
Archive
yapabilmelidir.
Config değişikliği yeni run'larda uygulanmalıdır.
Existing run snapshot değişmemelidir.
102. PM UI Acceptance Criteria
Kullanıcı:
PM
sayfasında:
conversation
decision journal
active plan
current context
token usage
görebilmelidir.
103. Run Detail Acceptance Criteria
Run detayında:
Work item
Parent
Persona
Task agent
Skills
Capabilities

Orchestrator provider

Executor provider
Model

Reviewer

Branch
Base SHA
Implementation SHA

Tokens
Context
Cost

Tests
Review
Findings

Events
görülmelidir.
104. Codebase Memory Acceptance Criteria
Enabled olduğunda:
health
indexed SHA
coverage
architecture
impact
runtime tarafından gerçekten kullanılmalıdır.
Sadece config snapshot'ta görünmesi yeterli değildir.
105. Do Not Overengineer
Bu projede yeni framework eklemeyin.
Özellikle:
Temporal
LangGraph
Kubernetes
Kafka
Redis
React
Next.js
gibi dependency'ler bu iş için gerekli değildir.
Mevcut:
Node.js
SQLite
vanilla web UI
git worktrees
mimarisi yeterlidir.
106. Recommended Implementation Order
İşleri aşağıdaki sırada yapın.
Phase 1
Canonical workflow.
rework
human_approval
ekle.
Dispatcher state-driven hale gelsin.
Phase 2
WorkSource contract.
transition
comments
children
dependencies
ekle.
Jira + GitHub implement et.
Phase 3
Review/rework full lifecycle.
Work source transitions ve comments bağla.
Phase 4
Operating Modes.
manual
supervised
autonomous
ekle.
Phase 5
Persona/taskAgent separation.
Agent Registry ekle.
Phase 6
Gerçek Orchestrator providers.
builtin
generic CLI
Codex
Antigravity
Claude
Phase 7
PM conversation + decision journal.
Phase 8
Token/context/cost telemetry.
Phase 9
Codebase Memory gerçek integration.
Phase 10
Parent/child dependency DAG.
Integration branch lifecycle.
Phase 11
4317 Control Plane management UI.
Phase 12
Worktree remote base correctness.
Phase 13
Hardening, tests, documentation.
107. PR Strategy
Tek 8.000 satırlık PR oluşturmayın.
Önerilen PR'lar:
PR 1
Canonical workflow + state-driven dispatcher

PR 2
WorkSource lifecycle + Jira/GitHub writes

PR 3
Review/Rework/Human Approval

PR 4
Operating modes + autonomy policy

PR 5
Persona/taskAgent + Agent Registry

PR 6
Orchestrator providers

PR 7
PM workspace + journal

PR 8
Usage/context telemetry

PR 9
Codebase Memory runtime integration

PR 10
Parent DAG + integration lifecycle

PR 11
4317 full management UI

PR 12
hardening/docs/migrations
Her PR bağımsız olarak test geçmelidir.
108. Per-PR Quality Gate
Her PR için:
npm run check
geçmelidir.
Ayrıca:
no weakened safety gate
no secret exposure
no final merge automation
no Done automation
no destructive migration
kontrol edilmelidir.
109. Definition of Done
Bu epic ancak aşağıdaki senaryo gerçekten çalışıyorsa tamamlanmış kabul edilmelidir:
Human creates work item
       ↓
sets READY
       ↓
Supervisor discovers
       ↓
PM analyzes
       ↓
PM selects

Persona
Task Agent
Skills
Capabilities
Executor
Model
       ↓
Worker implements
       ↓
Verification
       ↓
Independent Review
       ↓
   FAIL      PASS
     │         │
   REWORK   HUMAN APPROVAL
     │
     └──── REVIEW
Parent işlerde:
Parent
  ↓
Dependency DAG
  ↓
Parallel Child Workers
  ↓
Independent Reviews
  ↓
Integration Branch
  ↓
Integration Review
  ↓
PR
  ↓
Human Approval
Ve kullanıcı bütün sistemi 4317 Control Plane üzerinden:
configure
observe
pause
resume
interact
edebilmelidir.
110. Nihai Ürün Tanımı
Implementation boyunca bu tanımı referans alın:
Agent Scaffold is a provider-neutral autonomous software delivery control plane where a configurable PM orchestrator discovers work from pluggable work sources, routes it to versioned specialist agents with explicit personas, skills and capabilities, coordinates independent review and rework, manages dependency-aware integration, and hands final approval to humans while exposing the entire process through a local observable and configurable control plane.

Bu tanıma hizmet etmeyen speculative feature eklemeyin.
Mevcut runtime safety mekanizmalarını koruyun.
Öncelik:
correctness
determinism
auditability
provider neutrality
human control
observability
olmalıdır.
Agent için özellikle kritik son notlar
Mevcut develop üzerinde çalışın. Provider-neutral PR ile gelen WorkSourceProvider, OrchestratorProvider, Capability Registry, Control Plane metadata ve mevcut review/integration primitives çöpe atılmamalı; genişletilmelidir. Mevcut Jira ve GitHub adapter'ları şu anda ağırlıklı olarak read-only olduğu için write lifecycle bu abstraction'ın üzerine eklenmelidir.  
Existing independent review SHA/evidence mantığı ve integration sırasında reviewed SHA doğrulaması ile npm run check gate'i korunmalıdır. 
Worktree'lerde standalone task'ın HEAD tabanından çıkması yerine exact remote default-branch SHA tabanı kullanılmalıdır; mevcut implementation hâlâ HEAD fallback'i kullanıyor. 
Final merge ve Done hiçbir koşulda autonomous hale getirilmemelidir.
Bu epic'in hedefi daha fazla “agent davranışı” eklemek değil; agent davranışlarının deterministik, gözlemlenebilir ve insan tarafından kontrol edilebilir bir runtime içinde yürütülmesini sağlamaktır.