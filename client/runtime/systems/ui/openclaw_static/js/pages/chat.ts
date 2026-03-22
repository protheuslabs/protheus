// OpenFang Chat Page — Agent chat with markdown + streaming
'use strict';

function chatPage() {
  var msgId = 0;
  return {
    currentAgent: null,
    messages: [],
    inputText: '',
    sending: false,
    messageQueue: [],    // Queue for messages sent while streaming
    thinkingMode: 'off', // 'off' | 'on' | 'stream'
    _wsAgent: null,
    showAttachMenu: false,
    showSlashMenu: false,
    slashFilter: '',
    slashIdx: 0,
    attachments: [],
    dragOver: false,
    contextPressure: 'low',
    contextWindow: 8192,
    contextApproxTokens: 0,
    terminalMode: false,
    terminalCwd: '/Users/jay/.openclaw/workspace',
    terminalShortcutHint: 'Ctrl+\\',
    terminalCursorFocused: false,
    terminalSelectionStart: 0,
    _contextTelemetryTimer: null,
    _lastContextRequestAt: 0,
    _contextWindowByModel: {},
    _contextModelsFetchedAt: 0,
    _typingTimeout: null,
    // Multi-session state
    sessions: [],
    sessionsOpen: false,
    searchOpen: false,
    searchQuery: '',
    // Voice recording state
    recording: false,
    _mediaRecorder: null,
    _audioChunks: [],
    recordingTime: 0,
    _recordingTimer: null,
    // Model autocomplete state
    showModelPicker: false,
    modelPickerList: [],
    modelPickerFilter: '',
    modelPickerIdx: 0,
    // Model switcher dropdown
    showModelSwitcher: false,
    modelSwitcherFilter: '',
    modelSwitcherProviderFilter: '',
    modelSwitcherIdx: 0,
    modelSwitching: false,
    _modelCache: null,
    _modelCacheTime: 0,
    _chatMapWheelLockInstalled: false,
    conversationCache: {},
    conversationCacheKey: 'of-chat-conversation-cache-v1',
    _persistTimer: null,
    _responseStartedAt: 0,
    modelNoticeCache: {},
    modelNoticeCacheKey: 'of-chat-model-notices-v1',
    showScrollDown: false,
    hoveredMessageDomId: '',
    selectedMessageDomId: '',
    mapStepIndex: -1,
    activeMapPreviewDomId: '',
    activeMapPreviewDayKey: '',
    suppressMapPreview: false,
    _mapPreviewSuppressTimer: null,
    _scrollSyncFrame: 0,
    _lastInactiveNoticeKey: '',
    collapsedMessageDays: {},
    showAgentDrawer: false,
    agentDrawerLoading: false,
    agentDrawer: null,
    drawerTab: 'info',
    drawerConfigForm: {},
    drawerConfigSaving: false,
    drawerModelSaving: false,
    drawerIdentitySaving: false,
    drawerEditingModel: false,
    drawerEditingProvider: false,
    drawerEditingFallback: false,
    drawerEditingName: false,
    drawerEditingEmoji: false,
    drawerNewModelValue: '',
    drawerNewProviderValue: '',
    drawerNewFallbackValue: '',
    drawerArchetypeOptions: ['Assistant', 'Researcher', 'Coder', 'Writer', 'DevOps', 'Support', 'Analyst', 'Custom'],
    drawerVibeOptions: ['professional', 'friendly', 'technical', 'creative', 'concise', 'mentor'],
    slashCommands: [
      { cmd: '/help', desc: 'Show available commands' },
      { cmd: '/agents', desc: 'Switch to Agents page' },
      { cmd: '/new', desc: 'Reset session (clear history)' },
      { cmd: '/compact', desc: 'Trigger LLM session compaction' },
      { cmd: '/model', desc: 'Show or switch model (/model [name])' },
      { cmd: '/stop', desc: 'Cancel current agent run' },
      { cmd: '/usage', desc: 'Show session token usage & cost' },
      { cmd: '/think', desc: 'Toggle extended thinking (/think [on|off|stream])' },
      { cmd: '/context', desc: 'Show context window usage & pressure' },
      { cmd: '/verbose', desc: 'Cycle tool detail level (/verbose [off|on|full])' },
      { cmd: '/queue', desc: 'Check if agent is processing' },
      { cmd: '/status', desc: 'Show system status' },
      { cmd: '/clear', desc: 'Clear chat display' },
      { cmd: '/exit', desc: 'Disconnect from agent' },
      { cmd: '/budget', desc: 'Show spending limits and current costs' },
      { cmd: '/peers', desc: 'Show OFP peer network status' },
      { cmd: '/a2a', desc: 'List discovered external A2A agents' }
    ],
    tokenCount: 0,

    // ── Tip Bar ──
    tipIndex: 0,
    tips: ['Type / for commands', '/think on for reasoning', 'Ctrl+Shift+F for focus mode', 'Ctrl+T or Ctrl+\\ for terminal mode', 'Ctrl+F to add files', '/model to switch models', '/context to check usage', '/verbose off to hide tool details'],
    tipTimer: null,
    get currentTip() {
      if (localStorage.getItem('of-tips-off') === 'true') return '';
      return this.tips[this.tipIndex % this.tips.length];
    },
    dismissTips: function() { localStorage.setItem('of-tips-off', 'true'); },
    startTipCycle: function() {
      var self = this;
      if (this.tipTimer) clearInterval(this.tipTimer);
      this.tipTimer = setInterval(function() {
        self.tipIndex = (self.tipIndex + 1) % self.tips.length;
      }, 30000);
    },

    // Backward compat helper
    get thinkingEnabled() { return this.thinkingMode !== 'off'; },

    get terminalPromptPath() {
      return this.terminalCwd || '/Users/jay/.openclaw/workspace';
    },

    get terminalPromptPrefix() {
      return this.terminalPromptPath + ' % ';
    },

    get terminalPromptChars() {
      var len = this.terminalPromptPrefix.length;
      if (!Number.isFinite(len)) return 18;
      if (len < 18) return 18;
      return len;
    },

    get terminalCursorIndex() {
      var text = String(this.inputText || '');
      var max = text.length;
      var raw = Number(this.terminalSelectionStart);
      if (!Number.isFinite(raw)) return max;
      if (raw < 0) return 0;
      if (raw > max) return max;
      return Math.floor(raw);
    },

    get terminalCursorRow() {
      var text = String(this.inputText || '');
      if (!text) return 0;
      var upto = text.slice(0, this.terminalCursorIndex);
      var parts = upto.split('\n');
      return Math.max(0, parts.length - 1);
    },

    get terminalCursorColumn() {
      var text = String(this.inputText || '');
      if (!text) return 0;
      var upto = text.slice(0, this.terminalCursorIndex);
      var parts = upto.split('\n');
      return (parts[parts.length - 1] || '').length;
    },

    get terminalCursorStyle() {
      return '--terminal-cursor-ch:' + (this.terminalPromptChars + this.terminalCursorColumn) +
        '; --terminal-cursor-row:' + this.terminalCursorRow + ';';
    },

    formatTokenK(value) {
      var raw = Number(value || 0);
      if (!Number.isFinite(raw) || raw <= 0) return '0k';
      var k = raw / 1000;
      if (k >= 100) return Math.round(k) + 'k';
      if (k >= 10) return (Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, '') + 'k';
      return (Math.round(k * 100) / 100).toFixed(2).replace(/0$/, '').replace(/\.$/, '') + 'k';
    },

    get contextUsagePercent() {
      var windowSize = Number(this.contextWindow || 0);
      var used = Number(this.contextApproxTokens || 0);
      if (windowSize > 0 && used >= 0) {
        var ratio = Math.round((used / windowSize) * 100);
        if (ratio < 0) return 0;
        if (ratio > 100) return 100;
        return ratio;
      }
      switch (this.contextPressure) {
        case 'critical': return 95;
        case 'high': return 80;
        case 'medium': return 55;
        default: return 25;
      }
    },

    get contextRingArcLength() {
      // 330deg sweep: starts at 1 o'clock and ends at 12 o'clock at 100%.
      var maxArc = 91.6667;
      var usage = this.contextUsagePercent;
      if (!Number.isFinite(usage) || usage <= 0) return 0;
      if (usage >= 100) return maxArc;
      return Number(((usage / 100) * maxArc).toFixed(3));
    },

    get contextRingProgressStyle() {
      return 'stroke-dasharray: ' + this.contextRingArcLength + ' 100; stroke-dashoffset: 0;';
    },

    get contextRingTooltip() {
      return 'Context window\n' +
        this.contextUsagePercent + '% full\n' +
        ' ' + this.formatTokenK(this.contextApproxTokens) + ' / ' + this.formatTokenK(this.contextWindow) + ' tokens used\n\n' +
        ' Infring dynamically prunes its context';
    },

    get modelDisplayName() {
      if (!this.currentAgent) return '';
      var name = this.currentAgent.model_name || '';
      var short = name.replace(/-\d{8}$/, '');
      return short.length > 24 ? short.substring(0, 22) + '\u2026' : short;
    },

    get switcherProviders() {
      var seen = {};
      (this._modelCache || []).forEach(function(m) { seen[m.provider] = true; });
      return Object.keys(seen).sort();
    },

    get filteredSwitcherModels() {
      var models = this._modelCache || [];
      var provFilter = this.modelSwitcherProviderFilter;
      var textFilter = this.modelSwitcherFilter ? this.modelSwitcherFilter.toLowerCase() : '';
      if (!provFilter && !textFilter) return models;
      return models.filter(function(m) {
        if (provFilter && m.provider !== provFilter) return false;
        if (textFilter) {
          return m.id.toLowerCase().indexOf(textFilter) !== -1 ||
                 (m.display_name || '').toLowerCase().indexOf(textFilter) !== -1 ||
                 m.provider.toLowerCase().indexOf(textFilter) !== -1;
        }
        return true;
      });
    },

    get groupedSwitcherModels() {
      var filtered = this.filteredSwitcherModels;
      var groups = {}, order = [];
      filtered.forEach(function(m) {
        if (!groups[m.provider]) { groups[m.provider] = []; order.push(m.provider); }
        groups[m.provider].push(m);
      });
      return order.map(function(p) {
        return { provider: p.charAt(0).toUpperCase() + p.slice(1), models: groups[p] };
      });
    },

    pickDefaultAgent(agents) {
      if (!Array.isArray(agents) || !agents.length) return null;
      // Prefer the master/default agent when present; otherwise first running agent.
      var i;
      for (i = 0; i < agents.length; i++) {
        var a = agents[i] || {};
        var text = ((a.id || '') + ' ' + (a.name || '') + ' ' + (a.role || '')).toLowerCase();
        if (text.indexOf('master') >= 0 || text.indexOf('default') >= 0 || text.indexOf('primary') >= 0) {
          return a;
        }
      }
      for (i = 0; i < agents.length; i++) {
        var b = agents[i] || {};
        if (String(b.state || '').toLowerCase() === 'running') return b;
      }
      return agents[0];
    },

    resolveAgent(agentOrId) {
      if (!agentOrId) return null;
      var id = typeof agentOrId === 'string' ? agentOrId : agentOrId.id;
      if (!id) return null;
      var list = (Alpine.store('app') && Alpine.store('app').agents) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && String(list[i].id) === String(id)) return list[i];
      }
      if (typeof agentOrId === 'object' && agentOrId.id) return agentOrId;
      return null;
    },

    cacheAgentConversation(agentId) {
      if (!agentId) return;
      if (!this.conversationCache) this.conversationCache = {};
      try {
        this.conversationCache[String(agentId)] = {
          saved_at: Date.now(),
          token_count: this.tokenCount || 0,
          messages: JSON.parse(JSON.stringify(this.messages || [])),
        };
        var appStore = Alpine.store('app');
        if (appStore && typeof appStore.saveAgentChatPreview === 'function') {
          appStore.saveAgentChatPreview(agentId, this.conversationCache[String(agentId)].messages);
        }
        this.persistConversationCache();
      } catch {}
    },

    cacheCurrentConversation() {
      if (!this.currentAgent || !this.currentAgent.id) return;
      this.cacheAgentConversation(this.currentAgent.id);
    },

    scheduleConversationPersist() {
      var self = this;
      if (this._persistTimer) clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(function() {
        self.cacheCurrentConversation();
      }, 80);
    },

    restoreAgentConversation(agentId) {
      if (!agentId || !this.conversationCache) return false;
      const cached = this.conversationCache[String(agentId)];
      if (!cached || !Array.isArray(cached.messages)) return false;
      try {
        this.messages = this.mergeModelNoticesForAgent(agentId, JSON.parse(JSON.stringify(cached.messages)));
        this.tokenCount = Number(cached.token_count || 0);
        this.recomputeContextEstimate();
        this.$nextTick(() => this.scrollToBottom());
        return true;
      } catch {
        return false;
      }
    },

    loadConversationCache() {
      try {
        var raw = localStorage.getItem(this.conversationCacheKey);
        if (!raw) return {};
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        return parsed;
      } catch {
        return {};
      }
    },

    persistConversationCache() {
      try {
        localStorage.setItem(this.conversationCacheKey, JSON.stringify(this.conversationCache || {}));
      } catch {}
    },

    estimateTokensFromText(text) {
      return Math.max(0, Math.round(String(text || '').length / 4));
    },

    recomputeContextEstimate() {
      var rows = Array.isArray(this.messages) ? this.messages : [];
      var total = 0;
      for (var i = 0; i < rows.length; i++) {
        total += this.estimateTokensFromText(rows[i] && rows[i].text ? rows[i].text : '');
      }
      this.contextApproxTokens = total;
      this.refreshContextPressure();
    },

    applyContextTelemetry(data) {
      if (!data || typeof data !== 'object') return;
      var approx = Number(data.context_tokens || data.context_used_tokens || data.context_total_tokens || 0);
      if (Number.isFinite(approx) && approx > 0) {
        this.contextApproxTokens = approx;
      } else if (typeof data.message === 'string') {
        var tokenMatch = data.message.match(/~?\s*([0-9,]+)\s+tokens/i);
        if (tokenMatch && tokenMatch[1]) {
          var parsed = Number(String(tokenMatch[1]).replace(/,/g, ''));
          if (Number.isFinite(parsed) && parsed > 0) this.contextApproxTokens = parsed;
        }
      }
      var windowSize = Number(data.context_window || data.context_window_tokens || 0);
      if (Number.isFinite(windowSize) && windowSize > 0) {
        this.contextWindow = windowSize;
      }
      var ratio = Number(data.context_ratio || 0);
      if ((!Number.isFinite(approx) || approx <= 0) && Number.isFinite(ratio) && ratio > 0 && this.contextWindow > 0) {
        this.contextApproxTokens = Math.round(this.contextWindow * ratio);
      }
      if (data.context_pressure) {
        this.contextPressure = data.context_pressure;
      } else {
        this.refreshContextPressure();
      }
    },

    inferContextWindowFromModelId(modelId) {
      var value = String(modelId || '').toLowerCase();
      if (!value) return 0;
      var explicitK = value.match(/(?:^|[^0-9])([0-9]{2,4})k(?:[^a-z0-9]|$)/);
      if (explicitK && explicitK[1]) {
        var parsedK = Number(explicitK[1]);
        if (Number.isFinite(parsedK) && parsedK > 0) return parsedK * 1000;
      }
      var explicitM = value.match(/(?:^|[^0-9])([0-9]{1,3})m(?:[^a-z0-9]|$)/);
      if (explicitM && explicitM[1]) {
        var parsedM = Number(explicitM[1]);
        if (Number.isFinite(parsedM) && parsedM > 0) return parsedM * 1000000;
      }
      if (value.indexOf('qwen2.5') >= 0 || value.indexOf('qwen3') >= 0) return 131072;
      if (value.indexOf('kimi') >= 0 || value.indexOf('moonshot') >= 0) return 262144;
      if (value.indexOf('llama-3.3') >= 0 || value.indexOf('llama3.3') >= 0) return 131072;
      if (value.indexOf('llama-3.2') >= 0 || value.indexOf('llama3.2') >= 0) return 128000;
      if (value.indexOf('mistral-nemo') >= 0 || value.indexOf('mixtral') >= 0) return 32000;
      return 0;
    },

    refreshContextWindowMap(models) {
      var next = {};
      var rows = Array.isArray(models) ? models : [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i] || {};
        var id = String(row.id || '').trim();
        if (!id) continue;
        var windowSize = Number(row.context_window || row.context_window_tokens || 0);
        if (!Number.isFinite(windowSize) || windowSize <= 0) {
          windowSize = this.inferContextWindowFromModelId(id);
        }
        if (Number.isFinite(windowSize) && windowSize > 0) {
          next[id] = Math.round(windowSize);
        }
      }
      this._contextWindowByModel = next;
    },

    setContextWindowFromCurrentAgent() {
      var agent = this.currentAgent || {};
      var direct = Number(agent.context_window || agent.context_window_tokens || 0);
      if (Number.isFinite(direct) && direct > 0) {
        this.contextWindow = Math.round(direct);
        this.refreshContextPressure();
        return;
      }
      var modelName = String(agent.model_name || agent.runtime_model || '').trim();
      var fromMap = Number((this._contextWindowByModel || {})[modelName] || 0);
      if (Number.isFinite(fromMap) && fromMap > 0) {
        this.contextWindow = Math.round(fromMap);
        this.refreshContextPressure();
        return;
      }
      var inferred = this.inferContextWindowFromModelId(modelName);
      if (Number.isFinite(inferred) && inferred > 0) {
        this.contextWindow = Math.round(inferred);
        this.refreshContextPressure();
      }
    },

    refreshContextPressure() {
      var windowSize = Number(this.contextWindow || 0);
      var used = Number(this.contextApproxTokens || 0);
      if (!Number.isFinite(windowSize) || windowSize <= 0 || !Number.isFinite(used) || used < 0) return;
      var ratio = used / windowSize;
      if (ratio >= 0.96) this.contextPressure = 'critical';
      else if (ratio >= 0.82) this.contextPressure = 'high';
      else if (ratio >= 0.55) this.contextPressure = 'medium';
      else this.contextPressure = 'low';
    },

    fetchModelContextWindows(force) {
      var now = Date.now();
      if (!force && this._contextModelsFetchedAt && (now - this._contextModelsFetchedAt) < 300000) {
        this.setContextWindowFromCurrentAgent();
        return Promise.resolve();
      }
      var self = this;
      return OpenFangAPI.get('/api/models').then(function(data) {
        self.refreshContextWindowMap(data && data.models ? data.models : []);
        self._contextModelsFetchedAt = Date.now();
        self.setContextWindowFromCurrentAgent();
      }).catch(function() {});
    },

    requestContextTelemetry(force) {
      if (!this.currentAgent || !OpenFangAPI.isWsConnected()) return false;
      var now = Date.now();
      if (!force && (now - Number(this._lastContextRequestAt || 0)) < 2500) return false;
      this._lastContextRequestAt = now;
      return !!OpenFangAPI.wsSend({ type: 'command', command: 'context', silent: true });
    },

    loadModelNoticeCache: function() {
      try {
        var raw = localStorage.getItem(this.modelNoticeCacheKey);
        if (!raw) {
          this.modelNoticeCache = {};
          return;
        }
        var parsed = JSON.parse(raw);
        this.modelNoticeCache = (parsed && typeof parsed === 'object') ? parsed : {};
      } catch {
        this.modelNoticeCache = {};
      }
    },

    persistModelNoticeCache: function() {
      try {
        localStorage.setItem(this.modelNoticeCacheKey, JSON.stringify(this.modelNoticeCache || {}));
      } catch {}
    },

    rememberModelNotice: function(agentId, label, ts) {
      if (!agentId || !label) return;
      if (!this.modelNoticeCache || typeof this.modelNoticeCache !== 'object') {
        this.modelNoticeCache = {};
      }
      var key = String(agentId);
      if (!Array.isArray(this.modelNoticeCache[key])) this.modelNoticeCache[key] = [];
      var list = this.modelNoticeCache[key];
      var tsNum = Number(ts || Date.now());
      var exists = list.some(function(entry) {
        return entry && entry.label === label && Number(entry.ts || 0) === tsNum;
      });
      if (!exists) list.push({ label: label, ts: tsNum });
      if (list.length > 120) this.modelNoticeCache[key] = list.slice(list.length - 120);
      this.persistModelNoticeCache();
    },

    mergeModelNoticesForAgent: function(agentId, rows) {
      var list = Array.isArray(rows) ? rows.slice() : [];
      if (!agentId || !this.modelNoticeCache) return list;
      var notices = this.modelNoticeCache[String(agentId)];
      if (!Array.isArray(notices) || !notices.length) return list;
      var existing = {};
      list.forEach(function(msg) {
        if (!msg) return;
        var label = msg.notice_label || '';
        if (!label && msg.role === 'system' && typeof msg.text === 'string' && /^Model switched to /i.test(msg.text.trim())) {
          label = msg.text.trim();
        }
        if (!label) return;
        existing[label + '|' + Number(msg.ts || 0)] = true;
      });
      for (var i = 0; i < notices.length; i++) {
        var n = notices[i] || {};
        var nLabel = String(n.label || '').trim();
        if (!nLabel) continue;
        var nTs = Number(n.ts || 0) || Date.now();
        var nKey = nLabel + '|' + nTs;
        if (existing[nKey]) continue;
        list.push({
          id: ++msgId,
          role: 'system',
          text: '',
          meta: '',
          tools: [],
          is_notice: true,
          notice_label: nLabel,
          ts: nTs
        });
      }
      list.sort(function(a, b) {
        return Number((a && a.ts) || 0) - Number((b && b.ts) || 0);
      });
      return list;
    },

    normalizeSessionMessages(data) {
      var source = [];
      if (data && Array.isArray(data.messages)) {
        source = data.messages;
      } else if (data && Array.isArray(data.turns)) {
        var turns = data.turns;
        var turnRows = [];
        turns.forEach(function(turn) {
          var ts = turn && turn.ts ? turn.ts : Date.now();
          if (turn && typeof turn.user === 'string' && turn.user.trim()) {
            turnRows.push({ role: 'User', content: turn.user, ts: ts });
          }
          if (turn && typeof turn.assistant === 'string' && turn.assistant.trim()) {
            turnRows.push({ role: 'Agent', content: turn.assistant, ts: ts });
          }
        });
        source = turnRows;
      } else {
        source = [];
      }
      var self = this;
      return source.map(function(m) {
        var roleRaw = String((m && (m.role || m.type)) || '').toLowerCase();
        var isTerminal = roleRaw.indexOf('terminal') >= 0 || !!(m && m.terminal);
        var role = isTerminal
          ? 'terminal'
          : (roleRaw.indexOf('user') >= 0 ? 'user' : (roleRaw.indexOf('system') >= 0 ? 'system' : 'agent'));
        var textSource = m && (m.content != null ? m.content : (m.text != null ? m.text : m.message));
        if (role === 'user' && m && m.user != null) textSource = m.user;
        if (role !== 'user' && !isTerminal && m && m.assistant != null) textSource = m.assistant;
        var text = typeof textSource === 'string' ? textSource : JSON.stringify(textSource || '');
        text = self.sanitizeToolText(text);
        if (role === 'agent') text = self.stripModelPrefix(text);

        var tools = (m && Array.isArray(m.tools) ? m.tools : []).map(function(t, idx) {
          return {
            id: (t.name || 'tool') + '-hist-' + idx,
            name: t.name || 'unknown',
            running: false,
            expanded: false,
            input: t.input || '',
            result: t.result || '',
            is_error: !!t.is_error
          };
        });
        var images = (m && Array.isArray(m.images) ? m.images : []).map(function(img) {
          return { file_id: img.file_id, filename: img.filename || 'image' };
        });
        var tsRaw = m && (m.ts || m.timestamp || m.created_at || m.createdAt) ? (m.ts || m.timestamp || m.created_at || m.createdAt) : null;
        var ts = null;
        if (typeof tsRaw === 'number') {
          ts = tsRaw;
        } else if (typeof tsRaw === 'string') {
          var parsedTs = Date.parse(tsRaw);
          ts = Number.isNaN(parsedTs) ? null : parsedTs;
        }
        var meta = typeof (m && m.meta) === 'string' ? m.meta : '';
        if (!meta && m && (m.input_tokens || m.output_tokens)) {
          meta = (m.input_tokens || 0) + ' in / ' + (m.output_tokens || 0) + ' out';
        }
        var isNotice = false;
        var noticeLabel = '';
        if (role === 'system' && typeof text === 'string') {
          var compact = text.trim();
          if (/^Model switched to /i.test(compact)) {
            isNotice = true;
            noticeLabel = compact;
            text = '';
          }
        }
        return {
          id: ++msgId,
          role: role,
          text: text,
          meta: meta,
          tools: tools,
          images: images,
          ts: ts,
          is_notice: isNotice,
          notice_label: noticeLabel,
          terminal: isTerminal,
          cwd: m && m.cwd ? String(m.cwd) : '',
          agent_id: m && m.agent_id ? String(m.agent_id) : '',
          agent_name: m && m.agent_name ? String(m.agent_name) : ''
        };
      });
    },

    init() {
      var self = this;

      if (typeof window !== 'undefined') {
        window.__infringChatCache = window.__infringChatCache || {};
        var persistedCache = this.loadConversationCache();
        var runtimeCache = window.__infringChatCache || {};
        this.conversationCache = Object.assign({}, persistedCache, runtimeCache);
        window.__infringChatCache = this.conversationCache;
      }
      this.loadModelNoticeCache();

      // Start tip cycle
      this.startTipCycle();

      // Fetch dynamic commands from server
      this.fetchCommands();
      this.fetchModelContextWindows();

      // Ctrl+/ keyboard shortcut
      document.addEventListener('keydown', function(e) {
        var key = String(e && e.key ? e.key : '').toLowerCase();
        // Ctrl+T or Ctrl+\ toggles terminal compose mode.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (key === 't' || key === '\\') && self.currentAgent) {
          e.preventDefault();
          self.toggleTerminalMode();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
          e.preventDefault();
          var input = document.getElementById('msg-input');
          if (input) { input.focus(); self.inputText = '/'; }
        }
        // Ctrl+M for model switcher
        if ((e.ctrlKey || e.metaKey) && e.key === 'm' && self.currentAgent) {
          e.preventDefault();
          self.toggleModelSwitcher();
        }
        // Ctrl+F opens file picker from chat compose.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'f' && self.currentAgent) {
          e.preventDefault();
          if (self.terminalMode) {
            self.toggleTerminalMode();
          }
          self.showAttachMenu = true;
          self.$nextTick(function() {
            var input = self.$refs && self.$refs.fileInput ? self.$refs.fileInput : null;
            if (input && typeof input.click === 'function') input.click();
          });
          return;
        }
        // Ctrl+G for chat search
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'g' && self.currentAgent) {
          e.preventDefault();
          self.toggleSearch();
        }
      });

      // Load session + session list when agent changes
      this.$watch('currentAgent', function(agent) {
        if (agent) {
          self.loadSessions(agent.id);
          self.setContextWindowFromCurrentAgent();
          self.requestContextTelemetry(true);
        }
      });

      // Check for pending agent from Agents page (set before chat mounted)
      var store = Alpine.store('app');
      if (store.pendingAgent) {
        self.selectAgent(store.pendingAgent);
        store.pendingAgent = null;
      } else if (store.activeAgentId) {
        self.selectAgent(store.activeAgentId);
      } else {
        var preferred = self.pickDefaultAgent(store.agents || []);
        if (preferred) self.selectAgent(preferred);
      }

      // Watch for future pending agent selections (e.g., user clicks agent while on chat)
      this.$watch('$store.app.pendingAgent', function(agent) {
        if (agent) {
          self.selectAgent(agent);
          Alpine.store('app').pendingAgent = null;
        }
      });

      // Keep chat selection synced when an explicit active agent is set globally.
      this.$watch('$store.app.activeAgentId', function(agentId) {
        if (!agentId) return;
        if (!self.currentAgent || self.currentAgent.id !== agentId) {
          self.selectAgent(agentId);
        }
      });

      // Auto-select the first available agent in chat mode.
      this.$watch('$store.app.agents', function(agents) {
        var store = Alpine.store('app');
        var rows = Array.isArray(agents) ? agents : [];
        self.fetchModelContextWindows();
        if (self.currentAgent && self.currentAgent.id) {
          var currentLive = null;
          for (var ai = 0; ai < rows.length; ai++) {
            if (rows[ai] && String(rows[ai].id) === String(self.currentAgent.id)) {
              currentLive = rows[ai];
              break;
            }
          }
          if (!currentLive) {
            self.handleAgentInactive(self.currentAgent.id, 'inactive', { silentNotice: true });
          } else {
            self.currentAgent = currentLive;
          }
        }
        if (store.activeAgentId) {
          var resolved = self.resolveAgent(store.activeAgentId);
          if (resolved) {
            if (!self.currentAgent || self.currentAgent.id !== resolved.id) {
              self.selectAgent(resolved);
            } else {
              // Refresh visible metadata without resetting the thread.
              self.currentAgent = resolved;
            }
            return;
          }
        }
        if (!self.currentAgent) {
          var preferred = self.pickDefaultAgent(agents || []);
          if (preferred) self.selectAgent(preferred);
        }
      });

      // Watch for slash commands + model autocomplete
      this.$watch('inputText', function(val) {
        if (self.terminalMode) {
          self.updateTerminalCursor();
          self.showSlashMenu = false;
          self.showModelPicker = false;
          return;
        }
        var modelMatch = val.match(/^\/model\s+(.*)$/i);
        if (modelMatch) {
          self.showSlashMenu = false;
          self.modelPickerFilter = modelMatch[1].toLowerCase();
          if (!self.modelPickerList.length) {
            OpenFangAPI.get('/api/models').then(function(data) {
              self.modelPickerList = (data.models || []).filter(function(m) { return m.available; });
              self.showModelPicker = true;
              self.modelPickerIdx = 0;
            }).catch(function() {});
          } else {
            self.showModelPicker = true;
          }
        } else if (val.startsWith('/')) {
          self.showModelPicker = false;
          self.slashFilter = val.slice(1).toLowerCase();
          self.showSlashMenu = true;
          self.slashIdx = 0;
        } else {
          self.showSlashMenu = false;
          self.showModelPicker = false;
        }
      });

      this.$nextTick(function() {
        self.handleMessagesScroll();
        self.installChatMapWheelLock();
      });

      OpenFangAPI.get('/api/status').then(function(status) {
        var suggested = status && (status.workspace_dir || status.root_dir || status.home_dir)
          ? String(status.workspace_dir || status.root_dir || status.home_dir)
          : '';
        if (suggested) self.terminalCwd = suggested;
      }).catch(function() {});

      if (this._contextTelemetryTimer) clearInterval(this._contextTelemetryTimer);
      this._contextTelemetryTimer = setInterval(function() {
        self.requestContextTelemetry(false);
      }, 8000);
    },

    toggleTerminalMode() {
      this.terminalMode = !this.terminalMode;
      this.showSlashMenu = false;
      this.showModelPicker = false;
      this.showModelSwitcher = false;
      this.terminalCursorFocused = false;
      if (!this.terminalMode) this.terminalSelectionStart = 0;
      if (this.terminalMode && !this.terminalCwd) {
        this.terminalCwd = '/Users/jay/.openclaw/workspace';
      }
      if (this.terminalMode && this.currentAgent) {
        this.connectWs(this.currentAgent.id);
      }
      if (this.terminalMode && Array.isArray(this.attachments) && this.attachments.length) {
        for (var i = 0; i < this.attachments.length; i++) {
          if (this.attachments[i] && this.attachments[i].preview) {
            try { URL.revokeObjectURL(this.attachments[i].preview); } catch(_) {}
          }
        }
        this.attachments = [];
      }
      var self = this;
      this.$nextTick(function() {
        var input = document.getElementById('msg-input');
        if (input) {
          input.focus();
          if (self.terminalMode) {
            self.setTerminalCursorFocus(true, { target: input });
            self.updateTerminalCursor({ target: input });
          }
        }
        self.scheduleConversationPersist();
      });
    },

    setTerminalCursorFocus(active, event) {
      if (!this.terminalMode) {
        this.terminalCursorFocused = false;
        return;
      }
      this.terminalCursorFocused = !!active;
      if (this.terminalCursorFocused) this.updateTerminalCursor(event);
    },

    updateTerminalCursor(event) {
      if (!this.terminalMode) {
        this.terminalSelectionStart = 0;
        return;
      }
      var text = String(this.inputText || '');
      var active = (typeof document !== 'undefined' && document.activeElement && document.activeElement.id === 'msg-input')
        ? document.activeElement
        : null;
      var el = event && event.target ? event.target : (active || document.getElementById('msg-input'));
      var pos = text.length;
      if (el && Number.isFinite(Number(el.selectionStart))) pos = Number(el.selectionStart);
      if (!Number.isFinite(pos) || pos < 0) pos = text.length;
      if (pos > text.length) pos = text.length;
      this.terminalSelectionStart = Math.floor(pos);
    },

    installChatMapWheelLock() {
      var maps = document.querySelectorAll('.chat-map-scroll');
      if (!maps || !maps.length) return;
      for (var i = 0; i < maps.length; i++) {
        var map = maps[i];
        if (!map || map.__ofWheelLock) continue;
        map.__ofWheelLock = true;
        map.addEventListener('wheel', function(ev) {
          var target = ev.currentTarget;
          if (!target) return;
          if (!target.matches(':hover')) return;
          // Keep wheel behavior scoped to chat map so the page does not scroll beneath it.
          var delta = Number(ev.deltaY || 0);
          if (delta !== 0) {
            target.scrollTop += delta;
          }
          ev.preventDefault();
        }, { passive: false });
      }
    },

    get filteredModelPicker() {
      if (!this.modelPickerFilter) return this.modelPickerList.slice(0, 15);
      var f = this.modelPickerFilter;
      return this.modelPickerList.filter(function(m) {
        return m.id.toLowerCase().indexOf(f) !== -1 || (m.display_name || '').toLowerCase().indexOf(f) !== -1 || m.provider.toLowerCase().indexOf(f) !== -1;
      }).slice(0, 15);
    },

    pickModel(modelId) {
      this.showModelPicker = false;
      this.inputText = '/model ' + modelId;
      this.sendMessage();
    },

    toggleModelSwitcher() {
      if (this.showModelSwitcher) { this.showModelSwitcher = false; return; }
      var self = this;
      var now = Date.now();
      if (this._modelCache && (now - this._modelCacheTime) < 300000) {
        this.modelSwitcherFilter = '';
        this.modelSwitcherProviderFilter = '';
        this.modelSwitcherIdx = 0;
        this.showModelSwitcher = true;
        this.$nextTick(function() {
          var el = document.getElementById('model-switcher-search');
          if (el) el.focus();
        });
        return;
      }
      OpenFangAPI.get('/api/models').then(function(data) {
        var models = (data.models || []).filter(function(m) { return m.available; });
        self._modelCache = models;
        self._modelCacheTime = Date.now();
        self.modelPickerList = models;
        self.modelSwitcherFilter = '';
        self.modelSwitcherProviderFilter = '';
        self.modelSwitcherIdx = 0;
        self.showModelSwitcher = true;
        self.$nextTick(function() {
          var el = document.getElementById('model-switcher-search');
          if (el) el.focus();
        });
      }).catch(function(e) {
        OpenFangToast.error('Failed to load models: ' + e.message);
      });
    },

    switchModel(model) {
      if (!this.currentAgent) return;
      if (model.id === this.currentAgent.model_name) { this.showModelSwitcher = false; return; }
      var self = this;
      this.modelSwitching = true;
      OpenFangAPI.put('/api/agents/' + this.currentAgent.id + '/model', { model: model.id }).then(function(resp) {
        // Use server-resolved model/provider to stay in sync (fixes #387/#466)
        self.currentAgent.model_name = (resp && resp.model) || model.id;
        self.currentAgent.model_provider = (resp && resp.provider) || model.provider;
        self.addModelSwitchNotice(self.currentAgent.model_name, self.currentAgent.model_provider);
        OpenFangToast.success('Switched to ' + (model.display_name || model.id));
        self.showModelSwitcher = false;
        self.modelSwitching = false;
      }).catch(function(e) {
        OpenFangToast.error('Switch failed: ' + e.message);
        self.modelSwitching = false;
      });
    },

    // Fetch dynamic slash commands from server
    fetchCommands: function() {
      var self = this;
      OpenFangAPI.get('/api/commands').then(function(data) {
        if (data.commands && data.commands.length) {
          // Build a set of known cmds to avoid duplicates
          var existing = {};
          self.slashCommands.forEach(function(c) { existing[c.cmd] = true; });
          data.commands.forEach(function(c) {
            if (!existing[c.cmd]) {
              self.slashCommands.push({ cmd: c.cmd, desc: c.desc || '', source: c.source || 'server' });
              existing[c.cmd] = true;
            }
          });
        }
      }).catch(function() { /* silent — use hardcoded list */ });
    },

    get filteredSlashCommands() {
      if (!this.slashFilter) return this.slashCommands;
      var f = this.slashFilter;
      return this.slashCommands.filter(function(c) {
        return c.cmd.toLowerCase().indexOf(f) !== -1 || c.desc.toLowerCase().indexOf(f) !== -1;
      });
    },

    // Clear any stuck typing indicator after 120s
    _resetTypingTimeout: function() {
      var self = this;
      if (self._typingTimeout) clearTimeout(self._typingTimeout);
      self._typingTimeout = setTimeout(function() {
        // Auto-clear stuck typing indicators
        self.messages = self.messages.filter(function(m) { return !m.thinking; });
        self.sending = false;
      }, 120000);
    },

    _clearTypingTimeout: function() {
      if (this._typingTimeout) {
        clearTimeout(this._typingTimeout);
        this._typingTimeout = null;
      }
    },

    executeSlashCommand(cmd, cmdArgs) {
      this.showSlashMenu = false;
      this.inputText = '';
      var self = this;
      cmdArgs = cmdArgs || '';
      switch (cmd) {
        case '/help':
          self.messages.push({ id: ++msgId, role: 'system', text: self.slashCommands.map(function(c) { return '`' + c.cmd + '` — ' + c.desc; }).join('\n'), meta: '', tools: [] });
          self.scrollToBottom();
          break;
        case '/agents':
          location.hash = 'agents';
          break;
        case '/new':
          if (self.currentAgent) {
            OpenFangAPI.post('/api/agents/' + self.currentAgent.id + '/session/reset', {}).then(function() {
              self.messages = [];
              OpenFangToast.success('Session reset');
            }).catch(function(e) { OpenFangToast.error('Reset failed: ' + e.message); });
          }
          break;
        case '/compact':
          if (self.currentAgent) {
            self.messages.push({ id: ++msgId, role: 'system', text: 'Compacting session...', meta: '', tools: [] });
            OpenFangAPI.post('/api/agents/' + self.currentAgent.id + '/session/compact', {}).then(function(res) {
              self.messages.push({ id: ++msgId, role: 'system', text: res.message || 'Compaction complete', meta: '', tools: [] });
              self.scrollToBottom();
            }).catch(function(e) { OpenFangToast.error('Compaction failed: ' + e.message); });
          }
          break;
        case '/stop':
          self.stopAgent();
          break;
        case '/usage':
          if (self.currentAgent) {
            var approxTokens = self.messages.reduce(function(sum, m) { return sum + Math.round((m.text || '').length / 4); }, 0);
            self.messages.push({ id: ++msgId, role: 'system', text: '**Session Usage**\n- Messages: ' + self.messages.length + '\n- Approx tokens: ~' + approxTokens, meta: '', tools: [] });
            self.scrollToBottom();
          }
          break;
        case '/think':
          if (cmdArgs === 'on') {
            self.thinkingMode = 'on';
          } else if (cmdArgs === 'off') {
            self.thinkingMode = 'off';
          } else if (cmdArgs === 'stream') {
            self.thinkingMode = 'stream';
          } else {
            // Cycle: off -> on -> stream -> off
            if (self.thinkingMode === 'off') self.thinkingMode = 'on';
            else if (self.thinkingMode === 'on') self.thinkingMode = 'stream';
            else self.thinkingMode = 'off';
          }
          var modeLabel = self.thinkingMode === 'stream' ? 'enabled (streaming reasoning)' : (self.thinkingMode === 'on' ? 'enabled' : 'disabled');
          self.messages.push({ id: ++msgId, role: 'system', text: 'Extended thinking **' + modeLabel + '**. ' +
            (self.thinkingMode === 'stream' ? 'Reasoning tokens will appear in a collapsible panel.' :
             self.thinkingMode === 'on' ? 'The agent will show its reasoning when supported by the model.' :
             'Normal response mode.'), meta: '', tools: [] });
          self.scrollToBottom();
          break;
        case '/context':
          // Visual-only update for context ring; no chat message noise.
          if (self.currentAgent && OpenFangAPI.isWsConnected()) {
            OpenFangAPI.wsSend({ type: 'command', command: 'context', args: '', silent: true });
          } else {
            self.recomputeContextEstimate();
            self.setContextWindowFromCurrentAgent();
          }
          break;
        case '/verbose':
          if (self.currentAgent && OpenFangAPI.isWsConnected()) {
            OpenFangAPI.wsSend({ type: 'command', command: 'verbose', args: cmdArgs });
          } else {
            self.messages.push({ id: ++msgId, role: 'system', text: 'Not connected. Connect to an agent first.', meta: '', tools: [] });
            self.scrollToBottom();
          }
          break;
        case '/queue':
          if (self.currentAgent && OpenFangAPI.isWsConnected()) {
            OpenFangAPI.wsSend({ type: 'command', command: 'queue', args: '' });
          } else {
            self.messages.push({ id: ++msgId, role: 'system', text: 'Not connected.', meta: '', tools: [] });
            self.scrollToBottom();
          }
          break;
        case '/status':
          OpenFangAPI.get('/api/status').then(function(s) {
            self.messages.push({ id: ++msgId, role: 'system', text: '**System Status**\n- Agents: ' + (s.agent_count || 0) + '\n- Uptime: ' + (s.uptime_seconds || 0) + 's\n- Version: ' + (s.version || '?'), meta: '', tools: [] });
            self.scrollToBottom();
          }).catch(function() {});
          break;
        case '/model':
          if (self.currentAgent) {
            if (cmdArgs) {
              OpenFangAPI.put('/api/agents/' + self.currentAgent.id + '/model', { model: cmdArgs }).then(function(resp) {
                // Use server-resolved model/provider (fixes #387/#466)
                var resolvedModel = (resp && resp.model) || cmdArgs;
                var resolvedProvider = (resp && resp.provider) || '';
                self.currentAgent.model_name = resolvedModel;
                if (resolvedProvider) { self.currentAgent.model_provider = resolvedProvider; }
                self.addModelSwitchNotice(resolvedModel, resolvedProvider || self.currentAgent.model_provider || '');
              }).catch(function(e) { OpenFangToast.error('Model switch failed: ' + e.message); });
            } else {
              self.messages.push({ id: ++msgId, role: 'system', text: '**Current Model**\n- Provider: `' + (self.currentAgent.model_provider || '?') + '`\n- Model: `' + (self.currentAgent.model_name || '?') + '`', meta: '', tools: [] });
              self.scrollToBottom();
            }
          } else {
            self.messages.push({ id: ++msgId, role: 'system', text: 'No agent selected.', meta: '', tools: [] });
            self.scrollToBottom();
          }
          break;
        case '/clear':
          self.messages = [];
          break;
        case '/exit':
          OpenFangAPI.wsDisconnect();
          self._wsAgent = null;
          self.currentAgent = null;
          Alpine.store('app').activeAgentId = null;
          self.messages = [];
          window.dispatchEvent(new Event('close-chat'));
          break;
        case '/budget':
          OpenFangAPI.get('/api/budget').then(function(b) {
            var fmt = function(v) { return v > 0 ? '$' + v.toFixed(2) : 'unlimited'; };
            self.messages.push({ id: ++msgId, role: 'system', text: '**Budget Status**\n' +
              '- Hourly: $' + (b.hourly_spend||0).toFixed(4) + ' / ' + fmt(b.hourly_limit) + '\n' +
              '- Daily: $' + (b.daily_spend||0).toFixed(4) + ' / ' + fmt(b.daily_limit) + '\n' +
              '- Monthly: $' + (b.monthly_spend||0).toFixed(4) + ' / ' + fmt(b.monthly_limit), meta: '', tools: [] });
            self.scrollToBottom();
          }).catch(function() {});
          break;
        case '/peers':
          OpenFangAPI.get('/api/network/status').then(function(ns) {
            self.messages.push({ id: ++msgId, role: 'system', text: '**OFP Network**\n' +
              '- Status: ' + (ns.enabled ? 'Enabled' : 'Disabled') + '\n' +
              '- Connected peers: ' + (ns.connected_peers||0) + ' / ' + (ns.total_peers||0), meta: '', tools: [] });
            self.scrollToBottom();
          }).catch(function() {});
          break;
        case '/a2a':
          OpenFangAPI.get('/api/a2a/agents').then(function(res) {
            var agents = res.agents || [];
            if (!agents.length) {
              self.messages.push({ id: ++msgId, role: 'system', text: 'No external A2A agents discovered.', meta: '', tools: [] });
            } else {
              var lines = agents.map(function(a) { return '- **' + a.name + '** — ' + a.url; });
              self.messages.push({ id: ++msgId, role: 'system', text: '**A2A Agents (' + agents.length + ')**\n' + lines.join('\n'), meta: '', tools: [] });
            }
            self.scrollToBottom();
          }).catch(function() {});
          break;
      }
      this.scheduleConversationPersist();
    },

    selectAgent(agent) {
      var resolved = this.resolveAgent(agent);
      if (!resolved) return;
      this.clearHoveredMessageHard();
      this.activeMapPreviewDomId = '';
      this.activeMapPreviewDayKey = '';
      if (this.currentAgent && this.currentAgent.id && this.currentAgent.id !== resolved.id) {
        this.cacheAgentConversation(this.currentAgent.id);
      }
      if (this.currentAgent && this.currentAgent.id === resolved.id) {
        this.currentAgent = resolved;
        this.loadSession(resolved.id, true);
        return;
      }
      this.currentAgent = resolved;
      Alpine.store('app').activeAgentId = resolved.id || null;
      this.setContextWindowFromCurrentAgent();
      var restored = this.restoreAgentConversation(resolved.id);
      if (!restored) this.messages = [];
      this.connectWs(resolved.id);
      // Show welcome tips on first use
      if (!restored && !localStorage.getItem('of-chat-tips-seen')) {
        this.messages.push({
          id: ++msgId,
          role: 'system',
          text: '**Welcome to OpenFang Chat!**\n\n' +
            '- Type `/` to see available commands\n' +
            '- `/help` shows all commands\n' +
            '- `/think on` enables extended reasoning\n' +
            '- `/context` shows context window usage\n' +
            '- `/verbose off` hides tool details\n' +
            '- `Ctrl+Shift+F` toggles focus mode\n' +
            '- `Ctrl+F` opens file picker\n' +
            '- Drag & drop files to attach them\n' +
            '- `Ctrl+/` opens the command palette',
          meta: '',
          tools: []
        });
        localStorage.setItem('of-chat-tips-seen', 'true');
      }
      this.loadSession(resolved.id, restored);
      this.loadSessions(resolved.id);
      this.requestContextTelemetry(true);
      if (this.showAgentDrawer) {
        this.openAgentDrawer();
      }
      // Focus input after agent selection
      var self = this;
      this.$nextTick(function() {
        var el = document.getElementById('msg-input');
        if (el) el.focus();
        self.installChatMapWheelLock();
      });
    },

    async loadSession(agentId, keepCurrent) {
      var self = this;
      try {
        var data = await OpenFangAPI.get('/api/agents/' + agentId + '/session');
        var normalized = self.mergeModelNoticesForAgent(agentId, self.normalizeSessionMessages(data));
        if (normalized.length) {
          if (!keepCurrent || !self.messages || !self.messages.length || normalized.length >= self.messages.length) {
            self.messages = normalized;
            self.clearHoveredMessageHard();
            self.activeMapPreviewDomId = '';
            self.activeMapPreviewDayKey = '';
            self.recomputeContextEstimate();
          }
          self.cacheAgentConversation(agentId);
          self.$nextTick(function() { self.scrollToBottom(); });
        } else if (!keepCurrent) {
          self.messages = [];
          self.clearHoveredMessageHard();
          self.activeMapPreviewDomId = '';
          self.activeMapPreviewDayKey = '';
          self.recomputeContextEstimate();
          self.cacheAgentConversation(agentId);
        }
      } catch(e) { /* silent */ }
    },

    // Multi-session: load session list for current agent
    async loadSessions(agentId) {
      try {
        var data = await OpenFangAPI.get('/api/agents/' + agentId + '/sessions');
        this.sessions = data.sessions || [];
      } catch(e) { this.sessions = []; }
    },

    // Multi-session: create a new session
    async createSession() {
      if (!this.currentAgent) return;
      this.cacheCurrentConversation();
      var label = prompt('Session name (optional):');
      if (label === null) return; // cancelled
      try {
        await OpenFangAPI.post('/api/agents/' + this.currentAgent.id + '/sessions', {
          label: label.trim() || undefined
        });
        await this.loadSessions(this.currentAgent.id);
        await this.loadSession(this.currentAgent.id);
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.success('New session created');
      } catch(e) {
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.error('Failed to create session');
      }
    },

    // Multi-session: switch to an existing session
    async switchSession(sessionId) {
      if (!this.currentAgent) return;
      this.cacheCurrentConversation();
      try {
        await OpenFangAPI.post('/api/agents/' + this.currentAgent.id + '/sessions/' + sessionId + '/switch', {});
        await this.loadSession(this.currentAgent.id);
        await this.loadSessions(this.currentAgent.id);
        // Reconnect WebSocket for new session
        this._wsAgent = null;
        this.connectWs(this.currentAgent.id);
      } catch(e) {
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.error('Failed to switch session');
      }
    },

    connectWs(agentId) {
      if (this._wsAgent === agentId && OpenFangAPI.isWsConnected()) return;
      this._wsAgent = agentId;
      var self = this;

      OpenFangAPI.wsConnect(agentId, {
        onOpen: function() {
          Alpine.store('app').wsConnected = true;
          self.requestContextTelemetry(true);
        },
        onMessage: function(data) { self.handleWsMessage(data); },
        onClose: function() {
          Alpine.store('app').wsConnected = false;
          self._wsAgent = null;
          if (self.currentAgent && self.currentAgent.id) {
            Alpine.store('app').refreshAgents().then(function() {
              var stillLive = self.resolveAgent(self.currentAgent.id);
              if (!stillLive) {
                self.handleAgentInactive(self.currentAgent.id, 'inactive');
              }
            }).catch(function() {});
          }
        },
        onError: function() {
          Alpine.store('app').wsConnected = false;
          self._wsAgent = null;
        }
      });
    },

    formatInactiveReason: function(reason) {
      var raw = String(reason || '').trim();
      if (!raw) return 'inactive';
      raw = raw.replace(/^agent_contract_/, '');
      raw = raw.replace(/^rogue_/, '');
      raw = raw.replace(/_/g, ' ').trim();
      return raw || 'inactive';
    },

    handleAgentInactive: function(agentId, reason, options) {
      var opts = options || {};
      var targetId = String(agentId || (this.currentAgent && this.currentAgent.id) || '').trim();
      var reasonLabel = this.formatInactiveReason(reason || 'inactive');
      var noticeKey = targetId + '|' + reasonLabel;
      var self = this;

      this._clearTypingTimeout();
      this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
      this.sending = false;
      this._responseStartedAt = 0;
      this.tokenCount = 0;

      if (!opts.silentNotice && noticeKey !== this._lastInactiveNoticeKey) {
        var noticeText = opts.noticeText || '';
        if (!noticeText) {
          noticeText = targetId
            ? ('Agent ' + targetId + ' is now inactive (' + reasonLabel + ').')
            : ('Agent is now inactive (' + reasonLabel + ').');
        }
        this.messages.push({ id: ++msgId, role: 'system', text: noticeText, meta: '', tools: [], ts: Date.now() });
        this._lastInactiveNoticeKey = noticeKey;
      }

      if (targetId && this._wsAgent && String(this._wsAgent) === targetId) {
        OpenFangAPI.wsDisconnect();
        this._wsAgent = null;
      }

      if (this.currentAgent && this.currentAgent.id && (!targetId || String(this.currentAgent.id) === targetId)) {
        this.currentAgent = null;
        Alpine.store('app').activeAgentId = null;
        this.showAgentDrawer = false;
      }

      this.scrollToBottom();
      this.$nextTick(function() { self._processQueue(); });

      try { Alpine.store('app').refreshAgents(); } catch(_) {}
    },

    handleStopResponse: function(agentId, payload) {
      var result = payload && typeof payload === 'object' ? payload : {};
      var reasonRaw = String(result.reason || result.error || '').trim();
      var reason = reasonRaw || (result.contract_terminated ? 'contract_terminated' : '');
      var state = String(result.state || '').trim().toLowerCase();
      var reasonLower = reason.toLowerCase();
      var isInactive =
        !!result.archived ||
        !!result.contract_terminated ||
        state === 'inactive' ||
        state === 'archived' ||
        state === 'terminated' ||
        String(result.type || '').toLowerCase() === 'agent_archived' ||
        reasonLower.indexOf('inactive') >= 0 ||
        reasonLower.indexOf('terminated') >= 0;

      if (isInactive) {
        this.handleAgentInactive(
          agentId,
          reason || (result.contract_terminated ? 'contract_terminated' : 'inactive'),
          result.message ? { noticeText: String(result.message) } : {}
        );
        return;
      }

      this._clearTypingTimeout();
      this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
      this.messages.push({ id: ++msgId, role: 'system', text: result.message || 'Run cancelled', meta: '', tools: [], ts: Date.now() });
      this.sending = false;
      this._responseStartedAt = 0;
      this.tokenCount = 0;
      this.scrollToBottom();
      var self = this;
      this.$nextTick(function() { self._processQueue(); });
      try { Alpine.store('app').refreshAgents(); } catch(_) {}
    },

    handleWsMessage(data) {
      switch (data.type) {
        case 'connected': break;

        case 'context_state':
          this.applyContextTelemetry(data);
          break;

        // Legacy thinking event (backward compat)
        case 'thinking':
          if (!this.messages.length || !this.messages[this.messages.length - 1].thinking) {
            var thinkLabel = data.level ? 'Thinking (' + data.level + ')...' : 'Processing...';
            this.messages.push({ id: ++msgId, role: 'agent', text: '*' + thinkLabel + '*', meta: '', thinking: true, streaming: true, tools: [] });
            this.scrollToBottom();
            this._resetTypingTimeout();
          } else if (data.level) {
            var lastThink = this.messages[this.messages.length - 1];
            if (lastThink && lastThink.thinking) lastThink.text = '*Thinking (' + data.level + ')...*';
          }
          break;

        // New typing lifecycle
        case 'typing':
          if (data.state === 'start') {
            if (!this.messages.length || !this.messages[this.messages.length - 1].thinking) {
              this.messages.push({ id: ++msgId, role: 'agent', text: '*Processing...*', meta: '', thinking: true, streaming: true, tools: [] });
              this.scrollToBottom();
            }
            this._resetTypingTimeout();
          } else if (data.state === 'tool') {
            var typingMsg = this.messages.length ? this.messages[this.messages.length - 1] : null;
            if (typingMsg && (typingMsg.thinking || typingMsg.streaming)) {
              typingMsg.text = '*Using ' + (data.tool || 'tool') + '...*';
            }
            this._resetTypingTimeout();
          } else if (data.state === 'stop') {
            this._clearTypingTimeout();
          }
          break;

        case 'phase':
          // Show tool/phase progress so the user sees the agent is working
          var phaseMsg = this.messages.length ? this.messages[this.messages.length - 1] : null;
          if (phaseMsg && (phaseMsg.thinking || phaseMsg.streaming)) {
            // Skip phases that have no user-meaningful display text — "streaming"
            // and "done" are lifecycle signals, not status to show in the chat bubble.
            if (data.phase === 'streaming' || data.phase === 'done') {
              break;
            }
            // Context warning: show prominently as a separate system message
            if (data.phase === 'context_warning') {
              var cwDetail = data.detail || 'Context limit reached.';
              this.messages.push({ id: ++msgId, role: 'system', text: cwDetail, meta: '', tools: [] });
            } else if (data.phase === 'thinking' && this.thinkingMode === 'stream') {
              // Stream reasoning tokens to a collapsible panel
              if (!phaseMsg._reasoning) phaseMsg._reasoning = '';
              phaseMsg._reasoning += (data.detail || '') + '\n';
              phaseMsg.text = '<details><summary><em>Reasoning...</em></summary>\n\n' + phaseMsg._reasoning + '</details>';
            } else if (phaseMsg.thinking) {
              // Only update text on messages still in thinking state (not yet
              // receiving streamed content) to avoid overwriting accumulated text.
              var phaseDetail;
              if (data.phase === 'tool_use') {
                phaseDetail = 'Using ' + (data.detail || 'tool') + '...';
              } else if (data.phase === 'thinking') {
                phaseDetail = 'Thinking...';
              } else {
                phaseDetail = data.detail || 'Working...';
              }
              phaseMsg.text = '*' + phaseDetail + '*';
            }
          }
          this.scrollToBottom();
          break;

        case 'text_delta':
          var last = this.messages.length ? this.messages[this.messages.length - 1] : null;
          if (last && last.streaming) {
            if (last.thinking) { last.text = ''; last.thinking = false; }
            // If we already detected a text-based tool call, skip further text
            if (last._toolTextDetected) break;
            var deltaText = String(data.content || '');
            last._streamRawText = String(last._streamRawText || '') + deltaText;
            var streamingSplit = this.extractThinkingLeak(last._streamRawText);
            var visibleText = streamingSplit.content || '';
            last._cleanText = visibleText;
            last._thoughtText = streamingSplit.thought || '';
            if (streamingSplit.thought && !visibleText.trim()) {
              last.isHtml = true;
              last.thoughtStreaming = true;
              last.text = this.renderLiveThoughtHtml(streamingSplit.thought);
            } else {
              if (last.isHtml) last.isHtml = false;
              last.thoughtStreaming = false;
              last.text = visibleText;
            }
            // Detect function-call patterns streamed as text and convert to tool cards
            var toolScanText = String(last._cleanText || '');
            var fcIdx = toolScanText.search(/\w+<\/function[=,>]/);
            if (fcIdx === -1) fcIdx = toolScanText.search(/<function=\w+>/);
            if (fcIdx !== -1) {
              var fcPart = toolScanText.substring(fcIdx);
              var toolMatch = fcPart.match(/^(\w+)<\/function/) || fcPart.match(/^<function=(\w+)>/);
              var trimmedVisible = toolScanText.substring(0, fcIdx).trim();
              if (streamingSplit.thought && !trimmedVisible) {
                last.isHtml = true;
                last.thoughtStreaming = true;
                last.text = this.renderLiveThoughtHtml(streamingSplit.thought);
              } else {
                if (last.isHtml) last.isHtml = false;
                last.thoughtStreaming = false;
                last.text = trimmedVisible;
              }
              last._cleanText = trimmedVisible;
              last._toolTextDetected = true;
              if (toolMatch) {
                if (!last.tools) last.tools = [];
                var inputMatch = fcPart.match(/[=,>]\s*(\{[\s\S]*)/);
                last.tools.push({
                  id: toolMatch[1] + '-txt-' + Date.now(),
                  name: toolMatch[1],
                  running: true,
                  expanded: false,
                  input: inputMatch ? inputMatch[1].replace(/<\/function>?\s*$/, '').trim() : '',
                  result: '',
                  is_error: false
                });
              }
            }
            this.tokenCount = Math.round(String(last._cleanText || '').length / 4);
          } else {
            var firstChunk = this.stripModelPrefix(data.content || '');
            var firstSplit = this.extractThinkingLeak(firstChunk);
            var firstVisible = firstSplit.content || '';
            var firstMessage = {
              id: ++msgId,
              role: 'agent',
              text: firstVisible,
              meta: '',
              streaming: true,
              tools: [],
              _streamRawText: firstChunk,
              _cleanText: firstVisible,
              _thoughtText: firstSplit.thought || '',
              thoughtStreaming: false,
              ts: Date.now()
            };
            if (firstSplit.thought && !firstVisible.trim()) {
              firstMessage.isHtml = true;
              firstMessage.thoughtStreaming = true;
              firstMessage.text = this.renderLiveThoughtHtml(firstSplit.thought);
            }
            this.messages.push(firstMessage);
          }
          this.scrollToBottom();
          break;

        case 'tool_start':
          var lastMsg = this.messages.length ? this.messages[this.messages.length - 1] : null;
          if (lastMsg && lastMsg.streaming) {
            if (!lastMsg.tools) lastMsg.tools = [];
            lastMsg.tools.push({ id: data.tool + '-' + Date.now(), name: data.tool, running: true, expanded: false, input: '', result: '', is_error: false });
          }
          this.scrollToBottom();
          break;

        case 'tool_end':
          // Tool call parsed by LLM — update tool card with input params
          var lastMsg2 = this.messages.length ? this.messages[this.messages.length - 1] : null;
          if (lastMsg2 && lastMsg2.tools) {
            for (var ti = lastMsg2.tools.length - 1; ti >= 0; ti--) {
              if (lastMsg2.tools[ti].name === data.tool && lastMsg2.tools[ti].running) {
                lastMsg2.tools[ti].input = data.input || '';
                break;
              }
            }
          }
          break;

        case 'tool_result':
          // Tool execution completed — update tool card with result
          var lastMsg3 = this.messages.length ? this.messages[this.messages.length - 1] : null;
          if (lastMsg3 && lastMsg3.tools) {
            for (var ri = lastMsg3.tools.length - 1; ri >= 0; ri--) {
              if (lastMsg3.tools[ri].name === data.tool && lastMsg3.tools[ri].running) {
                lastMsg3.tools[ri].running = false;
                lastMsg3.tools[ri].result = data.result || '';
                lastMsg3.tools[ri].is_error = !!data.is_error;
                // Extract image URLs from image_generate or browser_screenshot results
                if ((data.tool === 'image_generate' || data.tool === 'browser_screenshot') && !data.is_error) {
                  try {
                    var parsed = JSON.parse(data.result);
                    if (parsed.image_urls && parsed.image_urls.length) {
                      lastMsg3.tools[ri]._imageUrls = parsed.image_urls;
                    }
                  } catch(e) { /* not JSON */ }
                }
                // Extract audio file path from text_to_speech results
                if (data.tool === 'text_to_speech' && !data.is_error) {
                  try {
                    var ttsResult = JSON.parse(data.result);
                    if (ttsResult.saved_to) {
                      lastMsg3.tools[ri]._audioFile = ttsResult.saved_to;
                      lastMsg3.tools[ri]._audioDuration = ttsResult.duration_estimate_ms;
                    }
                  } catch(e) { /* not JSON */ }
                }
                break;
              }
            }
          }
          this.scrollToBottom();
          break;

        case 'response':
          this._clearTypingTimeout();
          this.applyContextTelemetry(data);
          // Collect streamed text before removing streaming messages
          var streamedText = '';
          var streamedTools = [];
          var streamedThought = '';
          this.messages.forEach(function(m) {
            if (m.streaming && !m.thinking && m.role === 'agent') {
              streamedText += (typeof m._cleanText === 'string') ? m._cleanText : (m.text || '');
              if (m._thoughtText) {
                if (streamedThought) streamedThought += '\n';
                streamedThought += String(m._thoughtText).trim();
              }
              streamedTools = streamedTools.concat(m.tools || []);
            }
          });
          streamedTools.forEach(function(t) {
            t.running = false;
            // Text-detected tool calls (model leaked as text) — mark as not executed
            if (t.id && t.id.indexOf('-txt-') !== -1 && !t.result) {
              t.result = 'Model attempted this call as text (not executed via tool system)';
              t.is_error = true;
            }
          });
          this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
          var meta = (data.input_tokens || 0) + ' in / ' + (data.output_tokens || 0) + ' out';
          if (data.cost_usd != null) meta += ' | $' + data.cost_usd.toFixed(4);
          if (data.iterations) meta += ' | ' + data.iterations + ' iter';
          if (data.fallback_model) meta += ' | fallback: ' + data.fallback_model;
          var wsDurationMs = Number(data.duration_ms || data.elapsed_ms || data.response_ms || 0);
          if (!wsDurationMs && this._responseStartedAt) {
            wsDurationMs = Math.max(0, Date.now() - this._responseStartedAt);
          }
          var wsDuration = this.formatResponseDuration(wsDurationMs);
          if (wsDuration) meta += ' | ' + wsDuration;
          // Use server response if non-empty, otherwise preserve accumulated streamed text
          var finalText = (data.content && data.content.trim()) ? data.content : streamedText;
          finalText = this.stripModelPrefix(finalText);
          var finalSplit = this.extractThinkingLeak(finalText);
          if (finalSplit.thought) {
            if (!streamedThought) {
              streamedThought = finalSplit.thought;
            } else if (streamedThought.indexOf(finalSplit.thought) === -1) {
              streamedThought += '\n' + finalSplit.thought;
            }
            finalText = finalSplit.content || '';
          }
          // Strip raw function-call JSON that some models leak as text
          finalText = this.sanitizeToolText(finalText);
          var collapsedThought = String(streamedThought || '').trim();
          if (collapsedThought) {
            streamedTools.unshift(this.makeThoughtToolCard(collapsedThought));
          }
          if (!finalText.trim()) {
            finalText = this.defaultAssistantFallback(collapsedThought, streamedTools);
          }
          this.messages.push({ id: ++msgId, role: 'agent', text: finalText, meta: meta, tools: streamedTools, ts: Date.now() });
          this.sending = false;
          this._responseStartedAt = 0;
          this.tokenCount = 0;
          this.scrollToBottom();
          var self3 = this;
          this.$nextTick(function() {
            var el = document.getElementById('msg-input'); if (el) el.focus();
            self3._processQueue();
          });
          this.requestContextTelemetry(false);
          break;

        case 'silent_complete':
          // Agent intentionally chose not to reply (NO_REPLY)
          this._clearTypingTimeout();
          this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
          this.messages.push({
            id: ++msgId,
            role: 'agent',
            text: this.defaultAssistantFallback('', []),
            meta: '',
            tools: [],
            ts: Date.now()
          });
          this.sending = false;
          this._responseStartedAt = 0;
          this.tokenCount = 0;
          var selfSilent = this;
          this.$nextTick(function() { selfSilent._processQueue(); });
          break;

        case 'error':
          this._clearTypingTimeout();
          var rawError = String(data && data.content ? data.content : 'unknown_error');
          var errorText = 'Error: ' + rawError;
          var lowerError = rawError.toLowerCase();
          if (lowerError.indexOf('agent contract terminated') !== -1 || lowerError.indexOf('agent_contract_terminated') !== -1) {
            this.handleAgentInactive(
              this.currentAgent && this.currentAgent.id ? this.currentAgent.id : '',
              'contract_terminated',
              { noticeText: errorText }
            );
            break;
          }
          if (lowerError.indexOf('agent is inactive') !== -1 || lowerError.indexOf('agent_inactive') !== -1) {
            this.handleAgentInactive(
              this.currentAgent && this.currentAgent.id ? this.currentAgent.id : '',
              'inactive',
              { noticeText: errorText }
            );
            break;
          }
          this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
          this.messages.push({ id: ++msgId, role: 'system', text: errorText, meta: '', tools: [], ts: Date.now() });
          this.sending = false;
          this._responseStartedAt = 0;
          this.tokenCount = 0;
          this.scrollToBottom();
          var self2 = this;
          this.$nextTick(function() {
            var el = document.getElementById('msg-input'); if (el) el.focus();
            self2._processQueue();
          });
          break;

        case 'agent_archived':
          this.handleAgentInactive(
            data && data.agent_id ? String(data.agent_id) : (this.currentAgent && this.currentAgent.id ? this.currentAgent.id : ''),
            data && data.reason ? String(data.reason) : 'archived'
          );
          break;

        case 'agents_updated':
          if (data.agents) {
            Alpine.store('app').agents = data.agents;
            Alpine.store('app').agentCount = data.agents.length;
          }
          break;

        case 'command_result':
          this.applyContextTelemetry(data);
          var isContextTelemetryResult = Object.prototype.hasOwnProperty.call(data || {}, 'context_tokens') ||
            Object.prototype.hasOwnProperty.call(data || {}, 'context_window') ||
            Object.prototype.hasOwnProperty.call(data || {}, 'context_ratio') ||
            Object.prototype.hasOwnProperty.call(data || {}, 'context_pressure');
          if (!data.silent && !isContextTelemetryResult) {
            this.messages.push({ id: ++msgId, role: 'system', text: data.message || 'Command executed.', meta: '', tools: [] });
            this.scrollToBottom();
          }
          break;

        case 'terminal_output':
          this._clearTypingTimeout();
          this.messages = this.messages.filter(function(m) { return !(m && m.terminal && m.thinking); });
          var stdout = typeof data.stdout === 'string' ? data.stdout : '';
          var stderr = typeof data.stderr === 'string' ? data.stderr : '';
          var termText = '';
          if (stdout.trim()) termText += stdout;
          if (stderr.trim()) termText += (termText ? '\n' : '') + stderr;
          if (!termText.trim()) termText = '(no output)';
          var termMeta = 'exit ' + (Number.isFinite(Number(data.exit_code)) ? String(Number(data.exit_code)) : '1');
          var termDuration = this.formatResponseDuration(Number(data.duration_ms || 0));
          if (termDuration) termMeta += ' | ' + termDuration;
          var termCwd = this.terminalPromptPath;
          if (data.cwd) {
            termCwd = String(data.cwd);
            this.terminalCwd = termCwd;
            termMeta += ' | ' + termCwd;
          }
          this._appendTerminalMessage({
            role: 'terminal',
            text: termText,
            meta: termMeta,
            tools: [],
            ts: Date.now(),
            cwd: termCwd
          });
          this.sending = false;
          this._responseStartedAt = 0;
          this.scrollToBottom();
          this.$nextTick(() => this._processQueue());
          break;

        case 'terminal_error':
          this._clearTypingTimeout();
          this.messages = this.messages.filter(function(m) { return !(m && m.terminal && m.thinking); });
          this._appendTerminalMessage({
            role: 'terminal',
            text: 'Terminal error: ' + (data && data.message ? data.message : 'command failed'),
            meta: '',
            tools: [],
            ts: Date.now(),
            cwd: this.terminalPromptPath
          });
          this.sending = false;
          this._responseStartedAt = 0;
          this.scrollToBottom();
          this.$nextTick(() => this._processQueue());
          break;

        case 'canvas':
          // Agent presented an interactive canvas — render it in an iframe sandbox
          var canvasHtml = '<div class="canvas-panel" style="border:1px solid var(--border);border-radius:8px;margin:8px 0;overflow:hidden;">';
          canvasHtml += '<div style="padding:6px 12px;background:var(--surface);border-bottom:1px solid var(--border);font-size:0.85em;display:flex;justify-content:space-between;align-items:center;">';
          canvasHtml += '<span>' + (data.title || 'Canvas') + '</span>';
          canvasHtml += '<span style="opacity:0.5;font-size:0.8em;">' + (data.canvas_id || '').substring(0, 8) + '</span></div>';
          canvasHtml += '<iframe sandbox="allow-scripts" srcdoc="' + (data.html || '').replace(/"/g, '&quot;') + '" ';
          canvasHtml += 'style="width:100%;min-height:300px;border:none;background:#fff;" loading="lazy"></iframe></div>';
          this.messages.push({ id: ++msgId, role: 'agent', text: canvasHtml, meta: 'canvas', isHtml: true, tools: [] });
          this.scrollToBottom();
          break;

        case 'pong': break;
      }
      this.scheduleConversationPersist();
    },

    // Format timestamp for display
    formatTime: function(ts) {
      if (!ts) return '';
      var d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '';
      var h = d.getHours();
      var m = d.getMinutes();
      var ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
    },

    isSameDay: function(a, b) {
      if (!a || !b) return false;
      return (
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate()
      );
    },

    // UI-safe timestamp formatter for templates
    messageTs: function(msg) {
      if (!msg || !msg.ts) return '';
      var ts = new Date(msg.ts);
      if (Number.isNaN(ts.getTime())) return '';
      var now = new Date();
      if (this.isSameDay(ts, now)) return this.formatTime(ts);
      var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      if (this.isSameDay(ts, yesterday)) {
        return 'Yesterday at ' + this.formatTime(ts);
      }
      var dateText = ts.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return dateText + ' at ' + this.formatTime(ts);
    },

    messageDomId: function(msg, idx) {
      var suffix = (msg && msg.id != null) ? String(msg.id) : String(idx || 0);
      return 'chat-msg-' + suffix;
    },

    messageRoleClass: function(msg) {
      if (msg && msg.terminal) return 'terminal';
      if (!msg || !msg.role) return 'agent';
      return String(msg.role);
    },

    messageGroupRole: function(msg) {
      if (!msg) return '';
      if (msg.terminal) return 'terminal';
      return String(msg.role || '');
    },

    messagePreview: function(msg) {
      if (!msg) return '';
      if (msg.is_notice && msg.notice_label) {
        return String(msg.notice_label);
      }
      var raw = '';
      if (typeof msg.text === 'string' && msg.text.trim()) {
        raw = msg.text;
      } else if (Array.isArray(msg.tools) && msg.tools.length) {
        raw = 'Tool calls: ' + msg.tools.map(function(tool) {
          return tool && tool.name ? tool.name : 'tool';
        }).join(', ');
      } else {
        raw = '[' + (msg.role || 'message') + ']';
      }
      var compact = raw.replace(/\s+/g, ' ').trim();
      if (compact.length > 140) return compact.slice(0, 137) + '...';
      return compact;
    },

    messageMapPreview: function(msg) {
      if (this.messageMapMarkerType(msg) === 'tool') {
        return this.messageToolPreview(msg);
      }
      return this.messagePreview(msg);
    },

    messageToolPreview: function(msg) {
      if (!msg || !Array.isArray(msg.tools) || !msg.tools.length) {
        return this.messagePreview(msg);
      }
      var self = this;
      var compactToolText = function(value, maxLen) {
        if (value == null) return '';
        var raw = '';
        if (typeof value === 'string') {
          raw = value;
        } else {
          try {
            raw = JSON.stringify(value);
          } catch (e) {
            raw = String(value);
          }
        }
        var compact = raw.replace(/\s+/g, ' ').trim();
        if (!compact) return '';
        if (compact.length > maxLen) return compact.slice(0, maxLen - 3) + '...';
        return compact;
      };

      var parts = msg.tools.map(function(tool) {
        if (!tool) return '';
        var name = self.toolDisplayName(tool);
        var status = self.toolStatusText(tool);
        var summary = status ? (name + ' [' + status + ']') : name;
        var inputPreview = compactToolText(tool.input, 96);
        var resultPreview = compactToolText(tool.result, 120);
        var detail = '';
        if (inputPreview && resultPreview) {
          detail = inputPreview + ' -> ' + resultPreview;
        } else {
          detail = inputPreview || resultPreview;
        }
        if (detail) summary += ': ' + detail;
        return summary;
      }).filter(function(part) { return !!part; });

      if (!parts.length) return 'Tool call';
      var preview = parts.join(' | ');
      if (preview.length > 220) return preview.slice(0, 217) + '...';
      return preview;
    },

    isLongMessagePreview: function(msg) {
      if (!msg) return false;
      var raw = '';
      if (typeof msg.text === 'string' && msg.text.trim()) {
        raw = msg.text;
      } else if (Array.isArray(msg.tools) && msg.tools.length) {
        raw = msg.tools.map(function(tool) {
          return tool && tool.name ? tool.name : 'tool';
        }).join(', ');
      }
      if (!raw) return false;
      var compact = raw.replace(/\s+/g, ' ').trim();
      if (compact.length >= 220) return true;
      if (raw.indexOf('\n\n') >= 0) return true;
      return false;
    },

    isSelectedMessage: function(msg, idx) {
      if (!this.selectedMessageDomId) return false;
      return this.selectedMessageDomId === this.messageDomId(msg, idx);
    },

    truncateActorLabel: function(label, maxChars) {
      var text = String(label || '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      var limitRaw = Number(maxChars || 0);
      var limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.max(8, Math.floor(limitRaw)) : 24;
      if (text.length <= limit) return text;
      return text.slice(0, limit - 1) + '\u2026';
    },

    messageAgentLabel: function(msg) {
      var name = '';
      if (msg && msg.agent_name) name = String(msg.agent_name || '');
      if (!name && msg && msg.agent_id) {
        var resolved = this.resolveAgent(msg.agent_id);
        if (resolved && resolved.name) name = String(resolved.name || '');
      }
      if (!name && this.currentAgent && this.currentAgent.name) {
        name = String(this.currentAgent.name || '');
      }
      var shortName = this.truncateActorLabel(name, 28);
      return shortName || 'Agent';
    },

    messageActorLabel: function(msg) {
      if (!msg) return 'Message';
      if (msg.is_notice) return 'Model';
      if (msg.terminal) return 'Terminal';
      if (Array.isArray(msg.tools) && msg.tools.length && (!msg.text || !String(msg.text).trim())) {
        return 'Tool';
      }
      if (msg.role === 'user') return 'You';
      if (msg.role === 'system') return 'System';
      if (msg.role === 'agent') {
        var name = '';
        if (msg && msg.agent_name) name = String(msg.agent_name || '');
        if (!name && msg && msg.agent_id) {
          var resolved = this.resolveAgent(msg.agent_id);
          if (resolved && resolved.name) name = String(resolved.name || '');
        }
        if (!name && this.currentAgent && this.currentAgent.name) {
          name = String(this.currentAgent.name || '');
        }
        var shortName = this.truncateActorLabel(name, 24);
        if (shortName) return shortName;
      }
      return 'Agent';
    },

    messageMapToolOutcome: function(msg) {
      if (!msg || !Array.isArray(msg.tools) || !msg.tools.length) return '';
      var hasError = false;
      var hasWarning = false;
      for (var i = 0; i < msg.tools.length; i++) {
        var tool = msg.tools[i] || {};
        if (tool.running || this.isBlockedTool(tool)) {
          hasWarning = true;
          continue;
        }
        if (tool.is_error) {
          hasError = true;
        }
      }
      if (hasError) return 'error';
      if (hasWarning) return 'warning';
      return 'success';
    },

    messageMapMarkerType: function(msg) {
      if (!msg) return '';
      if (msg.is_notice) return 'model';
      if (msg.terminal) return 'terminal';
      if (Array.isArray(msg.tools) && msg.tools.length) return 'tool';
      return '';
    },

    messageMapShowMarker: function(msg) {
      return this.messageMapMarkerType(msg) !== '';
    },

    messageMapMarkerTitle: function(msg) {
      var type = this.messageMapMarkerType(msg);
      if (type === 'model') {
        return msg && msg.notice_label ? String(msg.notice_label) : 'Model switched';
      }
      if (type === 'tool') {
        var outcome = this.messageMapToolOutcome(msg) || 'success';
        if (outcome === 'error') return 'Tool call error';
        if (outcome === 'warning') return 'Tool call warning';
        return 'Tool call success';
      }
      if (type === 'terminal') {
        return 'Terminal activity';
      }
      return '';
    },

    messageDayKey: function(msg) {
      if (!msg || !msg.ts) return '';
      var d = new Date(msg.ts);
      if (Number.isNaN(d.getTime())) return '';
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    },

    messageDayLabel: function(msg) {
      if (!msg || !msg.ts) return 'Unknown day';
      var d = new Date(msg.ts);
      if (Number.isNaN(d.getTime())) return 'Unknown day';
      return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    },

    messageDayDomId: function(msg) {
      var key = this.messageDayKey(msg);
      return key ? ('chat-day-' + key) : '';
    },

    isMessageDayCollapsed: function(msg) {
      var key = this.messageDayKey(msg);
      if (!key) return false;
      return !!(this.collapsedMessageDays && this.collapsedMessageDays[key]);
    },

    toggleMessageDayCollapse: function(msg) {
      var key = this.messageDayKey(msg);
      if (!key) return;
      if (!this.collapsedMessageDays) this.collapsedMessageDays = {};
      this.collapsedMessageDays[key] = !this.collapsedMessageDays[key];
    },

    isNewMessageDay: function(list, idx) {
      if (!Array.isArray(list) || idx < 0 || idx >= list.length) return false;
      if (idx === 0) return true;
      var curr = this.messageDayKey(list[idx]);
      var prev = this.messageDayKey(list[idx - 1]);
      if (!curr) return false;
      return curr !== prev;
    },

    jumpToMessage: function(msg, idx) {
      var id = this.messageDomId(msg, idx);
      var target = document.getElementById(id);
      if (!target) return;
      this.selectedMessageDomId = id;
      this.hoveredMessageDomId = id;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.mapStepIndex = idx;
      this.centerChatMapOnMessage(id);
    },

    jumpToMessageDay: function(msg) {
      var key = this.messageDayKey(msg);
      if (!key) return;
      var target = document.querySelector('.chat-day-anchor[data-day="' + key + '"]');
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    addModelSwitchNotice: function(modelName, providerName) {
      var model = String(modelName || '').trim();
      if (!model) return;
      var provider = String(providerName || '').trim();
      var label = provider ? ('Model switched to ' + provider + ' / ' + model) : ('Model switched to ' + model);
      var ts = Date.now();
      this.messages.push({
        id: ++msgId,
        role: 'system',
        text: '',
        meta: '',
        tools: [],
        is_notice: true,
        notice_label: label,
        ts: ts
      });
      if (this.currentAgent && this.currentAgent.id) {
        this.rememberModelNotice(this.currentAgent.id, label, ts);
      }
      this.scrollToBottom();
      this.scheduleConversationPersist();
    },

    formatResponseDuration: function(ms) {
      var num = Number(ms || 0);
      if (!Number.isFinite(num) || num <= 0) return '';
      if (num < 1000) return Math.round(num) + 'ms';
      if (num < 60000) {
        return (num < 10000 ? (num / 1000).toFixed(1) : Math.round(num / 1000)) + 's';
      }
      var min = Math.floor(num / 60000);
      var sec = Math.round((num % 60000) / 1000);
      return min + 'm ' + sec + 's';
    },

    stepMessageMap: function(list, dir) {
      if (!Array.isArray(list) || !list.length) return;
      this.suppressMapPreview = true;
      this.activeMapPreviewDomId = '';
      this.activeMapPreviewDayKey = '';
      if (this._mapPreviewSuppressTimer) clearTimeout(this._mapPreviewSuppressTimer);
      var visibleIndexes = [];
      for (var i = 0; i < list.length; i++) {
        if (!this.isMessageDayCollapsed(list[i])) visibleIndexes.push(i);
      }
      if (!visibleIndexes.length) return;

      var activePos = -1;
      var anchorDomId = String(this.selectedMessageDomId || '');
      if (anchorDomId) {
        for (var p = 0; p < visibleIndexes.length; p++) {
          var vi = visibleIndexes[p];
          if (this.messageDomId(list[vi], vi) === anchorDomId) {
            activePos = p;
            break;
          }
        }
      }
      if (activePos < 0) {
        for (var p2 = 0; p2 < visibleIndexes.length; p2++) {
          if (visibleIndexes[p2] === this.mapStepIndex) {
            activePos = p2;
            break;
          }
        }
      }

      if (activePos < 0) {
        activePos = dir > 0 ? 0 : (visibleIndexes.length - 1);
      } else {
        activePos = activePos + (dir > 0 ? 1 : -1);
        if (activePos < 0) activePos = 0;
        if (activePos > visibleIndexes.length - 1) activePos = visibleIndexes.length - 1;
      }

      var next = visibleIndexes[activePos];
      var msg = list[next];
      if (!msg) return;
      this.setHoveredMessage(msg, next);
      this.jumpToMessage(msg, next);
      this.centerChatMapOnMessage(this.messageDomId(msg, next));
      var self = this;
      this._mapPreviewSuppressTimer = setTimeout(function() {
        self.suppressMapPreview = false;
      }, 220);
    },

    setMapItemHover: function(msg, idx) {
      if (!msg) return;
      var domId = this.messageDomId(msg, idx);
      this.suppressMapPreview = false;
      this.activeMapPreviewDomId = domId;
      this.activeMapPreviewDayKey = '';
      this.selectedMessageDomId = domId;
      this.mapStepIndex = idx;
      this.setHoveredMessage(msg, idx);
    },

    clearMapItemHover: function() {
      this.activeMapPreviewDomId = '';
      this.clearHoveredMessage();
    },

    setMapDayHover: function(msg) {
      if (!msg) return;
      this.suppressMapPreview = false;
      this.activeMapPreviewDayKey = this.messageDayKey(msg);
      this.activeMapPreviewDomId = '';
    },

    clearMapDayHover: function() {
      this.activeMapPreviewDayKey = '';
    },

    isMapPreviewVisible: function(msg, idx) {
      if (this.suppressMapPreview) return false;
      if (!msg) return false;
      return this.activeMapPreviewDomId === this.messageDomId(msg, idx);
    },

    isMapDayPreviewVisible: function(msg) {
      if (this.suppressMapPreview) return false;
      if (!msg) return false;
      return this.activeMapPreviewDayKey === this.messageDayKey(msg);
    },

    setHoveredMessage: function(msg, idx) {
      if (!msg && msg !== 0) {
        this.hoveredMessageDomId = this.selectedMessageDomId || '';
        return;
      }
      this.hoveredMessageDomId = this.messageDomId(msg, idx);
    },

    clearHoveredMessage: function() {
      this.hoveredMessageDomId = this.selectedMessageDomId || '';
    },

    clearHoveredMessageHard: function() {
      this.hoveredMessageDomId = '';
      this.selectedMessageDomId = '';
    },

    isHoveredMessage: function(msg, idx) {
      if (!this.hoveredMessageDomId) return false;
      return this.hoveredMessageDomId === this.messageDomId(msg, idx);
    },

    centerChatMapOnMessage: function(domId, options) {
      if (!domId) return;
      var immediate = !!(options && options.immediate);
      var map = null;
      var maps = document.querySelectorAll('.chat-map-scroll');
      for (var i = 0; i < maps.length; i++) {
        var candidate = maps[i];
        if (candidate && candidate.offsetParent !== null) {
          map = candidate;
          break;
        }
      }
      if (!map) return;
      var host = map.closest('.chat-map') || map;
      var item = host.querySelector('.chat-map-item[data-msg-dom-id="' + domId + '"]');
      if (!item) return;
      var topGuard = 28;
      var bottomGuard = 28;
      var viewport = Math.max(20, map.clientHeight - topGuard - bottomGuard);
      var desired = item.offsetTop + (item.offsetHeight / 2) - (viewport / 2) - topGuard;
      var max = Math.max(0, map.scrollHeight - map.clientHeight);
      var nextTop = Math.max(0, Math.min(max, desired));
      var diff = Math.abs(map.scrollTop - nextTop);
      if (diff < 3) return;
      map.scrollTo({ top: nextTop, behavior: (immediate || this.suppressMapPreview) ? 'auto' : 'smooth' });
    },

    async openAgentDrawer() {
      if (!this.currentAgent || !this.currentAgent.id) return;
      this.showAgentDrawer = true;
      this.agentDrawerLoading = true;
      this.drawerTab = 'info';
      this.drawerEditingModel = false;
      this.drawerEditingProvider = false;
      this.drawerEditingFallback = false;
      this.drawerEditingName = false;
      this.drawerEditingEmoji = false;
      this.drawerIdentitySaving = false;
      this.drawerNewModelValue = '';
      this.drawerNewProviderValue = '';
      this.drawerNewFallbackValue = '';
      var base = this.resolveAgent(this.currentAgent) || this.currentAgent;
      this.agentDrawer = Object.assign({}, base, {
        _fallbacks: Array.isArray(base && base._fallbacks) ? base._fallbacks : []
      });
      this.drawerConfigForm = {
        name: this.agentDrawer.name || '',
        system_prompt: this.agentDrawer.system_prompt || '',
        emoji: (this.agentDrawer.identity && this.agentDrawer.identity.emoji) || '',
        color: (this.agentDrawer.identity && this.agentDrawer.identity.color) || '#2563EB',
        archetype: (this.agentDrawer.identity && this.agentDrawer.identity.archetype) || '',
        vibe: (this.agentDrawer.identity && this.agentDrawer.identity.vibe) || '',
      };
      try {
        var full = await OpenFangAPI.get('/api/agents/' + this.currentAgent.id);
        this.agentDrawer = Object.assign({}, base, full || {}, {
          _fallbacks: Array.isArray(full && full.fallback_models) ? full.fallback_models : []
        });
        this.drawerConfigForm = {
          name: this.agentDrawer.name || '',
          system_prompt: this.agentDrawer.system_prompt || '',
          emoji: (this.agentDrawer.identity && this.agentDrawer.identity.emoji) || '',
          color: (this.agentDrawer.identity && this.agentDrawer.identity.color) || '#2563EB',
          archetype: (this.agentDrawer.identity && this.agentDrawer.identity.archetype) || '',
          vibe: (this.agentDrawer.identity && this.agentDrawer.identity.vibe) || '',
        };
      } catch(e) {
        // Keep best-effort drawer data from current agent/store.
      } finally {
        this.agentDrawerLoading = false;
      }
    },

    closeAgentDrawer() {
      this.showAgentDrawer = false;
      this.drawerEditingName = false;
      this.drawerEditingEmoji = false;
    },

    toggleAgentDrawer() {
      if (this.showAgentDrawer) {
        this.closeAgentDrawer();
        return;
      }
      this.openAgentDrawer();
    },

    async syncDrawerAgentAfterChange() {
      if (!this.agentDrawer || !this.agentDrawer.id) return;
      try {
        await Alpine.store('app').refreshAgents();
      } catch {}
      var refreshed = this.resolveAgent(this.agentDrawer.id);
      if (refreshed) {
        this.currentAgent = refreshed;
      }
      await this.openAgentDrawer();
    },

    async setDrawerMode(mode) {
      if (!this.agentDrawer || !this.agentDrawer.id) return;
      try {
        await OpenFangAPI.put('/api/agents/' + this.agentDrawer.id + '/mode', { mode: mode });
        OpenFangToast.success('Mode set to ' + mode);
        await this.syncDrawerAgentAfterChange();
      } catch(e) {
        OpenFangToast.error('Failed to set mode: ' + e.message);
      }
    },

    async saveDrawerConfig() {
      if (!this.agentDrawer || !this.agentDrawer.id) return;
      this.drawerConfigSaving = true;
      try {
        await OpenFangAPI.patch('/api/agents/' + this.agentDrawer.id + '/config', this.drawerConfigForm || {});
        OpenFangToast.success('Config updated');
        await this.syncDrawerAgentAfterChange();
      } catch(e) {
        OpenFangToast.error('Failed to save config: ' + e.message);
      }
      this.drawerConfigSaving = false;
    },

    async saveDrawerIdentity(part) {
      if (!this.agentDrawer || !this.agentDrawer.id) return;
      var payload = {};
      if (part === 'name') {
        payload.name = String((this.drawerConfigForm && this.drawerConfigForm.name) || '').trim();
      } else if (part === 'emoji') {
        payload.emoji = String((this.drawerConfigForm && this.drawerConfigForm.emoji) || '').trim();
      } else {
        return;
      }
      this.drawerIdentitySaving = true;
      try {
        await OpenFangAPI.patch('/api/agents/' + this.agentDrawer.id + '/config', payload);
        if (part === 'name') this.drawerEditingName = false;
        if (part === 'emoji') this.drawerEditingEmoji = false;
        OpenFangToast.success(part === 'name' ? 'Name updated' : 'Emoji updated');
        await this.syncDrawerAgentAfterChange();
      } catch(e) {
        OpenFangToast.error('Failed to save ' + part + ': ' + e.message);
      }
      this.drawerIdentitySaving = false;
    },

    async changeDrawerModel() {
      if (!this.agentDrawer || !this.agentDrawer.id || !String(this.drawerNewModelValue || '').trim()) return;
      this.drawerModelSaving = true;
      try {
        var resp = await OpenFangAPI.put('/api/agents/' + this.agentDrawer.id + '/model', {
          model: String(this.drawerNewModelValue || '').trim()
        });
        this.addModelSwitchNotice((resp && resp.model) || String(this.drawerNewModelValue || '').trim(), (resp && resp.provider) || this.agentDrawer.model_provider || '');
        var providerInfo = (resp && resp.provider) ? ' (provider: ' + resp.provider + ')' : '';
        OpenFangToast.success('Model changed' + providerInfo + ' (memory reset)');
        this.drawerEditingModel = false;
        this.drawerNewModelValue = '';
        await this.syncDrawerAgentAfterChange();
      } catch(e) {
        OpenFangToast.error('Failed to change model: ' + e.message);
      }
      this.drawerModelSaving = false;
    },

    async changeDrawerProvider() {
      if (!this.agentDrawer || !this.agentDrawer.id || !String(this.drawerNewProviderValue || '').trim()) return;
      this.drawerModelSaving = true;
      try {
        var combined = String(this.drawerNewProviderValue || '').trim() + '/' + (this.agentDrawer.model_name || '');
        var resp = await OpenFangAPI.put('/api/agents/' + this.agentDrawer.id + '/model', { model: combined });
        this.addModelSwitchNotice((resp && resp.model) || this.agentDrawer.model_name || '', (resp && resp.provider) || String(this.drawerNewProviderValue || '').trim());
        OpenFangToast.success('Provider changed to ' + (resp && resp.provider ? resp.provider : String(this.drawerNewProviderValue || '').trim()));
        this.drawerEditingProvider = false;
        this.drawerNewProviderValue = '';
        await this.syncDrawerAgentAfterChange();
      } catch(e) {
        OpenFangToast.error('Failed to change provider: ' + e.message);
      }
      this.drawerModelSaving = false;
    },

    async addDrawerFallback() {
      if (!this.agentDrawer || !this.agentDrawer.id || !String(this.drawerNewFallbackValue || '').trim()) return;
      var parts = String(this.drawerNewFallbackValue || '').trim().split('/');
      var provider = parts.length > 1 ? parts[0] : this.agentDrawer.model_provider;
      var model = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
      if (!this.agentDrawer._fallbacks) this.agentDrawer._fallbacks = [];
      this.agentDrawer._fallbacks.push({ provider: provider, model: model });
      try {
        await OpenFangAPI.patch('/api/agents/' + this.agentDrawer.id + '/config', {
          fallback_models: this.agentDrawer._fallbacks
        });
        OpenFangToast.success('Fallback added: ' + provider + '/' + model);
        this.drawerEditingFallback = false;
        this.drawerNewFallbackValue = '';
      } catch(e) {
        OpenFangToast.error('Failed to save fallbacks: ' + e.message);
        this.agentDrawer._fallbacks.pop();
      }
    },

    async removeDrawerFallback(idx) {
      if (!this.agentDrawer || !this.agentDrawer.id || !Array.isArray(this.agentDrawer._fallbacks)) return;
      var removed = this.agentDrawer._fallbacks.splice(idx, 1);
      try {
        await OpenFangAPI.patch('/api/agents/' + this.agentDrawer.id + '/config', {
          fallback_models: this.agentDrawer._fallbacks
        });
        OpenFangToast.success('Fallback removed');
      } catch(e) {
        OpenFangToast.error('Failed to save fallbacks: ' + e.message);
        if (removed && removed.length) this.agentDrawer._fallbacks.splice(idx, 0, removed[0]);
      }
    },

    isBlockedTool: function(tool) {
      if (!tool) return false;
      if (tool.blocked === true) return true;
      var txt = String(tool.result || '').toLowerCase();
      if (String(tool.status || '').toLowerCase() === 'blocked') return true;
      if (!tool.is_error) return false;
      return (
        txt.indexOf('blocked') >= 0 ||
        txt.indexOf('policy') >= 0 ||
        txt.indexOf('denied') >= 0 ||
        txt.indexOf('not allowed') >= 0 ||
        txt.indexOf('forbidden') >= 0 ||
        txt.indexOf('approval') >= 0 ||
        txt.indexOf('permission') >= 0 ||
        txt.indexOf('fail-closed') >= 0
      );
    },

    isToolSuccessful: function(tool) {
      if (!tool) return false;
      if (tool.running) return false;
      if (this.isBlockedTool(tool)) return false;
      if (tool.is_error) return false;
      return true;
    },

    isThoughtTool: function(tool) {
      return !!(tool && String(tool.name || '').toLowerCase() === 'thought_process');
    },

    toolDisplayName: function(tool) {
      if (!tool) return 'tool';
      if (this.isThoughtTool(tool)) return 'thought';
      return String(tool.name || 'tool');
    },

    toolStatusText: function(tool) {
      if (!tool) return '';
      if (tool.running) return 'running...';
      if (this.isThoughtTool(tool)) return 'thought';
      if (this.isBlockedTool(tool)) return 'blocked';
      if (tool.is_error) return 'error';
      if (tool.result) {
        return tool.result.length > 500 ? Math.round(tool.result.length / 1024) + 'KB' : 'done';
      }
      return 'done';
    },

    // Mark chat-rendered error messages for styling
    isErrorMessage: function(msg) {
      if (!msg || !msg.text) return false;
      var t = String(msg.text).toLowerCase();
      return t.startsWith('error:') || t.includes(' failed') || t.includes('exception');
    },

    messageHasTools: function(msg) {
      return !!(msg && Array.isArray(msg.tools) && msg.tools.length);
    },

    allToolsCollapsed: function(msg) {
      if (!this.messageHasTools(msg)) return true;
      return !msg.tools.some(function(tool) {
        return !!(tool && tool.expanded);
      });
    },

    toggleMessageTools: function(msg) {
      if (!this.messageHasTools(msg)) return;
      var expand = this.allToolsCollapsed(msg);
      msg.tools.forEach(function(tool) {
        if (tool) tool.expanded = expand;
      });
      this.scheduleConversationPersist();
    },

    // Copy message text to clipboard
    copyMessage: function(msg) {
      var text = msg.text || '';
      navigator.clipboard.writeText(text).then(function() {
        msg._copied = true;
        setTimeout(function() { msg._copied = false; }, 2000);
      }).catch(function() {});
    },

    // Process queued messages after current response completes
    _processQueue: function() {
      if (!this.messageQueue.length || this.sending) return;
      var next = this.messageQueue.shift();
      if (next && next.terminal) {
        this._sendTerminalPayload(next.command);
        return;
      }
      this._sendPayload(next.text, next.files, next.images);
    },

    _terminalPromptLine: function(cwd, command) {
      var path = String(cwd || this.terminalPromptPath || '/Users/jay/.openclaw/workspace');
      var cmd = String(command || '').trim();
      if (!cmd) return path + ' %';
      return path + ' % ' + cmd;
    },

    _appendTerminalMessage: function(entry) {
      var payload = entry || {};
      var text = String(payload.text || '');
      var now = Date.now();
      var ts = Number.isFinite(Number(payload.ts)) ? Number(payload.ts) : now;
      var role = payload.role ? String(payload.role) : 'terminal';
      var cwd = payload.cwd ? String(payload.cwd) : this.terminalPromptPath;
      var meta = payload.meta == null ? '' : String(payload.meta);
      var tools = Array.isArray(payload.tools) ? payload.tools : [];

      var last = this.messages.length ? this.messages[this.messages.length - 1] : null;
      if (last && !last.thinking && last.terminal) {
        if (text) {
          if (last.text && !/\n$/.test(last.text)) last.text += '\n';
          last.text += text;
        }
        if (meta) last.meta = meta;
        if (cwd) {
          last.cwd = cwd;
          this.terminalCwd = cwd;
        }
        last.ts = ts;
        if (!Array.isArray(last.tools)) last.tools = [];
        if (tools.length) last.tools = last.tools.concat(tools);
        return last;
      }

      var msg = {
        id: ++msgId,
        role: role,
        text: text,
        meta: meta,
        tools: tools,
        ts: ts,
        terminal: true,
        cwd: cwd
      };
      this.messages.push(msg);
      if (cwd) this.terminalCwd = cwd;
      return msg;
    },

    async sendTerminalMessage() {
      if (!this.currentAgent || !this.inputText.trim()) return;
      var command = this.inputText.trim();
      this.inputText = '';
      this.terminalSelectionStart = 0;

      var ta = document.getElementById('msg-input');
      if (ta) ta.style.height = '';

      if (this.sending) {
        this.messageQueue.push({ terminal: true, command: command });
        return;
      }

      this._sendTerminalPayload(command);
    },

    async sendMessage() {
      if (this.terminalMode) {
        await this.sendTerminalMessage();
        return;
      }
      if (!this.currentAgent || (!this.inputText.trim() && !this.attachments.length)) return;
      var text = this.inputText.trim();

      // Handle slash commands
      if (text.startsWith('/') && !this.attachments.length) {
        var cmd = text.split(' ')[0].toLowerCase();
        var cmdArgs = text.substring(cmd.length).trim();
        var matched = this.slashCommands.find(function(c) { return c.cmd === cmd; });
        if (matched) {
          this.executeSlashCommand(matched.cmd, cmdArgs);
          return;
        }
      }

      this.inputText = '';

      // Reset textarea height to single line
      var ta = document.getElementById('msg-input');
      if (ta) ta.style.height = '';

      // Upload attachments first if any
      var fileRefs = [];
      var uploadedFiles = [];
      if (this.attachments.length) {
        for (var i = 0; i < this.attachments.length; i++) {
          var att = this.attachments[i];
          att.uploading = true;
          try {
            var uploadRes = await OpenFangAPI.upload(this.currentAgent.id, att.file);
            fileRefs.push('[File: ' + att.file.name + ']');
            uploadedFiles.push({ file_id: uploadRes.file_id, filename: uploadRes.filename, content_type: uploadRes.content_type });
          } catch(e) {
            OpenFangToast.error('Failed to upload ' + att.file.name);
            fileRefs.push('[File: ' + att.file.name + ' (upload failed)]');
          }
          att.uploading = false;
        }
        // Clean up previews
        for (var j = 0; j < this.attachments.length; j++) {
          if (this.attachments[j].preview) URL.revokeObjectURL(this.attachments[j].preview);
        }
        this.attachments = [];
      }

      // Build final message text
      var finalText = text;
      if (fileRefs.length) {
        finalText = (text ? text + '\n' : '') + fileRefs.join('\n');
      }

      // Collect image references for inline rendering
      var msgImages = uploadedFiles.filter(function(f) { return f.content_type && f.content_type.startsWith('image/'); });

      // Always show user message immediately
      this.messages.push({ id: ++msgId, role: 'user', text: finalText, meta: '', tools: [], images: msgImages, ts: Date.now() });
      this.scrollToBottom();
      localStorage.setItem('of-first-msg', 'true');
      this.scheduleConversationPersist();

      // If already streaming, queue this message
      if (this.sending) {
        this.messageQueue.push({ text: finalText, files: uploadedFiles, images: msgImages });
        return;
      }

      this._sendPayload(finalText, uploadedFiles, msgImages);
    },

    async _sendTerminalPayload(command) {
      this.sending = true;
      this._responseStartedAt = Date.now();
      this._appendTerminalMessage({
        role: 'terminal',
        text: this._terminalPromptLine(this.terminalPromptPath, command),
        meta: this.terminalPromptPath,
        tools: [],
        ts: Date.now(),
        cwd: this.terminalPromptPath
      });
      this.recomputeContextEstimate();
      this.scrollToBottom();
      this.scheduleConversationPersist();

      if (!OpenFangAPI.isWsConnected() && this.currentAgent) {
        this.connectWs(this.currentAgent.id);
        var wsWaitStarted = Date.now();
        while (!OpenFangAPI.isWsConnected() && (Date.now() - wsWaitStarted) < 1500) {
          await new Promise(function(resolve) { setTimeout(resolve, 75); });
        }
      }

      if (OpenFangAPI.wsSend({ type: 'terminal', command: command, cwd: this.terminalPromptPath })) {
        return;
      }

      try {
        var res = await OpenFangAPI.post('/api/agents/' + this.currentAgent.id + '/terminal', {
          command: command,
          cwd: this.terminalPromptPath,
        });
        this.handleWsMessage({
          type: 'terminal_output',
          stdout: res && res.stdout ? String(res.stdout) : '',
          stderr: res && res.stderr ? String(res.stderr) : '',
          exit_code: Number(res && res.exit_code != null ? res.exit_code : 1),
          duration_ms: Number(res && res.duration_ms ? res.duration_ms : 0),
          cwd: res && res.cwd ? String(res.cwd) : this.terminalPromptPath,
        });
      } catch (e) {
        this.handleWsMessage({
          type: 'terminal_error',
          message: e && e.message ? e.message : 'command failed',
        });
      }
    },

    async _sendPayload(finalText, uploadedFiles, msgImages) {
      this.sending = true;

      // Try WebSocket first
      var wsPayload = { type: 'message', content: finalText };
      if (uploadedFiles && uploadedFiles.length) wsPayload.attachments = uploadedFiles;
      if (OpenFangAPI.wsSend(wsPayload)) {
        this._responseStartedAt = Date.now();
        this.messages.push({ id: ++msgId, role: 'agent', text: '', meta: '', thinking: true, streaming: true, tools: [], ts: Date.now() });
        this.scrollToBottom();
        this.scheduleConversationPersist();
        return;
      }

      // HTTP fallback
      if (!OpenFangAPI.isWsConnected()) {
        OpenFangToast.info('Using HTTP mode (no streaming)');
      }
      this.messages.push({ id: ++msgId, role: 'agent', text: '', meta: '', thinking: true, tools: [], ts: Date.now() });
      this.scrollToBottom();
      this.scheduleConversationPersist();
      var httpStartedAt = Date.now();

      try {
        var httpBody = { message: finalText };
        if (uploadedFiles && uploadedFiles.length) httpBody.attachments = uploadedFiles;
        var res = await OpenFangAPI.post('/api/agents/' + this.currentAgent.id + '/message', httpBody);
        this.applyContextTelemetry(res);
        this.messages = this.messages.filter(function(m) { return !m.thinking; });
        var httpMeta = (res.input_tokens || 0) + ' in / ' + (res.output_tokens || 0) + ' out';
        if (res.cost_usd != null) httpMeta += ' | $' + res.cost_usd.toFixed(4);
        if (res.iterations) httpMeta += ' | ' + res.iterations + ' iter';
        var httpDuration = this.formatResponseDuration(Date.now() - httpStartedAt);
        if (httpDuration) httpMeta += ' | ' + httpDuration;
        var httpTools = Array.isArray(res.tools)
          ? res.tools.map(function(t, idx) {
              return {
                id: (t && t.id) || ('http-tool-' + Date.now() + '-' + idx),
                name: (t && t.name) || 'tool',
                running: false,
                expanded: false,
                input: (t && t.input) || '',
                result: (t && t.result) || '',
                is_error: !!(t && t.is_error),
              };
            })
          : [];
        var httpText = this.stripModelPrefix(this.sanitizeToolText(res.response || ''));
        var httpSplit = this.extractThinkingLeak(httpText);
        if (httpSplit.thought) {
          httpTools.unshift(this.makeThoughtToolCard(httpSplit.thought));
          httpText = httpSplit.content || '';
        }
        if (!String(httpText || '').trim()) {
          httpText = this.defaultAssistantFallback(httpSplit.thought || '', httpTools);
        }
        this.messages.push({
          id: ++msgId,
          role: 'agent',
          text: httpText,
          meta: httpMeta,
          tools: httpTools,
          ts: Date.now()
        });
        this.scheduleConversationPersist();
      } catch(e) {
        this.messages = this.messages.filter(function(m) { return !m.thinking; });
        this.messages.push({ id: ++msgId, role: 'system', text: 'Error: ' + e.message, meta: '', tools: [], ts: Date.now() });
        this.scheduleConversationPersist();
      }
      this._responseStartedAt = 0;
      this.sending = false;
      this.scrollToBottom();
      // Process next queued message
      var self = this;
      this.$nextTick(function() {
        var el = document.getElementById('msg-input'); if (el) el.focus();
        self._processQueue();
      });
    },

    // Stop the current agent run
    stopAgent: function() {
      if (!this.currentAgent) return;
      var self = this;
      OpenFangAPI.post('/api/agents/' + this.currentAgent.id + '/stop', {}).then(function(res) {
        self.handleStopResponse(self.currentAgent && self.currentAgent.id ? self.currentAgent.id : '', res || {});
      }).catch(function(e) {
        var raw = String(e && e.message ? e.message : 'stop_failed');
        var lower = raw.toLowerCase();
        if (lower.indexOf('agent_inactive') >= 0 || lower.indexOf('inactive') >= 0) {
          self.handleAgentInactive(
            self.currentAgent && self.currentAgent.id ? self.currentAgent.id : '',
            'inactive',
            { noticeText: 'Agent is now inactive.' }
          );
          return;
        }
        if (lower.indexOf('agent_contract_terminated') >= 0 || lower.indexOf('contract terminated') >= 0) {
          self.handleAgentInactive(
            self.currentAgent && self.currentAgent.id ? self.currentAgent.id : '',
            'contract_terminated',
            { noticeText: 'Agent contract terminated.' }
          );
          return;
        }
        OpenFangToast.error('Stop failed: ' + raw);
      });
    },

    killAgent() {
      if (!this.currentAgent) return;
      var self = this;
      var name = this.currentAgent.name;
      OpenFangToast.confirm('Stop Agent', 'Stop agent "' + name + '"? The agent will be shut down.', async function() {
        try {
          await OpenFangAPI.del('/api/agents/' + self.currentAgent.id);
          OpenFangAPI.wsDisconnect();
          self._wsAgent = null;
          self.currentAgent = null;
          Alpine.store('app').activeAgentId = null;
          self.messages = [];
          OpenFangToast.success('Agent "' + name + '" stopped');
          Alpine.store('app').refreshAgents();
        } catch(e) {
          OpenFangToast.error('Failed to stop agent: ' + e.message);
        }
      });
    },

    _latexTimer: null,

    resolveMessagesScroller: function(preferred) {
      var candidate = preferred || null;
      if (candidate && candidate.id === 'messages' && candidate.offsetParent !== null) return candidate;
      var nodes = document.querySelectorAll('#messages');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node && node.offsetParent !== null) return node;
      }
      return candidate && candidate.id === 'messages' ? candidate : null;
    },

    syncMapSelectionToScroll: function(container) {
      var el = this.resolveMessagesScroller(container);
      if (!el || !this.currentAgent || !Array.isArray(this.messages) || !this.messages.length) return;
      var nodes = el.querySelectorAll('.message[id^="chat-msg-"]');
      if (!nodes || !nodes.length) return;
      var viewport = el.getBoundingClientRect();
      var viewportCenterY = viewport.top + (viewport.height / 2);
      var bestNode = null;
      var bestDiff = Number.POSITIVE_INFINITY;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!node || node.offsetParent === null) continue;
        var rect = node.getBoundingClientRect();
        if (rect.height <= 0) continue;
        if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
        var nodeCenter = rect.top + (rect.height / 2);
        var diff = Math.abs(nodeCenter - viewportCenterY);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestNode = node;
        }
      }
      if (!bestNode || !bestNode.id) return;
      var domId = String(bestNode.id);
      if (this.selectedMessageDomId !== domId) {
        this.selectedMessageDomId = domId;
      }
      if (!this.activeMapPreviewDomId) {
        this.hoveredMessageDomId = domId;
      }
      for (var idx = 0; idx < this.messages.length; idx++) {
        if (this.messageDomId(this.messages[idx], idx) === domId) {
          this.mapStepIndex = idx;
          break;
        }
      }
      this.centerChatMapOnMessage(domId, { immediate: true });
    },

    scrollToBottom() {
      var self = this;
      var el = this.resolveMessagesScroller();
      if (el) self.$nextTick(function() {
        el.scrollTop = el.scrollHeight;
        self.showScrollDown = false;
        self.syncMapSelectionToScroll(el);
        // Debounce LaTeX rendering to avoid running on every streaming token
        if (self._latexTimer) clearTimeout(self._latexTimer);
        self._latexTimer = setTimeout(function() { renderLatex(el); }, 150);
      });
    },

    handleMessagesScroll(e) {
      var el = this.resolveMessagesScroller(e && e.target ? e.target : null);
      if (!el) return;
      var hiddenBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
      this.showScrollDown = hiddenBottom > 120;
      var self = this;
      if (typeof requestAnimationFrame === 'function') {
        if (this._scrollSyncFrame) cancelAnimationFrame(this._scrollSyncFrame);
        this._scrollSyncFrame = requestAnimationFrame(function() {
          self._scrollSyncFrame = 0;
          self.syncMapSelectionToScroll(el);
        });
      } else {
        self.syncMapSelectionToScroll(el);
      }
    },

    addFiles(files) {
      var self = this;
      var allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'application/pdf',
                      'text/markdown', 'application/json', 'text/csv'];
      var allowedExts = ['.txt', '.pdf', '.md', '.json', '.csv'];
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (file.size > 10 * 1024 * 1024) {
          OpenFangToast.warn('File "' + file.name + '" exceeds 10MB limit');
          continue;
        }
        var typeOk = allowed.indexOf(file.type) !== -1;
        if (!typeOk) {
          var ext = file.name.lastIndexOf('.') !== -1 ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';
          typeOk = allowedExts.indexOf(ext) !== -1 || file.type.startsWith('image/');
        }
        if (!typeOk) {
          OpenFangToast.warn('File type not supported: ' + file.name);
          continue;
        }
        var preview = null;
        if (file.type.startsWith('image/')) {
          preview = URL.createObjectURL(file);
        }
        self.attachments.push({ file: file, preview: preview, uploading: false });
      }
    },

    removeAttachment(idx) {
      var att = this.attachments[idx];
      if (att && att.preview) URL.revokeObjectURL(att.preview);
      this.attachments.splice(idx, 1);
    },

    handleDrop(e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        this.addFiles(e.dataTransfer.files);
      }
    },

    isGrouped(idx) {
      if (idx === 0) return false;
      var prev = this.messages[idx - 1];
      var curr = this.messages[idx];
      return prev && curr && this.messageGroupRole(prev) === this.messageGroupRole(curr) && !curr.thinking && !prev.thinking;
    },

    // Strip raw function-call text that some models (Llama, Groq, etc.) leak into output.
    // These models don't use proper tool_use blocks — they output function calls as plain text.
    sanitizeToolText: function(text) {
      if (!text) return text;
      // Pattern: tool_name</function={"key":"value"} or tool_name</function,{...}
      text = text.replace(/\s*\w+<\/function[=,]?\s*\{[\s\S]*$/gm, '');
      // Pattern: <function=tool_name>{...}</function>
      text = text.replace(/<function=\w+>[\s\S]*?<\/function>/g, '');
      // Pattern: tool_name{"type":"function",...}
      text = text.replace(/\s*\w+\{"type"\s*:\s*"function"[\s\S]*$/gm, '');
      // Pattern: lone </function...> tags
      text = text.replace(/<\/function[^>]*>/g, '');
      // Pattern: <|python_tag|> or similar special tokens
      text = text.replace(/<\|[\w_]+\|>/g, '');
      return text.trim();
    },

    extractThinkingLeak: function(text) {
      if (!text) return { thought: '', content: '' };
      var raw = String(text).replace(/\r\n?/g, '\n');
      var trimmed = raw.replace(/^\s+/, '');
      if (!trimmed) return { thought: '', content: '' };
      var thinkingPrefix = /^(thinking(?:\s+out\s+loud)?(?:\.\.\.|:)?|analysis(?:\.\.\.|:)?|reasoning(?:\.\.\.|:)?)/i;
      if (!thinkingPrefix.test(trimmed)) return { thought: '', content: raw };
      var splitAt = this.findThinkingBoundary(trimmed);
      if (splitAt < 0) return { thought: trimmed.trim(), content: '' };
      return {
        thought: trimmed.slice(0, splitAt).trim(),
        content: trimmed.slice(splitAt).trim()
      };
    },

    findThinkingBoundary: function(text) {
      if (!text) return -1;
      var boundaries = [];
      var markers = [
        /\n\s*final answer\s*:/i,
        /\n\s*answer\s*:/i,
        /\n\s*response\s*:/i,
        /\n\s*output\s*:/i,
        /\n\s*```/i,
        /\n\s*\n(?=\s*[\{\[])/,
      ];
      markers.forEach(function(rx) {
        var match = text.match(rx);
        if (match && Number.isFinite(match.index)) {
          boundaries.push(match.index + 1);
        }
      });
      if (!boundaries.length) return -1;
      boundaries.sort(function(a, b) { return a - b; });
      return boundaries[0];
    },

    makeThoughtToolCard: function(thoughtText) {
      return {
        id: 'thought-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
        name: 'thought_process',
        running: false,
        expanded: false,
        input: String(thoughtText || '').trim(),
        result: '',
        is_error: false
      };
    },

    renderLiveThoughtHtml: function(thoughtText) {
      var text = String(thoughtText || '').trim();
      return '<span class="thinking-live-inline"><em>' + escapeHtml(text) + '</em></span>';
    },

    defaultAssistantFallback: function(thoughtText, tools) {
      var thought = String(thoughtText || '').trim();
      var hasToolError = Array.isArray(tools) && tools.some(function(tool) {
        return !!(tool && tool.is_error);
      });
      if (hasToolError) {
        return 'I could not finish the request because a required step failed. Please clarify the goal or try again.';
      }
      if (thought) {
        return 'I do not have enough confidence in a final answer yet. Please clarify what outcome you want.';
      }
      return 'I do not know yet. Please clarify what you want me to do next.';
    },

    // Remove provider/model disclosure prefixes injected by backend responses.
    // Example: "[openai/gpt-5] hello" -> "hello"
    stripModelPrefix: function(text) {
      if (!text) return text;
      var out = String(text);
      for (var i = 0; i < 2; i++) {
        var next = out.replace(/^\s*\[[^\]\n]{2,96}\]\s*/, '');
        if (next === out) break;
        out = next;
      }
      return out;
    },

    formatToolJson: function(text) {
      if (!text) return '';
      try { return JSON.stringify(JSON.parse(text), null, 2); }
      catch(e) { return text; }
    },

    // Voice: start recording
    startRecording: async function() {
      if (this.recording) return;
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
                       MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
        this._audioChunks = [];
        this._mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
        var self = this;
        this._mediaRecorder.ondataavailable = function(e) {
          if (e.data.size > 0) self._audioChunks.push(e.data);
        };
        this._mediaRecorder.onstop = function() {
          stream.getTracks().forEach(function(t) { t.stop(); });
          self._handleRecordingComplete();
        };
        this._mediaRecorder.start(250);
        this.recording = true;
        this.recordingTime = 0;
        this._recordingTimer = setInterval(function() { self.recordingTime++; }, 1000);
      } catch(e) {
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.error('Microphone access denied');
      }
    },

    // Voice: stop recording
    stopRecording: function() {
      if (!this.recording || !this._mediaRecorder) return;
      this._mediaRecorder.stop();
      this.recording = false;
      if (this._recordingTimer) { clearInterval(this._recordingTimer); this._recordingTimer = null; }
    },

    // Voice: handle completed recording — upload and transcribe
    _handleRecordingComplete: async function() {
      if (!this._audioChunks.length || !this.currentAgent) return;
      var blob = new Blob(this._audioChunks, { type: this._audioChunks[0].type || 'audio/webm' });
      this._audioChunks = [];
      if (blob.size < 100) return; // too small

      // Show a temporary "Transcribing..." message
      this.messages.push({ id: ++msgId, role: 'system', text: 'Transcribing audio...', thinking: true, ts: Date.now(), tools: [] });
      this.scrollToBottom();

      try {
        // Upload audio file
        var ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : 'mp3';
        var file = new File([blob], 'voice_' + Date.now() + '.' + ext, { type: blob.type });
        var upload = await OpenFangAPI.upload(this.currentAgent.id, file);

        // Remove the "Transcribing..." message
        this.messages = this.messages.filter(function(m) { return !m.thinking || m.role !== 'system'; });

        // Use server-side transcription if available, otherwise fall back to placeholder
        var text = (upload.transcription && upload.transcription.trim())
          ? upload.transcription.trim()
          : '[Voice message - audio: ' + upload.filename + ']';
        this._sendPayload(text, [upload], []);
      } catch(e) {
        this.messages = this.messages.filter(function(m) { return !m.thinking || m.role !== 'system'; });
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.error('Failed to upload audio: ' + (e.message || 'unknown error'));
      }
    },

    // Voice: format recording time as MM:SS
    formatRecordingTime: function() {
      var m = Math.floor(this.recordingTime / 60);
      var s = this.recordingTime % 60;
      return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    },

    // Search: toggle open/close
    toggleSearch: function() {
      this.searchOpen = !this.searchOpen;
      if (this.searchOpen) {
        var self = this;
        this.$nextTick(function() {
          var el = document.getElementById('chat-search-input');
          if (el) el.focus();
        });
      } else {
        this.searchQuery = '';
      }
    },

    // Search: filter messages by query
    get filteredMessages() {
      if (!this.searchQuery.trim()) return this.messages;
      var q = this.searchQuery.toLowerCase();
      return this.messages.filter(function(m) {
        return (m.text && m.text.toLowerCase().indexOf(q) !== -1) ||
               (m.tools && m.tools.some(function(t) { return t.name.toLowerCase().indexOf(q) !== -1; }));
      });
    },

    // Search: highlight matched text in a string
    highlightSearch: function(html) {
      if (!this.searchQuery.trim() || !html) return html;
      var q = this.searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var regex = new RegExp('(' + q + ')', 'gi');
      return html.replace(regex, '<mark style="background:var(--warning);color:var(--bg);border-radius:2px;padding:0 2px">$1</mark>');
    },

    renderMarkdown: renderMarkdown,
    escapeHtml: escapeHtml
  };
}
