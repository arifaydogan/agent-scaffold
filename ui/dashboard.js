/**
 * ui/dashboard.js
 *
 * Phase I — Operator-Facing Control Plane UI Client.
 *
 * Design invariants:
 * - Strict CSP compliance: ZERO inline JavaScript (no onclick, onerror, onload, or javascript protocol URLs).
 * - Full DOM safety: uses textContent, createElement, and safe escaping to prevent XSS.
 * - Single canonical element ID contract aligned with ui/index.html.
 * - Truthful metrics: unknown tokens or duration render as "—" or "Usage unavailable", never 0.
 * - Authoritative backend models for PM Workspace, Decision Trace, Observability, and Parent Orchestration.
 * - Safe concurrency: 409 plan fingerprint conflict detection with auto-refresh.
 * - Human Approval boundary: WAITING_HUMAN renders completion evidence with NO automatic merge/Done button.
 * - Full accessibility: focus management, Escape key dismiss, semantic landmarks and controls.
 * - Light-weight URL state navigation with pushState, replaceState, and popstate support.
 * - Full backwards-compatibility with test/ui.test.js evaluation.
 */

const state = {
  snapshot: null,
  filter: "all",
  query: "",
  connected: false,
  loading: true,
  currentView: "overview-view",
  currentPmFilter: "inbox",
  currentAgentFilter: "all",
  currentObsWindow: "24h",
  selectedParentKey: null,
  selectedWorkItemKey: null,
  selectedRunId: null,
  lastFocusedElement: null,
  pendingApprovalItem: null,
  pendingRejectionItem: null,
  providerConnections: null,
  providerConnectionsLoading: false,
  activeProviderConnectionId: null,
  activeProviderConnectionCategory: "work-tools",
  workSourceCatalog: null,
  workSourceCatalogLoading: false,
  workSourceCatalogError: null,
  workItemQuery: "",
  workItemState: "all",
  workItemPage: 1,
  workItemPageSize: 25,
  language: readStoredLanguage(),
  workItemDetailRequestId: 0,
  parentDetailRequestId: 0,
  currentWorkItemDetail: null,
  pendingExecutionPlan: null,
  currentParentDetail: null
};

const elements = typeof document !== "undefined" ? {
  empty: document.querySelector("#empty-state"),
  activity: document.querySelector("#activity-body"),
  providers: document.querySelector("#provider-list"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  syncTime: document.querySelector("#sync-time"),
  error: document.querySelector("#error-banner"),
  demo: document.querySelector("#demo-badge"),
  project: document.querySelector("#project-key"),
  capacityTotal: document.querySelector("#capacity-total"),
  metricActive: document.querySelector("#metric-active"),
  metricQueued: document.querySelector("#metric-queued"),
  metricReview: document.querySelector("#metric-review"),
  metricRework: document.querySelector("#metric-rework"),
  metricBlocked: document.querySelector("#metric-blocked"),
  metricAwaitingApproval: document.querySelector("#metric-awaiting-approval"),
  metricHumanApproval: document.querySelector("#metric-human-approval"),
  metricActiveParents: document.querySelector("#metric-active-parents"),
  metricParentConflicts: document.querySelector("#metric-parent-conflicts"),
  metricTokens: document.querySelector("#metric-tokens"),
  metricCapacity: document.querySelector("#metric-capacity"),
  search: document.querySelector("#run-search"),
  operatingModePill: document.querySelector("#operating-mode-pill"),
  operatingModeLabel: document.querySelector("#operating-mode-label"),
  overviewModeBadge: document.querySelector("#overview-mode-badge"),
  overviewModeDesc: document.querySelector("#overview-mode-desc"),
  supervisorCard: document.querySelector("#supervisor-card"),
  supervisorDot: document.querySelector("#supervisor-dot"),
  supervisorStatusText: document.querySelector("#supervisor-status-text"),
  supervisorPid: document.querySelector("#supervisor-pid"),
  supervisorMode: document.querySelector("#supervisor-mode"),
  supervisorCycles: document.querySelector("#supervisor-cycles"),
  supervisorHeartbeat: document.querySelector("#supervisor-heartbeat")
} : {};

const STATUS_LABELS_TR = {
  discovered: "Keşfedildi",
  eligible: "Hazır",
  claimed: "Alındı",
  prepared: "Hazırlanıyor",
  queued: "Sıraya alındı",
  started: "Başlatıldı",
  model_selected: "Model seçildi",
  progress: "İşleniyor",
  executing: "Çalışıyor",
  retry_requested: "Yeniden deneme kuyruğunda",
  verifying: "Review bekliyor",
  review_queued: "Review kuyruğunda",
  reviewing: "Review ediliyor",
  review_fix_queued: "Review düzeltmesi bekliyor",
  accepted: "Kabul edildi",
  blocked: "Bloke",
  human_action_required: "Senden aksiyon bekliyor",
  "failed-retryable": "Tekrar denenebilir",
  "failed-scope": "Scope ihlali",
  failed: "Başarısız",
  "blocked-conflict": "Entegrasyon Çatışması",
  integrated: "Entegre Edildi",
  waiting_human: "İnsan Onayında",
  human_approval: "İnsan Onayında",
  not_started: "Henüz başlatılmadı",
  unknown: "Work-source durumu"
};

const STATUS_LABELS_EN = {
  discovered: "Discovered", eligible: "Ready", claimed: "Claimed", prepared: "Preparing",
  queued: "Queued", started: "Started", model_selected: "Model selected", progress: "In progress",
  executing: "Running", retry_requested: "Retry queued", verifying: "Waiting for review",
  review_queued: "Review queued", reviewing: "Under review", review_fix_queued: "Waiting for review fix",
  accepted: "Accepted", blocked: "Blocked", human_action_required: "Waiting for your action",
  "failed-retryable": "Retryable", "failed-scope": "Scope violation", failed: "Failed",
  "blocked-conflict": "Integration conflict", integrated: "Integrated", waiting_human: "Human approval",
  human_approval: "Human approval", not_started: "Not started", unknown: "Work-source status"
};

const STATUS_LABELS = { ...STATUS_LABELS_TR };

// Fixed interface copy only. Jira summaries, descriptions, and provider data stay untouched.
const UI_TEXT_EN = Object.freeze({
  "Ana içeriğe geç": "Skip to main content", "Menüyü aç/kapat": "Open/close menu",
  "Kontrol Merkezi": "Control Center", "Çalışma Modu": "Operating mode", "Bağlanıyor": "Connecting",
  "Son senkronizasyon": "Last synchronization", "Demo verisi": "Demo data", "Ana Navigasyon": "Main navigation",
  "Genel Bakış": "Overview", "İşler": "Work", "Parentlar": "Parents", "Gözlem": "Observability",
  "Agentlar": "Agents", "Sağlayıcılar": "Providers", "Canlı bağlantı kesildi.": "Live connection was lost.",
  "Son başarılı veri gösteriliyor; yeniden bağlanmayı deniyoruz.": "Showing the last successful data while reconnecting.",
  "Sistem durumunu, aktif işleri ve dikkat gerektiren öğeleri izleyin.": "Monitor system status, active work, and items needing attention.",
  "Aktif İşler": "Active work", "Kapasite hesaplanıyor": "Calculating capacity", "İlgi Gereken": "Needs attention",
  "İlgi Gerekenler": "Needs attention", "İlgi gerekiyor": "Needs attention", "Müdahale gereken": "Requires intervention",
  "Onay Bekleyen": "Awaiting approval", "Plan parmak izi korumalı": "Protected by plan fingerprint",
  "İnsan İçin Hazır": "Ready for human", "Hazır / Final PR": "Ready / Final PR",
  "Çalışan ve Kuyruktaki İşler": "Running and queued work", "Task veya persona ara": "Search task or persona",
  "Task, persona veya skill ara": "Search task, persona, or skill", "Agent durum filtreleri": "Agent status filters",
  "Tümü": "All", "Aktif": "Active", "Süre": "Duration", "Son Aktivite": "Last activity",
  "Bu görünümde run yok": "No runs in this view", "Dikkat gerektiren öğe yok.": "No items need attention.",
  "Son hareketler": "Recent activity", "Salt okunur": "Read-only", "Zaman": "Time", "Olay": "Event", "Durum": "Status",
  "Operasyonel iş kuyruğu, onaylar ve karar günlüğü.": "Operational work queue, approvals, and decision journal.",
  "İş kaynağı bekleniyor": "Waiting for work source", "İş Kaynağından Yenile": "Refresh from work source",
  "İş kuyruğu filtreleri": "Work queue filters", "Onaylar": "Approvals", "Sorular": "Questions", "Hazır": "Ready",
  "Agent Soruları": "Agent Questions",
  "Agent bir iş kararına ihtiyaç duyduğunda sorusu burada görünür. Yanıtınız kaydedilir ve aynı güvenli planla çalışma otomatik devam eder.": "When an agent needs a work decision, its question appears here. Your answer is recorded and work resumes automatically with the same safe plan.",
  "Agentı Çalıştır": "Run Agent", "Planı hazırla": "Prepare plan", "Agentı başlat": "Start agent", "Agentı durdur": "Stop agent",
  "Proje seçimi gerekli": "Project selection required", "Proje / Repo": "Project / Repository",
  "Bu Jira işinin hangi repoda planlanacağını seçin. Seçim yalnızca yerel olarak saklanır; Jira değiştirilmez.": "Select which repository should be used to plan this Jira work item. The selection is stored locally; Jira is not changed.",
  "Proje": "Project", "Bir proje seçin": "Select a project", "Bu projeyle planla": "Plan with this project",
  "Git tabanı seç": "Select Git base", "Mevcut bir dal seçin": "Select an existing branch",
  "Bu Git tabanıyla planla": "Plan with this Git base",
  "İstenen parent dalı bulunamadı. Seçilen repodaki mevcut ve incelenmiş bir dalı açıkça seçin.": "The requested parent branch was not found. Explicitly select an existing, reviewed branch in the chosen repository.",
  "Repo eşleştirmesi bulunamadı.": "No repository match was found.",
  "Birden fazla repo eşleşti; devam etmek için birini seçin.": "Multiple repositories matched; select one to continue.",
  "Ticket üzerindeki repo eşleştirmesi bu seçimle çelişiyor.": "The repository mapping on the ticket conflicts with this selection.",
  "Uyumluluk gerekiyor": "Compatibility required", "İşi uyumlu hale getir": "Make work item compatible",
  "Uyumluluk önizlemesi": "Compatibility preview", "Mevcut": "Current", "Önerilen": "Proposed",
  "Yapılması gereken": "Required action", "İş kaynağı": "Work source", "Dosya kapsamı": "File scope",
  "Kaynak kontrolü": "Source control", "Politika": "Policy",
  "İş güncel kurallarla yeniden yorumlandı; kalan maddeler aşağıda.": "The work item was re-evaluated with the current rules; remaining items are below.",
  "Uyumluluk yeniden değerlendiriliyor…": "Re-evaluating compatibility…",
  "Uyumluluk değerlendirilemedi:": "Compatibility could not be evaluated:",
  "Önce güvenli planı hazırlayın; agent, gösterilen rol ve dosya kapsamıyla ancak ikinci adımda başlar.": "Prepare the safe plan first; the agent starts in the second step with the displayed role and file scope.",
  "Yanıtınız": "Your answer", "Yanıtla ve devam ettir": "Answer and resume",
  "Agentlardan bekleyen bir soru yok.": "There are no pending questions from agents.",
  "Yanıt kaydedildikten sonra agent aynı planla otomatik devam eder.": "After your answer is recorded, the agent automatically resumes with the same plan.",
  "Yanıt servisi şu anda etkin değil.": "The answer service is not currently enabled.",
  "Plan hazır. Kapsamı kontrol edip Agentı başlat düğmesine basın.": "The plan is ready. Review the scope, then press Start agent.",
  "İnsan Onayı": "Human approval", "Özet": "Summary", "Kanonik durum": "Canonical status",
  "Yerel durum": "Local status", "Güncelleme": "Updated", "İş kuyruğu": "Work queue",
  "Bekleyen Onay Talepleri": "Pending approval requests",
  "Plan parmak izi korumalı, denetlenebilir ve aksiyon kapsamlı insan onayları.": "Auditable, action-scoped human approvals protected by plan fingerprints.",
  "Müdahale Gerektiren Durumlar": "Items requiring intervention",
  "Bloke workerlar, tükenmiş rework denemeleri, scope ihlalleri ve entegrasyon çatışmaları.": "Blocked workers, exhausted rework attempts, scope violations, and integration conflicts.",
  "Gönder": "Send", "Birden fazla işi tek teslimat hedefi altında yönetin.": "Manage multiple work items under one delivery goal.",
  "Parent seç": "Select parent", "Parent Epik Yükleniyor...": "Loading parent epics...",
  "Parent listesini yenile": "Refresh parent list", "İş": "Work item",
  "Tek başına planlanıp çalıştırılabilen Jira kaydıdır.": "A Jira record that can be planned and run independently.",
  "Aynı teslimatın altındaki işleri ve bağımlılıklarını bir arada yönetir.": "Groups work and dependencies that belong to the same delivery.",
  "Kullanım:": "How to use:",
  "Önce İşler sekmesinde görevleri inceleyin; bir Epic seçtiğinizde burada alt işlerin hangi sırayla çalışacağını ve ne zaman birleştirileceğini görün.": "Review tasks in Work first; after selecting an Epic, see the child execution order and merge timing here.",
  "Parent Epik Seçilmedi": "No parent epic selected", "Lütfen bir parent epik seçin": "Please select a parent epic",
  "Parent seçilmedi.": "No parent selected.", "İnsan Onayı Sınırı:": "Human approval boundary:",
  "Sistem otonom teslimatı tamamlamıştır.": "The system has completed the autonomous delivery.",
  "Çalışma planı": "Execution plan", "Alt İşlerin Yürütme Sırası": "Child work execution order",
  "Birbirini beklemeyen işler birlikte, bağımlı işler ise gereken iş tamamlandıktan sonra başlar.": "Independent work can run together; dependent work starts after its prerequisite completes.",
  "Çalışıyor": "Running", "Tamamlandı": "Completed", "Engelli": "Blocked", "Birleştirme Sırası": "Merge order",
  "İncelemesi tamamlanan alt işlerin Parent dalına alınma durumu.": "Status of reviewed child work being merged into the parent branch.",
  "Kalite kapısı": "Quality gate", "Birleştirilen değişikliklerin test ve inceleme sonucu.": "Test and review results for merged changes.",
  "Operasyonel metrikler, provider sağlığı ve telemetri.": "Operational metrics, provider health, and telemetry.",
  "Yürütmeler": "Executions", "Token Kullanımı": "Token usage", "Provider Sağlığı": "Provider health",
  "Başarısızlıklar": "Failures", "Canlı ve Kuyruktaki İşlemler": "Live and queued executions",
  "Şu anda çalışan veya yürütme sırası bekleyen provider süreçleri.": "Provider processes currently running or waiting in the execution queue.",
  "Gerçek çalışma gözlemlerine dayalı sağlık durumu.": "Health status based on actual runtime observations.",
  "Son Yürütmeler ve Token Kullanımı": "Recent executions and token usage",
  "Durable telemetry zaman çizelgesi.": "Durable telemetry timeline.",
  "İmmutable versiyonlama ile agent registry ve kullanım telemetrisi.": "Agent registry and usage telemetry with immutable versioning.",
  "Devre Dışı": "Disabled", "Arşiv": "Archive", "İmmutable Versiyonlama:": "Immutable versioning:",
  "Kayıtlı Agentlar": "Registered agents", "Kullanım Telemetrisi": "Usage telemetry",
  "Sağlayıcı Yapılandırması": "Provider configuration",
  "Runtime mimarisi, adaptörler ve provider seçimleri.": "Runtime architecture, adapters, and provider selections.",
  "Gelecek Çalıştırmalar Uyarısı:": "Future runs notice:", "Bağlantılar": "Connections",
  "İş kaynaklarını, AI araçlarını ve model sunucularını ayrı kategorilerde yönetin.": "Manage work sources, AI tools, and model servers in separate categories.",
  "Yerel ve güvenli": "Local and secure", "İş Araçları": "Work tools", "AI Araçları": "AI tools",
  "Model Sunucuları": "Model servers", "Bağlantı durumları yükleniyor…": "Loading connection statuses…",
  "İş kaynakları ve görev kuyruğu entegrasyonu.": "Work source and task queue integration.",
  "Görev yönlendirme, risk değerlendirme ve planlama.": "Task routing, risk assessment, and planning.",
  "Kod yazma ve reviewer süreçlerini çalıştıran motor.": "Engine that runs coding and reviewer processes.",
  "Semantik kod zekası ve etki analiz motoru.": "Semantic code intelligence and impact analysis engine.",
  "Git worktree ve entegrasyon branch sağlayıcısı.": "Git worktree and integration branch provider.",
  "Yürütme Onayı": "Execution approval",
  "Aşağıdaki işlem için plan parmak izi korumalı onay vermek üzeresiniz:": "You are about to grant plan-fingerprint-protected approval for:",
  "İzinli Yollar (Scope)": "Allowed paths (scope)", "Plan Parmak İzi:": "Plan fingerprint:", "İptal": "Cancel",
  "✓ Onayla ve Yürüt": "✓ Approve and run",
  "Talebi reddetmek işi bloke duruma geçirecektir. Lütfen bir gerekçe belirtin:": "Rejecting this request will block the work item. Please provide a reason:",
  "Reddetme Gerekçesi:": "Rejection reason:", "Agent Detayı": "Agent details",
  "Sağlayıcı Detayı": "Provider details", "Sağlayıcı bağlantısı": "Provider connection",
  "Jira hesabı e-postası": "Jira account email",
  "Token ekranda tekrar gösterilmez ve yapılandırma dosyasına yazılmaz.": "The token is never shown again and is not written to the configuration file.",
  "Bu güvenilir özel ağ sunucusuna görev metni ve ilgili kod bağlamının gönderilebileceğini onaylıyorum.": "I confirm task text and relevant code context may be sent to this trusted private network server.",
  "Önce “Modelleri Getir” ile sunucuyu doğrulayın.": "Verify the server with “Fetch models” first.",
  "Bağlan": "Connect", "Yürütücü Olarak Kullan": "Use as executor", "Bağlantıyı Kaldır": "Remove connection",
  "Agent Versiyon Geçmişi": "Agent version history", "Agent Güncelle (Yeni Versiyon)": "Update agent (new version)",
  "İmmutable Kuralı:": "Immutable rule:", "Görünen İsim:": "Display name:",
  "Skills (virgülle ayrılmış):": "Skills (comma-separated):", "Allowed Paths (virgülle ayrılmış):": "Allowed paths (comma-separated):",
  "Yeni Agent Tanımla": "Create new agent", "✓ Agent Oluştur": "✓ Create agent",
  "Prompts ve Jira açıklamaları bu ekranda ham olarak gösterilmez.": "Prompts and Jira descriptions are not shown raw on this screen.",
  "Canlı": "Live", "Bağlantı Yok": "No connection", "Bağlantı Kesildi": "Connection lost",
  "Açıklama yok": "No description", "Detay": "Details", "İncele": "View", "Onayla": "Approve",
  "Reddet": "Reject", "Aç": "Open", "Arşivle": "Archive", "Seç": "Select",
  "Yapılandırılabilir": "Configurable", "Yapılandırıldı": "Configured", "Bağlı": "Connected",
  "Bağlı değil": "Not connected", "Kurulu": "Installed", "Kurulu değil": "Not installed",
  "Çalışmıyor": "Not running", "Model yok": "No models", "Oturum gerekli": "Sign-in required",
  "Seçili": "Selected", "Bilinmiyor": "Unknown", "İş kaynağı": "Work source",
  "Orkestratör": "Orchestrator", "Kod zekâsı": "Code intelligence", "Kaynak kontrol": "Source control",
  "Tip": "Type", "Model / profil": "Model / profile", "Değişiklik": "Change", "Sağlayıcı": "Provider",
  "Bağlantı": "Connection", "Yerel yürütücü": "Local executor", "AI yürütme aracı": "AI execution tool",
  "Windows güvenli kasa": "Windows secure vault", "Ortam değişkenleri": "Environment variables",
  "Bağlantı bilgisi bulunamadı.": "No connection information found.",
  "Sağlayıcı bilgisi bulunamadı.": "No provider information found.", "Sağlayıcı yapılandırması": "Provider configuration",
  "Detaylar yükleniyor...": "Loading details...", "Yükleniyor...": "Loading...", "İş Detayı": "Work item details",
  "1. Work Item Özeti": "1. Work item summary", "Kanonik Durum": "Canonical status",
  "Kaynak Sağlayıcı": "Source provider", "Otonom İlerlenebilir": "Autonomous eligible",
  "Evet": "Yes", "Hayır": "No", "2. Orkestrasyon ve Planlama Kararı": "2. Orchestration and planning decision",
  "Plan Parmak İzi": "Plan fingerprint", "İzinli Yollar": "Allowed paths", "Bağımlılıklar": "Dependencies",
  "Bağımsız": "Independent", "3. Agent Kimliği (Registry)": "3. Agent identity (registry)",
  "Canlı Registry Durumu": "Live registry status", "Canlı Registry Version": "Live registry version",
  "Canlı Registry Hash": "Live registry hash", "Sabitlenmiş Sürüm Güncel": "Pinned version current",
  "4. Yürütme Motoru ve Worktree": "4. Execution engine and worktree", "Çalışma Durumu": "Execution status",
  "Deneme": "Attempt", "5. Reviewer ve Doğrulama Bulguları": "5. Reviewer and verification findings",
  "Henüz verilmedi": "Not available yet", "İncelenen SHA": "Reviewed SHA",
  "6. İnsan Kontrol ve Onay Kapısı": "6. Human control and approval gate", "Bekleyen Aksiyon": "Pending action",
  "Yok": "None", "Onay Durumu": "Approval status", "🛑 Bloke Durumu ve Teşhis": "🛑 Blocked status and diagnosis",
  "Gerekçe": "Reason", "Teknik ayrıntı": "Technical detail", "Hata kategorisi": "Failure category", "Otomatik geçiş uygunluğu": "Automatic failover eligibility", "Tekrar Denenebilir": "Retryable", "Onaylanabilir": "Approvable",
  "Yedek rota": "Fallback route", "Otomatik geçiş": "Automatic failover", "Geçiş kaynağı": "Switched from",
  "Etkin": "Enabled", "Kapalı": "Disabled",
  "7. Denetlenebilir Olay Zaman Çizelgesi": "7. Auditable event timeline", "7. Çalışma zaman çizelgesi": "7. Work timeline", "Zaman çizelgesi boş.": "Timeline is empty.",
  "Son önemli adımlar gösteriliyor. Tekrarlanan teknik olaylar aşağıda kapalıdır.": "The latest important steps are shown. Repeated technical events are collapsed below.",
  "Teknik ayrıntı": "Technical detail", "Canlı ara rapor": "Live progress report", "Ara raporu aç": "Open progress report",
  "Canlı agent raporu": "Live agent report", "Ara raporu yenile": "Refresh progress report", "Son sinyal:": "Last signal:", "henüz alınmadı": "not received yet",
  "Agent çalışıyor; henüz ayrıntılı bir ilerleme mesajı alınmadı.": "The agent is running; no detailed progress message has been received yet.",
  "Agent oturumu başlatıldı ve çalışma alanı hazırlandı.": "The agent session started and the workspace is ready.",
  "İş talimatları alındı; agent analiz ve uygulama aşamasına geçti.": "The task instructions were received; the agent moved to analysis and implementation.",
  "Agent adımı güncellendi:": "Agent step updated:", "Agent araç kullanıyor:": "Agent is using a tool:",
  "Agent çalışıyor:": "Agent is working:", "Agent çalışıyor; yeni bir çalışma olayı alındı.": "The agent is working; a new progress event was received.",
  "İş kaydı alındı": "Work item received", "Çalıştırma koşulları doğrulandı": "Execution conditions verified",
  "Agent işi sahiplendi": "Agent claimed the work", "Güvenli çalışma alanı hazırlandı": "Safe workspace prepared",
  "Agent sıraya alındı": "Agent queued", "Agent başlatıldı": "Agent started", "Model seçildi": "Model selected",
  "Agent çalışıyor": "Agent is working", "Agent uygulamayı yürütüyor": "Agent is implementing",
  "Doğrulama başladı": "Verification started", "İnceleme sıraya alındı": "Review queued",
  "İnceleme temiz tamamlandı": "Review completed cleanly", "İncelemede düzeltme istendi": "Review requested changes",
  "İş dikkat gerektiriyor": "Work needs attention", "Deneme başarısız; yeniden denenebilir": "Attempt failed; retry is available",
  "Dosya kapsamı ihlali nedeniyle durdu": "Stopped because of a file-scope violation", "Çalışma başarısız oldu": "Execution failed", "Çalışma olayı": "Work event",
  "Parentlar yüklenemedi": "Parents could not be loaded", "Parent epik bulunamadı": "No parent epic found",
  "-- Parent Epik Seçin --": "-- Select parent epic --", "Toplam alt iş": "Total child work",
  "Hemen başlayabilir": "Can start now", "Önceki işler tamamlanınca": "After previous work completes",
  "Ön koşul": "Prerequisite", "Beklemeden başlayabilir": "Can start without waiting",
  "Alt iş bulunamadı.": "No child work found.", "Bu Parent altında henüz alt iş bulunmuyor.": "This parent has no child work yet.",
  "Henüz orchestration run yok": "No orchestration run yet", "Parent Epik": "Parent epic",
  "Birleştirmeye hazır": "Ready to merge", "İnceleme bekliyor": "Waiting for review", "İncelemede": "Under review",
  "Başarılı": "Successful", "Başarısız": "Failed", "döngü": "cycles", "Kuyrukta": "Queued",
  "Filtreyi değiştirin veya bir": "Change the filter or dispatch an", "task dispatch edin.": "task.",
  "Bu görünümde aktif veya kuyrukta iş yok.": "No active or queued work in this view.",
  "Şu anda çalışan veya incelemede aktif işlem yok.": "There is no running or actively reviewed execution.",
  "Şu anda onay bekleyen yürütme planı yok.": "There is no execution plan awaiting approval.",
  "Henüz hareket kaydedilmedi.": "No activity has been recorded yet.", "Henüz PM mesajı yok.": "No PM messages yet.",
  "Henüz kayıtlı karar yok.": "No recorded decisions yet.", "Bu filtrede iş bulunmuyor.": "No work found for this filter.",
  "Issue adı veya anahtarı ara": "Search issue name or key", "Durum": "Status", "Tüm durumlar": "All statuses",
  "Planlama bekliyor": "Needs planning", "Devam ediyor": "In progress", "Düzeltme gerekiyor": "Needs rework",
  "Bloke": "Blocked", "İnsan onayı": "Human approval", "Tamamlandı": "Done", "İptal edildi": "Cancelled",
  "Bilinmeyen durum": "Unknown status", "Sayfa boyutu": "Page size", "Önceki": "Previous", "Sonraki": "Next",
  "İş detayını aç →": "Open work details →", "Bağlantı durumu bilinmiyor": "Connection status is unknown",
  "Bağlantı durumunu kontrol edin.": "Check the connection status.", "Bağlantı durumunu test edin.": "Test the connection status.",
  "Bağlantı hazır ve kullanılabilir.": "The connection is ready to use.", "Bağlan ve Güvenli Kaydet": "Connect and save securely",
  "Bağlantıyı Aç": "Open connection", "Codex Girişini Aç": "Open Codex sign-in",
  "Bağlantı test ediliyor…": "Testing connection…", "Bağlantı doğrulanıyor…": "Verifying connection…",
  "Bağlantı kaldırılıyor…": "Removing connection…", "Yerel model yürütücü olarak seçiliyor…": "Selecting local model as executor…",
  "Özel ağ sunucusu": "Private network server", "Güvenli kasa": "Secure vault", "Yürütme": "Execution",
  "Çalışma yapılandırması": "Execution configuration", "Review yapılandırması": "Review configuration",
  "Sabitlenmiş sürüm ve çalışma yapılandırması": "Pinned version and execution configuration",
  "Kayıtlı agent bulunamadı.": "No registered agents found.", "Olay kaydı yok.": "No events recorded.",
  "Provider telemetri verisi bulunamadı.": "No provider telemetry data found.",
  "Seçilen zaman penceresinde yürütme kaydı yok.": "No executions in the selected time window.",
  "Sağlık": "Health", "Başarı Oranı": "Success rate", "Ort. Süre": "Avg. duration",
  "Kullanılabilir": "Available", "Başarılı / Başarısız": "Successful / failed",
  "Yeniden deneme kuyruğunda": "Retry queued", "Review kuyruğunda": "Review queued",
  "Review düzeltmesi bekliyor": "Waiting for review fix", "Entegrasyon Çatışması": "Integration conflict",
  "İnsan Onayında": "Human approval", "Henüz başlatılmadı": "Not started",
  "İşleniyor": "In progress", "Keşfedildi": "Discovered", "Hazırlanıyor": "Preparing",
  "Sıraya alındı": "Queued", "Başlatıldı": "Started", "Model seçildi": "Model selected"
});

const UI_TEXT_TR = Object.freeze(Object.fromEntries(Object.entries(UI_TEXT_EN).map(([tr, en]) => [en, tr])));
const TRANSLATION_TEXT_SOURCES = new WeakMap();
const TRANSLATION_ATTRIBUTE_SOURCES = new WeakMap();
const UI_MESSAGES = Object.freeze({
  tr: {
    workDetailTitle: "İş Detayı · {key}", detailsLoading: "Detaylar yükleniyor...", loading: "Yükleniyor...",
    workDetailFailed: "İş detayı yüklenemedi", parentLoading: "Parent detayı yükleniyor...",
    parentFailed: "Parent detayı yüklenemedi", requestTimedOut: "İstek zaman aşımına uğradı. Bağlantıyı kontrol edip tekrar deneyin.",
    compatibilityCount: "{count} uyumluluk maddesi bulundu. Sistem güvenlik kapılarını otomatik olarak aşmaz.",
    compatibilityChecking: "Uyumluluk yeniden değerlendiriliyor…",
    compatibilityChecked: "İş güncel kurallarla yeniden yorumlandı; kalan maddeler aşağıda.",
    compatibilityFailed: "Uyumluluk değerlendirilemedi: {error}"
  },
  en: {
    workDetailTitle: "Work item details · {key}", detailsLoading: "Loading details...", loading: "Loading...",
    workDetailFailed: "Work item details could not be loaded", parentLoading: "Loading parent details...",
    parentFailed: "Parent details could not be loaded", requestTimedOut: "The request timed out. Check the connection and try again.",
    compatibilityCount: "{count} compatibility items were found. The system never bypasses safety gates automatically.",
    compatibilityChecking: "Re-evaluating compatibility…",
    compatibilityChecked: "The work item was re-evaluated with the current rules; remaining items are below.",
    compatibilityFailed: "Compatibility could not be evaluated: {error}"
  }
});

function readStoredLanguage() {
  try {
    const value = localStorage.getItem("pacebuild-language");
    return value === "en" ? "en" : "tr";
  } catch {
    return "tr";
  }
}

function uiMessage(key, values = {}) {
  const messages = UI_MESSAGES[state.language] || UI_MESSAGES.tr;
  return String(messages[key] || UI_MESSAGES.tr[key] || key).replace(/\{(\w+)\}/g, (_match, name) => values[name] ?? "");
}

function translateUiText(value) {
  const text = String(value ?? "");
  return state.language === "en" ? (UI_TEXT_EN[text] || text) : (UI_TEXT_TR[text] || text);
}

function applyDocumentTranslations() {
  if (typeof document === "undefined") return;
  if (typeof document.createTreeWalker === "function" && typeof NodeFilter !== "undefined") {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parentTag = node.parentElement?.tagName?.toLowerCase();
      if (parentTag !== "script" && parentTag !== "style") {
        const raw = node.nodeValue || "";
        const trimmed = raw.trim();
        const canonical = TRANSLATION_TEXT_SOURCES.get(node) || UI_TEXT_TR[trimmed] || trimmed;
        if (UI_TEXT_EN[canonical]) {
          TRANSLATION_TEXT_SOURCES.set(node, canonical);
          node.nodeValue = raw.replace(trimmed, state.language === "en" ? UI_TEXT_EN[canonical] : canonical);
        }
      }
      node = walker.nextNode();
    }
  }
  document.querySelectorAll?.("[placeholder], [title], [aria-label]").forEach(node => {
    const sources = TRANSLATION_ATTRIBUTE_SOURCES.get(node) || {};
    for (const attr of ["placeholder", "title", "aria-label"]) {
      if (!node.hasAttribute?.(attr)) continue;
      const current = node.getAttribute(attr);
      const canonical = sources[attr] || UI_TEXT_TR[current] || current;
      if (!UI_TEXT_EN[canonical]) continue;
      sources[attr] = canonical;
      node.setAttribute(attr, state.language === "en" ? UI_TEXT_EN[canonical] : canonical);
    }
    TRANSLATION_ATTRIBUTE_SOURCES.set(node, sources);
  });
}

function applyLanguage(language, { rerender = true } = {}) {
  state.language = language === "en" ? "en" : "tr";
  try { localStorage.setItem("pacebuild-language", state.language); } catch {}
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = state.language;
  Object.keys(STATUS_LABELS).forEach(key => delete STATUS_LABELS[key]);
  Object.assign(STATUS_LABELS, state.language === "en" ? STATUS_LABELS_EN : STATUS_LABELS_TR);
  if (typeof document !== "undefined") {
    document.querySelectorAll?.("[data-language]").forEach(button => {
      const active = button.dataset.language === state.language;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
  if (rerender && state.snapshot) {
    updateTopbar(state.snapshot); renderOverview(state.snapshot); renderPmWorkspace();
    renderConfigView(state.snapshot); renderAgentRegistry(); populateParentSelector();
  }
  if (rerender && state.currentWorkItemDetail) renderDecisionTraceDetail(state.currentWorkItemDetail);
  if (rerender && state.currentParentDetail) renderParentDetail(state.currentParentDetail);
  if (rerender && state.providerConnections) renderProviderConnections(state.providerConnections);
  applyDocumentTranslations();
}

const PERSONA_INITIALS = {
  "frontend-engineer": "FE",
  "backend-engineer": "BE",
  "cv-engineer": "CV",
  "data-engineer": "DE",
  "devops-engineer": "DO",
  "qa-engineer": "QA",
  "security-engineer": "SE",
  architect: "AR",
  "pm-analyst": "PM"
};

const ROLE_LABELS = {
  worker: "Worker",
  reviewer: "Reviewer",
  integration: "Integration"
};

function getElem(id) {
  if (typeof document === "undefined") return null;
  if (typeof document.getElementById === "function") return document.getElementById(id);
  if (typeof document.querySelector === "function") return document.querySelector("#" + id);
  return null;
}

function safeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function element(tag, className, text) {
  if (typeof document === "undefined") return {};
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = translateUiText(text);
  return node;
}

function formatNumber(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(state.language === "en" ? "en-US" : "tr-TR", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "Duration unavailable";
  const sec = Number(seconds);
  if (sec < 60) return `${sec} sn`;
  const minutes = Math.floor(sec / 60);
  const rest = sec % 60;
  if (minutes < 60) return `${minutes} dk ${rest ? `${rest} sn` : ""}`.trim();
  return `${Math.floor(minutes / 60)} sa ${minutes % 60} dk`;
}

function formatDurationMs(ms) {
  if (ms === null || ms === undefined) return "Duration unavailable";
  const sec = Math.round(Number(ms) / 1000);
  return formatDuration(sec);
}

function formatTime(value, includeDate = false) {
  if (!value) return "—";
  try {
    const options = includeDate
      ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit", second: "2-digit" };
    return new Intl.DateTimeFormat(state.language === "en" ? "en-US" : "tr-TR", options).format(new Date(value));
  } catch {
    return String(value);
  }
}

function getWorkerInfo(run) {
  return { status: run.workerStatus || "finished", pid: run.workerPid };
}

function formatWorkerLabel(run) {
  const { status, pid } = getWorkerInfo(run);
  if (status === "queued") return "Kuyrukta";
  if (status === "running") {
    return pid ? `Çalışıyor · PID ${pid}` : "Çalışıyor";
  }
  return "Tamamlandı";
}

function displayModel(run) {
  if (!run.model) return run.provider || "default";
  return run.model
    .replace("claude-", "")
    .replace("-thinking", " · thinking")
    .replace("gpt-oss-", "GPT-OSS ")
    .replace("-medium", " · medium")
    .trim();
}

function statePill(run) {
  const pill = element("span", `state-pill ${run.stateKind}`);
  pill.textContent = STATUS_LABELS[run.state] || run.state;
  return pill;
}

function metaRow(label, value) {
  const row = element("div", "agent-meta-row");
  if (typeof row.append === "function") {
    row.append(element("span", "", label), element("strong", "", value || "—"));
  }
  return row;
}

function formatAgentProgress(value) {
  const raw = String(value || "").trim();
  if (!raw) return translateUiText("Agent çalışıyor; henüz ayrıntılı bir ilerleme mesajı alınmadı.");
  try {
    const parsed = JSON.parse(raw);
    const event = String(parsed.event || parsed.type || "").toLowerCase();
    if (event === "init") return translateUiText("Agent oturumu başlatıldı ve çalışma alanı hazırlandı.");
    if (event === "step_update") {
      const update = parsed.step_update || {};
      const type = String(update.step_type || "step").replaceAll("_", " ");
      const status = String(update.state || "running").toUpperCase();
      if (type === "user input" && status === "DONE") {
        return translateUiText("İş talimatları alındı; agent analiz ve uygulama aşamasına geçti.");
      }
      return translateUiText("Agent adımı güncellendi:") + ` ${type} · ${status}`;
    }
    const toolName = parsed.tool?.name || parsed.tool_name || parsed.name;
    if (event.includes("tool") && toolName) return translateUiText("Agent araç kullanıyor:") + ` ${toolName}`;
    const message = parsed.message?.text || parsed.message?.content || parsed.text || parsed.delta?.text;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 600);
    if (event) return translateUiText("Agent çalışıyor:") + ` ${event.replaceAll("_", " ")}`;
    return translateUiText("Agent çalışıyor; yeni bir çalışma olayı alındı.");
  } catch {
    return raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
  }
}

const FRIENDLY_TIMELINE_LABELS = Object.freeze({
  discovered: "İş kaydı alındı",
  eligible: "Çalıştırma koşulları doğrulandı",
  claimed: "Agent işi sahiplendi",
  preparation: "Güvenli çalışma alanı hazırlandı",
  prepared: "Güvenli çalışma alanı hazırlandı",
  queued: "Agent sıraya alındı",
  started: "Agent başlatıldı",
  model_selected: "Model seçildi",
  progress: "Agent çalışıyor",
  execution: "Agent uygulamayı yürütüyor",
  executing: "Agent uygulamayı yürütüyor",
  verifying: "Doğrulama başladı",
  review_queued: "İnceleme sıraya alındı",
  review_clean: "İnceleme temiz tamamlandı",
  review_failed: "İncelemede düzeltme istendi",
  blocked: "İş dikkat gerektiriyor",
  "failed-retryable": "Deneme başarısız; yeniden denenebilir",
  "failed-scope": "Dosya kapsamı ihlali nedeniyle durdu",
  failed: "Çalışma başarısız oldu"
});

function friendlyTimelineLabel(item) {
  const stage = String(item?.stage || item?.state || "event");
  return translateUiText(FRIENDLY_TIMELINE_LABELS[stage] || item?.label || "Çalışma olayı");
}

function compactAuditHistory(history) {
  const keepOne = new Set([
    "discovered", "eligible", "claimed", "preparation", "prepared", "queued",
    "started", "model_selected", "progress", "execution", "executing"
  ]);
  const seen = new Set();
  const compact = [];
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index];
    const stage = String(item?.stage || item?.state || "event");
    if (keepOne.has(stage) && seen.has(stage)) continue;
    if (keepOne.has(stage)) seen.add(stage);
    compact.push(item);
  }
  return compact.reverse().slice(-8);
}

function normalizeRole(role) {
  const value = String(role || "worker").toLowerCase();
  if (["review", "reviewer", "qa"].includes(value)) return "reviewer";
  if (["integration", "integrator"].includes(value)) return "integration";
  return value || "worker";
}

function roleLane(lane) {
  const run = lane.latest;
  const section = element("section", `role-lane role-lane-${lane.role}`);
  if (typeof section.setAttribute === "function") {
    section.setAttribute("aria-label", `${ROLE_LABELS[lane.role] || lane.role} lane`);
  }

  const header = element("div", "role-lane-header");
  const heading = element("div", "role-lane-heading");
  if (typeof heading.append === "function") {
    heading.append(
      element("strong", "role-lane-name", ROLE_LABELS[lane.role] || lane.role),
      element("span", `worker-badge worker-${getWorkerInfo(run).status}`, formatWorkerLabel(run))
    );
  }
  if (typeof header.append === "function") {
    header.append(heading, statePill(run));
    section.append(header);
  }

  const actor = run.taskAgent || run.persona || "unassigned";
  if (typeof section.append === "function") {
    section.append(element(
      "p",
      "role-lane-agent",
      `${actor} · ${displayModel(run)} · Deneme ${run.attempt || lane.attempts.length}`
    ));
  }

  if (run.blockers?.length || run.stateKind === "blocked") {
    const blocker = element("div", "blocker-note role-lane-blocker");
    const statusText = run.humanActionRequired
      ? "Senden aksiyon bekleniyor"
      : run.blockerResolved
        ? "Blocker çözüldü"
        : "Otomatik çözüm bekliyor";
    if (typeof blocker.append === "function") {
      blocker.append(
        element("strong", "blocker-title", statusText),
        element("span", "blocker-cause", `Neden durdu: ${run.blockers?.[0] || "Bilinmeyen blocker nedeni"}`),
        element("span", "blocker-expectation", `Senden beklenen: ${run.humanActionRequired
          ? (run.userExpectation || "Blocker açıklamasındaki insan kararını tamamla")
          : "Bir işlem yok; sistem güvenli retry şartlarını kontrol edecek"}`),
        element("span", "blocker-action", `Sonraki adım: ${run.resolution || "Bir sonraki reconciliation döngüsünde yeniden değerlendirilecek"}`)
      );
    }
    if (typeof section.append === "function") {
      section.append(blocker);
    }
  }

  const retryable = ["failed-retryable", "blocked"].includes(run.state) && !run.humanActionRequired;
  if (retryable) {
    const maxAttempts = state.snapshot?.policy?.maxAttempts || 3;
    const retryPanel = element("div", "retry-panel");
    const retryBtn = element("button", "retry-button", "Blocker çözüldü — aynı işi yeniden çalıştır");
    const retryStatus = element("p", "retry-status", "");
    const hasHandler = state.snapshot?.capabilities?.retryHandler;
    const canRetry = (run.attempt || lane.attempts.length) < maxAttempts;
    if (!hasHandler || !canRetry) {
      retryBtn.disabled = true;
      retryStatus.textContent = !hasHandler
        ? "Yeniden çalıştırma servisi şu anda bağlı değil."
        : `${maxAttempts}/${maxAttempts} otomatik deneme kullanıldı; yeni worker başlatılmayacak.`;
    }
    if (typeof retryPanel.append === "function") {
      retryPanel.append(
        element("p", "retry-help", "Bu işlem onay veya merge vermez; aynı branch ve güvenli planla yeni worker denemesi oluşturur."),
        retryBtn,
        retryStatus
      );
    }
    if (typeof section.append === "function") {
      section.append(retryPanel);
    }
  }

  return section;
}

function taskCard(group) {
  // Support both raw run objects and grouped task objects
  const run = group.latest || group;
  const allRuns = group.attempts || [group];
  const lanes = group.lanes || [];

  const card = element("article", `agent-card state-${run.stateKind || "idle"}`);
  card.dataset = card.dataset || {};
  card.dataset.issueKey = run.issue || run.issueKey || "";

  if (typeof card.setAttribute === "function") {
    card.setAttribute("aria-label", `${run.issue || run.issueKey}: ${run.summary || ""}`);
  }

  const topline = element("div", "card-topline");
  const leftGroup = element("div", "topline-left");
  const { status: workerStatus } = getWorkerInfo(run);

  const issueLink = element("a", "issue-key-link", run.issue || run.issueKey);
  issueLink.href = `https://houndvision.atlassian.net/browse/${run.issue || run.issueKey}`;
  issueLink.target = "_blank";
  issueLink.rel = "noopener noreferrer";

  if (typeof leftGroup.append === "function") {
    leftGroup.append(
      issueLink,
      element("span", `worker-badge worker-${workerStatus}`, formatWorkerLabel(run))
    );
    topline.append(leftGroup, statePill(run));
    card.append(topline);
  }

  const taskTitle = element("h3", "task-title");
  const taskLink = element("a", "task-title-link", run.summary || "Task");
  taskLink.href = issueLink.href;
  taskLink.target = "_blank";
  taskLink.rel = "noopener noreferrer";
  if (typeof taskTitle.append === "function") {
    taskTitle.append(taskLink);
    card.append(taskTitle);
  }

  if (lanes.length > 0) {
    const lanesContainer = element("div", "role-lanes");
    if (typeof lanesContainer.append === "function") {
      lanesContainer.append(...lanes.map(roleLane));
      card.append(lanesContainer);
    }
  }

  const meta = element("div", "agent-meta");
  if (typeof meta.append === "function") {
    meta.append(metaRow("Model", displayModel(run)), metaRow("Çalışma", formatDuration(run.durationSeconds)));
    card.append(meta);
  }

  if (run.stateKind === "active") {
    const liveReport = element("div", "live-agent-card-report");
    liveReport.appendChild(element("strong", null, "Canlı ara rapor"));
    liveReport.appendChild(element("span", null, formatAgentProgress(run.progressText)));
    const reportButton = element("button", "pm-btn pm-btn-view", "Ara raporu aç");
    reportButton.type = "button";
    reportButton.addEventListener?.("click", () => openDecisionTrace(run.issue || run.issueKey));
    liveReport.appendChild(reportButton);
    card.append(liveReport);
  }

  const footer = element("footer", "agent-card-footer");
  const taskTokens = allRuns.reduce((sum, r) => sum + (r.tokens || 0), 0);
  const latestTokens = run.tokens;

  const tokenText = (latestTokens === undefined || latestTokens === null || latestTokens === 0)
    ? "Usage unavailable"
    : `${formatNumber(taskTokens)} token (total) · ${formatNumber(latestTokens)} (this attempt)`;

  const taskTokenText = taskTokens > 0
    ? `${formatNumber(taskTokens)} token toplam · ${run.usageAvailable && latestTokens > 0 ? `${formatNumber(latestTokens)} son deneme` : "son deneme usage unavailable"}`
    : tokenText;

  const detailBtn = element("button", "pm-btn pm-btn-view", "İncele");
  detailBtn.type = "button";
  if (typeof detailBtn.addEventListener === "function") {
    detailBtn.addEventListener("click", () => {
      openDecisionTrace(run.issue || run.issueKey);
    });
  }

  if (typeof footer.append === "function") {
    footer.append(
      element("span", "", taskTokenText),
      element("span", "", `${run.turns || 0} turn`),
      detailBtn
    );
    card.append(footer);
  }

  return card;
}

function visibleRuns() {
  if (!state.snapshot) return [];
  const runs = state.snapshot.runs || [];
  const query = (state.query || "").trim().toLocaleLowerCase("tr-TR");

  const groups = {};
  for (const run of runs) {
    const key = run.issue || run.issueKey || "UNASSIGNED";
    if (!groups[key]) groups[key] = [];
    groups[key].push(run);
  }

  const groupedTasks = Object.values(groups).map((group) => {
    const attempts = [...group].sort((a, b) =>
      new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    );
    const roleGroups = {};
    for (const run of attempts) {
      const role = normalizeRole(run.role);
      const laneKey = role;
      if (!roleGroups[laneKey]) roleGroups[laneKey] = { role, attempts: [] };
      roleGroups[laneKey].attempts.push(run);
    }
    const lanes = Object.values(roleGroups)
      .map((lane) => ({
        role: lane.role,
        attempts: lane.attempts,
        latest: lane.attempts.at(-1)
      }))
      .sort((a, b) => {
        const order = ["worker", "reviewer", "integration"];
        return (order.indexOf(a.role) + 1 || 99) - (order.indexOf(b.role) + 1 || 99);
      });
    const latest = attempts.at(-1);
    return {
      issue: latest.issue || latest.issueKey,
      summary: latest.summary,
      latest,
      attempts,
      lanes,
      stateKind: latest.stateKind
    };
  });

  return groupedTasks.filter((task) => {
    const run = task.latest;
    const matchesFilter = state.filter === "all" || task.lanes.some((lane) => lane.latest.stateKind === state.filter);
    const text = task.attempts.flatMap((attempt) => [
      attempt.issue, attempt.issueKey, attempt.summary, attempt.persona, attempt.taskAgent,
      attempt.provider, attempt.model, ...(attempt.skills || [])
    ])
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("tr-TR");
    return matchesFilter && (!query || text.includes(query));
  });
}

function appendNode(parent, child) {
  if (typeof parent?.appendChild === "function") parent.appendChild(child);
  else if (typeof parent?.append === "function") parent.append(child);
}

function appendTableTextCell(row, value, className = "") {
  const cell = element("td", className, value === null || value === undefined || value === "" ? "—" : String(value));
  appendNode(row, cell);
  return cell;
}

function renderActiveWorkTable(tasks) {
  const tbody = getElem("active-work-tbody");
  const table = getElem("active-work-table");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (tasks.length === 0) {
    const row = element("tr");
    const cell = element("td", null, "Bu görünümde aktif veya kuyrukta iş yok.");
    cell.colSpan = 7;
    appendNode(row, cell);
    appendNode(tbody, row);
    if (table) table.setAttribute("aria-busy", "false");
    return;
  }

  tasks.forEach(task => {
    const run = task.latest || task;
    const issueKey = run.issue || run.issueKey || "—";
    const row = element("tr", "work-table-row");
    row.tabIndex = 0;
    row.setAttribute("aria-label", issueKey + " detayını aç");
    const openDetail = () => openDecisionTrace(issueKey, false, row);
    row.addEventListener?.("click", openDetail);
    row.addEventListener?.("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail();
      }
    });

    appendTableTextCell(row, issueKey, "code-cell");
    const stateCell = element("td");
    appendNode(stateCell, statePill(run));
    appendNode(row, stateCell);
    appendTableTextCell(row, run.taskAgent || run.persona || "—");
    appendTableTextCell(row, (run.provider || "—") + " / " + (displayModel(run) || "—"));
    appendTableTextCell(row, formatDuration(run.durationSeconds));
    appendTableTextCell(row, formatTime(run.updatedAt || run.createdAt));
    const actionCell = element("td");
    const detail = element("button", "pm-btn pm-btn-view", "Detay");
    detail.type = "button";
    detail.addEventListener?.("click", event => {
      event.stopPropagation();
      openDetail();
    });
    appendNode(actionCell, detail);
    const canStop = state.snapshot?.capabilities?.execution?.stopEnabled === true &&
      run.stateKind === "active" &&
      Boolean(run.id);
    if (canStop) {
      const stop = element("button", "pm-btn pm-btn-reject", "Durdur");
      stop.type = "button";
      stop.addEventListener?.("click", event => {
        event.stopPropagation();
        stopRunExecution(run.id, stop);
      });
      appendNode(actionCell, stop);
    }
    appendNode(row, actionCell);
    appendNode(tbody, row);
  });

  if (table) table.setAttribute("aria-busy", "false");
}

function renderRuns() {
  const tasks = visibleRuns();
  const empty = elements.empty || getElem("empty-state");

  renderActiveWorkTable(tasks);

  if (empty) empty.hidden = tasks.length !== 0;
}

function providerItem(provider) {
  const wrapper = element("div", "provider-item");
  const label = element("div", "capacity-label");
  const name = element("span", "provider-name");
  if (typeof name.append === "function") {
    name.append(element("span", "provider-symbol", provider.name === "antigravity" ? "AG" : "CX"), document.createTextNode ? document.createTextNode(provider.name) : provider.name);
  }

  const statsSpan = element("span", "capacity-stats");
  const queuedText = provider.queued ? ` (${provider.queued} kuyrukta)` : "";
  const quotaText = (provider.quota !== undefined && provider.quota !== null)
    ? `Remaining quota: ${new Intl.NumberFormat("tr-TR").format(provider.quota)}`
    : `Provider does not expose remaining quota`;
  const quotaEl = element("small", "", quotaText);

  if (typeof statsSpan.append === "function") {
    statsSpan.append(element("span", "", `${provider.active} / ${provider.limit || 2}${queuedText}`), quotaEl);
  }

  if (typeof label.append === "function") {
    label.append(name, statsSpan);
  }

  const track = element("div", "capacity-track");
  const fill = element("div", "capacity-fill");
  fill.style = fill.style || {};
  fill.style.width = `${Math.min(100, (provider.active / Math.max(1, provider.limit || 2)) * 100)}%`;
  if (typeof track.append === "function") {
    track.append(fill);
  }
  if (typeof wrapper.append === "function") {
    wrapper.append(label, track);
  }
  return wrapper;
}

function renderCapacity() {
  const cap = state.snapshot?.capacity;
  if (!cap) return;
  const queuedText = cap.queued ? ` (${cap.queued} kuyrukta)` : "";
  const capTotalEl = elements.capacityTotal || getElem("capacity-total");
  const provListEl = elements.providers || getElem("provider-list");

  if (capTotalEl) capTotalEl.textContent = `${cap.active || 0} / ${cap.total || cap.maxSlots || 4}${queuedText}`;

  if (provListEl) {
    const providers = cap.providers || cap.executors || [];
    if (typeof provListEl.replaceChildren === "function") {
      provListEl.replaceChildren(...providers.map(providerItem));
    } else {
      provListEl.innerHTML = "";
      providers.forEach(p => provListEl.appendChild(providerItem(p)));
    }
  }
}

// URL State Navigation
function syncUrlState(replace = false) {
  if (typeof window === "undefined" || !window.history) return;
  const params = new URLSearchParams();

  if (state.currentView && state.currentView !== "overview-view") {
    const viewKey = state.currentView.replace("-view", "");
    params.set("view", viewKey);
  }
  if (state.selectedParentKey) {
    params.set("parent", state.selectedParentKey);
  }
  if (state.selectedWorkItemKey) {
    params.set("issue", state.selectedWorkItemKey);
  }
  if (state.selectedRunId) {
    params.set("run", state.selectedRunId);
  }

  const newQuery = params.toString();
  const newUrl = newQuery ? `${window.location.pathname}?${newQuery}` : window.location.pathname;
  const currentUrl = `${window.location.pathname}${window.location.search}`;

  if (newUrl !== currentUrl) {
    const historyState = {
      view: state.currentView || "overview-view",
      parent: state.selectedParentKey || null,
      issue: state.selectedWorkItemKey || null,
      run: state.selectedRunId || null
    };
    if (replace) {
      window.history.replaceState(historyState, "", newUrl);
    } else {
      window.history.pushState(historyState, "", newUrl);
    }
  }
}

function readUrlState() {
  if (typeof window === "undefined" || !window.location) return;
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get("view");
  const parentParam = params.get("parent");
  const issueParam = params.get("issue");
  const runParam = params.get("run");

  // Reconcile parent selection state before view switching
  if (parentParam) {
    state.selectedParentKey = parentParam;
  } else {
    state.selectedParentKey = null;
    const select = getElem("parent-select");
    if (select) select.value = "";
    clearParentDetail();
  }

  // Reconcile view — absent means overview
  if (viewParam) {
    const targetView = `${viewParam}-view`;
    const viewEl = getElem(targetView);
    if (viewEl) {
      switchView(targetView, true);
    }
  } else {
    switchView("overview-view", true);
  }

  // If on parents view and parent is specified, fetch it
  if (parentParam && state.currentView === "parents-view") {
    fetchParentDetail(parentParam);
  }

  // Reconcile issue — absent closes Decision Trace
  if (issueParam) {
    openDecisionTrace(issueParam, true);
  } else {
    if (state.selectedWorkItemKey) {
      closeModal("decision-trace-modal");
      state.selectedWorkItemKey = null;
    }
  }

  // Reconcile run — absent closes Telemetry drawer
  if (runParam) {
    openTelemetryDrawer(runParam, true);
  } else {
    if (state.selectedRunId) {
      closeModal("telemetry-drawer-modal");
      state.selectedRunId = null;
    }
  }
}

// View Switching
function switchView(targetViewId, fromHistory = false) {
  state.currentView = targetViewId;
  if (typeof document === "undefined") return;

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.target === targetViewId);
  });

  ["overview-view", "pm-view", "parents-view", "observability-view", "agents-view", "config-view"].forEach(id => {
    const view = getElem(id);
    if (!view) return;
    const active = id === targetViewId;
    if (active) view.classList?.add?.("is-active");
    else view.classList?.remove?.("is-active");
    view.hidden = !active;
  });

  if (targetViewId === "parents-view") {
    populateParentSelector();
    refreshWorkSourceCatalog(false);
    if (state.selectedParentKey) fetchParentDetail(state.selectedParentKey);
    else clearParentDetail();
  } else if (targetViewId === "observability-view") {
    fetchObservabilitySummary();
  } else if (targetViewId === "pm-view") {
    renderPmWorkspace();
    refreshWorkSourceCatalog(false);
  }

  if (!fromHistory) syncUrlState(false);
}

// Focus & Accessibility for Modals/Drawers
function openModal(modalId, triggerElement = null) {
  const modal = getElem(modalId);
  if (!modal) return;
  state.lastFocusedElement = triggerElement || (typeof document !== "undefined" ? document.activeElement : null);
  modal.hidden = false;
  const focusable = modal.querySelector ? modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') : null;
  if (focusable && typeof focusable.focus === "function") {
    focusable.focus();
  }
}

function closeModal(modalId) {
  const modal = getElem(modalId);
  if (!modal) return;
  modal.hidden = true;
  if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
    try { state.lastFocusedElement.focus(); } catch {}
    state.lastFocusedElement = null;
  }
}

// Topbar & Operating Mode
function updateTopbar(data) {
  const connDot = getElem("connection-dot");
  const connLabel = getElem("connection-label");
  const syncTime = getElem("sync-time");
  const demoBadge = getElem("demo-badge");
  const projectKey = getElem("project-key");

  if (connDot) connDot.className = state.connected ? "connection-dot is-live" : "connection-dot is-offline";
  if (connLabel) connLabel.textContent = state.connected ? "Canlı" : "Bağlantı Yok";
  if (syncTime) syncTime.textContent = formatTime(data.generatedAt || new Date().toISOString());
  if (demoBadge) demoBadge.hidden = data.mode !== "demo";
  if (projectKey && data.project) projectKey.textContent = data.project;

  const operatingMode = (data.config?.operatingMode || data.pmWorkspace?.operatingMode || "AUTONOMOUS").toUpperCase();
  const modePill = getElem("operating-mode-pill");
  const modeLabel = getElem("operating-mode-label");
  const ovModeBadge = getElem("overview-mode-badge");
  const ovModeDesc = getElem("overview-mode-desc");

  if (modeLabel) modeLabel.textContent = operatingMode;
  if (modePill) modePill.className = `mode-pill mode-${operatingMode.toLowerCase()}`;
  if (ovModeBadge) {
    ovModeBadge.textContent = operatingMode;
    ovModeBadge.className = `mode-badge mode-${operatingMode.toLowerCase()}`;
  }
  if (ovModeDesc) {
    if (operatingMode === "AUTONOMOUS") {
      ovModeDesc.textContent = "Ready işler otonom ilerler; final merge ve Done insan kontrolündedir.";
    } else if (operatingMode === "SUPERVISED") {
      ovModeDesc.textContent = "Planlama ve kritik yürütme adımları insan onayı bekler.";
    } else {
      ovModeDesc.textContent = "Tüm görev ve entegrasyon adımları operatör tarafından yürütülür.";
    }
  }

  const supCard = getElem("supervisor-card");
  const sup = data.supervisor;
  if (supCard) {
    if (sup) {
      supCard.hidden = false;
      const supDot = getElem("supervisor-dot");
      const supStatus = getElem("supervisor-status-text");
      const supPid = getElem("supervisor-pid");
      const supMode = getElem("supervisor-mode");
      const supCycles = getElem("supervisor-cycles");
      const supHb = getElem("supervisor-heartbeat");

      if (supDot) supDot.className = `supervisor-dot is-${sup.status || "stopped"}`;
      if (supStatus) supStatus.textContent = (sup.status || "—").toUpperCase();
      if (supPid) supPid.textContent = sup.pid || "—";
      if (supMode) supMode.textContent = (sup.mode || "loop").toUpperCase();
      if (supCycles) supCycles.textContent = sup.consecutiveCycles ?? sup.cycles ?? "—";
      if (supHb) supHb.textContent = formatTime(sup.lastHeartbeatAt || sup.heartbeatAt);
    } else {
      supCard.hidden = true;
    }
  }
}

// Overview Rendering
function renderOverview(data) {
  const activeWorkers = data.capacity?.active ?? 0;
  const queuedWorkers = data.capacity?.queued ?? 0;
  const counts = data.pmWorkspace?.counts || {};

  const elActive = getElem("metric-active");
  const elQueued = getElem("metric-queued");
  const elReview = getElem("metric-review");
  const elRework = getElem("metric-rework");
  const elBlocked = getElem("metric-blocked");
  const elApproval = getElem("metric-awaiting-approval");
  const elHuman = getElem("metric-human-approval");
  const elActiveParents = getElem("metric-active-parents");
  const elParentConflicts = getElem("metric-parent-conflicts");
  const elTokens = getElem("metric-tokens");
  const elCapacity = getElem("metric-capacity");

  if (elActive) elActive.textContent = activeWorkers;
  if (elQueued) elQueued.textContent = queuedWorkers;
  if (elReview) elReview.textContent = counts.inReview ?? 0;
  if (elRework) elRework.textContent = counts.needsRework ?? 0;
  if (elBlocked) elBlocked.textContent = counts.blocked ?? 0;
  if (elApproval) elApproval.textContent = counts.awaitingApproval ?? 0;
  if (elHuman) elHuman.textContent = counts.humanApproval ?? 0;

  const parents = data.parentExecutions || [];
  const pMetrics = data.parentMetrics || {};
  const activeParentsCount = pMetrics.activeParents ?? parents.filter(p => ["active", "integrating", "waiting_approval", "in_review"].includes(p.state)).length;
  const conflictedParentsCount = pMetrics.conflictedParents ?? parents.filter(p => p.driftDetected || p.state === "blocked-conflict").length;

  if (elActiveParents) elActiveParents.textContent = activeParentsCount;
  if (elParentConflicts) elParentConflicts.textContent = `${conflictedParentsCount} çatışma`;

  if (elTokens) {
    const totalsTokens = data.totals?.tokens;
    if (totalsTokens !== null && totalsTokens !== undefined && totalsTokens > 0) {
      elTokens.textContent = formatNumber(totalsTokens);
    } else {
      elTokens.textContent = "—";
    }
  }

  if (elCapacity) {
    const maxSlots = data.capacity?.maxSlots ?? 4;
    elCapacity.textContent = `${activeWorkers} / ${maxSlots} aktif slot`;
  }

  renderCapacity();
  renderRuns();
  renderAttentionList(data.pmWorkspace?.groups || {});
  renderActivityFeed(data.activity || []);
}

function renderAttentionList(groups) {
  const container = getElem("attention-list");
  if (!container) return;
  container.innerHTML = "";
  const items = [
    ...(groups.awaitingApproval || []),
    ...(groups.blocked || []),
    ...(groups.needsRework || []),
    ...(groups.humanApproval || [])
  ].slice(0, 6);

  if (items.length === 0) {
    container.appendChild(element("p", "empty-text", "Dikkat gerektiren öğe yok."));
    return;
  }

  items.forEach(item => {
    const entry = element("button", "attention-item");
    entry.type = "button";
    const copy = element("span");
    copy.appendChild(element("strong", "att-key", item.issueKey || "—"));
    copy.appendChild(element("span", "att-reason", item.blockedReason || STATUS_LABELS[item.canonicalState] || item.canonicalState || "İşlem bekliyor"));
    const action = element("span", "attention-action", "Aç");
    entry.append(copy, action);
    entry.addEventListener?.("click", () => openDecisionTrace(item.issueKey, false, entry));
    container.appendChild(entry);
  });
}

function renderActivityFeed(activity) {
  const tbody = getElem("activity-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (activity.length === 0) {
    const row = element("tr");
    const td = element("td", null, "Henüz hareket kaydedilmedi.");
    td.colSpan = 4;
    row.appendChild(td);
    tbody.appendChild(row);
    return;
  }

  activity.slice(0, 30).forEach(ev => {
    const row = element("tr");
    const timeTd = element("td", null, formatTime(ev.createdAt));
    const taskTd = element("td", "code-cell", ev.issue || (ev.category === "supervisor" ? "Supervisor" : "—"));
    const eventTd = element("td", null, ev.type || ev.state || "—");
    const statusTd = element("td", null, ev.status || ev.stateKind || "—");

    row.appendChild(timeTd);
    row.appendChild(taskTd);
    row.appendChild(eventTd);
    row.appendChild(statusTd);
    tbody.appendChild(row);
  });
}

// Connected Work-Source Catalog
function catalogOperationalGroup(canonicalState) {
  const value = String(canonicalState || "").toLowerCase();
  if (value === "ready") return "ready";
  if (value === "in_progress" || value === "executing") return "executing";
  if (value === "review") return "inReview";
  if (value === "rework") return "needsRework";
  if (value === "blocked") return "blocked";
  if (value === "human_approval") return "humanApproval";
  if (value === "done") return "done";
  if (value === "cancelled") return "cancelled";
  return "needsPlanning";
}

function mergedWorkSourceGroups(localGroups = {}) {
  const names = ["needsPlanning", "awaitingApproval", "ready", "executing", "inReview", "needsRework", "blocked", "humanApproval", "done", "cancelled"];
  const groups = Object.fromEntries(names.map(name => [name, [...(localGroups[name] || [])]]));
  const seen = new Set(Object.values(groups).flat().map(item => item.issueKey));
  for (const item of state.workSourceCatalog?.items || []) {
    if (!item?.key || seen.has(item.key)) continue;
    const operationalGroup = catalogOperationalGroup(item.canonicalState);
    groups[operationalGroup].push({
      issueKey: item.key,
      summary: item.summary,
      canonicalState: item.canonicalState,
      currentRunState: item.status || "not_started",
      operationalGroup,
      persona: null,
      taskAgent: null,
      risk: null,
      sourceProvider: item.sourceProvider,
      sourceUrl: item.sourceUrl,
      createdAt: null,
      updatedAt: state.workSourceCatalog.syncedAt,
      providerOnly: true
    });
    seen.add(item.key);
  }
  return groups;
}

function setWorkSourceSyncStatus(message, kind = "") {
  const target = getElem("work-source-sync-status");
  if (!target) return;
  target.textContent = message;
  target.className = "read-only-badge" + (kind ? " is-" + kind : "");
}

async function refreshWorkSourceCatalog(force = false) {
  if (state.workSourceCatalogLoading) return state.workSourceCatalog;
  if (state.workSourceCatalog && !force) {
    renderPmWorkspace();
    populateParentSelector();
    return state.workSourceCatalog;
  }
  state.workSourceCatalogLoading = true;
  state.workSourceCatalogError = null;
  setWorkSourceSyncStatus("İş kaynağı yükleniyor…", "loading");
  const refreshButton = getElem("work-source-refresh-btn");
  if (refreshButton) refreshButton.disabled = true;
  try {
    const response = await fetch("/api/work-source/catalog" + (force ? "?refresh=1" : ""));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
    state.workSourceCatalog = data;
    state.workItemPage = 1;
    if (data.demo) {
      setWorkSourceSyncStatus("Demo modu · Jira okunmuyor", "warning");
    } else {
      setWorkSourceSyncStatus((data.provider || "İş kaynağı") + " · " + data.items.length + " iş · " + data.parents.length + " parent", "success");
    }
    renderPmWorkspace();
    populateParentSelector();
    return data;
  } catch (error) {
    state.workSourceCatalogError = error.message;
    setWorkSourceSyncStatus("İş kaynağı yüklenemedi: " + error.message, "error");
    renderPmWorkspace();
    populateParentSelector();
    return null;
  } finally {
    state.workSourceCatalogLoading = false;
    if (refreshButton) refreshButton.disabled = false;
  }
}

// PM Workspace Rendering
function renderPmWorkspace() {
  const pm = state.snapshot?.pmWorkspace;
  if (!pm) return;

  const groups = mergedWorkSourceGroups(pm.groups || {});
  const counts = Object.fromEntries(Object.entries(groups).map(([name, items]) => [name, items.length]));
  const attentionCount = (counts.blocked || 0) + (counts.needsRework || 0);
  const updates = {
    "pm-badge-attention": attentionCount,
    "pm-badge-approvals": counts.awaitingApproval || 0,
    "pm-badge-questions": (state.snapshot?.operatorInbox || []).filter(item => item.status === "open" || item.status === "resume_failed").length,
    "pm-stat-approvals": counts.awaitingApproval || 0,
    "pm-stat-blocked": counts.blocked || 0,
    "pm-stat-executing": counts.executing || 0,
    "pm-stat-review": counts.inReview || 0,
    "pm-stat-rework": counts.needsRework || 0,
    "pm-stat-ready": counts.ready || 0,
    "pm-stat-human-approval": counts.humanApproval || 0
  };
  Object.entries(updates).forEach(([id, value]) => {
    const target = getElem(id);
    if (target) target.textContent = value;
  });

  if (typeof document !== "undefined") {
    document.querySelectorAll(".pm-sub-nav .pm-filter-btn").forEach(btn => {
      const active = btn.dataset.pmFilter === state.currentPmFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  const inbox = getElem("pm-inbox-section");
  const operator = getElem("pm-operator-section");
  const approvals = getElem("pm-approvals-section");
  const attention = getElem("pm-attention-section");
  const journal = getElem("pm-journal-section");
  const isJournal = state.currentPmFilter === "journal";
  const isQuestions = state.currentPmFilter === "questions";
  if (inbox) inbox.hidden = isJournal || isQuestions;
  if (operator) operator.hidden = !isQuestions;
  if (approvals) approvals.hidden = true;
  if (attention) attention.hidden = true;
  if (journal) journal.hidden = !isJournal;
  if (isJournal) renderPmJournal();
  else if (isQuestions) renderOperatorInbox();
  else renderPmInbox(groups, state.currentPmFilter);
}

function pmItemsForFilter(groups, filter) {
  const all = Object.values(groups).flatMap(items => Array.isArray(items) ? items : []);
  const byFilter = {
    inbox: all,
    attention: [...(groups.blocked || []), ...(groups.needsRework || [])],
    approvals: groups.awaitingApproval || [],
    review: groups.inReview || [],
    rework: groups.needsRework || [],
    ready: groups.ready || [],
    human: groups.humanApproval || []
  };
  return byFilter[filter] || all;
}

function normalizedWorkSearch(value) {
  return String(value || "").trim().toLocaleLowerCase("tr-TR");
}

function filteredPmItems(groups, filter) {
  const query = normalizedWorkSearch(state.workItemQuery);
  const selectedState = String(state.workItemState || "all");
  return pmItemsForFilter(groups, filter).filter(item => {
    const matchesQuery = !query || [item.issueKey, item.summary]
      .some(value => normalizedWorkSearch(value).includes(query));
    const canonicalState = String(item.canonicalState || "unknown").toLowerCase();
    const matchesState = selectedState === "all" || canonicalState === selectedState;
    return matchesQuery && matchesState;
  });
}

function updateWorkPagination(totalItems, totalPages, page, startIndex, endIndex) {
  const summary = getElem("work-pagination-summary");
  const indicator = getElem("work-page-indicator");
  const previous = getElem("work-page-prev");
  const next = getElem("work-page-next");
  if (summary) {
    summary.textContent = state.language === "en"
      ? `${startIndex}-${endIndex} of ${totalItems} work items`
      : `${totalItems} işten ${startIndex}-${endIndex} gösteriliyor`;
  }
  if (indicator) indicator.textContent = `${page} / ${totalPages}`;
  if (previous) previous.disabled = page <= 1;
  if (next) next.disabled = page >= totalPages;
}

function renderPmInbox(groups = {}, filter = "inbox") {
  const container = getElem("pm-queue-container");
  if (!container) return;
  container.innerHTML = "";
  const matchingItems = filteredPmItems(groups, filter);
  const pageSize = [25, 50, 100].includes(Number(state.workItemPageSize))
    ? Number(state.workItemPageSize)
    : 25;
  const totalPages = Math.max(1, Math.ceil(matchingItems.length / pageSize));
  state.workItemPage = Math.max(1, Math.min(Number(state.workItemPage) || 1, totalPages));
  const offset = (state.workItemPage - 1) * pageSize;
  const items = matchingItems.slice(offset, offset + pageSize);
  const startIndex = matchingItems.length === 0 ? 0 : offset + 1;
  const endIndex = matchingItems.length === 0 ? 0 : offset + items.length;
  updateWorkPagination(matchingItems.length, totalPages, state.workItemPage, startIndex, endIndex);

  if (items.length === 0) {
    const row = element("tr");
    const cell = element("td", null, "Bu filtrede iş bulunmuyor.");
    cell.colSpan = 8;
    row.appendChild(cell);
    container.appendChild(row);
    return;
  }

  items.forEach(item => {
    const row = element("tr", "work-table-row");
    row.tabIndex = 0;
    const openDetail = () => openDecisionTrace(item.issueKey, false, row);
    row.addEventListener?.("click", openDetail);
    row.addEventListener?.("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail();
      }
    });

    appendTableTextCell(row, item.issueKey, "code-cell");
    appendTableTextCell(row, item.summary || "—", "work-summary-cell");
    appendTableTextCell(row, STATUS_LABELS[item.canonicalState] || item.canonicalState || "—");
    appendTableTextCell(row, STATUS_LABELS[item.currentRunState] || item.currentRunState || "—");
    appendTableTextCell(row, item.taskAgent || item.persona || "—");
    appendTableTextCell(row, item.risk || "normal");
    appendTableTextCell(row, formatTime(item.updatedAt || item.createdAt));

    const actions = element("td");
    const detail = element("button", "pm-btn pm-btn-view", "Detay");
    detail.type = "button";
    detail.addEventListener?.("click", event => {
      event.stopPropagation();
      openDetail();
    });
    actions.appendChild(detail);
    if (item.operationalGroup === "awaitingApproval") {
      const approve = element("button", "pm-btn pm-btn-approve", "Onayla");
      approve.type = "button";
      approve.addEventListener?.("click", event => {
        event.stopPropagation();
        openApprovalModal(item, approve);
      });
      actions.appendChild(approve);
      const reject = element("button", "pm-btn pm-btn-reject", "Reddet");
      reject.type = "button";
      reject.addEventListener?.("click", event => {
        event.stopPropagation();
        openRejectionModal(item, reject);
      });
      actions.appendChild(reject);
    }
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function renderPmApprovals(items = []) {
  const list = getElem("pm-approvals-list");
  if (!list) return;
  list.innerHTML = "";

  if (items.length === 0) {
    const empty = element("div", "empty-state");
    empty.appendChild(element("p", null, "Şu anda onay bekleyen yürütme planı yok."));
    list.appendChild(empty);
    return;
  }

  items.forEach(item => {
    list.appendChild(createPmItemCard(item, "approval", true));
  });
}

function renderPmAttention(items = []) {
  const list = getElem("pm-attention-list");
  if (!list) return;
  list.innerHTML = "";

  if (items.length === 0) {
    const empty = element("div", "empty-state");
    empty.appendChild(element("p", null, "Müdahale veya dikkat gerektiren bir durum yok."));
    list.appendChild(empty);
    return;
  }

  items.forEach(item => {
    list.appendChild(createPmItemCard(item, "blocked", true));
  });
}

function createPmItemCard(item, styleClass, showActions = false) {
  const card = element("div", `pm-item-card ${styleClass}`);
  card.dataset = card.dataset || {};
  card.dataset.issueKey = item.issueKey;

  const top = element("div", "pm-item-top");
  const keyBadge = element("span", "badge badge-key", item.issueKey);
  const stateBadge = element("span", `state-badge ${styleClass}`, STATUS_LABELS[item.canonicalState] || item.canonicalState || item.currentRunState || "—");
  top.appendChild(keyBadge);
  top.appendChild(stateBadge);

  const summary = element("h4", "pm-item-summary", item.summary || "Açıklama yok");

  const meta = element("div", "pm-item-meta");
  if (item.persona) meta.appendChild(element("span", null, `Persona: ${item.persona}`));
  if (item.taskAgent) meta.appendChild(element("span", null, `Agent: ${item.taskAgent}`));
  if (item.executorProvider) meta.appendChild(element("span", null, `${item.executorProvider} · ${item.executorModel || "default"}`));
  if (item.risk) meta.appendChild(element("span", "badge-risk", `Risk: ${item.risk}`));

  card.appendChild(top);
  card.appendChild(summary);
  card.appendChild(meta);

  if (item.blockedReason) {
    const blk = element("div", "pm-item-blocker", `🛑 ${item.blockedReason}`);
    card.appendChild(blk);
  }

  if (item.planFingerprint) {
    const fp = element("div", "pm-item-fp", `FP: ${item.planFingerprint.slice(0, 12)}...`);
    card.appendChild(fp);
  }

  const actions = element("div", "pm-item-actions");
  const viewBtn = element("button", "pm-btn pm-btn-view", "İncele");
  viewBtn.type = "button";
  if (typeof viewBtn.addEventListener === "function") {
    viewBtn.addEventListener("click", () => {
      openDecisionTrace(item.issueKey);
    });
  }
  actions.appendChild(viewBtn);

  if (item.operationalGroup === "awaitingApproval") {
    const approveBtn = element("button", "pm-btn pm-btn-approve", "✓ Onayla");
    approveBtn.type = "button";
    if (typeof approveBtn.addEventListener === "function") {
      approveBtn.addEventListener("click", () => {
        openApprovalModal(item, approveBtn);
      });
    }
    actions.appendChild(approveBtn);

    const rejectBtn = element("button", "pm-btn pm-btn-reject", "✕ Reddet");
    rejectBtn.type = "button";
    if (typeof rejectBtn.addEventListener === "function") {
      rejectBtn.addEventListener("click", () => {
        openRejectionModal(item, rejectBtn);
      });
    }
    actions.appendChild(rejectBtn);
  }

  card.appendChild(actions);
  return card;
}

function renderOperatorInbox() {
  const host = getElem("pm-operator-list");
  if (!host) return;
  host.innerHTML = "";
  const requests = [...(state.snapshot?.operatorInbox || [])].sort((a, b) => {
    const rank = value => value.status === "open" ? 0 : value.status === "resume_failed" ? 1 : 2;
    return rank(a) - rank(b) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  if (requests.length === 0) {
    host.appendChild(element("div", "empty-state", "Agentlardan bekleyen bir soru yok."));
    return;
  }

  const canRespond = state.snapshot?.capabilities?.execution?.operatorResponseEnabled === true;
  requests.forEach(request => {
    const card = element("article", "operator-question-card status-" + request.status);
    const header = element("div", "operator-question-header");
    header.appendChild(element("span", "badge badge-key", request.issueKey || "—"));
    const statusLabels = {
      open: "Yanıt bekliyor",
      answered: "Yanıtlandı",
      resuming: "Agent devam ediyor",
      resume_failed: "Devam başlatılamadı"
    };
    header.appendChild(element("span", "state-badge " + (request.status === "open" ? "approval" : "ready"), statusLabels[request.status] || request.status));
    card.appendChild(header);
    card.appendChild(element("h4", "operator-question-title", request.question || "Agent operatör girdisi bekliyor."));
    const meta = element("p", "operator-question-meta", [
      request.taskAgent || "agent",
      formatTime(request.createdAt, true)
    ].join(" · "));
    card.appendChild(meta);

    if (request.answer) {
      const answered = element("div", "operator-answer-summary");
      answered.appendChild(element("span", null, "Yanıtınız"));
      answered.appendChild(element("strong", null, request.answer));
      card.appendChild(answered);
    }

    if (request.status === "open") {
      const form = element("form", "operator-answer-form");
      const label = element("label", null, "Yanıtınız");
      const input = element("textarea", "operator-answer-input");
      input.rows = 3;
      input.maxLength = 4000;
      input.required = true;
      input.placeholder = "Agentın devam etmesi için net ve kısa bir yanıt yazın.";
      label.appendChild(input);
      const footer = element("div", "operator-answer-actions");
      const status = element("p", "operator-answer-status", canRespond ? "Yanıt kaydedildikten sonra agent aynı planla otomatik devam eder." : "Yanıt servisi şu anda etkin değil.");
      const submit = element("button", "pm-btn pm-btn-approve", "Yanıtla ve devam ettir");
      submit.type = "submit";
      submit.disabled = !canRespond;
      footer.appendChild(status);
      footer.appendChild(submit);
      form.appendChild(label);
      form.appendChild(footer);
      form.addEventListener?.("submit", event => {
        event.preventDefault();
        submitOperatorAnswer(request, input, submit, status);
      });
      card.appendChild(form);
    } else if (request.status === "resume_failed") {
      card.appendChild(element("p", "operator-answer-status is-error", request.resume?.error || "Agent otomatik devam ettirilemedi; run detayını kontrol edin."));
    }
    host.appendChild(card);
  });
  applyDocumentTranslations();
}

async function submitOperatorAnswer(request, input, button, status) {
  const answer = String(input?.value || "").trim();
  if (!answer || !request?.requestId) return;
  button.disabled = true;
  input.disabled = true;
  status.className = "operator-answer-status is-loading";
  status.textContent = "Yanıt kaydediliyor ve agent devam ettiriliyor…";
  try {
    const response = await fetch("/api/control-plane/operator-requests/" + encodeURIComponent(request.requestId) + "/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
    status.className = "operator-answer-status is-success";
    status.textContent = "Yanıt kaydedildi. Agent arka planda devam ediyor.";
    await fetchSnapshot();
  } catch (error) {
    status.className = "operator-answer-status is-error";
    status.textContent = "Yanıt gönderilemedi: " + error.message;
    button.disabled = false;
    input.disabled = false;
  }
}
function renderPmJournal() {
  const messagesEl = getElem("pm-messages");
  const decisionsEl = getElem("pm-decisions");
  const msgs = state.snapshot?.pmMessages || [];
  const decs = state.snapshot?.pmDecisions || [];

  if (messagesEl) {
    messagesEl.innerHTML = "";
    if (msgs.length === 0) {
      messagesEl.appendChild(element("p", "empty-text", "Henüz PM mesajı yok."));
    } else {
      msgs.slice(0, 30).forEach(m => {
        const block = element("div", `pm-msg ${m.sender === "user" ? "user-msg" : "system-msg"}`);
        const hdr = element("small", null, `${m.sender} · ${formatTime(m.createdAt)}`);
        const body = element("p", null, m.content || m.text || "");
        block.appendChild(hdr);
        block.appendChild(body);
        messagesEl.appendChild(block);
      });
    }
  }

  if (decisionsEl) {
    decisionsEl.innerHTML = "";
    if (decs.length === 0) {
      decisionsEl.appendChild(element("p", "empty-text", "Henüz kayıtlı karar yok."));
    } else {
      decs.slice(0, 30).forEach(d => {
        const item = element("div", "decision-item");
        const hdr = element("strong", null, `${d.issueKey || "GENEL"}: ${d.type}`);
        const time = element("small", null, formatTime(d.createdAt));
        item.appendChild(hdr);
        item.appendChild(time);
        if (d.payload) {
          const desc = element("p", null, typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload));
          item.appendChild(desc);
        }
        decisionsEl.appendChild(item);
      });
    }
  }
}

// Work Item Decision Trace Drawer
async function fetchJsonWithTimeout(url, timeoutMs = 15000) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller && typeof setTimeout === "function" ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) throw new Error("HTTP " + response.status + (response.statusText ? ": " + response.statusText : ""));
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(uiMessage("requestTimedOut"));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function renderDetailError(summaryEl, body, heading, error) {
  if (summaryEl) summaryEl.textContent = heading;
  if (!body) return;
  const banner = element("div", "error-banner");
  banner.setAttribute?.("role", "alert");
  banner.appendChild(element("strong", null, heading));
  banner.appendChild(element("span", null, error?.message ? " " + error.message : ""));
  body.replaceChildren?.(banner);
}

async function openDecisionTrace(issueKey, fromHistory = false, triggerElement = null) {
  if (!issueKey) return;
  const requestId = ++state.workItemDetailRequestId;
  if (state.selectedWorkItemKey !== issueKey) state.pendingExecutionPlan = null;
  state.selectedWorkItemKey = issueKey;
  state.currentWorkItemDetail = null;
  const modal = getElem("decision-trace-modal");
  const title = getElem("trace-drawer-title");
  const pill = getElem("trace-issue-pill");
  const summaryEl = getElem("trace-issue-summary");
  const body = getElem("trace-drawer-body");
  if (!modal || !body) return;

  if (pill) pill.textContent = issueKey;
  if (title) title.textContent = uiMessage("workDetailTitle", { key: issueKey });
  if (summaryEl) summaryEl.textContent = uiMessage("detailsLoading");
  body.replaceChildren(element("div", "loading-spinner", uiMessage("loading")));

  try {
    openModal("decision-trace-modal", triggerElement);
    if (!fromHistory) syncUrlState(false);
    const data = await fetchJsonWithTimeout("/api/pm/work-items/" + encodeURIComponent(issueKey));
    if (requestId !== state.workItemDetailRequestId) return;
    if (!data || !data.workItem) throw new Error("The server returned an incomplete work item response.");
    renderDecisionTraceDetail(data);
  } catch (error) {
    if (requestId !== state.workItemDetailRequestId) return;
    renderDetailError(summaryEl, body, uiMessage("workDetailFailed"), error);
  }
}

function renderExecutionLauncher(data) {
  const workItem = data.workItem || {};
  const execution = data.execution || {};
  const capability = state.snapshot?.capabilities?.execution || {};
  const section = element("section", "trace-section execution-launcher");
  section.appendChild(element("h3", "trace-section-title", "Agentı Çalıştır"));
  section.appendChild(element("p", "execution-launcher-copy", "Önce güvenli planı hazırlayın; agent, gösterilen rol ve dosya kapsamıyla ancak ikinci adımda başlar."));

  const controls = element("div", "execution-launcher-actions");
  const status = element("p", "execution-launcher-status", "");
  const preview = element("div", "execution-plan-preview");

  const planButton = element("button", "pm-btn pm-btn-view", "Planı hazırla");
  planButton.type = "button";
  planButton.disabled = capability.planEnabled !== true;
  planButton.addEventListener?.("click", () => prepareWorkItemPlan(workItem.key, preview, planButton, status));
  controls.appendChild(planButton);

  const activeStates = new Set(["claimed", "prepared", "queued", "started", "model_selected", "progress", "executing"]);
  if (data.providerOnly !== true && workItem.id && activeStates.has(execution.currentRunState) && capability.stopEnabled === true) {
    const stopButton = element("button", "pm-btn pm-btn-reject", "Agentı durdur");
    stopButton.type = "button";
    stopButton.addEventListener?.("click", () => stopRunExecution(workItem.id, stopButton, status));
    controls.appendChild(stopButton);
  }

  if (capability.planEnabled !== true) {
    status.className = "execution-launcher-status is-warning";
    status.textContent = "Dashboard’dan çalıştırma kapalı veya canlı süreç yeniden başlatılmalı.";
  }
  section.appendChild(controls);
  section.appendChild(status);
  section.appendChild(preview);

  if (state.pendingExecutionPlan?.issue === workItem.key) {
    renderPlanPreview(state.pendingExecutionPlan, preview, status);
  }
  return section;
}

function renderPlanPreview(plan, host, status, options = {}) {
  host.innerHTML = "";
  const grid = element("div", "plan-preview-grid");
  const projectLabel = plan.projectProfile
    ? `${plan.projectProfile.name} · ${plan.projectProfile.repository}`
    : "—";
  grid.appendChild(createTraceCell("Proje / Repo", projectLabel));
  grid.appendChild(createTraceCell("Agent", plan.taskAgent || plan.persona || "—"));
  grid.appendChild(createTraceCell("Provider / Model", (plan.execution?.provider || "—") + " / " + (plan.execution?.model || "varsayılan")));
  const fallbackCandidates = (plan.executionCandidates || []).slice(1);
  if (fallbackCandidates.length > 0) {
    grid.appendChild(createTraceCell("Yedek rota", fallbackCandidates
      .map(candidate => `${candidate.provider} / ${candidate.model || candidate.modelProfile || "varsayılan"}`)
      .join(" → ")));
  }
  grid.appendChild(createTraceCell("Risk", plan.risk || "normal"));
  grid.appendChild(createTraceCell("Base", (plan.baseRef || "—") + (plan.baseSha ? " @ " + plan.baseSha.slice(0, 10) : "")));
  grid.appendChild(createTraceCell("İzinli yollar", (plan.allowedPaths || []).join(", ") || "—"));
  grid.appendChild(createTraceCell("Plan parmak izi", plan.planFingerprint ? plan.planFingerprint.slice(0, 16) + "…" : "—"));
  host.appendChild(grid);

  if (!plan.eligible) {
    const reasons = element("div", "plan-ineligible");
    reasons.appendChild(element("strong", null, "Uyumluluk gerekiyor"));
    const count = plan.compatibility?.items?.length || plan.eligibilityReasons?.length || 0;
    reasons.appendChild(element("p", null, uiMessage("compatibilityCount", { count })));
    const compatibilityButton = element("button", "pm-btn pm-btn-view compatibility-button", "İşi uyumlu hale getir");
    compatibilityButton.type = "button";
    compatibilityButton.addEventListener?.("click", () => recheckWorkItemCompatibility(
      plan.issue,
      host,
      compatibilityButton,
      status,
      plan.projectProfileId,
      plan.baseRefOverride
    ));
    reasons.appendChild(compatibilityButton);
    host.appendChild(reasons);
    if (options.showCompatibility === true) renderCompatibilityPreview(plan.compatibility, host);
    if (
      plan.compatibility?.items?.some(entry => compatibilityCode(entry) === "base-ref") &&
      Array.isArray(plan.availableBaseRefs) &&
      plan.availableBaseRefs.length > 0
    ) {
      renderBaseRefSelection(plan, host, status);
    }
    return;
  }

  const startButton = element("button", "pm-btn pm-btn-approve execution-start-button", "Agentı başlat");
  startButton.type = "button";
  startButton.disabled = state.snapshot?.capabilities?.execution?.startEnabled !== true;
  startButton.addEventListener?.("click", () => startWorkItemExecution(plan, startButton, status));
  host.appendChild(startButton);
  status.className = "execution-launcher-status is-success";
  status.textContent = "Plan hazır. Kapsamı kontrol edip Agentı başlat düğmesine basın.";
}

const COMPATIBILITY_COPY = {
  labels: {
    tr: ["Gerekli iş kaynağı etiketleri eksik", "Listelenen etiketleri bağlı iş kaynağına ekleyin ve planı yeniden hazırlayın."],
    en: ["Required work-source labels are missing", "Add the listed labels in the connected work source, then prepare the plan again."]
  },
  agent: {
    tr: ["Seçilen agent kayıtlı değil", "Yerleşik agent kayıtlarını yenileyin veya kayıtlı bir route seçin."],
    en: ["The selected agent is not registered", "Refresh the built-in agent registry or select a registered route."]
  },
  "agent-state": {
    tr: ["Seçilen agent iş alamıyor", "Agent tanımını inceleyin; iş alması gerekiyorsa açıkça etkinleştirin."],
    en: ["The selected agent cannot receive work", "Review the agent definition and enable it explicitly if it should receive work."]
  },
  scope: {
    tr: ["İstenen dosya kapsamı yetkili değil", "Ticket kapsamını, kalıcı agent tanımını ve hard policy kesişimini inceleyin. Kapsam otomatik genişletilmez."],
    en: ["The requested file scope is not authorized", "Review the ticket scope, durable agent definition, and hard policy intersection. Scope is never widened automatically."]
  },
  "base-ref": {
    tr: ["İstenen Git tabanı bulunmuyor", "Amaçlanan parent/integration branch'ini açıkça oluşturun veya seçin. Sistem otomatik fallback seçmez."],
    en: ["The requested Git base does not exist", "Create or select the intended parent/integration branch explicitly. No fallback branch is chosen automatically."]
  },
  "acceptance-criteria": {
    tr: ["Kabul kriterleri eksik", "İşe test edilebilir kabul kriterleri ekleyin ve planı yeniden hazırlayın."],
    en: ["Acceptance criteria are missing", "Add testable acceptance criteria to the work item, then prepare the plan again."]
  },
  "workflow-mapping": {
    tr: ["Provider durumu eşlenmemiş", "Provider durumunu yerel iş kaynağı yapılandırmasında kanonik bir duruma eşleyin."],
    en: ["The provider status is not mapped", "Map the provider status to a canonical state in the local work-source configuration."]
  },
  policy: {
    tr: ["Bir politika kapısı ilgi gerektiriyor", "Bu kapıyı açıkça inceleyin; dashboard politikayı atlamaz."],
    en: ["A policy gate requires attention", "Review this gate explicitly; the dashboard will not bypass it."]
  }
};

function compatibilityCode(entry = {}) {
  return String(entry.id || "policy").split(":")[0];
}

function compatibilityCategory(category) {
  const labels = {
    work_source: ["İş kaynağı", "Work source"],
    agent: ["Agent", "Agent"],
    scope: ["Dosya kapsamı", "File scope"],
    source_control: ["Kaynak kontrolü", "Source control"],
    policy: ["Politika", "Policy"]
  };
  return (labels[category] || labels.policy)[state.language === "en" ? 1 : 0];
}

function compatibilityText(entry = {}) {
  const copy = COMPATIBILITY_COPY[compatibilityCode(entry)] || COMPATIBILITY_COPY.policy;
  const localized = copy[state.language] || copy.tr;
  return { title: localized[0], resolution: localized[1] };
}

function compatibilityValue(value) {
  const translations = {
    "No effective path": ["Etkin dosya yolu yok", "No effective path"],
    "A reviewed, narrow path scope": ["İncelenmiş, dar bir dosya kapsamı", "A reviewed, narrow path scope"],
    "An existing, reviewed integration base": ["Var olan, incelenmiş bir integration tabanı", "An existing, reviewed integration base"],
    "Testable acceptance criteria": ["Test edilebilir kabul kriterleri", "Testable acceptance criteria"],
    "A canonical workflow state": ["Kanonik bir workflow durumu", "A canonical workflow state"],
    "Satisfied policy gate": ["Karşılanmış politika kapısı", "Satisfied policy gate"]
  };
  const mapped = translations[String(value || "")];
  return mapped ? mapped[state.language === "en" ? 1 : 0] : String(value || "—");
}

function renderCompatibilityPreview(compatibility, host) {
  const panel = element("section", "compatibility-preview");
  panel.appendChild(element("h4", "compatibility-preview-title", "Uyumluluk önizlemesi"));
  const list = element("div", "compatibility-list");
  for (const entry of compatibility?.items || []) {
    const copy = compatibilityText(entry);
    const card = element("article", "compatibility-card");
    const header = element("div", "compatibility-card-header");
    header.appendChild(element("span", "status-pill", compatibilityCategory(entry.category)));
    header.appendChild(element("strong", null, copy.title));
    card.appendChild(header);
    const values = element("dl", "compatibility-values");
    for (const [label, value] of [
      ["Mevcut", entry.current],
      ["Önerilen", entry.proposed],
      ["Yapılması gereken", copy.resolution]
    ]) {
      values.appendChild(element("dt", null, label));
      values.appendChild(element("dd", null, compatibilityValue(value)));
    }
    card.appendChild(values);
    list.appendChild(card);
  }
  panel.appendChild(list);
  host.appendChild(panel);
}

function projectSelectionReason(reason) {
  if (reason === "ambiguous_match") return "Birden fazla repo eşleşti; devam etmek için birini seçin.";
  if (reason === "selection_conflicts_with_work_item") return "Ticket üzerindeki repo eşleştirmesi bu seçimle çelişiyor.";
  return "Repo eşleştirmesi bulunamadı.";
}

function renderProjectSelection(issueKey, resolution, host, status) {
  host.innerHTML = "";
  const panel = element("section", "project-selection-panel");
  panel.appendChild(element("h4", "project-selection-title", "Proje seçimi gerekli"));
  panel.appendChild(element("p", "project-selection-reason", projectSelectionReason(resolution?.reason)));
  panel.appendChild(element(
    "p",
    "project-selection-copy",
    "Bu Jira işinin hangi repoda planlanacağını seçin. Seçim yalnızca yerel olarak saklanır; Jira değiştirilmez."
  ));

  const label = element("label", "project-selection-label", "Proje");
  const select = element("select", "form-input project-profile-select");
  select.setAttribute?.("aria-label", translateUiText("Proje"));
  const placeholder = element("option", null, "Bir proje seçin");
  placeholder.value = "";
  select.appendChild(placeholder);
  for (const profile of resolution?.profiles || []) {
    const option = element(
      "option",
      null,
      `${profile.name} · ${profile.repository} · ${profile.baseBranch}`
    );
    option.value = profile.id;
    select.appendChild(option);
  }
  label.appendChild(select);
  panel.appendChild(label);

  const submit = element("button", "pm-btn pm-btn-approve project-selection-submit", "Bu projeyle planla");
  submit.type = "button";
  submit.disabled = true;
  select.addEventListener?.("change", () => { submit.disabled = !select.value; });
  submit.addEventListener?.("click", () => {
    if (select.value) prepareWorkItemPlan(issueKey, host, submit, status, select.value);
  });
  panel.appendChild(submit);
  host.appendChild(panel);
  status.className = "execution-launcher-status is-warning";
  status.textContent = translateUiText(projectSelectionReason(resolution?.reason));
}

function renderBaseRefSelection(plan, host, status) {
  const panel = element("section", "project-selection-panel base-ref-selection-panel");
  panel.appendChild(element("h4", "project-selection-title", "Git tabanı seç"));
  panel.appendChild(element(
    "p",
    "project-selection-copy",
    "İstenen parent dalı bulunamadı. Seçilen repodaki mevcut ve incelenmiş bir dalı açıkça seçin."
  ));
  const label = element("label", "project-selection-label", "Mevcut bir dal seçin");
  const select = element("select", "form-input base-ref-select");
  const placeholder = element("option", null, "Mevcut bir dal seçin");
  placeholder.value = "";
  select.appendChild(placeholder);
  for (const candidate of plan.availableBaseRefs || []) {
    const option = element("option", null, `${candidate.ref} · ${candidate.sha.slice(0, 10)}`);
    option.value = candidate.ref;
    select.appendChild(option);
  }
  label.appendChild(select);
  panel.appendChild(label);
  const submit = element("button", "pm-btn pm-btn-approve base-ref-selection-submit", "Bu Git tabanıyla planla");
  submit.type = "button";
  submit.disabled = true;
  select.addEventListener?.("change", () => { submit.disabled = !select.value; });
  submit.addEventListener?.("click", () => {
    if (select.value) {
      prepareWorkItemPlan(plan.issue, host, submit, status, plan.projectProfileId, select.value);
    }
  });
  panel.appendChild(submit);
  host.appendChild(panel);
}

async function recheckWorkItemCompatibility(
  issueKey,
  host,
  button,
  status,
  projectProfileId = null,
  baseRef = null
) {
  button.disabled = true;
  status.className = "execution-launcher-status is-loading";
  status.textContent = uiMessage("compatibilityChecking");
  try {
    const response = await fetch("/api/control-plane/work-items/" + encodeURIComponent(issueKey) + "/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(projectProfileId ? { projectProfileId } : {}),
        ...(baseRef ? { baseRef } : {})
      })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.code === "project_selection_required") {
      renderProjectSelection(issueKey, data.projectResolution, host, status);
      return;
    }
    if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
    state.pendingExecutionPlan = data.plan;
    renderPlanPreview(data.plan, host, status, { showCompatibility: true });
    if (!data.plan.eligible) {
      status.className = "execution-launcher-status is-warning";
      status.textContent = uiMessage("compatibilityChecked");
    }
  } catch (error) {
    status.className = "execution-launcher-status is-error";
    status.textContent = uiMessage("compatibilityFailed", { error: error.message });
    button.disabled = false;
  }
}

async function prepareWorkItemPlan(
  issueKey,
  host,
  button,
  status,
  projectProfileId = null,
  baseRef = null
) {
  if (!issueKey) return;
  button.disabled = true;
  status.className = "execution-launcher-status is-loading";
  status.textContent = "Plan hazırlanıyor…";
  try {
    const response = await fetch("/api/control-plane/work-items/" + encodeURIComponent(issueKey) + "/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(projectProfileId ? { projectProfileId } : {}),
        ...(baseRef ? { baseRef } : {})
      })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.code === "project_selection_required") {
      renderProjectSelection(issueKey, data.projectResolution, host, status);
      return;
    }
    if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
    state.pendingExecutionPlan = data.plan;
    renderPlanPreview(data.plan, host, status);
  } catch (error) {
    status.className = "execution-launcher-status is-error";
    status.textContent = "Plan hazırlanamadı: " + error.message;
  } finally {
    button.disabled = false;
  }
}

async function startWorkItemExecution(plan, button, status) {
  if (!plan?.issue || !plan?.planFingerprint) return;
  button.disabled = true;
  status.className = "execution-launcher-status is-loading";
  status.textContent = "Agent güvenli worktree üzerinde başlatılıyor…";
  try {
    const response = await fetch("/api/control-plane/work-items/" + encodeURIComponent(plan.issue) + "/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planFingerprint: plan.planFingerprint,
        ...(plan.projectProfileId ? { projectProfileId: plan.projectProfileId } : {}),
        ...(plan.baseRefOverride ? { baseRef: plan.baseRefOverride } : {})
      })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.plan) {
      state.pendingExecutionPlan = data.plan;
      throw new Error("Plan değişti. Güncel planı tekrar kontrol edin.");
    }
    if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
    status.className = "execution-launcher-status is-success";
    status.textContent = "Agent başlatıldı. İlerlemeyi Genel Bakış ekranından izleyebilirsiniz.";
    state.pendingExecutionPlan = null;
    await fetchSnapshot();
  } catch (error) {
    status.className = "execution-launcher-status is-error";
    status.textContent = "Agent başlatılamadı: " + error.message;
    button.disabled = false;
  }
}

async function stopRunExecution(runId, button, status = null) {
  if (!runId) return;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("Bu agent çalışmasını durdurmak istiyor musunuz?")) return;
  button.disabled = true;
  if (status) {
    status.className = "execution-launcher-status is-loading";
    status.textContent = "Durdurma isteği gönderiliyor…";
  }
  try {
    const response = await fetch("/api/control-plane/runs/" + encodeURIComponent(runId) + "/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
    if (status) {
      status.className = "execution-launcher-status is-success";
      status.textContent = "Durdurma isteği kabul edildi.";
    }
    await fetchSnapshot();
  } catch (error) {
    if (status) {
      status.className = "execution-launcher-status is-error";
      status.textContent = "Agent durdurulamadı: " + error.message;
    } else if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert("Agent durdurulamadı: " + error.message);
    }
    button.disabled = false;
  }
}
function renderDecisionTraceDetail(data) {
  state.currentWorkItemDetail = data;
  const summaryEl = getElem("trace-issue-summary");
  const body = getElem("trace-drawer-body");
  if (!body) return;
  body.innerHTML = "";

  const wi = data.workItem || {};
  const orch = data.orchestratorDecision || {};
  const agentId = data.agentIdentity || {};
  const exec = data.execution || {};
  const rev = data.review || {};
  const human = data.humanControl || {};
  const blk = data.blockedInfo || {};
  const history = data.history || [];

  if (summaryEl) summaryEl.textContent = wi.summary || "Açıklama yok";

  body.appendChild(renderExecutionLauncher(data));

  // 1. Work Item Summary
  const wiSection = element("div", "trace-section");
  wiSection.appendChild(element("h3", "trace-section-title", "1. Work Item Özeti"));
  const wiGrid = element("div", "trace-grid");
  wiGrid.appendChild(createTraceCell("Key", wi.key));
  wiGrid.appendChild(createTraceCell("Kanonik Durum", wi.canonicalState));
  wiGrid.appendChild(createTraceCell("Kaynak Sağlayıcı", wi.sourceProvider || "jira"));
  wiGrid.appendChild(createTraceCell("Otonom İlerlenebilir", wi.autonomousEligible ? "Evet" : "Hayır"));
  wiSection.appendChild(wiGrid);
  if (wi.description) wiSection.appendChild(element("p", "trace-description", wi.description));
  body.appendChild(wiSection);

  // 2. Orchestration Decision
  const orchSection = element("div", "trace-section");
  orchSection.appendChild(element("h3", "trace-section-title", "2. Orkestrasyon ve Planlama Kararı"));
  const orchGrid = element("div", "trace-grid");
  orchGrid.appendChild(createTraceCell("Persona", orch.persona || "—"));
  orchGrid.appendChild(createTraceCell("Task Agent", orch.taskAgent || "—"));
  orchGrid.appendChild(createTraceCell("Risk", orch.risk || "normal"));
  orchGrid.appendChild(createTraceCell("Plan Parmak İzi", orch.planFingerprint ? orch.planFingerprint.slice(0, 16) + "..." : "—"));
  orchGrid.appendChild(createTraceCell("İzinli Yollar", Array.isArray(orch.allowedPaths) ? orch.allowedPaths.join(", ") : "—"));
  orchGrid.appendChild(createTraceCell("Bağımlılıklar", Array.isArray(orch.dependencies) && orch.dependencies.length ? orch.dependencies.join(", ") : "Bağımsız"));
  orchSection.appendChild(orchGrid);
  body.appendChild(orchSection);

  // 3. Agent Identity
  const aidSection = element("div", "trace-section");
  aidSection.appendChild(element("h3", "trace-section-title", "3. Agent Kimliği (Registry)"));
  const aidGrid = element("div", "trace-grid");
  aidGrid.appendChild(createTraceCell("Agent ID", agentId.agentId || orch.taskAgent || "—"));
  aidGrid.appendChild(createTraceCell("Agent Version", agentId.agentVersion ?? "—"));
  aidGrid.appendChild(createTraceCell("Agent Hash", agentId.agentHash ? String(agentId.agentHash).slice(0, 12) + "..." : "—"));
  aidGrid.appendChild(createTraceCell("Canlı Registry Durumu", agentId.liveRegistryStatus || "—"));
  aidGrid.appendChild(createTraceCell("Canlı Registry Version", agentId.liveRegistryVersion ?? "—"));
  aidGrid.appendChild(createTraceCell("Canlı Registry Hash", agentId.liveRegistryHash ? String(agentId.liveRegistryHash).slice(0, 12) + "..." : "—"));
  aidGrid.appendChild(createTraceCell("Sabitlenmiş Sürüm Güncel", agentId.isPinnedVersionCurrent === true ? "Evet" : (agentId.isPinnedVersionCurrent === false ? "Hayır" : "—")));
  aidSection.appendChild(aidGrid);
  body.appendChild(aidSection);

  // 4. Execution Engine & Worktree
  const execSection = element("div", "trace-section");
  execSection.appendChild(element("h3", "trace-section-title", "4. Yürütme Motoru ve Worktree"));
  const execGrid = element("div", "trace-grid");
  execGrid.appendChild(createTraceCell("Provider", exec.provider || "—"));
  execGrid.appendChild(createTraceCell("Model", exec.model || "—"));
  execGrid.appendChild(createTraceCell("Model Profile", exec.modelProfile || "—"));
  execGrid.appendChild(createTraceCell("Çalışma Durumu", exec.currentRunState || "—"));
  execGrid.appendChild(createTraceCell("Branch", exec.branch || "—"));
  execGrid.appendChild(createTraceCell("Worktree", exec.worktree || "—"));
  execGrid.appendChild(createTraceCell("Commit SHA", exec.commit || "—"));
  execGrid.appendChild(createTraceCell("Deneme", exec.attempt != null && exec.maxAttempts != null ? `${exec.attempt} / ${exec.maxAttempts}` : String(exec.attempt ?? "0")));
  execGrid.appendChild(createTraceCell("Otomatik geçiş", exec.adaptiveRoutingEnabled ? "Etkin" : "Kapalı"));
  if (exec.failoverContext) {
    execGrid.appendChild(createTraceCell(
      "Geçiş kaynağı",
      `${exec.failoverContext.fromProvider || "—"} / ${exec.failoverContext.fromModel || "varsayılan"} · ${exec.failoverContext.category || "—"}`
    ));
  }
  if (Array.isArray(exec.candidates) && exec.candidates.length > 1) {
    execGrid.appendChild(createTraceCell("Yedek rota", exec.candidates.slice(1)
      .map(candidate => `${candidate.provider} / ${candidate.model || candidate.modelProfile || "varsayılan"}`)
      .join(" → ")));
  }
  execSection.appendChild(execGrid);
  if (exec.workerStatus === "running" || exec.currentActivity) {
    const report = element("div", "live-agent-report");
    report.appendChild(element("h4", null, "Canlı agent raporu"));
    report.appendChild(element("p", "live-agent-activity", formatAgentProgress(exec.currentActivity)));
    report.appendChild(element(
      "small",
      "live-agent-updated",
      `${translateUiText("Son sinyal:")} ${exec.lastActivityAt ? formatTime(exec.lastActivityAt) : translateUiText("henüz alınmadı")}`
    ));
    const refreshButton = element("button", "pm-btn pm-btn-view", "Ara raporu yenile");
    refreshButton.type = "button";
    refreshButton.addEventListener?.("click", () => openDecisionTrace(wi.key, true, refreshButton));
    report.appendChild(refreshButton);
    execSection.appendChild(report);
  }
  body.appendChild(execSection);

  // 5. Reviewer & Findings
  const revSection = element("div", "trace-section");
  revSection.appendChild(element("h3", "trace-section-title", "5. Reviewer ve Doğrulama Bulguları"));
  const revGrid = element("div", "trace-grid");
  revGrid.appendChild(createTraceCell("Reviewer Agent", rev.reviewerTaskAgent || "—"));
  revGrid.appendChild(createTraceCell("Review Agent Version", rev.reviewAgentVersion ?? "—"));
  revGrid.appendChild(createTraceCell("Review Agent Hash", rev.reviewAgentHash ? String(rev.reviewAgentHash).slice(0, 12) + "..." : "—"));
  revGrid.appendChild(createTraceCell("Review Provider", rev.reviewProvider || "—"));
  revGrid.appendChild(createTraceCell("Review Model", rev.reviewModel || "—"));
  revGrid.appendChild(createTraceCell("Review Model Profile", rev.reviewModelProfile || "—"));
  revGrid.appendChild(createTraceCell("Verdict", rev.verdict || "Henüz verilmedi"));
  revGrid.appendChild(createTraceCell("İncelenen SHA", rev.latestImplementationSha || "—"));
  revSection.appendChild(revGrid);

  if (rev.structuredFindings && Array.isArray(rev.structuredFindings) && rev.structuredFindings.length > 0) {
    const findingsList = element("ul", "trace-findings-list");
    rev.structuredFindings.forEach(f => {
      const li = element("li", null, typeof f === "string" ? f : `${f.severity || "INFO"}: ${f.message || JSON.stringify(f)}`);
      findingsList.appendChild(li);
    });
    revSection.appendChild(findingsList);
  }
  body.appendChild(revSection);

  // 6. Human Control
  const humanSection = element("div", "trace-section");
  humanSection.appendChild(element("h3", "trace-section-title", "6. İnsan Kontrol ve Onay Kapısı"));
  const humanGrid = element("div", "trace-grid");
  humanGrid.appendChild(createTraceCell("Bekleyen Aksiyon", human.pendingAction || "Yok"));
  humanGrid.appendChild(createTraceCell("Onay Durumu", human.approvalState || "not_required"));
  humanGrid.appendChild(createTraceCell("Plan Parmak İzi", human.planFingerprint ? String(human.planFingerprint).slice(0, 16) + "..." : "—"));
  humanGrid.appendChild(createTraceCell("Çalışma Modu", human.operatingMode || "AUTONOMOUS"));
  humanSection.appendChild(humanGrid);
  body.appendChild(humanSection);

  // 7. Blocked Info
  if (blk.isBlocked) {
    const blkSection = element("div", "trace-section trace-blocked-box");
    blkSection.appendChild(element("h3", "trace-section-title", "🛑 Bloke Durumu ve Teşhis"));
    const blkGrid = element("div", "trace-grid");
    blkGrid.appendChild(createTraceCell("Gerekçe", blk.reason || "Bilinmiyor"));
    if (blk.detail) blkGrid.appendChild(createTraceCell("Teknik ayrıntı", blk.detail));
    if (blk.failureCategory) blkGrid.appendChild(createTraceCell("Hata kategorisi", blk.failureCategory));
    blkGrid.appendChild(createTraceCell("Otomatik geçiş uygunluğu", blk.autoFailoverEligible ? "Evet" : "Hayır"));
    blkGrid.appendChild(createTraceCell("Tekrar Denenebilir", blk.canRetry ? "Evet" : "Hayır"));
    blkGrid.appendChild(createTraceCell("Onaylanabilir", blk.canApprove ? "Evet" : "Hayır"));
    blkSection.appendChild(blkGrid);
    body.appendChild(blkSection);
  }

  // 8. History Timeline — concise milestones by default, full audit on demand.
  const histSection = element("div", "trace-section");
  histSection.appendChild(element("h3", "trace-section-title", "7. Çalışma zaman çizelgesi"));
  if (history.length === 0) {
    histSection.appendChild(element("p", "empty-text", "Zaman çizelgesi boş."));
  } else {
    const renderTimeline = (items, technical = false) => {
      const timeline = element("div", `trace-timeline${technical ? " trace-timeline-technical" : " trace-timeline-summary"}`);
      items.forEach(item => {
        const step = element("div", "timeline-step");
        const dot = element("span", "timeline-dot");
        const content = element("div", "timeline-content");
        const time = element("small", null, formatTime(item.timestamp || item.createdAt));
        const title = technical
          ? String(item.stage || item.state || "event").replaceAll("_", " ")
          : friendlyTimelineLabel(item);
        const stage = element("strong", null, title);
        let actorStr = "";
        if (item.actor) {
          if (typeof item.actor === "object") {
            const type = item.actor.type || item.actor.role || "";
            const id = item.actor.id || item.actor.name || item.actor.agentId || "";
            if (type && id) actorStr = `[${type} · ${id}]`;
            else if (id || type) actorStr = `[${id || type}]`;
          } else {
            actorStr = `[${String(item.actor)}]`;
          }
        }
        let safeDetails = null;
        if (technical && item.details) {
          if (typeof item.details === "string") {
            safeDetails = item.details.slice(0, 2000);
          } else if (typeof item.details === "object") {
            const clean = { ...item.details };
            delete clean.rawPrompt;
            delete clean.prompt;
            delete clean.stdout;
            delete clean.stderr;
            delete clean.apiKey;
            delete clean.token;
            delete clean.secret;
            delete clean.raw;
            const serialized = JSON.stringify(clean);
            if (serialized !== "{}") safeDetails = serialized.slice(0, 2000);
          }
        }
        content.appendChild(time);
        content.appendChild(stage);
        if (actorStr) content.appendChild(element("span", "timeline-actor", actorStr));
        if (technical && item.label && item.label !== title) content.appendChild(element("span", null, item.label));
        if (safeDetails) {
          const detail = element("details", "timeline-event-detail");
          detail.appendChild(element("summary", null, "Teknik ayrıntı"));
          detail.appendChild(element("pre", "timeline-detail-json", safeDetails));
          content.appendChild(detail);
        }
        step.appendChild(dot);
        step.appendChild(content);
        timeline.appendChild(step);
      });
      return timeline;
    };
    histSection.appendChild(element("p", "timeline-help", "Son önemli adımlar gösteriliyor. Tekrarlanan teknik olaylar aşağıda kapalıdır."));
    histSection.appendChild(renderTimeline(compactAuditHistory(history)));
    const allEvents = element("details", "timeline-all-events");
    allEvents.appendChild(element("summary", null, `${state.language === "en" ? "Show all technical events" : "Tüm teknik olayları göster"} (${history.length})`));
    allEvents.appendChild(renderTimeline(history, true));
    histSection.appendChild(allEvents);
  }
  body.appendChild(histSection);
  applyDocumentTranslations();
}

function createTraceCell(label, value) {
  const cell = element("div", "trace-cell");
  cell.appendChild(element("span", "trace-cell-label", label));
  cell.appendChild(element("strong", "trace-cell-value", value !== null && value !== undefined && value !== "" ? String(value) : "—"));
  return cell;
}

// Approval & Rejection Modals
function openApprovalModal(item, triggerBtn = null) {
  state.pendingApprovalItem = item;
  const issueEl = getElem("app-modal-issue");
  const actionEl = getElem("app-modal-action");
  const agentEl = getElem("app-modal-agent");
  const riskEl = getElem("app-modal-risk");
  const provEl = getElem("app-modal-provider");
  const pathsEl = getElem("app-modal-paths");
  const fpEl = getElem("app-modal-fp");
  const statusEl = getElem("approval-modal-status");
  const confirmBtn = getElem("approval-modal-confirm-btn");
  const cancelBtn = getElem("approval-modal-cancel-btn");

  if (issueEl) issueEl.textContent = item.issueKey || "—";
  if (actionEl) actionEl.textContent = item.action || "implementation";
  if (agentEl) agentEl.textContent = item.taskAgent || item.persona || "—";
  if (riskEl) riskEl.textContent = item.risk || "normal";
  if (provEl) provEl.textContent = `${item.executorProvider || "default"} / ${item.executorModel || "default"}`;
  if (pathsEl) pathsEl.textContent = Array.isArray(item.allowedPaths) ? item.allowedPaths.join(", ") : "—";
  if (fpEl) fpEl.textContent = item.planFingerprint || "—";
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }

  if (confirmBtn) confirmBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = false;

  openModal("approval-modal", triggerBtn);
}

async function submitApproval() {
  const item = state.pendingApprovalItem;
  if (!item) return;

  const confirmBtn = getElem("approval-modal-confirm-btn");
  const cancelBtn = getElem("approval-modal-cancel-btn");
  const statusEl = getElem("approval-modal-status");

  if (confirmBtn) confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "modal-status-msg is-loading";
    statusEl.textContent = "Onay kaydediliyor...";
  }

  try {
    const res = await fetch(`/api/pm/work-items/${encodeURIComponent(item.issueKey)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: item.action || "implementation",
        planFingerprint: item.planFingerprint,
        attempt: item.reworkAttempt || 0,
        approver: "pm-operator"
      })
    });

    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (statusEl) {
        statusEl.className = "modal-status-msg is-error";
        statusEl.textContent = `409 Çakışma: Plan parmak izi değişmiş (${data.error || "Plan güncellendi"}). Çalışma alanı yenileniyor...`;
      }
      if (confirmBtn) confirmBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      await fetchSnapshot();
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
    }

    if (statusEl) {
      statusEl.className = "modal-status-msg is-success";
      statusEl.textContent = "✓ Onay başarıyla kaydedildi.";
    }

    setTimeout(() => {
      closeModal("approval-modal");
      state.pendingApprovalItem = null;
      fetchSnapshot();
    }, 700);
  } catch (err) {
    if (statusEl) {
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = `Hata: ${err.message}`;
    }
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

function openRejectionModal(item, triggerBtn = null) {
  state.pendingRejectionItem = item;
  const reasonInput = getElem("rejection-reason-input");
  const statusEl = getElem("rejection-modal-status");
  const confirmBtn = getElem("rejection-modal-confirm-btn");
  const cancelBtn = getElem("rejection-modal-cancel-btn");

  if (reasonInput) reasonInput.value = "";
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }
  if (confirmBtn) confirmBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = false;

  openModal("rejection-modal", triggerBtn);
}

async function submitRejection() {
  const item = state.pendingRejectionItem;
  if (!item) return;

  const reasonInput = getElem("rejection-reason-input");
  const confirmBtn = getElem("rejection-modal-confirm-btn");
  const cancelBtn = getElem("rejection-modal-cancel-btn");
  const statusEl = getElem("rejection-modal-status");

  const reason = reasonInput ? reasonInput.value.trim() : "";
  if (!reason) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = "Lütfen bir reddetme gerekçesi belirtin.";
    }
    return;
  }

  if (confirmBtn) confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "modal-status-msg is-loading";
    statusEl.textContent = "Red işlemi kaydediliyor...";
  }

  try {
    const res = await fetch(`/api/pm/work-items/${encodeURIComponent(item.issueKey)}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: item.action || "implementation",
        planFingerprint: item.planFingerprint,
        reason,
        approver: "pm-operator"
      })
    });

    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (statusEl) {
        statusEl.className = "modal-status-msg is-error";
        statusEl.textContent = `409 Çakışma: Plan parmak izi değişmiş (${data.error || "Plan güncellendi"}). Çalışma alanı yenileniyor...`;
      }
      if (confirmBtn) confirmBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      await fetchSnapshot();
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
    }

    if (statusEl) {
      statusEl.className = "modal-status-msg is-success";
      statusEl.textContent = "✓ Reddedildi ve iş bloke edildi.";
    }

    setTimeout(() => {
      closeModal("rejection-modal");
      state.pendingRejectionItem = null;
      fetchSnapshot();
    }, 700);
  } catch (err) {
    if (statusEl) {
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = `Hata: ${err.message}`;
    }
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

// Parent Orchestration & Child DAG
function clearParentDetail() {
  state.currentParentDetail = null;
  const keyBadge = getElem("parent-key-badge");
  const summaryText = getElem("parent-summary-text");
  const statePillEl = getElem("parent-state-pill");
  const baseSha = getElem("parent-base-sha");
  const intBranch = getElem("parent-int-branch");
  const intHeadSha = getElem("parent-int-head-sha");
  const graphFp = getElem("parent-graph-fp");
  const blockersBox = getElem("parent-blockers-container");
  const compCard = getElem("parent-human-approval-card");
  const container = getElem("parent-dag-container");
  const lane = getElem("parent-integration-lane");
  const findings = getElem("parent-review-findings");

  if (keyBadge) keyBadge.textContent = "—";
  if (summaryText) summaryText.textContent = "Lütfen bir parent epik seçin";
  if (statePillEl) {
    statePillEl.textContent = "—";
    statePillEl.className = "state-pill";
  }
  if (baseSha) baseSha.textContent = "—";
  if (intBranch) intBranch.textContent = "—";
  if (intHeadSha) intHeadSha.textContent = "—";
  if (graphFp) graphFp.textContent = "—";
  if (blockersBox) { blockersBox.hidden = true; blockersBox.innerHTML = ""; }
  if (compCard) compCard.hidden = true;
  if (container) container.innerHTML = '<div class="empty-state">Parent seçilmedi.</div>';
  if (lane) lane.innerHTML = '<div class="empty-state">Parent seçilmedi.</div>';
  if (findings) findings.innerHTML = "";
}

function populateParentSelector() {
  const select = getElem("parent-select");
  if (!select) return;

  const parentMap = new Map((state.workSourceCatalog?.parents || []).map(parent => [parent.key, parent]));
  for (const parent of state.snapshot?.parentExecutions || []) parentMap.set(parent.parentKey || parent.key, parent);
  const parents = [...parentMap.values()];
  select.innerHTML = "";

  if (parents.length === 0) {
    const opt = element("option", null, state.workSourceCatalogError ? "Parentlar yüklenemedi" : "Parent epik bulunamadı");
    opt.value = "";
    select.appendChild(opt);
    return;
  }

  const defaultOpt = element("option", null, "-- Parent Epik Seçin --");
  defaultOpt.value = "";
  select.appendChild(defaultOpt);

  parents.forEach(p => {
    const pKey = p.parentKey || p.key;
    const opt = element("option", null, `${pKey}: ${p.summary || "Epik"}`);
    opt.value = pKey;
    if (state.selectedParentKey === pKey) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  if (state.selectedParentKey) {
    select.value = state.selectedParentKey;
  } else {
    select.value = "";
  }
}

async function fetchParentDetail(parentKey) {
  if (!parentKey) return;
  const requestId = ++state.parentDetailRequestId;
  state.selectedParentKey = parentKey;
  state.currentParentDetail = null;
  const select = getElem("parent-select");
  const refresh = getElem("parent-refresh-btn");
  const summaryText = getElem("parent-summary-text");
  const keyBadge = getElem("parent-key-badge");
  const dag = getElem("parent-dag-container");
  const lane = getElem("parent-integration-lane");
  const findings = getElem("parent-review-findings");
  if (select) { select.value = parentKey; select.disabled = true; }
  if (refresh) refresh.disabled = true;
  if (keyBadge) keyBadge.textContent = parentKey;
  if (summaryText) summaryText.textContent = uiMessage("parentLoading");
  for (const host of [dag, lane, findings]) {
    if (host) host.replaceChildren(element("div", "loading-spinner", uiMessage("loading")));
  }

  try {
    const data = await fetchJsonWithTimeout("/api/pm/parents/" + encodeURIComponent(parentKey));
    if (requestId !== state.parentDetailRequestId) return;
    const detail = data?.parent || data;
    if (!detail || (!detail.parent && !detail.key && !detail.parentKey)) {
      throw new Error("The server returned an incomplete parent response.");
    }
    renderParentDetail(detail);
  } catch (error) {
    if (requestId !== state.parentDetailRequestId) return;
    clearParentDetail();
    if (keyBadge) keyBadge.textContent = parentKey;
    if (summaryText) summaryText.textContent = uiMessage("parentFailed") + ": " + error.message;
    for (const host of [dag, lane, findings]) {
      if (host) renderDetailError(null, host, uiMessage("parentFailed"), error);
    }
  } finally {
    if (requestId === state.parentDetailRequestId) {
      if (select) select.disabled = false;
      if (refresh) refresh.disabled = false;
    }
  }
}

function renderParentDetail(data) {
  state.currentParentDetail = data;
  const detail = (data && data.ok && data.parent) ? data.parent : (data || {});
  const parent = detail.parent || {};
  const stateVal = detail.state || "active";
  const children = detail.children || [];
  const blockedReasons = detail.blockedReasons || [];
  const isWaitingHuman = Boolean(detail.waitingHuman) || stateVal === "waiting_human" || stateVal === "human_approval";

  const keyBadge = getElem("parent-key-badge");
  const summaryText = getElem("parent-summary-text");
  const statePillEl = getElem("parent-state-pill");
  const baseSha = getElem("parent-base-sha");
  const intBranch = getElem("parent-int-branch");
  const intHeadSha = getElem("parent-int-head-sha");
  const graphFp = getElem("parent-graph-fp");
  const blockersBox = getElem("parent-blockers-container");

  if (keyBadge) keyBadge.textContent = parent.parentKey || parent.key || "—";
  if (summaryText) summaryText.textContent = parent.summary || "Parent Epik";
  if (statePillEl) {
    statePillEl.textContent = STATUS_LABELS[stateVal] || stateVal.toUpperCase();
    statePillEl.className = `state-pill ${stateVal}`;
  }
  if (baseSha) baseSha.textContent = detail.readOnly ? "Henüz orchestration run yok" : (detail.baseSha ? `${detail.baseRef || "develop"} @ ${detail.baseSha.slice(0, 8)}` : (detail.baseRef || "develop"));
  if (intBranch) intBranch.textContent = detail.integrationBranch || "—";
  if (intHeadSha) intHeadSha.textContent = detail.integrationHeadSha ? detail.integrationHeadSha.slice(0, 8) : "—";
  if (graphFp) graphFp.textContent = detail.graphFingerprint ? detail.graphFingerprint.slice(0, 12) + "..." : "—";

  if (blockersBox) {
    if (blockedReasons.length > 0) {
      blockersBox.hidden = false;
      blockersBox.innerHTML = `<strong>🛑 Parent Blockerları:</strong><ul>${blockedReasons.map(r => `<li>${safeHtml(r)}</li>`).join("")}</ul>`;
    } else {
      blockersBox.hidden = true;
      blockersBox.innerHTML = "";
    }
  }

  const compCard = getElem("parent-human-approval-card");
  if (compCard) {
    if (isWaitingHuman) {
      compCard.hidden = false;
      const cFp = getElem("comp-graph-fp");
      const cBase = getElem("comp-base-sha");
      const cHead = getElem("comp-int-head");
      const cRev = getElem("comp-review-verdict");

      if (cFp) cFp.textContent = detail.graphFingerprint ? detail.graphFingerprint.slice(0, 12) + "..." : "—";
      if (cBase) cBase.textContent = detail.baseSha ? detail.baseSha.slice(0, 10) : "—";
      if (cHead) cHead.textContent = detail.integrationHeadSha ? detail.integrationHeadSha.slice(0, 10) : "—";
      if (cRev) cRev.textContent = detail.integrationReview?.verdict || "CLEAN";
    } else {
      compCard.hidden = true;
    }
  }

  renderChildDag(children);
  renderIntegrationLane(children, detail.integrationBranch);
  renderParentReviewFindings(detail);
  applyDocumentTranslations();
}

function childIssueKey(child = {}) {
  return String(child.issueKey || child.key || "").trim();
}

function childDependencies(child = {}) {
  return Array.isArray(child.dependencies)
    ? child.dependencies.map(String).filter(Boolean)
    : [];
}

function childVisualState(child = {}) {
  const integration = String(child.integrationState || "").toLowerCase();
  const runtime = String(child.canonicalState || child.runtimeState || child.orchestrationState || "").toLowerCase();
  if (integration === "integrated" || child.integratedSha || ["integrated", "done", "completed"].includes(runtime)) return "done";
  if (runtime.includes("blocked") || runtime.includes("conflict") || runtime.includes("failed")) return "blocked";
  if (child.reviewedSha || runtime.includes("review") || runtime === "verifying") return "review";
  if (["in_progress", "executing", "started", "progress", "running"].includes(runtime) || runtime.includes("in progress")) return "running";
  return "ready";
}

function childStatusLabel(child = {}) {
  return {
    done: "Tamamlandı",
    blocked: "Engelli",
    review: "İncelemede",
    running: "Çalışıyor",
    ready: "Hazır"
  }[childVisualState(child)];
}

function buildExecutionStages(children = []) {
  const ordered = [];
  const seen = new Set();
  for (const child of children) {
    const key = childIssueKey(child);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ordered.push(child);
  }

  const knownKeys = new Set(ordered.map(childIssueKey));
  const remaining = new Map(ordered.map(child => [childIssueKey(child), child]));
  const placed = new Set();
  const stages = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(child => {
      const dependencies = childDependencies(child);
      return dependencies.every(dependency => knownKeys.has(dependency) && placed.has(dependency));
    });

    if (ready.length === 0) {
      stages.push({ index: stages.length, unresolved: true, children: [...remaining.values()] });
      break;
    }

    stages.push({ index: stages.length, unresolved: false, children: ready });
    for (const child of ready) {
      const key = childIssueKey(child);
      placed.add(key);
      remaining.delete(key);
    }
  }

  return stages;
}

function createChildFlowStat(value, label, tone) {
  const stat = element("div", `child-flow-stat ${tone || ""}`.trim());
  stat.appendChild(element("strong", null, String(value)));
  stat.appendChild(element("span", null, label));
  return stat;
}

function renderChildDag(children = []) {
  const container = getElem("parent-dag-container");
  const textFallback = getElem("parent-dag-text-fallback");
  if (!container) return;
  container.innerHTML = "";

  if (children.length === 0) {
    container.appendChild(element("div", "empty-state", "Bu Parent altında henüz alt iş bulunmuyor."));
    if (textFallback) textFallback.textContent = "Alt iş bulunamadı.";
    return;
  }

  if (textFallback) {
    const lines = children.map(child => {
      const dependencies = childDependencies(child);
      const dependencyText = dependencies.length > 0
        ? `Önce tamamlanması gereken: ${dependencies.join(", ")}`
        : "Beklemeden başlayabilir";
      return `• ${childIssueKey(child)}: ${child.summary || "İş"} | ${childStatusLabel(child)} | ${dependencyText}`;
    });
    textFallback.textContent = lines.join("\n");
  }

  const stages = buildExecutionStages(children);
  const completedCount = children.filter(child => childVisualState(child) === "done").length;
  const blockedCount = children.filter(child => childVisualState(child) === "blocked").length;
  const readyNow = stages[0]?.unresolved ? 0 : (stages[0]?.children.length || 0);

  const summary = element("div", "child-flow-summary");
  summary.appendChild(createChildFlowStat(children.length, "Toplam alt iş", "is-total"));
  summary.appendChild(createChildFlowStat(readyNow, "Hemen başlayabilir", "is-ready"));
  summary.appendChild(createChildFlowStat(completedCount, "Tamamlandı", "is-done"));
  summary.appendChild(createChildFlowStat(blockedCount, "Engelli", "is-blocked"));
  container.appendChild(summary);

  const flow = element("div", "child-flow-stages");
  stages.forEach((stage, stageIndex) => {
    const stageBox = element("section", `child-flow-stage${stage.unresolved ? " is-unresolved" : ""}`);
    const header = element("div", "child-flow-stage-header");
    const number = element("span", "child-flow-stage-number", stage.unresolved ? "!" : String(stageIndex + 1));
    const copy = element("div", "child-flow-stage-copy");
    const title = stage.unresolved
      ? "Bağımlılığı kontrol edilmeli"
      : stageIndex === 0
        ? "Hemen başlayabilir"
        : "Önceki işler tamamlanınca";
    const description = stage.unresolved
      ? "Bu işlerde eksik veya döngüsel bir bağımlılık var."
      : stageIndex === 0
        ? "Bu işler birbirini beklemez; uygun kapasite varsa aynı anda çalışabilir."
        : "Bu aşama, kendisinden önce gereken işler tamamlandığında açılır.";
    copy.appendChild(element("h4", null, title));
    copy.appendChild(element("p", null, description));
    header.appendChild(number);
    header.appendChild(copy);
    header.appendChild(element("span", "child-flow-stage-count", `${stage.children.length} iş`));
    stageBox.appendChild(header);

    const grid = element("div", "child-flow-grid");
    stage.children.forEach(child => grid.appendChild(createDagNode(child)));
    stageBox.appendChild(grid);
    flow.appendChild(stageBox);
  });
  container.appendChild(flow);
}

function createDagNode(child) {
  const issueKey = childIssueKey(child);
  const visualState = childVisualState(child);
  const node = element("button", `dag-node-btn child-flow-card is-${visualState}`);
  node.type = "button";
  node.dataset = node.dataset || {};
  node.dataset.issueKey = issueKey;
  if (typeof node.setAttribute === "function") {
    node.setAttribute("aria-label", `${issueKey}: ${child.summary || "İş"}. ${childStatusLabel(child)}. Detayını aç.`);
  }

  const top = element("div", "child-flow-card-top");
  const key = element("strong", "child-flow-key", issueKey);
  const badge = element("span", `child-flow-status is-${visualState}`, childStatusLabel(child));
  top.appendChild(key);
  top.appendChild(badge);

  const title = element("p", "child-flow-title", child.summary || "İş");
  const dependencies = childDependencies(child);
  const dependency = element("div", "child-flow-dependency");
  dependency.appendChild(element("span", "child-flow-dependency-label", dependencies.length > 0 ? "Ön koşul" : "Başlangıç"));
  dependency.appendChild(element("strong", null, dependencies.length > 0 ? `${dependencies.join(", ")} tamamlanmalı` : "Beklemeden başlayabilir"));

  node.appendChild(top);
  node.appendChild(title);
  node.appendChild(dependency);

  if (child.childBaseSha) {
    node.appendChild(element("small", "child-flow-tech", `Base: ${child.childBaseSha.slice(0, 8)}`));
  }
  node.appendChild(element("span", "child-flow-open", "İş detayını aç →"));

  if (typeof node.addEventListener === "function") {
    node.addEventListener("click", () => {
      openDecisionTrace(issueKey);
    });
  }

  return node;
}

function renderIntegrationLane(children = [], branchName) {
  const lane = getElem("parent-integration-lane");
  if (!lane) return;
  lane.innerHTML = "";

  if (children.length === 0) {
    lane.appendChild(element("div", "empty-state", "Birleştirilecek alt iş bulunmuyor."));
    return;
  }

  children.forEach((child, index) => {
    const integrated = Boolean(child.integratedSha) || child.integrationState === "integrated";
    const reviewed = Boolean(child.reviewedSha);
    const tone = integrated ? "is-integrated" : reviewed ? "is-ready" : "is-pending";
    const item = element("div", `integration-item ${tone}`);
    const number = element("span", "int-seq", String(index + 1));
    const content = element("div", "int-content");
    const top = element("div", "int-content-top");
    top.appendChild(element("strong", null, `${childIssueKey(child)} · ${child.summary || "İş"}`));
    top.appendChild(element("span", `integration-status ${tone}`, integrated ? "Parent'a eklendi" : reviewed ? "Birleştirmeye hazır" : "İnceleme bekliyor"));

    const explanation = element("p", "integration-explanation", integrated
      ? "Bu değişiklik Parent dalına güvenle alındı."
      : reviewed
        ? "İnceleme tamamlandı; sırası geldiğinde Parent dalına alınabilir."
        : "Önce işin tamamlanması ve incelemeden geçmesi gerekiyor.");

    const evidence = element("div", "integration-evidence");
    if (child.reviewedSha) evidence.appendChild(element("small", null, `İnceleme: ${child.reviewedSha.slice(0, 8)}`));
    if (child.integratedSha) evidence.appendChild(element("small", null, `Birleştirme: ${child.integratedSha.slice(0, 8)}`));
    if (!child.reviewedSha && !child.integratedSha) evidence.appendChild(element("small", null, branchName ? `Hedef: ${branchName}` : "Henüz commit kanıtı yok"));

    content.appendChild(top);
    content.appendChild(explanation);
    content.appendChild(evidence);
    item.appendChild(number);
    item.appendChild(content);
    lane.appendChild(item);
  });
}

function renderParentReviewFindings(data) {
  const container = getElem("parent-review-findings");
  if (!container) return;
  container.innerHTML = "";

  const rev = data.integrationReview;
  const completion = data.completion || {};
  const verification = completion.verification || data.verification;

  if (!rev && !verification) {
    container.appendChild(element("p", "empty-text", "Tüm child tasklar entegre edildiğinde aggregate review ve repo doğrulaması burada görüntülenecektir."));
    return;
  }

  if (verification) {
    const verifBox = element("div", "finding-box");
    const verifLabel = verification.command || verification.check || "verification check";
    verifBox.appendChild(element("h4", null, `Verification (${verifLabel})`));
    const passed = verification.passed ?? verification.result;
    verifBox.appendChild(element("p", null, `Durum: ${passed ? "✓ Başarılı" : (passed === false ? "✕ Başarısız" : "Bilinmiyor")}`));
    if (verification.evidence) {
      const pre = element("pre", "code-block", String(verification.evidence).slice(0, 500));
      verifBox.appendChild(pre);
    } else if (verification.output) {
      const pre = element("pre", "code-block", String(verification.output).slice(0, 500));
      verifBox.appendChild(pre);
    }
    container.appendChild(verifBox);
  }

  if (rev) {
    const revBox = element("div", "finding-box");
    const reviewerName = rev.reviewerAgentId || rev.reviewer || "reviewer-agent";
    revBox.appendChild(element("h4", null, `Aggregate Integration Review (${reviewerName})`));

    const revMeta = element("div", "trace-grid");
    revMeta.appendChild(createTraceCell("Reviewer Agent", rev.reviewerAgentId || "—"));
    revMeta.appendChild(createTraceCell("Reviewer Version", rev.reviewerVersion ?? "—"));
    revMeta.appendChild(createTraceCell("Reviewer Hash", rev.reviewerHash ? String(rev.reviewerHash).slice(0, 12) + "..." : "—"));
    revMeta.appendChild(createTraceCell("Provider", rev.provider || "—"));
    revMeta.appendChild(createTraceCell("Model Profile", rev.modelProfile || "—"));
    revMeta.appendChild(createTraceCell("Verdict", rev.verdict || "CLEAN"));
    revBox.appendChild(revMeta);

    if (rev.findings && rev.findings.length > 0) {
      const ul = element("ul", null);
      rev.findings.forEach(f => ul.appendChild(element("li", null, typeof f === "string" ? f : JSON.stringify(f))));
      revBox.appendChild(ul);
    }
    container.appendChild(revBox);
  }

  // Render warnings if present
  const warnings = completion.warnings || data.warnings;
  if (warnings && Array.isArray(warnings) && warnings.length > 0) {
    const warnBox = element("div", "finding-box");
    warnBox.appendChild(element("h4", null, "⚠️ Uyarılar (Warnings)"));
    const warnList = element("ul", null);
    warnings.forEach(w => warnList.appendChild(element("li", null, typeof w === "string" ? w : JSON.stringify(w))));
    warnBox.appendChild(warnList);
    container.appendChild(warnBox);
  }
}

// Observability View
async function fetchObservabilitySummary() {
  const windowParam = state.currentObsWindow || "24h";
  try {
    const res = await fetch(`/api/observability/summary?window=${encodeURIComponent(windowParam)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderObservability(data);
  } catch (err) {
    const runsTbody = getElem("obs-runs-table-body");
    if (runsTbody) {
      runsTbody.innerHTML = `<tr><td colspan="8" class="error-banner">Gözlemlenebilirlik verisi alınamadı: ${safeHtml(err.message)}</td></tr>`;
    }
  }
}

function renderObservability(data) {
  const metrics = data.metrics || {};
  const providers = data.providers || [];
  const healthyProviders = providers.filter(provider => ["healthy", "available", "ok"].includes(String(provider.status || "").toLowerCase())).length;
  const activeEl = getElem("obs-active-workers");
  const healthEl = getElem("obs-active-parents");
  const tokensEl = getElem("obs-total-tokens");
  const failuresEl = getElem("obs-conflicts");
  if (activeEl) activeEl.textContent = String(metrics.activeRuns || 0) + " aktif / " + String(metrics.queuedRuns || 0) + " kuyruk";
  if (healthEl) healthEl.textContent = providers.length ? String(healthyProviders) + " / " + String(providers.length) : "—";
  if (tokensEl) tokensEl.textContent = metrics.totalUsage?.totalTokens === null || metrics.totalUsage?.totalTokens === undefined ? "—" : formatNumber(metrics.totalUsage.totalTokens);
  if (failuresEl) failuresEl.textContent = String(metrics.runsFailed || 0) + " başarısız";

  const liveGrid = getElem("obs-live-grid");
  if (liveGrid) {
    liveGrid.innerHTML = "";
    const runs = state.snapshot?.runs || [];
    const liveRuns = runs.filter(r => r.stateKind === "active" || r.stateKind === "review");

    if (liveRuns.length === 0) {
      liveGrid.appendChild(element("p", "empty-text", "Şu anda çalışan veya incelemede aktif işlem yok."));
    } else {
      liveRuns.forEach(run => {
        const card = element("div", "obs-live-card");
        const top = element("div", "obs-live-top");
        top.appendChild(element("strong", null, run.issue || run.issueKey));
        top.appendChild(element("span", `state-badge ${run.stateKind}`, STATUS_LABELS[run.state] || run.state));
        card.appendChild(top);
        card.appendChild(element("p", "obs-live-desc", `${run.persona || "persona"} · ${run.provider || "provider"}`));
        liveGrid.appendChild(card);
      });
    }
  }

  const provGrid = getElem("obs-providers-grid");
  if (provGrid) {
    provGrid.innerHTML = "";
    const providers = data.providers || [];
    if (providers.length === 0) {
      provGrid.appendChild(element("p", "empty-text", "Provider telemetri verisi bulunamadı."));
    } else {
      providers.forEach(p => {
        const card = element("div", "obs-provider-card");
        const hdr = element("div", "obs-prov-header");
        hdr.appendChild(element("h4", null, p.provider));
        const badge = element("span", `prov-status-badge ${p.status || "healthy"}`, p.status || "healthy");
        hdr.appendChild(badge);
        card.appendChild(hdr);

        const metrics = element("div", "obs-prov-metrics");
        metrics.appendChild(createTraceCell("Başarı Oranı", p.successRate !== null ? `${Math.round(p.successRate * 100)}%` : "—"));
        metrics.appendChild(createTraceCell("Ort. Süre", p.averageDurationMs !== null ? formatDurationMs(p.averageDurationMs) : "—"));
        metrics.appendChild(createTraceCell("Başarılı / Başarısız", `${p.recentSuccesses || 0} / ${p.recentFailures || 0}`));
        if (p.cooldownUntil) {
          metrics.appendChild(createTraceCell("Cooldown", formatTime(p.cooldownUntil)));
        }
        card.appendChild(metrics);
        provGrid.appendChild(card);
      });
    }
  }

  const tbody = getElem("obs-runs-table-body");
  if (tbody) {
    tbody.innerHTML = "";
    const runs = data.runs || [];
    if (runs.length === 0) {
      const row = element("tr");
      const td = element("td", null, "Seçilen zaman penceresinde yürütme kaydı yok.");
      td.colSpan = 8;
      row.appendChild(td);
      tbody.appendChild(row);
      return;
    }

    runs.forEach(run => {
      const row = element("tr");
      const issueTd = element("td", "code-cell", run.issueKey || "—");
      const roleTd = element("td", null, `${run.role || "impl"} / ${run.taskAgent || "agent"}`);
      const modelTd = element("td", null, `${run.provider || "—"} / ${run.model || "default"}`);
      const statusTd = element("td", null, STATUS_LABELS[run.state] || run.state || "—");

      const durTd = element("td", null);
      if (run.durationSeconds !== null && run.durationSeconds !== undefined) {
        durTd.textContent = formatDuration(run.durationSeconds);
      } else {
        durTd.textContent = "—";
      }

      const tokTd = element("td", null);
      if (run.usage && run.usage.available && run.usage.totalTokens !== null) {
        tokTd.textContent = `${formatNumber(run.usage.totalTokens)} tok`;
      } else if (run.tokens !== null && run.tokens !== undefined) {
        tokTd.textContent = `${formatNumber(run.tokens)} tok`;
      } else {
        tokTd.textContent = "—";
      }

      const dateTd = element("td", null, formatTime(run.createdAt || run.timestamp));

      const actionTd = element("td", null);
      const detailBtn = element("button", "pm-btn pm-btn-view", "Detay");
      detailBtn.type = "button";
      if (typeof detailBtn.addEventListener === "function") {
        detailBtn.addEventListener("click", () => {
          openTelemetryDrawer(run.runId || run.id);
        });
      }
      actionTd.appendChild(detailBtn);

      row.appendChild(issueTd);
      row.appendChild(roleTd);
      row.appendChild(modelTd);
      row.appendChild(statusTd);
      row.appendChild(durTd);
      row.appendChild(tokTd);
      row.appendChild(dateTd);
      row.appendChild(actionTd);
      tbody.appendChild(row);
    });
  }
}

// Telemetry Timeline Drawer
async function openTelemetryDrawer(runId, fromHistory = false) {
  if (!runId) return;
  state.selectedRunId = runId;

  const modal = getElem("telemetry-drawer-modal");
  const pill = getElem("telem-run-pill");
  const title = getElem("telem-drawer-title");
  const summaryEl = getElem("telem-run-summary");
  const body = getElem("telem-drawer-body");

  if (!modal || !body) return;

  if (pill) pill.textContent = runId;
  if (title) title.textContent = `Run Telemetry Timeline · ${runId}`;
  if (summaryEl) summaryEl.textContent = "Telemetri yükleniyor...";
  body.innerHTML = '<div class="loading-spinner">Yükleniyor...</div>';

  openModal("telemetry-drawer-modal");

  if (!fromHistory) {
    syncUrlState(false);
  }

  try {
    const res = await fetch(`/api/observability/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderTelemetryDrawerDetail(data);
  } catch (err) {
    body.innerHTML = `<div class="error-banner">Telemetri detayı yüklenemedi: ${safeHtml(err.message)}</div>`;
  }
}

function renderTelemetryDrawerDetail(data) {
  const summaryEl = getElem("telem-run-summary");
  const body = getElem("telem-drawer-body");
  if (!body) return;
  body.innerHTML = "";

  const id = data.identity || {};
  const st = data.state || {};
  const tm = data.timing || {};
  const usg = data.usage || {};
  const ci = data.codeIntelligence || {};
  const events = data.events || [];

  if (summaryEl) {
    summaryEl.textContent = `${id.issueKey || "Task"} · ${id.role || "impl"} (${st.current || "unknown"})`;
  }

  const idSection = element("div", "trace-section");
  idSection.appendChild(element("h3", "trace-section-title", "1. Run Kimliği ve Konfigürasyon"));
  const idGrid = element("div", "trace-grid");
  idGrid.appendChild(createTraceCell("Issue", id.issueKey));
  idGrid.appendChild(createTraceCell("Rol", id.role));
  idGrid.appendChild(createTraceCell("Persona / Agent", `${id.persona || "—"} / ${id.taskAgent || "—"}`));
  idGrid.appendChild(createTraceCell("Agent Version", id.agentVersion ?? "—"));
  idGrid.appendChild(createTraceCell("Provider / Model", `${id.provider || "—"} / ${id.model || "default"}`));
  idGrid.appendChild(createTraceCell("Deneme No", String(id.attempt ?? "0")));
  idSection.appendChild(idGrid);
  body.appendChild(idSection);

  const tokSection = element("div", "trace-section");
  tokSection.appendChild(element("h3", "trace-section-title", "2. Token Kullanımı ve Maliyet Ledgeri"));
  const tokGrid = element("div", "trace-grid");
  tokGrid.appendChild(createTraceCell("Input Tokens", usg.inputTokens !== null ? formatNumber(usg.inputTokens) : "Usage unavailable"));
  tokGrid.appendChild(createTraceCell("Output Tokens", usg.outputTokens !== null ? formatNumber(usg.outputTokens) : "Usage unavailable"));
  tokGrid.appendChild(createTraceCell("Cached Input Tokens", usg.cachedInputTokens !== null ? formatNumber(usg.cachedInputTokens) : "—"));
  tokGrid.appendChild(createTraceCell("Toplam Token", usg.totalTokens !== null ? formatNumber(usg.totalTokens) : "Usage unavailable"));
  tokGrid.appendChild(createTraceCell("Hesaplanan Maliyet", data.cost ? `$${data.cost.amount || 0}` : "Cost unavailable"));
  tokSection.appendChild(tokGrid);
  body.appendChild(tokSection);

  const timeSection = element("div", "trace-section");
  timeSection.appendChild(element("h3", "trace-section-title", "3. Yürütme Süreleri"));
  const timeGrid = element("div", "trace-grid");
  timeGrid.appendChild(createTraceCell("Kuyruk Süresi", tm.queuedDurationMs !== null && tm.queuedDurationMs !== undefined ? formatDurationMs(tm.queuedDurationMs) : "—"));
  timeGrid.appendChild(createTraceCell("Çalışma Süresi", tm.executionDurationMs !== null && tm.executionDurationMs !== undefined ? formatDurationMs(tm.executionDurationMs) : (tm.durationMs !== null ? formatDurationMs(tm.durationMs) : "Duration unavailable")));
  timeSection.appendChild(timeGrid);
  body.appendChild(timeSection);

  if (ci && (ci.symbolResolutions || ci.referencesFound)) {
    const ciSection = element("div", "trace-section");
    ciSection.appendChild(element("h3", "trace-section-title", "4. Code Intelligence Metrikleri"));
    const ciGrid = element("div", "trace-grid");
    ciGrid.appendChild(createTraceCell("Sembol Çözümlemeleri", String(ci.symbolResolutions || 0)));
    ciGrid.appendChild(createTraceCell("Referanslar", String(ci.referencesFound || 0)));
    ciSection.appendChild(ciGrid);
    body.appendChild(ciSection);
  }

  const evSection = element("div", "trace-section");
  evSection.appendChild(element("h3", "trace-section-title", "5. Sıralı Telemetri Olayları"));
  if (events.length === 0) {
    evSection.appendChild(element("p", "empty-text", "Olay kaydı yok."));
  } else {
    const list = element("div", "trace-timeline");
    events.forEach(ev => {
      const step = element("div", "timeline-step");
      const dot = element("span", `timeline-dot ${ev.stage || "progress"}`);
      const content = element("div", "timeline-content");
      content.appendChild(element("small", null, `${formatTime(ev.timestamp || ev.createdAt)} · Seq ${ev.sequence ?? 0}`));
      content.appendChild(element("strong", null, `${ev.stage || "event"} (${ev.status || "ok"})`));
      if (ev.usage && ev.usage.available) {
        content.appendChild(element("span", null, ` — ${formatNumber(ev.usage.totalTokens)} tokens`));
      }
      step.appendChild(dot);
      step.appendChild(content);
      list.appendChild(step);
    });
    evSection.appendChild(list);
  }
  body.appendChild(evSection);
}

// Agent Management View
function renderAgentRegistry() {
  const host = getElem("agent-definitions");
  const usageEl = getElem("usage-events");
  if (!host) return;
  host.innerHTML = "";

  if (typeof document !== "undefined") {
    document.querySelectorAll(".agent-filters .agent-filter-btn").forEach(btn => {
      const active = btn.dataset.agentFilter === state.currentAgentFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  const definitions = state.snapshot?.agentDefinitions || [];
  const filtered = definitions.filter(agent => {
    if (state.currentAgentFilter === "all") return true;
    return agent.status === state.currentAgentFilter;
  });
  const usageEvents = state.snapshot?.usageEvents || [];

  if (filtered.length === 0) {
    host.appendChild(element("div", "empty-state", "Kayıtlı agent bulunamadı."));
  } else {
    const tableWrap = element("div", "table-wrap agent-table-wrap");
    const table = element("table");
    table.setAttribute("aria-label", "Agent kayıtları");
    const head = element("thead");
    head.innerHTML = "<tr><th>Agent</th><th>Rol</th><th>Sürüm</th><th>Durum</th><th>Executor</th><th>Reviewer</th><th>Son aktivite</th><th></th></tr>";
    const body = element("tbody");
    filtered.forEach(agent => body.appendChild(createAgentTableRow(agent, usageEvents)));
    table.append(head, body);
    tableWrap.appendChild(table);
    host.appendChild(tableWrap);
  }

  if (usageEl) {
    usageEl.innerHTML = "";
    const events = usageEvents.slice(0, 8);
    if (events.length === 0) {
      usageEl.appendChild(element("p", "empty-text", "Henüz kullanım telemetrisi kaydedilmedi."));
    } else {
      events.forEach(event => {
        const row = element("div", "usage-item");
        const identity = event.agentId || event.taskAgent || "agent";
        row.appendChild(element("strong", null, identity + " · " + (event.provider || "—") + "/" + (event.model || "—")));
        let tokenText = "usage unavailable";
        if (event.inputTokens !== undefined && event.inputTokens !== null && event.outputTokens !== undefined && event.outputTokens !== null) {
          tokenText = formatNumber(event.inputTokens) + " in / " + formatNumber(event.outputTokens) + " out (" + formatNumber(event.inputTokens + event.outputTokens) + " tot)";
        } else if (event.inputTokens !== undefined && event.inputTokens !== null) {
          tokenText = formatNumber(event.inputTokens) + " in";
        } else if (event.outputTokens !== undefined && event.outputTokens !== null) {
          tokenText = formatNumber(event.outputTokens) + " out";
        }
        const duration = event.durationMs === null || event.durationMs === undefined ? "—" : formatDurationMs(event.durationMs);
        row.appendChild(element("span", null, tokenText + " · Süre " + duration + " · " + formatTime(event.createdAt)));
        usageEl.appendChild(row);
      });
    }
  }
}

function createAgentTableRow(agent, usageEvents) {
  const row = element("tr", "work-table-row");
  row.tabIndex = 0;
  const latestUsage = usageEvents.find(event => event.agentId === agent.id || event.taskAgent === agent.id);
  const executor = agent.executor || {};
  const executorProvider = executor.provider || agent.executorProvider || "—";
  const executorModel = executor.model || agent.executorModel || "—";
  const executorProfile = executor.modelProfile || agent.executorModelProfile || agent.modelProfile || "—";
  const executorText = executorProvider + " / " + executorModel + " · " + executorProfile;
  const reviewer = (agent.reviewer && typeof agent.reviewer === "object" ? (agent.reviewer.agentId || agent.reviewer.name) : agent.reviewer) || agent.reviewerAssignment || agent.reviewerAgent || "—";
  const openDetail = () => openAgentDetailDrawer(agent, row);
  row.addEventListener?.("click", openDetail);
  row.addEventListener?.("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetail();
    }
  });
  appendTableTextCell(row, agent.displayName || agent.id, "agent-name-cell");
  appendTableTextCell(row, agent.role || "—");
  appendTableTextCell(row, "v" + (agent.version || agent.currentVersion || 1));
  appendTableTextCell(row, (agent.status || "enabled").toUpperCase());
  appendTableTextCell(row, executorText);
  appendTableTextCell(row, reviewer);
  appendTableTextCell(row, latestUsage ? formatTime(latestUsage.createdAt) : "—");
  const actions = element("td");
  const detail = element("button", "pm-btn pm-btn-view", "Detay");
  detail.type = "button";
  detail.addEventListener?.("click", event => { event.stopPropagation(); openDetail(); });
  actions.appendChild(detail);
  row.appendChild(actions);
  return row;
}

function openAgentDetailDrawer(agent, triggerBtn = null) {
  const pill = getElem("agent-detail-pill");
  const title = getElem("agent-detail-title");
  const summary = getElem("agent-detail-summary");
  const body = getElem("agent-detail-body");
  if (!body) return;
  if (pill) pill.textContent = agent.id || "—";
  if (title) title.textContent = (agent.displayName || agent.id || "Agent") + " · Detay";
  if (summary) summary.textContent = "Sabitlenmiş sürüm ve çalışma yapılandırması";
  body.innerHTML = "";

  const executor = agent.executor || {};
  const reviewer = agent.reviewer && typeof agent.reviewer === "object" ? agent.reviewer : { agentId: agent.reviewer || agent.reviewerAssignment || agent.reviewerAgent };
  const sections = [
    ["Kimlik", [["Rol", agent.role], ["Sürüm", "v" + (agent.version || agent.currentVersion || 1)], ["Durum", agent.status || "enabled"], ["Risk", agent.risk || "normal"]]],
    ["Yürütme", [["Provider", executor.provider || agent.executorProvider], ["Model", executor.model || agent.executorModel], ["Profil", executor.modelProfile || agent.executorModelProfile || agent.modelProfile], ["Eşzamanlılık", agent.maxConcurrency || 1]]],
    ["Review yapılandırması", [["Reviewer", reviewer.agentId || reviewer.name || "—"], ["Reviewer sürümü", reviewer.version || "—"], ["Reviewer hash", reviewer.hash || "—"]]],
    ["Kapsam", [["Beceriler", Array.isArray(agent.skills) ? agent.skills.join(", ") : "—"], ["İzinli yollar", Array.isArray(agent.allowedPaths) ? agent.allowedPaths.join(", ") : "—"], ["Definition hash", agent.definitionHash || "—"]]]
  ];
  sections.forEach(([heading, cells]) => {
    const section = element("section", "trace-section");
    section.appendChild(element("h3", "trace-section-title", heading));
    const grid = element("div", "trace-grid");
    cells.forEach(([label, value]) => grid.appendChild(createTraceCell(label, value)));
    section.appendChild(grid);
    body.appendChild(section);
  });

  const actions = element("div", "drawer-actions");
  const edit = element("button", "pm-btn pm-btn-view", "Yeni sürüm düzenle");
  edit.type = "button";
  edit.addEventListener?.("click", () => openAgentEditModal(agent, edit));
  const versions = element("button", "pm-btn pm-btn-view", "Sürüm geçmişi");
  versions.type = "button";
  versions.addEventListener?.("click", () => openAgentVersionsDrawer(agent.id, versions));
  actions.append(edit, versions);
  body.appendChild(actions);
  openModal("agent-detail-drawer", triggerBtn);
}

function createAgentCard(agent) {
  const card = element("div", `agent-def-card status-${agent.status || "enabled"}`);
  card.dataset = card.dataset || {};
  card.dataset.agentId = agent.id;

  const top = element("div", "agent-def-top");
  const titleBox = element("div", null);
  titleBox.appendChild(element("strong", "agent-def-name", agent.displayName || agent.id));
  titleBox.appendChild(element("span", "code-cell", ` (${agent.id}) v${agent.version || agent.currentVersion || 1}`));
  const badge = element("span", `badge badge-${agent.status || "enabled"}`, (agent.status || "enabled").toUpperCase());
  top.appendChild(titleBox);
  top.appendChild(badge);

  const executor = agent.executor || {};
  const executorProvider = executor.provider || agent.executorProvider;
  const executorModel = executor.model || agent.executorModel;
  const executorModelProfile = executor.modelProfile || agent.executorModelProfile || agent.modelProfile;
  const reviewer = (agent.reviewer && typeof agent.reviewer === "object" ? (agent.reviewer.agentId || agent.reviewer.name) : agent.reviewer) || agent.reviewerAssignment || agent.reviewerAgent;

  const meta = element("div", "agent-def-meta");
  meta.appendChild(createTraceCell("Rol", agent.role));
  meta.appendChild(createTraceCell("Default Persona", agent.defaultPersona || "—"));
  meta.appendChild(createTraceCell("Skills", Array.isArray(agent.skills) ? agent.skills.join(", ") : "—"));
  meta.appendChild(createTraceCell("Allowed Paths", Array.isArray(agent.allowedPaths) ? agent.allowedPaths.join(", ") : "—"));
  meta.appendChild(createTraceCell("Risk", agent.risk || "normal"));
  meta.appendChild(createTraceCell("Max Concurrency", String(agent.maxConcurrency || 1)));
  meta.appendChild(createTraceCell("Executor Provider", executorProvider || "—"));
  meta.appendChild(createTraceCell("Executor Model", executorModel || "—"));
  meta.appendChild(createTraceCell("Model Profile", executorModelProfile || "—"));
  meta.appendChild(createTraceCell("Reviewer", reviewer ? String(reviewer) : "—"));
  if (agent.definitionHash) {
    meta.appendChild(createTraceCell("Definition Hash", agent.definitionHash.slice(0, 12) + "..."));
  }

  const actions = element("div", "agent-def-actions");
  const editBtn = element("button", "pm-btn pm-btn-view", "✏️ Düzenle (v+1)");
  editBtn.type = "button";
  if (typeof editBtn.addEventListener === "function") {
    editBtn.addEventListener("click", () => {
      openAgentEditModal(agent, editBtn);
    });
  }
  actions.appendChild(editBtn);

  const verBtn = element("button", "pm-btn pm-btn-view", "📜 Versiyonlar");
  verBtn.type = "button";
  if (typeof verBtn.addEventListener === "function") {
    verBtn.addEventListener("click", () => {
      openAgentVersionsDrawer(agent.id, verBtn);
    });
  }
  actions.appendChild(verBtn);

  if (agent.status === "enabled") {
    const disBtn = element("button", "pm-btn pm-btn-reject", "Devre Dışı Bırak");
    disBtn.type = "button";
    if (typeof disBtn.addEventListener === "function") {
      disBtn.addEventListener("click", () => updateAgentStatus(agent.id, "disabled"));
    }
    actions.appendChild(disBtn);
  } else if (agent.status === "disabled") {
    const enBtn = element("button", "pm-btn pm-btn-approve", "Etkinleştir");
    enBtn.type = "button";
    if (typeof enBtn.addEventListener === "function") {
      enBtn.addEventListener("click", () => updateAgentStatus(agent.id, "enabled"));
    }
    actions.appendChild(enBtn);

    const archBtn = element("button", "pm-btn pm-btn-reject", "Arşivle");
    archBtn.type = "button";
    if (typeof archBtn.addEventListener === "function") {
      archBtn.addEventListener("click", () => updateAgentStatus(agent.id, "archived"));
    }
    actions.appendChild(archBtn);
  } else if (agent.status === "archived") {
    const enBtn = element("button", "pm-btn pm-btn-approve", "Yeniden Etkinleştir");
    enBtn.type = "button";
    if (typeof enBtn.addEventListener === "function") {
      enBtn.addEventListener("click", () => updateAgentStatus(agent.id, "enabled"));
    }
    actions.appendChild(enBtn);
  }

  card.appendChild(top);
  card.appendChild(meta);
  card.appendChild(actions);
  return card;
}

async function updateAgentStatus(agentId, newStatus) {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchSnapshot();
  } catch (err) {
    alert(`Agent durumu güncellenemedi: ${err.message}`);
  }
}

async function openAgentVersionsDrawer(agentId, triggerBtn = null) {
  const modal = getElem("agent-versions-drawer");
  const pill = getElem("agent-ver-pill");
  const title = getElem("agent-ver-title");
  const summaryEl = getElem("agent-ver-summary");
  const body = getElem("agent-ver-drawer-body");

  if (!modal || !body) return;

  if (pill) pill.textContent = agentId;
  if (title) title.textContent = `Agent Versiyon Geçmişi · ${agentId}`;
  if (summaryEl) summaryEl.textContent = "Versiyonlar yükleniyor...";
  body.innerHTML = '<div class="loading-spinner">Yükleniyor...</div>';

  openModal("agent-versions-drawer", triggerBtn);

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/versions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const versions = Array.isArray(data) ? data : (data.versions || []);

    body.innerHTML = "";
    if (summaryEl) summaryEl.textContent = `Toplam ${versions.length} immutable versiyon`;

    if (versions.length === 0) {
      body.appendChild(element("p", "empty-text", "Versiyon bulunamadı."));
      return;
    }

    versions.forEach(v => {
      const item = element("div", "version-card");
      const hdr = element("div", "version-header");
      hdr.appendChild(element("strong", null, `v${v.version}`));
      hdr.appendChild(element("small", null, formatTime(v.createdAt, true)));
      item.appendChild(hdr);

      const grid = element("div", "version-grid");
      grid.appendChild(createTraceCell("Definition Hash", v.definitionHash ? v.definitionHash.slice(0, 16) + "..." : "—"));
      grid.appendChild(createTraceCell("Rol", v.definition?.role || "—"));
      grid.appendChild(createTraceCell("Default Persona", v.definition?.defaultPersona || "—"));
      grid.appendChild(createTraceCell("Skills", Array.isArray(v.definition?.skills) ? v.definition.skills.join(", ") : "—"));
      grid.appendChild(createTraceCell("Allowed Paths", Array.isArray(v.definition?.allowedPaths) ? v.definition.allowedPaths.join(", ") : "—"));
      item.appendChild(grid);
      body.appendChild(item);
    });
  } catch (err) {
    body.innerHTML = `<div class="error-banner">Versiyonlar yüklenemedi: ${safeHtml(err.message)}</div>`;
  }
}

function openAgentEditModal(agent, triggerBtn = null) {
  const idInput = getElem("edit-agent-id");
  const nameInput = getElem("edit-agent-name");
  const roleSelect = getElem("edit-agent-role");
  const skillsInput = getElem("edit-agent-skills");
  const pathsInput = getElem("edit-agent-paths");
  const riskSelect = getElem("edit-agent-risk");
  const concInput = getElem("edit-agent-max-concurrency");
  const statusEl = getElem("agent-edit-status");

  if (idInput) idInput.value = agent.id;
  if (nameInput) nameInput.value = agent.displayName || agent.id;
  if (roleSelect) roleSelect.value = agent.role || "implementation";
  if (skillsInput) skillsInput.value = Array.isArray(agent.skills) ? agent.skills.join(", ") : "";
  if (pathsInput) pathsInput.value = Array.isArray(agent.allowedPaths) ? agent.allowedPaths.join(", ") : "";
  if (riskSelect) riskSelect.value = agent.risk || "normal";
  if (concInput) concInput.value = agent.maxConcurrency || 2;
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }

  openModal("agent-edit-modal", triggerBtn);
}

async function submitAgentEdit() {
  const idInput = getElem("edit-agent-id");
  const nameInput = getElem("edit-agent-name");
  const roleSelect = getElem("edit-agent-role");
  const skillsInput = getElem("edit-agent-skills");
  const pathsInput = getElem("edit-agent-paths");
  const riskSelect = getElem("edit-agent-risk");
  const concInput = getElem("edit-agent-max-concurrency");
  const statusEl = getElem("agent-edit-status");
  const submitBtn = getElem("agent-edit-submit-btn");

  const id = idInput ? idInput.value : "";
  if (!id) return;

  if (submitBtn) submitBtn.disabled = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "modal-status-msg is-loading";
    statusEl.textContent = "Yeni versiyon kaydediliyor...";
  }

  const payload = {
    displayName: nameInput ? nameInput.value.trim() : id,
    role: roleSelect ? roleSelect.value : "implementation",
    skills: skillsInput ? skillsInput.value.split(",").map(s => s.trim()).filter(Boolean) : [],
    allowedPaths: pathsInput ? pathsInput.value.split(",").map(p => p.trim()).filter(Boolean) : [],
    risk: riskSelect ? riskSelect.value : "normal",
    maxConcurrency: concInput ? Number(concInput.value) || 1 : 1
  };

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    if (statusEl) {
      statusEl.className = "modal-status-msg is-success";
      statusEl.textContent = "✓ Yeni immutable versiyon (v+1) başarıyla oluşturuldu.";
    }

    setTimeout(() => {
      closeModal("agent-edit-modal");
      fetchSnapshot();
    }, 700);
  } catch (err) {
    if (statusEl) {
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = `Hata: ${err.message}`;
    }
    if (submitBtn) submitBtn.disabled = false;
  }
}

function openAgentCreateModal(triggerBtn = null) {
  const form = getElem("agent-create-form");
  if (form && typeof form.reset === "function") form.reset();
  const statusEl = getElem("agent-create-status");
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }
  const submitBtn = getElem("agent-create-submit-btn");
  if (submitBtn) submitBtn.disabled = false;

  openModal("agent-create-modal", triggerBtn);
}

async function submitAgentCreate() {
  const idInput = getElem("create-agent-id");
  const nameInput = getElem("create-agent-name");
  const roleSelect = getElem("create-agent-role");
  const skillsInput = getElem("create-agent-skills");
  const pathsInput = getElem("create-agent-paths");
  const riskSelect = getElem("create-agent-risk");
  const concInput = getElem("create-agent-max-concurrency");
  const statusEl = getElem("agent-create-status");
  const submitBtn = getElem("agent-create-submit-btn");

  const id = idInput ? idInput.value.trim() : "";
  const name = nameInput ? nameInput.value.trim() : "";
  if (!id || !name) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = "Agent ID ve Görünen İsim zorunludur.";
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "modal-status-msg is-loading";
    statusEl.textContent = "Agent tanımlanıyor...";
  }

  const payload = {
    id,
    displayName: name,
    role: roleSelect ? roleSelect.value : "implementation",
    defaultPersona: "backend-engineer",
    skills: skillsInput ? skillsInput.value.split(",").map(s => s.trim()).filter(Boolean) : [],
    allowedPaths: pathsInput ? pathsInput.value.split(",").map(p => p.trim()).filter(Boolean) : [],
    risk: riskSelect ? riskSelect.value : "normal",
    maxConcurrency: concInput ? Number(concInput.value) || 1 : 1
  };

  try {
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    if (statusEl) {
      statusEl.className = "modal-status-msg is-success";
      statusEl.textContent = "✓ Agent başarıyla tanımlandı.";
    }

    setTimeout(() => {
      closeModal("agent-create-modal");
      fetchSnapshot();
    }, 700);
  } catch (err) {
    if (statusEl) {
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = `Hata: ${err.message}`;
    }
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Provider Configuration View
function renderConfigView(data) {
  const mutationBadge = getElem("config-mutation-badge");
  const isMutable = Boolean(data.config?.mutationEnabled);
  if (mutationBadge) {
    mutationBadge.textContent = isMutable ? "Yapılandırılabilir" : "Salt okunur";
    mutationBadge.className = isMutable ? "badge badge-enabled" : "read-only-badge";
  }

  const host = typeof document === "undefined" ? null : document.querySelector(".config-providers-grid");
  if (!host) return;
  host.innerHTML = "";
  const providers = data.providers || {};
  const selections = data.config?.selections || {};
  const mutableFields = data.config?.mutableFields || [];
  const categories = [
    ["İş kaynağı", "workSource", providers.workSources || []],
    ["Orkestratör", "orchestrator", providers.orchestrators || []],
    ["Executor", "executor", providers.executors || []],
    ["Kod zekâsı", "codeIntelligence", providers.codeIntelligence || []],
    ["Kaynak kontrol", "sourceControl", providers.sourceControl || []]
  ];
  const rows = categories.flatMap(([category, fieldName, list]) => (Array.isArray(list) ? list : []).map(provider => ({
    category,
    fieldName,
    provider,
    selected: (typeof provider === "object" && provider.selected === true) || (typeof provider === "string" ? provider : provider.id || provider.name || provider.provider) === selections[fieldName],
    canMutate: isMutable && mutableFields.includes(fieldName) && fieldName !== "sourceControl"
  })));

  if (rows.length === 0) {
    host.appendChild(element("div", "empty-state", "Sağlayıcı bilgisi bulunamadı."));
    return;
  }

  const wrap = element("div", "panel table-wrap provider-table-wrap");
  const table = element("table");
  table.setAttribute("aria-label", "Sağlayıcı yapılandırması");
  const head = element("thead");
  head.innerHTML = "<tr><th>Sağlayıcı</th><th>Tip</th><th>Seçili</th><th>Durum</th><th>Model / profil</th><th>Değişiklik</th><th></th></tr>";
  const body = element("tbody");
  rows.forEach(info => body.appendChild(createProviderTableRow(info)));
  table.append(head, body);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

const PROVIDER_CONNECTION_STATUS_LABELS = {
  connected: "Bağlı",
  configured: "Yapılandırıldı",
  installed: "Kurulu",
  selected: "Seçili",
  not_running: "Çalışmıyor",
  no_models: "Model yok",
  not_authenticated: "Oturum gerekli",
  not_installed: "Kurulu değil",
  not_configured: "Bağlı değil"
};

const TOKEN_PROVIDER_IDS = new Set(["github", "notion", "linear"]);
const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio"]);

function localEndpointNeedsTrust(endpoint) {
  try {
    const host = new URL(String(endpoint || "")).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return !(host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127."));
  } catch {
    return true;
  }
}

function populateLocalModelOptions(models, selectedModel = "") {
  const select = getElem("local-model-select");
  if (!select) return;
  select.replaceChildren();
  (models || []).forEach(model => {
    const option = element("option", null, model);
    option.value = model;
    select.appendChild(option);
  });
  select.value = selectedModel || models?.[0] || "";
  select.disabled = !models?.length;
}

function syncLocalEndpointApproval(clearModels = false) {
  const endpoint = getElem("local-endpoint-input")?.value;
  const trustRow = getElem("local-endpoint-trust-row");
  const trust = getElem("local-endpoint-trust-input");
  const remote = localEndpointNeedsTrust(endpoint);
  if (trustRow) trustRow.hidden = !remote;
  if (trust && (!remote || clearModels)) trust.checked = false;
  if (clearModels) {
    populateLocalModelOptions([]);
    const connect = getElem("provider-connection-connect-btn");
    if (connect && LOCAL_PROVIDER_IDS.has(state.activeProviderConnectionId)) connect.disabled = true;
  }
}

function providerConnectionCategory(connection) {
  if (connection.category) return connection.category;
  return connection.kind === "work-source" ? "work-tools" : "ai-tools";
}

function setProviderConnectionCategory(category) {
  if (!["work-tools", "ai-tools", "local-ai"].includes(category)) return;
  state.activeProviderConnectionCategory = category;
  document.querySelectorAll?.("[data-provider-category]").forEach(button => {
    const active = button.dataset.providerCategory === category;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderProviderConnections(state.providerConnections || { connections: [] });
}

function renderProviderConnections(data) {
  state.providerConnections = data || { connections: [] };
  const host = getElem("provider-connections-grid");
  const security = getElem("provider-connections-security");
  if (security) {
    security.textContent = data?.secureStore?.supported ? "Windows güvenli kasa" : "Ortam değişkenleri";
    security.className = data?.secureStore?.supported ? "badge badge-enabled" : "badge";
  }
  if (!host) return;
  host.innerHTML = "";
  const connections = (Array.isArray(data?.connections) ? data.connections : [])
    .filter(connection => providerConnectionCategory(connection) === state.activeProviderConnectionCategory);
  if (connections.length === 0) {
    host.appendChild(element("div", "empty-state", "Bağlantı bilgisi bulunamadı."));
    return;
  }
  connections.forEach(connection => {
    const card = element("article", `provider-connection-card status-${connection.status || "unknown"}`);
    const header = element("div", "provider-connection-card-header");
    const identity = element("div", "provider-connection-identity");
    identity.appendChild(element("strong", null, connection.displayName || connection.id));
    const kindLabel = connection.kind === "work-source"
      ? "İş kaynağı"
      : connection.kind === "integration"
        ? "Bağlantı"
        : connection.category === "local-ai"
          ? "Yerel yürütücü"
          : "AI yürütme aracı";
    identity.appendChild(element("span", "provider-connection-kind", kindLabel));
    const badge = element("span", `provider-connection-status status-${connection.status || "unknown"}`, PROVIDER_CONNECTION_STATUS_LABELS[connection.status] || "Bilinmiyor");
    header.append(identity, badge);
    card.appendChild(header);
    card.appendChild(element("p", "provider-connection-copy", connection.guidance || "Bağlantı durumunu kontrol edin."));
    const meta = element("div", "provider-connection-meta");
    if (connection.site) meta.appendChild(element("span", null, connection.site));
    if (connection.credentialSource) {
      meta.appendChild(element("span", null, connection.credentialSource === "environment" ? "Ortam değişkenleri" : "Güvenli kasa"));
    }
    if (connection.selected) meta.appendChild(element("span", "badge badge-key", "Seçili"));
    if (connection.selectedModel) meta.appendChild(element("span", null, connection.selectedModel));
    if (connection.endpoint) meta.appendChild(element("span", null, connection.endpoint));
    if (connection.remote) meta.appendChild(element("span", "badge", "Özel ağ sunucusu"));
    if (connection.runtimeAvailable === false) meta.appendChild(element("span", "badge", "Bağlantı katmanı"));
    card.appendChild(meta);
    const actions = element("div", "provider-connection-card-actions");
    const manage = element("button", "pm-btn pm-btn-view", connection.status === "connected" ? "Detay" : "Bağlantıyı Aç");
    manage.type = "button";
    manage.addEventListener?.("click", () => openProviderConnectionDrawer(connection, manage));
    actions.appendChild(manage);
    const test = element("button", "pm-btn pm-btn-approve", "Test Et");
    test.type = "button";
    const credentialRequired = connection.id === "jira" || TOKEN_PROVIDER_IDS.has(connection.id);
    test.disabled = (!LOCAL_PROVIDER_IDS.has(connection.id) && connection.installed === false && !connection.connected) || (credentialRequired && !connection.configured);
    test.addEventListener?.("click", () => {
      openProviderConnectionDrawer(connection, test);
      testProviderConnection(connection.id, test);
    });
    actions.appendChild(test);
    card.appendChild(actions);
    host.appendChild(card);
  });
}

function setProviderConnectionMessage(kind, message) {
  const status = getElem("provider-connection-status");
  if (!status) return;
  status.hidden = false;
  status.className = `modal-status-msg is-${kind}`;
  status.textContent = message;
}

function clearProviderConnectionSecret() {
  ["jira-token-input", "provider-token-input"].forEach(id => {
    const token = getElem(id);
    if (token) token.value = "";
  });
}

function openProviderConnectionDrawer(connection, trigger = null) {
  state.activeProviderConnectionId = connection.id;
  const mutationEnabled = Boolean(state.providerConnections?.mutationEnabled);
  const pill = getElem("provider-connection-pill");
  const title = getElem("provider-connection-title");
  const summary = getElem("provider-connection-summary");
  const guidance = getElem("provider-connection-guidance");
  const jiraFields = getElem("jira-connection-fields");
  const tokenFields = getElem("token-connection-fields");
  const localFields = getElem("local-model-fields");
  const form = getElem("provider-connection-form");
  const connect = getElem("provider-connection-connect-btn");
  const test = getElem("provider-connection-test-btn");
  const select = getElem("provider-connection-select-btn");
  const disconnect = getElem("provider-connection-disconnect-btn");
  const status = getElem("provider-connection-status");
  if (pill) pill.textContent = connection.displayName || connection.id;
  if (title) title.textContent = `${connection.displayName || connection.id} bağlantısı`;
  if (summary) summary.textContent = PROVIDER_CONNECTION_STATUS_LABELS[connection.status] || "Bağlantı durumu bilinmiyor";
  if (guidance) guidance.textContent = connection.guidance || "Bağlantı durumunu test edin.";
  if (jiraFields) jiraFields.hidden = connection.id !== "jira";
  if (tokenFields) tokenFields.hidden = !TOKEN_PROVIDER_IDS.has(connection.id);
  if (localFields) localFields.hidden = !LOCAL_PROVIDER_IDS.has(connection.id);
  if (form) form.dataset.providerId = connection.id;
  if (status) status.hidden = true;
  const site = getElem("jira-site-input");
  const email = getElem("jira-email-input");
  if (site) site.value = connection.site || "";
  if (email) email.value = "";
  const tokenLabel = getElem("provider-token-label");
  if (tokenLabel) tokenLabel.textContent = `${connection.displayName || connection.id} API token`;
  const endpointInput = getElem("local-endpoint-input");
  if (endpointInput) endpointInput.value = connection.endpoint || "";
  const trustInput = getElem("local-endpoint-trust-input");
  if (trustInput) trustInput.checked = connection.remoteEndpointApproved === true;
  populateLocalModelOptions(connection.models || [], connection.selectedModel);
  syncLocalEndpointApproval(false);
  const endpoint = getElem("local-model-endpoint");
  if (endpoint) endpoint.textContent = connection.endpoint
    ? `Yerel sunucu: ${connection.endpoint}`
    : "Yerel sunucu adresi otomatik algılanır.";
  clearProviderConnectionSecret();
  const canStartLogin = connection.id === "jira" || TOKEN_PROVIDER_IDS.has(connection.id) || LOCAL_PROVIDER_IDS.has(connection.id)
    ? connection.canConnect
    : connection.loginSupported;
  if (connect) {
    connect.hidden = !canStartLogin;
    connect.disabled = !mutationEnabled || (LOCAL_PROVIDER_IDS.has(connection.id) && !(connection.models || []).length) || (!LOCAL_PROVIDER_IDS.has(connection.id) && connection.installed === false && !connection.connected);
    connect.textContent = connection.id === "codex"
      ? "Codex Girişini Aç"
      : LOCAL_PROVIDER_IDS.has(connection.id)
        ? "Modeli Kaydet"
        : "Bağlan ve Güvenli Kaydet";
  }
  const credentialRequired = connection.id === "jira" || TOKEN_PROVIDER_IDS.has(connection.id);
  if (test) {
    test.disabled = (!LOCAL_PROVIDER_IDS.has(connection.id) && connection.installed === false && !connection.connected) || (credentialRequired && !connection.configured);
    test.textContent = LOCAL_PROVIDER_IDS.has(connection.id) ? "Modelleri Getir" : "Test Et";
  }
  if (select) {
    select.hidden = !LOCAL_PROVIDER_IDS.has(connection.id) || connection.selected || !connection.canSelect;
    select.disabled = !mutationEnabled;
  }
  if (disconnect) {
    disconnect.hidden = !((connection.id === "jira" || TOKEN_PROVIDER_IDS.has(connection.id)) && connection.credentialSource === "vault");
    disconnect.disabled = !mutationEnabled;
  }
  if (!mutationEnabled && canStartLogin && guidance) {
    guidance.textContent += " Bu dashboard için bağlantı değişiklikleri kapalı.";
  }
  openModal("provider-connection-drawer", trigger);
}

function closeProviderConnectionDrawer() {
  clearProviderConnectionSecret();
  state.activeProviderConnectionId = null;
  closeModal("provider-connection-drawer");
}

async function fetchProviderConnections() {
  if (state.providerConnectionsLoading) return;
  state.providerConnectionsLoading = true;
  try {
    const response = await fetch("/api/provider-connections");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderProviderConnections(data);
  } catch (error) {
    const host = getElem("provider-connections-grid");
    if (host) {
      host.innerHTML = "";
      host.appendChild(element("div", "empty-state", `Bağlantı durumları alınamadı: ${error.message}`));
    }
  } finally {
    state.providerConnectionsLoading = false;
  }
}

async function providerConnectionRequest(id, action, payload) {
  const options = { method: action === "disconnect" ? "DELETE" : "POST" };
  const suffix = action === "disconnect" ? "" : `/${action}`;
  if (payload !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(`/api/provider-connections/${encodeURIComponent(id)}${suffix}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function submitProviderConnection(event) {
  event?.preventDefault?.();
  const id = state.activeProviderConnectionId;
  if (!id) return;
  const connect = getElem("provider-connection-connect-btn");
  if (connect) connect.disabled = true;
  setProviderConnectionMessage("loading", id === "codex" ? "Codex giriş ekranı açılıyor…" : "Bağlantı doğrulanıyor…");
  try {
    const payload = id === "jira"
      ? {
          baseUrl: getElem("jira-site-input")?.value,
          email: getElem("jira-email-input")?.value,
          token: getElem("jira-token-input")?.value
        }
      : TOKEN_PROVIDER_IDS.has(id)
        ? { token: getElem("provider-token-input")?.value }
        : LOCAL_PROVIDER_IDS.has(id)
          ? {
              endpoint: getElem("local-endpoint-input")?.value,
              model: getElem("local-model-select")?.value,
              trustRemoteEndpoint: getElem("local-endpoint-trust-input")?.checked === true
            }
          : {};
    const result = await providerConnectionRequest(id, "connect", payload);
    clearProviderConnectionSecret();
    setProviderConnectionMessage("success", result.guidance || "Bağlantı doğrulandı ve güvenli biçimde kaydedildi.");
    await fetchProviderConnections();
    const refreshed = state.providerConnections?.connections?.find(connection => connection.id === id);
    if (refreshed) {
      const test = getElem("provider-connection-test-btn");
      if (test) test.disabled = false;
      const select = getElem("provider-connection-select-btn");
      if (select) {
        select.hidden = !LOCAL_PROVIDER_IDS.has(id) || refreshed.selected || !refreshed.canSelect;
        select.disabled = !state.providerConnections?.mutationEnabled;
      }
    }
  } catch (error) {
    clearProviderConnectionSecret();
    setProviderConnectionMessage("error", `Bağlantı kurulamadı: ${error.message}`);
  } finally {
    if (connect) connect.disabled = false;
  }
}

async function testProviderConnection(id = state.activeProviderConnectionId, trigger = null) {
  if (!id) return;
  if (trigger) trigger.disabled = true;
  if (state.activeProviderConnectionId === id) setProviderConnectionMessage("loading", "Bağlantı test ediliyor…");
  try {
    const local = LOCAL_PROVIDER_IDS.has(id);
    const payload = local
      ? {
          endpoint: getElem("local-endpoint-input")?.value,
          trustRemoteEndpoint: getElem("local-endpoint-trust-input")?.checked === true
        }
      : undefined;
    const result = await providerConnectionRequest(id, "test", payload);
    if (local) {
      populateLocalModelOptions(result.models || []);
      const connect = getElem("provider-connection-connect-btn");
      if (connect) connect.disabled = !(result.models || []).length || !state.providerConnections?.mutationEnabled;
    }
    if (state.activeProviderConnectionId === id) {
      setProviderConnectionMessage("success", result.guidance || (local ? `${(result.models || []).length} model bulundu.` : (result.status === "installed" ? "Araç kurulu ve çalıştırılabilir." : "Bağlantı hazır ve kullanılabilir.")));
    }
    if (!local) await fetchProviderConnections();
  } catch (error) {
    if (state.activeProviderConnectionId === id) setProviderConnectionMessage("error", `Test başarısız: ${error.message}`);
  } finally {
    if (trigger) trigger.disabled = false;
  }
}

async function disconnectProviderConnection() {
  const id = state.activeProviderConnectionId;
  if (!id || !confirm("Dashboard tarafından güvenli kasada tutulan bu bağlantı kaldırılsın mı?")) return;
  const button = getElem("provider-connection-disconnect-btn");
  if (button) button.disabled = true;
  setProviderConnectionMessage("loading", "Bağlantı kaldırılıyor…");
  try {
    await providerConnectionRequest(id, "disconnect");
    setProviderConnectionMessage("success", "Güvenli kasadaki bağlantı kaldırıldı.");
    await fetchProviderConnections();
  } catch (error) {
    setProviderConnectionMessage("error", `Bağlantı kaldırılamadı: ${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function selectProviderConnection() {
  const id = state.activeProviderConnectionId;
  if (!id || !LOCAL_PROVIDER_IDS.has(id)) return;
  const button = getElem("provider-connection-select-btn");
  if (button) button.disabled = true;
  setProviderConnectionMessage("loading", "Yerel model yürütücü olarak seçiliyor…");
  try {
    const result = await providerConnectionRequest(id, "select");
    setProviderConnectionMessage("success", `${result.model || id} gelecek çalıştırmalar için seçildi.`);
    await fetchProviderConnections();
    if (button) button.hidden = true;
  } catch (error) {
    setProviderConnectionMessage("error", `Yürütücü seçilemedi: ${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function providerName(provider) {
  return typeof provider === "string" ? provider : provider.id || provider.name || provider.provider || "—";
}

function createProviderTableRow(info) {
  const provider = info.provider;
  const object = typeof provider === "object" ? provider : {};
  const row = element("tr", "work-table-row");
  row.tabIndex = 0;
  const openDetail = () => openProviderDetailDrawer(info, row);
  row.addEventListener?.("click", openDetail);
  row.addEventListener?.("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetail();
    }
  });
  appendTableTextCell(row, providerName(provider), "code-cell");
  appendTableTextCell(row, info.category);
  appendTableTextCell(row, info.selected ? "Evet" : "—");
  appendTableTextCell(row, object.enabled === false ? "Devre dışı" : (object.health || object.status || "Kullanılabilir"));
  appendTableTextCell(row, object.model || object.modelProfile || object.profile || "—");
  appendTableTextCell(row, info.canMutate ? "Değiştirilebilir" : "Salt okunur");
  const actions = element("td");
  const detail = element("button", "pm-btn pm-btn-view", "Detay");
  detail.type = "button";
  detail.addEventListener?.("click", event => { event.stopPropagation(); openDetail(); });
  actions.appendChild(detail);
  if (info.canMutate && !info.selected && object.enabled !== false) {
    const select = element("button", "pm-btn pm-btn-approve", "Seç");
    select.type = "button";
    select.addEventListener?.("click", event => {
      event.stopPropagation();
      updateProviderSelection(info.fieldName, providerName(provider));
    });
    actions.appendChild(select);
  }
  row.appendChild(actions);
  return row;
}

function openProviderDetailDrawer(info, triggerBtn = null) {
  const provider = info.provider;
  const object = typeof provider === "object" ? provider : {};
  const name = providerName(provider);
  const pill = getElem("provider-detail-pill");
  const title = getElem("provider-detail-title");
  const summary = getElem("provider-detail-summary");
  const body = getElem("provider-detail-body");
  if (!body) return;
  if (pill) pill.textContent = name;
  if (title) title.textContent = name + " · Sağlayıcı detayı";
  if (summary) summary.textContent = info.category + " · " + (info.selected ? "seçili" : "alternatif");
  body.innerHTML = "";
  const section = element("section", "trace-section");
  section.appendChild(element("h3", "trace-section-title", "Çalışma yapılandırması"));
  const grid = element("div", "trace-grid");
  [["Tip", info.category], ["Seçili", info.selected ? "Evet" : "Hayır"], ["Etkin", object.enabled === false ? "Hayır" : "Evet"], ["Sağlık", object.health || object.status || "—"], ["Model", object.model || "—"], ["Profil", object.modelProfile || object.profile || "—"], ["Değişiklik", info.canMutate ? "Uygun" : "Salt okunur"], ["Kimlik", object.id || object.name || name]].forEach(([label, value]) => grid.appendChild(createTraceCell(label, value)));
  section.appendChild(grid);
  body.appendChild(section);
  if (info.canMutate && !info.selected && object.enabled !== false) {
    const actions = element("div", "drawer-actions");
    const select = element("button", "pm-btn pm-btn-approve", "Bu sağlayıcıyı seç");
    select.type = "button";
    select.addEventListener?.("click", () => updateProviderSelection(info.fieldName, name));
    actions.appendChild(select);
    body.appendChild(actions);
  }
  openModal("provider-detail-drawer", triggerBtn);
}

function renderProviderSection(prefix, fieldName, providerList = [], selectedName, canMutate) {
  const selBadge = getElem(`cfg-${prefix}-selected`);
  const list = getElem(`cfg-${prefix}-list`);

  if (selBadge) selBadge.textContent = selectedName || "Yok";
  if (!list) return;
  list.innerHTML = "";

  if (!Array.isArray(providerList) || providerList.length === 0) {
    list.appendChild(element("div", "config-option-item", "Sağlayıcı bilgisi bulunamadı"));
    return;
  }

  providerList.forEach(p => {
    const pName = typeof p === "string" ? p : (p.id || p.name || p.provider);
    const isSelected = (typeof p === "object" && p.selected === true) || pName === selectedName;

    const item = element("div", `config-option-item ${isSelected ? "is-selected" : ""}`);
    const nameSpan = element("strong", null, pName);
    item.appendChild(nameSpan);

    if (typeof p === "object" && p.type) {
      item.appendChild(element("span", "badge", p.type));
    }

    if (isSelected) {
      item.appendChild(element("span", "badge badge-enabled", "AKTİF"));
    } else if (typeof p === "object" && p.enabled === false) {
      item.appendChild(element("span", "badge", "Devre Dışı"));
    } else if (canMutate) {
      const selectBtn = element("button", "pm-btn pm-btn-view", "Seç");
      selectBtn.type = "button";
      if (typeof selectBtn.addEventListener === "function") {
        selectBtn.addEventListener("click", () => {
          updateProviderSelection(fieldName, pName);
        });
      }
      item.appendChild(selectBtn);
    } else {
      item.appendChild(element("span", "badge", "Pasif"));
    }

    list.appendChild(item);
  });
}

async function updateProviderSelection(field, value) {
  try {
    const res = await fetch("/api/config/providers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    await fetchSnapshot();
  } catch (err) {
    alert(`Yapılandırma güncellenemedi: ${err.message}`);
  }
}

// Snapshot Fetch & Reconciliation
async function fetchSnapshot() {
  try {
    const res = await fetch("/api/snapshot");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.snapshot = data;
    state.connected = true;
    state.loading = false;

    const errBanner = getElem("error-banner");
    if (errBanner) errBanner.hidden = true;

    updateTopbar(data);
    renderOverview(data);
    renderPmWorkspace();
    renderConfigView(data);
    fetchProviderConnections();
    renderAgentRegistry();

    if (state.currentView === "parents-view") {
      populateParentSelector();
    }
    applyDocumentTranslations();
  } catch (err) {
    state.connected = false;
    const errBanner = getElem("error-banner");
    if (errBanner) errBanner.hidden = false;
    const connDot = getElem("connection-dot");
    const connLabel = getElem("connection-label");
    if (connDot) connDot.className = "connection-dot is-offline";
    if (connLabel) connLabel.textContent = "Bağlantı Kesildi";
  }
}

// Global Event Listeners & Setup
function setupEventListeners() {
  if (typeof document === "undefined") return;

  document.querySelectorAll?.("[data-language]").forEach(button => {
    button.addEventListener("click", () => applyLanguage(button.dataset.language));
  });

  const navButtons = document.querySelectorAll(".nav-item");
  navButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetView = btn.dataset.target;
      if (targetView) switchView(targetView, false);
      getElem("app-sidebar")?.classList.remove("is-open");
      getElem("sidebar-backdrop")?.classList.remove("is-visible");
      getElem("sidebar-toggle")?.setAttribute("aria-expanded", "false");
    });
  });

  const sidebarToggle = getElem("sidebar-toggle");
  const sidebar = getElem("app-sidebar");
  const sidebarBackdrop = getElem("sidebar-backdrop");
  sidebarToggle?.addEventListener("click", () => {
    const open = !sidebar?.classList.contains("is-open");
    sidebar?.classList.toggle("is-open", open);
    sidebarBackdrop?.classList.toggle("is-visible", open);
    sidebarToggle.setAttribute("aria-expanded", String(open));
  });
  sidebarBackdrop?.addEventListener("click", () => {
    sidebar?.classList.remove("is-open");
    sidebarBackdrop.classList.remove("is-visible");
    sidebarToggle?.setAttribute("aria-expanded", "false");
  });

  const pmFilterBtns = document.querySelectorAll(".pm-sub-nav .pm-filter-btn");
  pmFilterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      state.currentPmFilter = btn.dataset.pmFilter || "inbox";
      state.workItemState = "all";
      state.workItemPage = 1;
      const stateFilter = getElem("work-item-state-filter");
      if (stateFilter) stateFilter.value = "all";
      renderPmWorkspace();
    });
  });

  const pmStats = document.querySelectorAll(".pm-summary-bar .pm-stat");
  pmStats.forEach(stat => {
    stat.addEventListener("click", () => {
      const group = stat.dataset.group;
      if (group === "awaitingApproval") {
        state.currentPmFilter = "approvals";
      } else if (group === "blocked" || group === "needsRework") {
        state.currentPmFilter = "attention";
      } else {
        state.currentPmFilter = "inbox";
      }
      renderPmWorkspace();
    });
  });

  const pmForm = getElem("pm-form");
  if (pmForm) {
    pmForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = getElem("pm-input");
      if (!input || !input.value.trim()) return;
      const msg = input.value.trim();
      input.value = "";
      try {
        await fetch("/api/pm/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg })
        });
        await fetchSnapshot();
      } catch {}
    });
  }

  const fleetFilterBtns = document.querySelectorAll(".filter-bar .filter-btn");
  fleetFilterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      fleetFilterBtns.forEach(button => {
        button.classList.remove("is-active");
        button.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
      state.filter = btn.dataset.filter || "all";
      renderRuns();
    });
  });

  const searchInput = getElem("run-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.query = e.target.value;
      renderRuns();
    });
  }

  const workSourceRefreshBtn = getElem("work-source-refresh-btn");
  if (workSourceRefreshBtn) workSourceRefreshBtn.addEventListener("click", () => refreshWorkSourceCatalog(true));

  const workItemSearch = getElem("work-item-search");
  if (workItemSearch) {
    workItemSearch.addEventListener("input", event => {
      state.workItemQuery = event.target.value;
      state.workItemPage = 1;
      renderPmWorkspace();
    });
  }

  const workItemStateFilter = getElem("work-item-state-filter");
  if (workItemStateFilter) {
    workItemStateFilter.addEventListener("change", event => {
      state.workItemState = event.target.value || "all";
      state.currentPmFilter = "inbox";
      state.workItemPage = 1;
      renderPmWorkspace();
    });
  }

  const workItemPageSize = getElem("work-item-page-size");
  if (workItemPageSize) {
    workItemPageSize.addEventListener("change", event => {
      state.workItemPageSize = Number(event.target.value) || 25;
      state.workItemPage = 1;
      renderPmWorkspace();
    });
  }

  getElem("work-page-prev")?.addEventListener("click", () => {
    state.workItemPage = Math.max(1, state.workItemPage - 1);
    renderPmWorkspace();
  });
  getElem("work-page-next")?.addEventListener("click", () => {
    state.workItemPage += 1;
    renderPmWorkspace();
  });

  const parentSelect = getElem("parent-select");
  if (parentSelect) {
    parentSelect.addEventListener("change", (e) => {
      const pKey = e.target.value;
      if (pKey) {
        state.selectedParentKey = pKey;
        fetchParentDetail(pKey);
        syncUrlState(false);
      }
    });
  }

  const parentRefreshBtn = getElem("parent-refresh-btn");
  if (parentRefreshBtn) {
    parentRefreshBtn.addEventListener("click", async () => {
      await refreshWorkSourceCatalog(true);
      if (state.selectedParentKey) fetchParentDetail(state.selectedParentKey);
      else populateParentSelector();
    });
  }

  const obsWindowBtns = document.querySelectorAll(".obs-window-controls .window-btn");
  obsWindowBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      obsWindowBtns.forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.currentObsWindow = btn.dataset.window || "24h";
      fetchObservabilitySummary();
    });
  });

  const agentFilterBtns = document.querySelectorAll(".agent-filters .agent-filter-btn");
  agentFilterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      state.currentAgentFilter = btn.dataset.agentFilter || "all";
      renderAgentRegistry();
    });
  });

  const agentCreateBtn = getElem("agent-create-btn");
  if (agentCreateBtn) {
    agentCreateBtn.addEventListener("click", () => {
      openAgentCreateModal(agentCreateBtn);
    });
  }

  const agentCreateSubmitBtn = getElem("agent-create-submit-btn");
  if (agentCreateSubmitBtn) {
    agentCreateSubmitBtn.addEventListener("click", (e) => {
      e.preventDefault();
      submitAgentCreate();
    });
  }

  const agentCreateCancelBtn = getElem("agent-create-cancel-btn");
  const agentCreateCloseBtn = getElem("agent-create-close-btn");
  if (agentCreateCancelBtn) agentCreateCancelBtn.addEventListener("click", () => closeModal("agent-create-modal"));
  if (agentCreateCloseBtn) agentCreateCloseBtn.addEventListener("click", () => closeModal("agent-create-modal"));

  const agentEditSubmitBtn = getElem("agent-edit-submit-btn");
  if (agentEditSubmitBtn) {
    agentEditSubmitBtn.addEventListener("click", (e) => {
      e.preventDefault();
      submitAgentEdit();
    });
  }

  const agentEditCancelBtn = getElem("agent-edit-cancel-btn");
  const agentEditCloseBtn = getElem("agent-edit-close-btn");
  if (agentEditCancelBtn) agentEditCancelBtn.addEventListener("click", () => closeModal("agent-edit-modal"));
  if (agentEditCloseBtn) agentEditCloseBtn.addEventListener("click", () => closeModal("agent-edit-modal"));

  const agentVerCloseBtn = getElem("agent-ver-close-btn");
  if (agentVerCloseBtn) agentVerCloseBtn.addEventListener("click", () => closeModal("agent-versions-drawer"));
  const agentDetailCloseBtn = getElem("agent-detail-close-btn");
  if (agentDetailCloseBtn) agentDetailCloseBtn.addEventListener("click", () => closeModal("agent-detail-drawer"));
  const providerDetailCloseBtn = getElem("provider-detail-close-btn");
  if (providerDetailCloseBtn) providerDetailCloseBtn.addEventListener("click", () => closeModal("provider-detail-drawer"));
  const providerConnectionCloseBtn = getElem("provider-connection-close-btn");
  if (providerConnectionCloseBtn) providerConnectionCloseBtn.addEventListener("click", closeProviderConnectionDrawer);
  const providerConnectionForm = getElem("provider-connection-form");
  if (providerConnectionForm) providerConnectionForm.addEventListener("submit", submitProviderConnection);
  const providerConnectionTestBtn = getElem("provider-connection-test-btn");
  if (providerConnectionTestBtn) providerConnectionTestBtn.addEventListener("click", () => testProviderConnection());
  const providerConnectionDisconnectBtn = getElem("provider-connection-disconnect-btn");
  if (providerConnectionDisconnectBtn) providerConnectionDisconnectBtn.addEventListener("click", disconnectProviderConnection);
  const providerConnectionSelectBtn = getElem("provider-connection-select-btn");
  if (providerConnectionSelectBtn) providerConnectionSelectBtn.addEventListener("click", selectProviderConnection);
  const localEndpointInput = getElem("local-endpoint-input");
  if (localEndpointInput) localEndpointInput.addEventListener("input", () => syncLocalEndpointApproval(true));
  document.querySelectorAll?.("[data-provider-category]").forEach(button => {
    button.addEventListener("click", () => setProviderConnectionCategory(button.dataset.providerCategory));
  });

  const traceCloseBtn = getElem("trace-close-btn");
  if (traceCloseBtn) {
    traceCloseBtn.addEventListener("click", () => {
      closeModal("decision-trace-modal");
      state.selectedWorkItemKey = null;
      syncUrlState(false);
    });
  }

  const telemCloseBtn = getElem("telem-close-btn");
  if (telemCloseBtn) {
    telemCloseBtn.addEventListener("click", () => {
      closeModal("telemetry-drawer-modal");
      state.selectedRunId = null;
      syncUrlState(false);
    });
  }

  const appConfirmBtn = getElem("approval-modal-confirm-btn");
  const appCancelBtn = getElem("approval-modal-cancel-btn");
  const appCloseBtn = getElem("approval-modal-close-btn");
  if (appConfirmBtn) appConfirmBtn.addEventListener("click", submitApproval);
  if (appCancelBtn) appCancelBtn.addEventListener("click", () => closeModal("approval-modal"));
  if (appCloseBtn) appCloseBtn.addEventListener("click", () => closeModal("approval-modal"));

  const rejConfirmBtn = getElem("rejection-modal-confirm-btn");
  const rejCancelBtn = getElem("rejection-modal-cancel-btn");
  const rejCloseBtn = getElem("rejection-modal-close-btn");
  if (rejConfirmBtn) rejConfirmBtn.addEventListener("click", submitRejection);
  if (rejCancelBtn) rejCancelBtn.addEventListener("click", () => closeModal("rejection-modal"));
  if (rejCloseBtn) rejCloseBtn.addEventListener("click", () => closeModal("rejection-modal"));

  const modalBackdrops = document.querySelectorAll(".trace-modal-backdrop");
  modalBackdrops.forEach(backdrop => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        backdrop.hidden = true;
        if (backdrop.id === "decision-trace-modal") {
          state.selectedWorkItemKey = null;
          syncUrlState(false);
        } else if (backdrop.id === "telemetry-drawer-modal") {
          state.selectedRunId = null;
          syncUrlState(false);
        }
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.keyCode === 27) {
      getElem("app-sidebar")?.classList.remove("is-open");
      getElem("sidebar-backdrop")?.classList.remove("is-visible");
      getElem("sidebar-toggle")?.setAttribute("aria-expanded", "false");
      modalBackdrops.forEach(backdrop => {
        if (!backdrop.hidden) {
          backdrop.hidden = true;
          if (backdrop.id === "decision-trace-modal") {
            state.selectedWorkItemKey = null;
            syncUrlState(false);
          } else if (backdrop.id === "telemetry-drawer-modal") {
            state.selectedRunId = null;
            syncUrlState(false);
          }
        }
      });
      if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
        try { state.lastFocusedElement.focus(); } catch {}
        state.lastFocusedElement = null;
      }
    }
  });

  if (typeof window !== "undefined") {
    window.addEventListener("popstate", () => {
      readUrlState();
    });
  }
}

// Initialization
async function init() {
  applyLanguage(state.language, { rerender: false });
  setupEventListeners();
  await fetchSnapshot();
  readUrlState();

  if (typeof setInterval === "function") {
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) {
        fetchSnapshot();
      }
    }, 3000);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }
}

if (typeof module === "undefined" && typeof document !== "undefined" && typeof document.addEventListener === "function") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    state,
    elements,
    STATUS_LABELS,
    PERSONA_INITIALS,
    ROLE_LABELS,
    safeHtml,
    element,
    getElem,
    formatNumber,
    formatDuration,
    formatDurationMs,
    formatTime,
    taskCard,
    roleLane,
    visibleRuns,
    renderRuns,
    renderCapacity,
    renderOverview,
    renderPmWorkspace,
    refreshWorkSourceCatalog,
    mergedWorkSourceGroups,
    renderParentDetail,
    renderChildDag,
    buildExecutionStages,
    clearParentDetail,
    populateParentSelector,
    renderObservability,
    renderConfigView,
    renderProviderConnections,
    renderPlanPreview,
    renderCompatibilityPreview,
    fetchProviderConnections,
    renderAgentRegistry,
    createPmItemCard,
    renderProviderSection,
    renderDecisionTraceDetail,
    renderParentReviewFindings,
    switchView,
    openDecisionTrace,
    openTelemetryDrawer,
    openModal,
    closeModal,
    syncUrlState,
    readUrlState
  };
}
if (typeof window !== "undefined") {
  window.PaceControlPlane = {
    state,
    elements,
    renderRuns,
    renderCapacity,
    fetchSnapshot
  };
}
