import React, { useDeferredValue, useEffect, useMemo, useState } from 'https://esm.sh/react@18.2.0';
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client';

type Dict = Record<string, any>;

type Snapshot = {
  ts: string;
  receipt_hash?: string;
  metadata?: Dict;
  health?: Dict;
  app?: Dict;
  collab?: Dict;
  skills?: Dict;
  memory?: Dict;
  receipts?: Dict;
  logs?: Dict;
  apm?: Dict;
};

type SnapshotEnvelope = {
  type: string;
  snapshot?: Snapshot;
};

type Tone = 'ok' | 'warn' | 'bad';

type DrawerSection = {
  id: string;
  label: string;
};

const DRAWER_SECTIONS: DrawerSection[] = [
  { id: 'agents', label: 'Agents & Swarms' },
  { id: 'graph', label: 'Activity Graph' },
  { id: 'memory', label: 'Memory Explorer' },
  { id: 'tools', label: 'Tools & Marketplace' },
  { id: 'channels', label: 'Channels & Delivery' },
  { id: 'receipts', label: 'Receipts & Audit' },
  { id: 'logs', label: 'Logs' },
  { id: 'apm', label: 'APM & Alerts' },
  { id: 'settings', label: 'Settings & Governance' },
];

function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function shortHash(value: unknown, size = 16): string {
  const text = String(value ?? '').trim();
  if (!text) return 'n/a';
  return text.length <= size ? text : `${text.slice(0, size)}...`;
}

function fmtNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'n/a';
  if (Math.abs(num) >= 1000) return num.toLocaleString('en-US');
  if (Math.abs(num) >= 100) return num.toFixed(0);
  if (Math.abs(num) >= 10) return num.toFixed(1);
  return num.toFixed(2);
}

function statusTone(status: unknown): Tone {
  const value = String(status ?? '').trim().toLowerCase();
  if (['pass', 'ok', 'running', 'active', 'success', 'complete'].includes(value)) return 'ok';
  if (['warn', 'warning', 'pending', 'paused', 'thinking', 'tool_call'].includes(value)) return 'warn';
  return 'bad';
}

function iconTone(tone: Tone): string {
  if (tone === 'ok') return 'bg-emerald-400 shadow-[0_0_16px_rgba(52,211,153,.65)]';
  if (tone === 'warn') return 'bg-amber-400 shadow-[0_0_16px_rgba(251,191,36,.65)]';
  return 'bg-rose-400 shadow-[0_0_16px_rgba(251,113,133,.65)]';
}

function StatusPill({ status }: { status: unknown }) {
  const tone = statusTone(status);
  return (
    <span
      className={cls(
        'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[.11em]',
        tone === 'ok' && 'bg-emerald-500/25 text-emerald-100',
        tone === 'warn' && 'bg-amber-500/20 text-amber-100',
        tone === 'bad' && 'bg-rose-500/22 text-rose-100'
      )}
    >
      <i className={cls('inline-block h-2 w-2 rounded-full', iconTone(tone), tone === 'ok' && 'pulse-ok')} />
      {String(status ?? 'unknown')}
    </span>
  );
}

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch('/api/dashboard/snapshot', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`snapshot_http_${res.status}`);
  }
  return (await res.json()) as Snapshot;
}

async function postAction(action: string, payload: Dict): Promise<Dict> {
  const res = await fetch('/api/dashboard/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(String(data.error || data.type || `action_http_${res.status}`));
  }
  return data;
}

function useDashboardState() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let stop = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let backoffMs = 1000;

    const scheduleReconnect = () => {
      if (reconnectTimer != null || stop) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectWs();
      }, backoffMs);
      backoffMs = Math.min(12000, Math.floor(backoffMs * 1.8));
    };

    const connectWs = () => {
      try {
        socket = new WebSocket(wsUrl());
      } catch (err) {
        setConnected(false);
        setError(String((err as Error).message || err));
        scheduleReconnect();
        return;
      }
      socket.addEventListener('open', () => {
        if (stop) return;
        backoffMs = 1000;
        setConnected(true);
      });
      socket.addEventListener('message', (event) => {
        if (stop) return;
        try {
          const envelope = JSON.parse(String(event.data)) as SnapshotEnvelope;
          if (envelope.type === 'snapshot' && envelope.snapshot) {
            setSnapshot(envelope.snapshot);
          }
        } catch {
          // ignore malformed envelope
        }
      });
      socket.addEventListener('close', () => {
        if (stop) return;
        setConnected(false);
        scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        if (stop) return;
        setConnected(false);
        scheduleReconnect();
      });
    };

    fetchSnapshot()
      .then((row) => {
        if (!stop) setSnapshot(row);
      })
      .catch((err) => {
        if (!stop) setError(String((err as Error).message || err));
      })
      .finally(() => connectWs());

    return () => {
      stop = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      if (socket) {
        try {
          socket.close();
        } catch {}
      }
    };
  }, []);

  return { snapshot, setSnapshot, connected, error, setError };
}

function containsQuery(query: string, fields: unknown[]): boolean {
  if (!query) return true;
  const haystack = fields
    .map((value) => String(value == null ? '' : value).toLowerCase())
    .join(' ');
  return haystack.includes(query);
}

function WindowedList<T>(props: {
  items: T[];
  rowHeight: number;
  height: number;
  overscan?: number;
  emptyLabel?: string;
  keyFor: (item: T, index: number) => string;
  renderRow: (item: T, index: number) => React.ReactNode;
}) {
  const { items, rowHeight, height } = props;
  const overscan = props.overscan ?? 6;
  const [scrollTop, setScrollTop] = useState(0);

  const totalHeight = items.length * rowHeight;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  const visible = items.slice(start, end);

  if (items.length === 0) {
    return <div className="rounded-lg border border-slate-700/60 bg-slate-900/45 p-3 text-xs text-slate-400">{props.emptyLabel || 'No records'}</div>;
  }

  return (
    <div
      style={{ height }}
      className="overflow-y-auto rounded-lg border border-slate-700/60 bg-slate-950/55"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        {visible.map((item, offset) => {
          const index = start + offset;
          return (
            <div
              key={props.keyFor(item, index)}
              style={{
                position: 'absolute',
                top: index * rowHeight,
                left: 0,
                right: 0,
                height: rowHeight,
              }}
              className="px-2"
            >
              {props.renderRow(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DrawerAccordion(props: {
  id: string;
  label: string;
  open: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="drawer-section">
      <button className="drawer-toggle" onClick={() => props.onToggle(props.id)}>
        <span>{props.label}</span>
        <span className="mono text-[11px]">{props.open ? '−' : '+'}</span>
      </button>
      {props.open ? <div className="drawer-body">{props.children}</div> : null}
    </section>
  );
}

function App() {
  const { snapshot, setSnapshot, connected, error, setError } = useDashboardState();
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('gpt-5');
  const [team, setTeam] = useState('ops');
  const [role, setRole] = useState('analyst');
  const [shadow, setShadow] = useState('ops-analyst');
  const [skill, setSkill] = useState('');
  const [skillInput, setSkillInput] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatTurns, setChatTurns] = useState<Dict[]>([]);
  const [sending, setSending] = useState(false);
  const [drawerSearch, setDrawerSearch] = useState('');
  const deferredSearch = useDeferredValue(drawerSearch.trim().toLowerCase());
  const [controlsOpen, setControlsOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('infring_dashboard_controls_open') === '1';
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const value = window.localStorage.getItem('infring_dashboard_theme_v1');
      return value === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [welcomeVisible, setWelcomeVisible] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('infring_dashboard_welcome_seen_v1') !== '1';
    } catch {
      return true;
    }
  });
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    try {
      const raw = window.localStorage.getItem('infring_dashboard_controls_sections_v1');
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, boolean>;
        const normalized: Record<string, boolean> = {};
        for (const section of DRAWER_SECTIONS) {
          normalized[section.id] = !!parsed[section.id];
        }
        return normalized;
      }
    } catch {
      // ignore storage failures
    }
    const seed: Record<string, boolean> = {};
    for (const section of DRAWER_SECTIONS) {
      seed[section.id] = false;
    }
    return seed;
  });

  useEffect(() => {
    if (!snapshot?.app?.settings) return;
    const settings = snapshot.app.settings;
    setProvider(String(settings.provider || 'openai'));
    setModel(String(settings.model || 'gpt-5'));
  }, [snapshot?.app?.settings]);

  useEffect(() => {
    const turns = Array.isArray(snapshot?.app?.turns) ? snapshot.app.turns : [];
    if (turns.length > 0) setChatTurns(turns);
  }, [snapshot?.app?.turn_count, snapshot?.app?.receipt_hash]);

  useEffect(() => {
    const root = document.getElementById('root');
    if (root) root.setAttribute('data-dashboard-hydrated', 'react');
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('infring_dashboard_controls_open', controlsOpen ? '1' : '0');
    } catch {
      // ignore storage failures
    }
  }, [controlsOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem('infring_dashboard_theme_v1', theme);
    } catch {
      // ignore storage failures
    }
    document.documentElement.setAttribute('data-infring-theme', theme);
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem('infring_dashboard_controls_sections_v1', JSON.stringify(openSections));
    } catch {
      // ignore storage failures
    }
  }, [openSections]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && controlsOpen) {
        void toggleControls(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controlsOpen]);

  const runAction = async (action: string, payload: Dict): Promise<Dict | null> => {
    try {
      setError('');
      const response = await postAction(action, payload);
      if (response.snapshot) {
        setSnapshot(response.snapshot as Snapshot);
      } else {
        const fresh = await fetchSnapshot();
        setSnapshot(fresh);
      }
      return response;
    } catch (err) {
      setError(String((err as Error).message || err));
      return null;
    }
  };

  const receipts = useMemo(() => (Array.isArray(snapshot?.receipts?.recent) ? snapshot!.receipts.recent : []), [snapshot?.receipts]);
  const logs = useMemo(() => (Array.isArray(snapshot?.logs?.recent) ? snapshot!.logs.recent : []), [snapshot?.logs]);
  const memories = useMemo(() => (Array.isArray(snapshot?.memory?.entries) ? snapshot!.memory.entries : []), [snapshot?.memory]);
  const checks = useMemo(() => (snapshot?.health?.checks ? Object.entries(snapshot.health.checks) : []), [snapshot?.health]);
  const apmRows = useMemo(() => (Array.isArray(snapshot?.apm?.metrics) ? snapshot!.apm.metrics : []), [snapshot?.apm]);
  const agents = useMemo(() => (Array.isArray(snapshot?.collab?.dashboard?.agents) ? snapshot!.collab.dashboard.agents : []), [snapshot?.collab]);
  const hotspots = useMemo(() => (Array.isArray(snapshot?.skills?.metrics?.run_hotspots) ? snapshot!.skills.metrics.run_hotspots : []), [snapshot?.skills]);
  const handoffs = useMemo(() => (Array.isArray(snapshot?.collab?.dashboard?.handoff_history) ? snapshot!.collab.dashboard.handoff_history : []), [snapshot?.collab]);

  const filteredReceipts = useMemo(
    () => receipts.filter((row: Dict) => containsQuery(deferredSearch, [row.kind, row.path, row.mtime, row.size_bytes])),
    [receipts, deferredSearch]
  );
  const filteredLogs = useMemo(
    () => logs.filter((row: Dict) => containsQuery(deferredSearch, [row.ts, row.source, row.message])),
    [logs, deferredSearch]
  );
  const filteredMemories = useMemo(
    () => memories.filter((row: Dict) => containsQuery(deferredSearch, [row.scope, row.kind, row.path, row.mtime])),
    [memories, deferredSearch]
  );

  const graphNodes = useMemo(() => {
    const nodes: Array<{ id: string; label: string; x: number; y: number; tone: Tone }> = [
      { id: 'chat-ui', label: 'chat-ui', x: 88, y: 72, tone: 'ok' },
    ];
    handoffs.slice(0, 8).forEach((row: Dict, idx: number) => {
      nodes.push({
        id: String(row.shadow || `shadow-${idx}`),
        label: shortHash(row.shadow || `shadow-${idx}`, 14),
        x: 250 + idx * 106,
        y: idx % 2 === 0 ? 56 : 120,
        tone: statusTone(row.status || 'unknown'),
      });
    });
    chatTurns.slice(-4).forEach((turn: Dict, idx: number) => {
      nodes.push({
        id: String(turn.turn_id || `turn-${idx}`),
        label: shortHash(turn.turn_id || `turn-${idx}`, 10),
        x: 170 + idx * 170,
        y: 242,
        tone: 'warn',
      });
    });
    return nodes;
  }, [handoffs, chatTurns]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const row of graphNodes) map.set(row.id, { x: row.x, y: row.y });
    return map;
  }, [graphNodes]);

  const graphEdges = useMemo(() => {
    const edges: Array<{ from: string; to: string; label: string }> = [];
    handoffs.slice(0, 8).forEach((row: Dict, idx: number) => {
      edges.push({
        from: 'chat-ui',
        to: String(row.shadow || `shadow-${idx}`),
        label: shortHash(row.job_id || 'handoff', 10),
      });
    });
    chatTurns.slice(-4).forEach((turn: Dict, idx: number) => {
      edges.push({
        from: 'chat-ui',
        to: String(turn.turn_id || `turn-${idx}`),
        label: shortHash(turn.provider || 'turn', 8),
      });
    });
    return edges;
  }, [handoffs, chatTurns]);

  const dismissWelcome = () => {
    setWelcomeVisible(false);
    try {
      window.localStorage.setItem('infring_dashboard_welcome_seen_v1', '1');
    } catch {
      // ignore storage failures
    }
  };

  const toggleControls = async (next?: boolean) => {
    const open = typeof next === 'boolean' ? next : !controlsOpen;
    setControlsOpen(open);
    await runAction('dashboard.ui.toggleControls', { open });
  };

  const toggleSection = (id: string) => {
    setOpenSections((prev) => {
      const nextOpen = !prev[id];
      void runAction('dashboard.ui.toggleSection', { section: id, open: nextOpen });
      return {
        ...prev,
        [id]: nextOpen,
      };
    });
  };

  const sendChat = async (input: string) => {
    const text = input.trim();
    if (!text) return;
    setSending(true);
    const response = await runAction('app.chat', { input: text });
    const turn = response && response.lane && response.lane.turn ? response.lane.turn : null;
    if (turn && typeof turn === 'object') {
      setChatTurns((prev) => [...prev, turn]);
    }
    setSending(false);
  };

  const quickAction = async (kind: 'new_agent' | 'new_swarm' | 'assimilate' | 'benchmark' | 'open_controls') => {
    if (kind === 'new_agent') {
      await runAction('collab.launchRole', { team, role: 'analyst', shadow: `${team}-analyst` });
      return;
    }
    if (kind === 'new_swarm') {
      await runAction('collab.launchRole', { team, role: 'orchestrator', shadow: `${team}-orchestrator` });
      return;
    }
    if (kind === 'assimilate') {
      await runAction('dashboard.assimilate', { target: 'codex' });
      return;
    }
    if (kind === 'benchmark') {
      await runAction('dashboard.benchmark', {});
      return;
    }
    await toggleControls(true);
  };

  const alertsCount = Number(snapshot?.health?.alerts?.count || 0);

  const visibleSections = useMemo(() => {
    if (!deferredSearch) return DRAWER_SECTIONS;
    return DRAWER_SECTIONS.filter((section) => containsQuery(deferredSearch, [section.id, section.label]));
  }, [deferredSearch]);

  return (
    <div className="dash-root min-h-screen bg-transparent text-slate-100">
      <header className="dash-topbar sticky top-0 z-40">
        <div>
          <h1 className="text-[15px] font-semibold tracking-[.02em]">InfRing - Unified Agent Deck</h1>
          <p className="text-[11px] text-slate-300">Clean chat default. Advanced controls open from side pane.</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={connected ? 'live' : 'reconnecting'} />
          <button className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <button className="btn" onClick={() => toggleControls()}>
            {controlsOpen ? 'Close Controls' : 'Open Controls'}
          </button>
          <div className="avatar-chip" title="Operator">
            <span>J</span>
          </div>
        </div>
      </header>

      <main className="dash-main">
        <section className="chat-panel">
          <header className="chat-panel-head">
            <div>
              <h2>Chat</h2>
              <p>Session <span className="mono">{String(snapshot?.app?.session_id || 'chat-ui-default')}</span></p>
            </div>
            <div className="chat-head-stats">
              <span>Turns {fmtNumber(snapshot?.app?.turn_count || 0)}</span>
              <span>Alerts {fmtNumber(alertsCount)}</span>
            </div>
          </header>

          <div className="chat-scroll">
            {welcomeVisible ? (
              <div className="welcome-banner">
                <p>Welcome to InfRing - start chatting or open Controls for advanced features.</p>
                <button className="micro-btn" onClick={dismissWelcome}>Dismiss</button>
              </div>
            ) : null}

            {error ? <div className="error-banner">{error}</div> : null}

            {chatTurns.length === 0 ? (
              <div className="chat-empty">No messages yet. Ask anything or type "new agent" to begin.</div>
            ) : (
              <div className="chat-list">
                {chatTurns.slice(-40).map((turn: Dict, idx: number) => (
                  <article key={`${turn.turn_id || 'turn'}-${idx}`} className="chat-turn">
                    <div className="chat-turn-meta">
                      <span>{String(turn.ts || 'n/a')}</span>
                      <StatusPill status={sending && idx === chatTurns.length - 1 ? 'thinking' : turn.status || 'complete'} />
                    </div>
                    <div className="chat-bubble user">
                      <div className="bubble-label">You</div>
                      <div>{String(turn.user || '')}</div>
                    </div>
                    <div className="chat-bubble assistant">
                      <div className="bubble-label">Agent</div>
                      <div>{String(turn.assistant || '')}</div>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {sending ? (
              <div className="typing-indicator">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span>Agent is thinking...</span>
              </div>
            ) : null}
          </div>

          <section className="quick-actions-row">
            <button className="chip-btn" onClick={() => quickAction('new_agent')}>New Agent</button>
            <button className="chip-btn" onClick={() => quickAction('new_swarm')}>New Swarm</button>
            <button className="chip-btn" onClick={() => quickAction('assimilate')}>Assimilate Codex</button>
            <button className="chip-btn" onClick={() => quickAction('benchmark')}>Run Benchmark</button>
            <button className="chip-btn" onClick={() => quickAction('open_controls')}>Open Controls</button>
          </section>

          <form
            className="chat-input-row"
            onSubmit={async (event) => {
              event.preventDefault();
              const text = chatInput.trim();
              if (!text) return;
              await sendChat(text);
              setChatInput('');
            }}
          >
            <input
              className="input"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask anything or type 'new agent' to begin..."
            />
            <button className="btn" type="submit">Send</button>
          </form>
        </section>
      </main>

      <div className={cls('drawer-backdrop', controlsOpen && 'open')} onClick={() => toggleControls(false)} />
      <aside className={cls('controls-drawer', controlsOpen && 'open')}>
        <header className="drawer-head">
          <div>
            <h2>Advanced Controls</h2>
            <p>All power surfaces, collapsed by default.</p>
          </div>
          <button className="micro-btn" onClick={() => toggleControls(false)}>Close</button>
        </header>

        <div className="drawer-toolbar">
          <input
            className="input"
            value={drawerSearch}
            onChange={(event) => setDrawerSearch(event.target.value)}
            placeholder="Search controls, receipts, logs, memory..."
          />
          <button className="micro-btn" onClick={() => fetchSnapshot().then(setSnapshot).catch((err) => setError(String((err as Error).message || err)))}>Refresh</button>
        </div>

        <div className="drawer-content">
          {visibleSections.map((section) => (
            <DrawerAccordion key={section.id} id={section.id} label={section.label} open={!!openSections[section.id]} onToggle={toggleSection}>
              {section.id === 'agents' ? (
            <div className="grid gap-2">
              <article className="tile compact">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">chat-ui</h3>
                  <StatusPill status="active" />
                </div>
                <div className="text-xs text-slate-300 mt-1">{String(snapshot?.app?.settings?.provider || 'n/a')} / {String(snapshot?.app?.settings?.model || 'n/a')}</div>
              </article>
              {agents.map((row: Dict, idx: number) => (
                <article key={`${row.shadow || 'shadow'}-${idx}`} className="tile compact">
                  <div className="flex items-center justify-between gap-1">
                    <h3 className="font-semibold">{String(row.shadow || 'shadow')}</h3>
                    <StatusPill status={row.status || 'unknown'} />
                  </div>
                  <div className="text-xs text-slate-300 mt-1">Role {String(row.role || 'unknown')}</div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button className="micro-btn" onClick={() => runAction('collab.launchRole', { team, role: String(row.role || 'analyst'), shadow: String(row.shadow || `${team}-analyst`) })}>Respawn</button>
                  </div>
                </article>
              ))}
            </div>
              ) : null}

              {section.id === 'graph' ? (
            <div className="rounded-xl border border-slate-700/60 bg-slate-950/60 p-2">
              <svg viewBox="0 0 1140 320" className="h-[240px] w-full">
                {graphEdges.map((edge, idx) => {
                  const a = nodeMap.get(edge.from);
                  const b = nodeMap.get(edge.to);
                  if (!a || !b) return null;
                  return (
                    <g key={`edge-${idx}`}>
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#4c79a6" strokeWidth="1.6" strokeDasharray="5 4" />
                      <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} fill="#9ec6ef" fontSize="9" textAnchor="middle">{edge.label}</text>
                    </g>
                  );
                })}
                {graphNodes.map((node) => {
                  const tone = node.tone;
                  return (
                    <g key={node.id}>
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={node.id === 'chat-ui' ? 20 : 14}
                        fill={tone === 'ok' ? '#163042' : tone === 'warn' ? '#3a3118' : '#3a1c26'}
                        stroke={tone === 'ok' ? '#4de2c5' : tone === 'warn' ? '#ffb347' : '#fb7185'}
                        strokeWidth="1.7"
                      />
                      <text x={node.x} y={node.y + 26} fill="#e8f0ff" fontSize="10" textAnchor="middle">{node.label}</text>
                    </g>
                  );
                })}
              </svg>
            </div>
              ) : null}

              {section.id === 'memory' ? (
            <WindowedList
              items={filteredMemories}
              rowHeight={52}
              height={260}
              emptyLabel="No memory entries"
              keyFor={(row: Dict, idx) => `${row.path || 'memory'}-${idx}`}
              renderRow={(row: Dict) => (
                <div className="mt-1 rounded-md border border-slate-700/60 bg-slate-900/50 px-2 py-1 text-[11px]">
                  <div className="text-slate-200">{String(row.scope || 'state')} · {String(row.kind || 'snapshot')}</div>
                  <div className="mono text-slate-300">{shortHash(row.path || '', 56)}</div>
                </div>
              )}
            />
              ) : null}

              {section.id === 'tools' ? (
            <div className="grid gap-2 md:grid-cols-2">
              {hotspots.slice(0, 8).map((row: Dict, idx: number) => (
                <article key={`${row.skill || row.name || idx}`} className="tile compact">
                  <h4 className="font-semibold">{String(row.skill || row.name || 'skill')}</h4>
                  <div className="text-xs text-slate-300 mt-1">Runs {fmtNumber(row.runs)}</div>
                </article>
              ))}
            </div>
            <form
              className="mt-2 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!skill.trim()) return;
                runAction('skills.run', { skill, input: skillInput });
              }}
            >
              <input className="input" value={skill} onChange={(e) => setSkill(e.target.value)} placeholder="Skill" />
              <input className="input" value={skillInput} onChange={(e) => setSkillInput(e.target.value)} placeholder="Input" />
              <button className="btn">Run Skill</button>
            </form>
              ) : null}

              {section.id === 'channels' ? (
            <div className="max-h-[270px] overflow-auto space-y-2">
              {checks.slice(0, 18).map(([name, row]: [string, any]) => (
                <div key={name} className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-slate-100">{name}</div>
                    <StatusPill status={row?.status || 'unknown'} />
                  </div>
                  <div className="mono mt-1 text-[11px] text-slate-300">{String(row?.source || 'n/a')}</div>
                </div>
              ))}
            </div>
              ) : null}

              {section.id === 'receipts' ? (
            <WindowedList
              items={filteredReceipts}
              rowHeight={46}
              height={260}
              emptyLabel="No receipts"
              keyFor={(row: Dict, idx) => `${row.path || 'receipt'}-${idx}`}
              renderRow={(row: Dict) => (
                <div className="mt-1 rounded-md border border-slate-700/60 bg-slate-900/50 px-2 py-1 text-[11px]">
                  <div className="font-semibold text-slate-100">{String(row.kind || 'artifact')}</div>
                  <div className="mono text-slate-300">{shortHash(row.path || '', 56)}</div>
                </div>
              )}
            />
              ) : null}

              {section.id === 'logs' ? (
            <WindowedList
              items={filteredLogs}
              rowHeight={58}
              height={260}
              emptyLabel="No logs"
              keyFor={(row: Dict, idx) => `${row.source || 'log'}-${idx}`}
              renderRow={(row: Dict) => (
                <div className="mt-1 rounded-md border border-slate-700/60 bg-slate-900/50 px-2 py-1 text-[11px]">
                  <div className="mono text-slate-300">{shortHash(row.ts || 'n/a', 24)} · {shortHash(row.source || '', 26)}</div>
                  <div className="text-slate-100">{shortHash(row.message || '', 72)}</div>
                </div>
              )}
            />
              ) : null}

              {section.id === 'apm' ? (
            <div className="grid gap-2 md:grid-cols-2">
              {apmRows.slice(0, 12).map((row: Dict) => (
                <div key={String(row.name || 'metric')} className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-2">
                  <div className="text-xs font-semibold text-slate-100">{String(row.name || 'metric')}</div>
                  <div className="text-[11px] text-slate-300 mt-1">Value {fmtNumber(row.value)}</div>
                  <div className="text-[11px] text-slate-300">Target {String(row.target || 'n/a')}</div>
                  <div className="mt-1"><StatusPill status={row.status || 'unknown'} /></div>
                </div>
              ))}
            </div>
              ) : null}

              {section.id === 'settings' ? (
            <div className="space-y-2">
              <div>
                <label className="text-xs text-slate-300">Provider</label>
                <input className="input" value={provider} onChange={(e) => setProvider(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-slate-300">Model</label>
                <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
              </div>
              <button className="btn" onClick={() => runAction('app.switchProvider', { provider, model })}>Switch Provider</button>
              <div>
                <label className="text-xs text-slate-300">Team</label>
                <input className="input" value={team} onChange={(e) => setTeam(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-slate-300">Role</label>
                <input className="input" value={role} onChange={(e) => setRole(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-slate-300">Shadow</label>
                <input className="input" value={shadow} onChange={(e) => setShadow(e.target.value)} />
              </div>
              <button className="btn" onClick={() => runAction('collab.launchRole', { team, role, shadow })}>Launch Role</button>
            </div>
              ) : null}
            </DrawerAccordion>
          ))}
        </div>
      </aside>
    </div>
  );
}

const rootNode = document.getElementById('root');
if (!rootNode) {
  throw new Error('dashboard_root_missing');
}
createRoot(rootNode).render(<App />);
