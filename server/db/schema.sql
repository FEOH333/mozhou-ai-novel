-- server/db/schema.sql —— SQLite 数据库结构（node:sqlite）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 作品
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT DEFAULT '玄幻',
  blurb TEXT DEFAULT '',
  platform TEXT DEFAULT '通用',       -- 番茄 | 起点 | 通用（平台套路规则注入）
  perspective TEXT DEFAULT 'third',  -- V0.42：叙述视角 third=第三人称 | first=第一人称主角
  era TEXT DEFAULT '{}',             -- V0.82：朝代配置 JSON {dynasty,name,years,eraLine,seed}（历史题材；空=默认宋末）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settings_json TEXT DEFAULT '{}'   -- 作品级设置（路由覆盖/预算/策略）
);

-- 公共材料（缓存前缀的组成部分：system/世界观/人物卡/书纲；version 用于缓存重建提示）
CREATE TABLE IF NOT EXISTS public_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- system | world | characters | outline
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  UNIQUE(book_id, kind)
);

-- 卷
CREATE TABLE IF NOT EXISTS volumes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT DEFAULT '',
  goal TEXT DEFAULT '',
  outline_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'planned',    -- planned | outlined | writing | done
  summary TEXT DEFAULT '',          -- V0.95：卷级 Arc 摘要（卷速查表——已完结卷折叠为一行注入，O(卷) 替代 O(章)）
  UNIQUE(book_id, idx)
);

-- 章
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  volume_id TEXT,
  idx INTEGER NOT NULL,
  title TEXT DEFAULT '',
  outline_json TEXT DEFAULT '{}',   -- 章细纲（含 scenes/checkpoints）
  status TEXT DEFAULT 'planned',    -- planned | outlined | writing | drafted | revised | settled | done
  word_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(book_id, idx)
);

-- 场景（章内最小写作单元）
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  pov TEXT DEFAULT '',
  location TEXT DEFAULT '',
  beat TEXT DEFAULT '',
  content TEXT DEFAULT '',
  target_words INTEGER DEFAULT 1000,
  status TEXT DEFAULT 'planned',    -- planned | writing | done | revised
  history_seq INTEGER,              -- 该场景正文在历史堆中的 seq（修订时用于缓存重建定位）
  scene_type TEXT DEFAULT '',       -- V0.83：细纲标注的场景类型（fight/emotion/suspense/dialogue/climax/daily/reveal）——技法/诗词按真实类型匹配
  pacing TEXT DEFAULT '',           -- V0.95：细纲标注的场景节奏（铺垫/推进/爆发/余韵）——写作按节奏注入句长纪律（治 AI 匀速病）
  UNIQUE(chapter_id, idx)
);

-- 历史堆（缓存前缀：append-only；role = system|user|assistant）
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  UNIQUE(book_id, seq)
);

-- 事实库（幻觉控制锚）
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  source_chapter INTEGER,
  status TEXT DEFAULT 'active',     -- active | superseded | contradicted
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- 角色
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  name TEXT NOT NULL,
  card_json TEXT DEFAULT '{}',      -- 角色元数据（role=身份唯一真源；traits 已退役 V0.96，性格单源=personality 列）
  state_json TEXT DEFAULT '{}',     -- 当前状态（位置/实力/关系/持有物/心境）
  first_chapter INTEGER,
  last_chapter INTEGER,
  deceased INTEGER DEFAULT 0,       -- V0.37：已退场（死亡）标记——从活跃注入移除，杜绝"诈尸"
  death_chapter INTEGER,            -- 死亡章节
  -- V0.49：角色弧光维度（结构化列，供结算/点名册/写作注入/前端展示）
  personality TEXT DEFAULT '',      -- 性格（含缺陷；口头禅的说话方式见 speech）
  goal TEXT DEFAULT '',             -- 核心目标/渴望
  fear TEXT DEFAULT '',             -- 恐惧/软肋
  secret TEXT DEFAULT '',           -- 秘密/隐藏身份
  arc TEXT DEFAULT '',              -- 成长弧线（起点→分阶段节点→终点，能力+心境双线）
  relation TEXT DEFAULT '',         -- 与其他角色的关键关系
  speech TEXT DEFAULT '',           -- V0.101：说话方式（句长/用词层/答法，机制描述，禁止每章重复正例句）
  speech_forbid TEXT DEFAULT '',    -- V0.101：禁腔（| 分隔），写审同源检测
  -- V0.50：角色分级与能力系统
  tier TEXT DEFAULT 'minor',        -- 分级：protagonist 主角 | major 主要配角 | minor 次要配角 | extra 龙套
  abilities_json TEXT DEFAULT '[]', -- 能力/物品清单（按书类型适配：技能/法宝/道具/功法/背包…）[{name,type,desc}]
  -- V0.50：角色退出机制（区别于死亡：暂离/退场原因）
  exit_note TEXT DEFAULT '',        -- 退出/退场说明（死亡写死因；暂离写去向）
  created_at INTEGER NOT NULL
);

-- 地点/物品/势力（与角色同构）
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL,
  card_json TEXT DEFAULT '{}', first_chapter INTEGER, last_chapter INTEGER, created_at INTEGER NOT NULL,
  -- V0.71：地点库列（kind 类型/desc 描述/stable 稳定性/status 状态/note 变化记录）
  kind TEXT DEFAULT '', desc TEXT DEFAULT '', stable INTEGER DEFAULT 1, status TEXT DEFAULT 'normal', note TEXT DEFAULT '',
  -- V0.82：朝代行政层级/战略属性（历史题材：路/州/县/寨/堡 + 三江汇流等战略价值）
  admin_level TEXT DEFAULT '', strategic TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL,
  card_json TEXT DEFAULT '{}', owner TEXT DEFAULT '', first_chapter INTEGER, last_chapter INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS factions (
  id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL,
  card_json TEXT DEFAULT '{}', first_chapter INTEGER, last_chapter INTEGER, created_at INTEGER NOT NULL
);

-- 伏笔登记表
CREATE TABLE IF NOT EXISTS foreshadows (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  desc TEXT NOT NULL,
  type TEXT DEFAULT '剧情伏笔',      -- 物品/身份/剧情/对话伏笔
  planted_chapter INTEGER,
  advance_chapters TEXT DEFAULT '[]', -- [8,12]
  payoff_chapter INTEGER,
  status TEXT DEFAULT 'planted',    -- planted | advanced | paid_off | abandoned
  importance TEXT DEFAULT 'medium', -- high | medium | low
  note TEXT DEFAULT '',
  events_json TEXT DEFAULT '[]',    -- [{chapter, note}] 每章推进流水（可追溯）
  created_at INTEGER NOT NULL
);

-- 世界书（关键词触发注入）
CREATE TABLE IF NOT EXISTS worldbook (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  category TEXT DEFAULT '通用',
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 章摘要（后续检索/压缩用）
CREATE TABLE IF NOT EXISTS chapter_summaries (
  chapter_id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  summary TEXT DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- 全书滚动摘要（每章结算后增量更新；动态内容，只注入请求尾部，不进缓存前缀）
CREATE TABLE IF NOT EXISTS rolling_summaries (
  book_id TEXT PRIMARY KEY,
  content TEXT DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- 章节结算指纹：同一正文只应用一次事实/时间线/角色等派生投影
CREATE TABLE IF NOT EXISTS chapter_settlements (
  chapter_id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

-- 冲突记录（审校/结算发现）
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT,
  type TEXT DEFAULT '设定冲突',
  quote TEXT DEFAULT '',
  issue TEXT DEFAULT '',
  resolution TEXT DEFAULT 'open',    -- open | accepted | rejected
  created_at INTEGER NOT NULL
);

-- 时间线
CREATE TABLE IF NOT EXISTS timeline (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  year INTEGER,                -- V0.82：公元年（历史题材）
  era_year TEXT DEFAULT '',    -- V0.82：年号纪年（如"淳祐元年"）
  season TEXT DEFAULT '',      -- V0.82：季节（历史质感/倒计时锁）
  created_at INTEGER NOT NULL
);

-- V0.82：史实事件锚点（era_context.real_events 结构化落库，供"已过/未到史实节点"边界注入）
CREATE TABLE IF NOT EXISTS era_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  year INTEGER,
  era_year TEXT DEFAULT '',
  event TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_era_events_book ON era_events(book_id, year);

-- V0.93.10：历史人物档案（era_context.figures 结构化落库，供"人物登场窗"逐卷注入与人物级时间校验）
CREATE TABLE IF NOT EXISTS historical_figures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT DEFAULT '[]',
  first_year INTEGER,
  death_year INTEGER,
  office TEXT DEFAULT '',
  stance TEXT DEFAULT '',
  constraint_text TEXT DEFAULT '',
  alterable TEXT DEFAULT '',
  source TEXT DEFAULT 'era_context',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_historical_figures_book ON historical_figures(book_id, first_year);

-- LLM 调用日志（成本面板数据源）
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  book_id TEXT,
  chapter_id TEXT,
  task TEXT DEFAULT '',
  model TEXT DEFAULT '',
  prompt_hit INTEGER DEFAULT 0,
  prompt_miss INTEGER DEFAULT 0,
  completion INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  cost_if_miss REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  estimated INTEGER DEFAULT 0, -- V0.29：流式 usage 缺失时的估算标记
  extra TEXT DEFAULT '{}'
);

-- 向量索引（本地 embedding）
CREATE TABLE IF NOT EXISTS vectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  kind TEXT DEFAULT 'chapter',       -- chapter | fact | summary | foreshadow
  ref_id TEXT,
  chunk TEXT DEFAULT '',
  embedding_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 待登记设定（正文出现但未入世界书的疑似新设定，人工确认）
CREATE TABLE IF NOT EXISTS pending_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  name TEXT NOT NULL,
  context TEXT DEFAULT '',
  source_chapter INTEGER,
  status TEXT DEFAULT 'pending',     -- pending | confirmed | rejected
  created_at INTEGER NOT NULL
);

-- 章节健康快照（漂移检测数据源，每章结算后写入）
CREATE TABLE IF NOT EXISTS chapter_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  chapter_id TEXT,
  idx INTEGER NOT NULL,
  verdict TEXT DEFAULT 'ok',          -- ok | fix | defer | replan | error
  issues INTEGER DEFAULT 0,
  high_issues INTEGER DEFAULT 0,
  replan_count INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,           -- 1 = 该章生成失败
  word_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 归档批次（上下文压缩产物：结构化精炼卡，原文永存 scenes 表可回灌）
CREATE TABLE IF NOT EXISTS book_archives (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  batch INTEGER NOT NULL,             -- 第几次归档
  range_start INTEGER NOT NULL,       -- 归档章节范围
  range_end INTEGER NOT NULL,
  summary_json TEXT NOT NULL,         -- 批量精炼卡（结构化 JSON，防丢细节）
  tokens_saved INTEGER DEFAULT 0,     -- 本次归档节省的估算 tokens
  created_at INTEGER NOT NULL
);

-- 全局约束反哺（漂移诊断产出的 extra_constraints，持续注入后续写作）
CREATE TABLE IF NOT EXISTS book_constraints (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT DEFAULT 'recovery',     -- recovery | user | polish | pleasure
  active INTEGER DEFAULT 1,
  scope_start INTEGER,
  scope_end INTEGER,
  constraint_key TEXT DEFAULT '',
  superseded_by TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- V0.17 快感引擎：期待-满足账本（蔡格尼克/好奇心缺口/变量奖励）
CREATE TABLE IF NOT EXISTS pleasure_hooks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  desc TEXT NOT NULL,
  kind TEXT DEFAULT 'short',          -- short 短期待(1-2章) | medium 中期待(3-5章) | long 长期待(10-20章) | super 超级期待(全书)
  type TEXT DEFAULT '悬念钩',          -- 危机钩|悬念钩|反转钩|挑衅钩|倒计时钩|打脸期待|升级期待|情感期待
  planted_chapter INTEGER NOT NULL,
  due_chapter INTEGER,                -- 计划兑现章
  status TEXT DEFAULT 'open',         -- open 未兑现 | progressing 推进中 | confirmed 分期确认过 | paid 已兑现 | expired 超期
  intensity INTEGER DEFAULT 3,        -- 钩子强度 1-5
  last_progress_chapter INTEGER,      -- 最近一次进度确认章
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- V0.17 快感引擎：并行叙事弧线（蔡格尼克 3-5 条并行）
CREATE TABLE IF NOT EXISTS story_arcs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT DEFAULT '支线',           -- 主线|支线|感情线|暗线
  status TEXT DEFAULT 'opening',      -- opening 开启 | progressing 推进 | closing 临门一脚 | closed 闭合
  opened_chapter INTEGER,
  target_chapter INTEGER,
  last_active_chapter INTEGER,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- V0.95 长程记忆层：叙事记忆库（show-me-the-story MemoryEntry 同构）
-- 与 facts（SPO 事件三元组，管"发生了什么"）互补——本表管"它读起来是什么质感"：
-- 人物声音（口头禅/句式）、具体承诺、道具细节、名场面、关系里程碑。
-- 归档压缩后早期正文不可达时，这是文学质感的结构化载体（治"越写越没味"）。
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  category TEXT NOT NULL,            -- voice 人物声音 | promise 承诺 | detail 道具/细节 | scene 名场面 | relation 关系里程碑
  name TEXT DEFAULT '',              -- 关联实体名（人物/物品；scene 类可空）
  content TEXT NOT NULL,             -- 记忆内容（一句话，≤60 字）
  chapter INTEGER NOT NULL,          -- 来源章
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_book ON memory_entries(book_id, category);

CREATE INDEX IF NOT EXISTS idx_facts_book ON facts(book_id, status);
CREATE INDEX IF NOT EXISTS idx_foreshadows_book ON foreshadows(book_id, status);
CREATE INDEX IF NOT EXISTS idx_history_book ON history(book_id, seq);
CREATE INDEX IF NOT EXISTS idx_usage_book ON usage_logs(book_id, ts);
CREATE INDEX IF NOT EXISTS idx_scenes_chapter ON scenes(chapter_id, idx);
CREATE INDEX IF NOT EXISTS idx_vectors_book ON vectors(book_id, kind);
CREATE INDEX IF NOT EXISTS idx_health_book ON chapter_health(book_id, idx);
CREATE INDEX IF NOT EXISTS idx_archives_book ON book_archives(book_id, batch);
CREATE INDEX IF NOT EXISTS idx_settlements_book ON chapter_settlements(book_id, created_at);

-- V0.22：作品快照（打磨前自动快照；一键回滚；借鉴 storyforge 版本历史/快照）
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT DEFAULT 'auto',        -- auto 自动（打磨前） | manual 手动
  data_json TEXT NOT NULL,           -- { chapters: [{ id, idx, title, status, word_count, outline_json, scenes: [{ idx, content, status }] }] }
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_book ON snapshots(book_id, created_at);

-- V0.98：可回退开篇干预资产。正文前置层与创作记忆隔离，状态机控制审阅/选择/应用。
CREATE TABLE IF NOT EXISTS opening_assets (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('head_rewrite','chapter1_cold_open','standalone_prologue')),
  placement TEXT NOT NULL CHECK(placement IN ('scene_patch','prepend_chapter1','before_chapter1')),
  title TEXT DEFAULT '',
  anchor_scene_id TEXT,
  anchor_start INTEGER,
  anchor_end INTEGER,
  source_excerpt TEXT DEFAULT '',
  source_hash TEXT DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  contract_json TEXT NOT NULL DEFAULT '{}',
  audit_json TEXT NOT NULL DEFAULT '{}',
  rank_json TEXT NOT NULL DEFAULT '{}',
  creative_hypothesis TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK(status IN ('candidate','audited','selected','applied','retired','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opening_assets_book ON opening_assets(book_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_opening_active_reader_layer
  ON opening_assets(book_id)
  WHERE status IN ('selected','applied')
    AND placement IN ('prepend_chapter1','before_chapter1');

-- V0.28 操作日志（排查"哪步失败/哪个请求卡了多久"，自动清理保留最近 2000 条）
CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'api',
  level TEXT NOT NULL DEFAULT 'info',
  op TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  book_id TEXT,
  duration_ms INTEGER,
  result TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_oplog_ts ON operation_logs (ts);
CREATE INDEX IF NOT EXISTS idx_oplog_book ON operation_logs (book_id);

-- V0.80：契约承诺履行账本（书契约"前N章承诺"结构化落库 + 到期校验，防承诺落空）
CREATE TABLE IF NOT EXISTS contract_promises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  text TEXT NOT NULL,
  due_chapter INTEGER,
  status TEXT DEFAULT 'open',          -- open 待兑现 | met 已兑现 | missed 已错过
  checked_chapter INTEGER,             -- 上次核对到第几章
  fulfilled_chapter INTEGER,           -- 实际兑现章
  note TEXT DEFAULT '',
  created_at INTEGER,
  UNIQUE(book_id, text)
);
CREATE INDEX IF NOT EXISTS idx_promise_book ON contract_promises(book_id, status);

-- V0.41：卷级整体审阅（每卷写完自动体检；volume_id 唯一 → 幂等不重审）
CREATE TABLE IF NOT EXISTS volume_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  grade TEXT NOT NULL DEFAULT 'C',
  report_json TEXT NOT NULL DEFAULT '{}',
  issues_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done',
  revised_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (book_id, volume_id)
);
CREATE INDEX IF NOT EXISTS idx_vrev_book ON volume_reviews (book_id);

-- V0.99：平台发布档案。动态审核/数据只在 L4 注入，不进入稳定缓存前缀。
CREATE TABLE IF NOT EXISTS publication_profiles (
  book_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'fanqie',
  work_url TEXT NOT NULL DEFAULT '',
  external_book_id TEXT NOT NULL DEFAULT '',
  recommendation_stage TEXT NOT NULL DEFAULT 'not_applied'
    CHECK(recommendation_stage IN ('not_applied','preparing','under_review','failed','validation','recommended','terminated')),
  remaining_attempts INTEGER CHECK(remaining_attempts IS NULL OR remaining_attempts BETWEEN 0 AND 3),
  editor_feedback TEXT NOT NULL DEFAULT '',
  author_diagnosis TEXT NOT NULL DEFAULT '',
  suspected_turn_chapter INTEGER CHECK(suspected_turn_chapter IS NULL OR suspected_turn_chapter > 0),
  reviewed_at INTEGER,
  published_chapter_count INTEGER CHECK(published_chapter_count IS NULL OR published_chapter_count >= 0),
  published_word_count INTEGER CHECK(published_word_count IS NULL OR published_word_count >= 0),
  public_reader_count INTEGER CHECK(public_reader_count IS NULL OR public_reader_count >= 0),
  latest_chapter_title TEXT NOT NULL DEFAULT '',
  latest_chapter_item_id TEXT NOT NULL DEFAULT '',
  last_publish_time INTEGER,
  public_chapters_json TEXT NOT NULL DEFAULT '[]',
  last_synced_at INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'idle' CHECK(sync_status IN ('idle','syncing','ok','error')),
  sync_error TEXT NOT NULL DEFAULT '',
  pending_sync_json TEXT NOT NULL DEFAULT '[]',
  recovery_status TEXT NOT NULL DEFAULT 'idle'
    CHECK(recovery_status IN ('idle','needs_plan','diagnosing','planned','rewriting','verifying','completed','failed','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 每一次平台审核都追加记录，避免“最后状态”覆盖历史证据。
CREATE TABLE IF NOT EXISTS recommendation_reviews (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  stage TEXT NOT NULL
    CHECK(stage IN ('not_applied','preparing','under_review','failed','validation','recommended','terminated')),
  remaining_attempts INTEGER CHECK(remaining_attempts IS NULL OR remaining_attempts BETWEEN 0 AND 3),
  feedback TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  reviewed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recommendation_reviews_book
  ON recommendation_reviews(book_id, reviewed_at DESC, created_at DESC);

-- 作品数据按观察窗口追加。未获曝光的零数据与真实推荐后的弱表现必须分开。
CREATE TABLE IF NOT EXISTS publication_metrics (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  exposure_status TEXT NOT NULL DEFAULT 'not_exposed'
    CHECK(exposure_status IN ('not_exposed','validation','limited_test','recommended','organic')),
  impressions INTEGER CHECK(impressions IS NULL OR impressions >= 0),
  readers INTEGER CHECK(readers IS NULL OR readers >= 0),
  bookshelf_adds INTEGER CHECK(bookshelf_adds IS NULL OR bookshelf_adds >= 0),
  read_through_rate REAL CHECK(read_through_rate IS NULL OR (read_through_rate >= 0 AND read_through_rate <= 100)),
  follow_rate REAL CHECK(follow_rate IS NULL OR (follow_rate >= 0 AND follow_rate <= 100)),
  note TEXT NOT NULL DEFAULT '',
  observed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publication_metrics_book
  ON publication_metrics(book_id, observed_at DESC, created_at DESC);

-- 前 20 章返工运行账本：诊断、工单、采用/拒绝与恢复点均可追溯。
CREATE TABLE IF NOT EXISTS recommendation_recovery_runs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  start_chapter INTEGER NOT NULL CHECK(start_chapter > 0),
  end_chapter INTEGER NOT NULL CHECK(end_chapter >= start_chapter),
  status TEXT NOT NULL DEFAULT 'diagnosing'
    CHECK(status IN ('diagnosing','planned','rewriting','verifying','completed','failed','cancelled')),
  confirmed_published_rewrite INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_published_rewrite IN (0,1)),
  snapshot_id TEXT,
  quality_curve_json TEXT NOT NULL DEFAULT '[]',
  work_orders_json TEXT NOT NULL DEFAULT '[]',
  completed_chapters_json TEXT NOT NULL DEFAULT '[]',
  rejected_chapters_json TEXT NOT NULL DEFAULT '[]',
  execution_policy_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_runs_book
  ON recommendation_recovery_runs(book_id, created_at DESC);

-- V0.100：正文换版与派生叙事状态必须同版本。候选投影先写 shadow，验证后原子切换。
CREATE TABLE IF NOT EXISTS narrative_revisions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  parent_id TEXT,
  from_chapter INTEGER NOT NULL CHECK(from_chapter > 0),
  through_chapter INTEGER NOT NULL CHECK(through_chapter >= from_chapter),
  status TEXT NOT NULL
    CHECK(status IN ('building','ready','applying','valid','stale','failed')),
  source_hash TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_narrative_revision_book
  ON narrative_revisions(book_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chapter_projections (
  revision_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL CHECK(chapter_idx > 0),
  source_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(revision_id, chapter_id)
);
CREATE INDEX IF NOT EXISTS idx_chapter_projection_book
  ON chapter_projections(book_id, chapter_idx);

-- 结构签名只描述因果骨架，不用固定句式反向教模型照抄。
CREATE TABLE IF NOT EXISTS narrative_patterns (
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL CHECK(chapter_idx > 0),
  revision_id TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL,
  features_json TEXT NOT NULL DEFAULT '{}',
  source_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(book_id, chapter_id)
);
CREATE INDEX IF NOT EXISTS idx_narrative_patterns_book
  ON narrative_patterns(book_id, chapter_idx);

-- 只有有正文证据、且通过外部/总审验证的经验才进入有限期学习账本。
CREATE TABLE IF NOT EXISTS narrative_lessons (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  lesson_key TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('provisional','active','retired')),
  problem TEXT NOT NULL,
  positive_target TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  scope_start INTEGER,
  scope_end INTEGER,
  confidence REAL NOT NULL DEFAULT 0.5,
  uses INTEGER NOT NULL DEFAULT 0,
  outcome_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(book_id, lesson_key)
);
CREATE INDEX IF NOT EXISTS idx_narrative_lessons_book
  ON narrative_lessons(book_id, status, confidence DESC);

-- 回放前恢复“设计态”，再逐章重建动态 state/first/last/death 等投影。
CREATE TABLE IF NOT EXISTS narrative_entity_baselines (
  book_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(book_id, entity_kind, entity_id)
);
