import React, { useEffect, useMemo, useState } from 'https://esm.sh/react@18.2.0';
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client';
import ReactFlow, { Background, Controls, MiniMap } from 'https://esm.sh/reactflow@11.11.4';

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

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents + Swarms' },
  { id: 'activity', label: 'Activity Graph' },
  { id: 'memory', label: 'Memory' },
  { id: 'tools', label: 'Marketplace' },
  { id: 'channels', label: 'Channels' },
  { id: 'receipts', label: 'Receipts' },
  { id: 'logs', label: 'Logs' },
  { id: 'apm', label: 'APM' },
  { id: 'settings', label: 'Settings' },
];

function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function shortHash(value: unknown, size = 14): string {
  const text = String(value ?? '').trim();
  if (!text) return 'n/a';
  return text.length <= size ? text : `${text.slice(0, size)}…`;
}

function fmtNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'n/a';
  if (Math.abs(num) >= 1000) return num.toLocaleString('en-US');
  if (Math.abs(num) >= 100) return num.toFixed(0);
  if (Math.abs(num) >= 10) return num.toFixed(1);
  return num.toFixed(2);
}

function statusTone(status: unknown): 'ok' | 'warn' | 'bad' {
  const value = String(status ?? '').trim().toLowerCase();
  if (['pass', 'ok', 'running', 'active', 'success'].includes(value)) return 'ok';
  if (['warn', 'warning', 'pending', 'paused'].includes(value)) return 'warn';
  return 'bad';
}

function StatusChip({ status }: { status: unknown }) {
  const tone = statusTone(status);
  return (
    <span
      className={cls(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
        tone === 'ok' && 'bg-emerald-300 text-emerald-950',
        tone === 'warn' && 'bg-amber-300 text-amber-950',
        tone === 'bad' && 'bg-rose-300 text-rose-950'
      )}
    >
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
  const [error, setError] = useState<string>('');

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
        const envelope = JSON.parse(String(event.data)) as SnapshotEnvelope;
        if (envelope.type === 'snapshot' && envelope.snapshot) {
          setSnapshot(envelope.snapshot);
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
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
      }
      if (socket) {
        try {
          socket.close();
        } catch {}
      }
    };
  }, []);

  return { snapshot, setSnapshot, connected, error, setError };
}

function ActivityGraph({ snapshot }: { snapshot: Snapshot }) {
  const handoffs = useMemo(
    () => (Array.isArray(snapshot.collab?.dashboard?.handoff_history) ? snapshot.collab.dashboard.handoff_history : []),
    [snapshot]
  );
  const appTurns = useMemo(() => (Array.isArray(snapshot.app?.turns) ? snapshot.app.turns : []), [snapshot]);

  const flow = useMemo(() => {
    const nodes: Array<any> = [{ id: 'chat-ui', position: { x: 40, y: 40 }, data: { label: 'chat-ui' }, style: { background: '#163042', color: '#e6f6ff', border: '1px solid #4de2c5' } }];
    const edges: Array<any> = [];
    handoffs.slice(0, 8).forEach((row: Dict, idx: number) => {
      const id = String(row.shadow || `shadow-${idx}`);
      nodes.push({
        id,
        position: { x: 250 + idx * 140, y: idx % 2 === 0 ? 30 : 120 },
        data: { label: id },
        style: { background: '#2b2242', color: '#f4edff', border: '1px solid #a98bff' },
      });
      edges.push({
        id: `handoff-${idx}`,
        source: 'chat-ui',
        target: id,
        label: String(row.job_id || 'handoff'),
        animated: true,
      });
    });
    appTurns.slice(-4).forEach((turn: Dict, idx: number) => {
      const id = String(turn.turn_id || `turn-${idx}`);
      nodes.push({
        id,
        position: { x: 120 + idx * 190, y: 220 },
        data: { label: shortHash(id, 10) },
        style: { background: '#3a3118', color: '#fff7dd', border: '1px solid #ffb347' },
      });
      edges.push({
        id: `turn-${idx}`,
        source: 'chat-ui',
        target: id,
        label: String(turn.provider || 'turn'),
      });
    });
    return { nodes, edges };
  }, [handoffs, appTurns]);

  return (
    <div className="h-[360px] rounded-xl border border-sky-200/20 bg-slate-950/50">
      <ReactFlow nodes={flow.nodes} edges={flow.edges} fitView>
        <Background color="#35516e" gap={20} />
        <MiniMap pannable />
        <Controls />
      </ReactFlow>
    </div>
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

  useEffect(() => {
    if (!snapshot?.app?.settings) return;
    const settings = snapshot.app.settings;
    setProvider(String(settings.provider || 'openai'));
    setModel(String(settings.model || 'gpt-5'));
  }, [snapshot?.app?.settings]);

  const kpis = useMemo(() => {
    const health = snapshot?.health || {};
    const metrics = health.dashboard_metrics || {};
    const collabAgents = Array.isArray(snapshot?.collab?.dashboard?.agents) ? snapshot.collab.dashboard.agents.length : 0;
    return {
      agents: collabAgents,
      alerts: Number(health.alerts?.count || 0),
      burn: Number(metrics.token_burn_cost_attribution?.latest_day_tokens || 0),
      latency: metrics.vbrowser_session_surface?.stream_latency_ms,
    };
  }, [snapshot]);

  const runAction = async (action: string, payload: Dict) => {
    try {
      setError('');
      const response = await postAction(action, payload);
      if (response.snapshot) {
        setSnapshot(response.snapshot as Snapshot);
      } else {
        const fresh = await fetchSnapshot();
        setSnapshot(fresh);
      }
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  const receipts = Array.isArray(snapshot?.receipts?.recent) ? snapshot!.receipts.recent : [];
  const logs = Array.isArray(snapshot?.logs?.recent) ? snapshot!.logs.recent : [];
  const memories = Array.isArray(snapshot?.memory?.entries) ? snapshot!.memory.entries : [];
  const checks = snapshot?.health?.checks ? Object.entries(snapshot.health.checks) : [];
  const apmRows = Array.isArray(snapshot?.apm?.metrics) ? snapshot!.apm.metrics : [];
  const agents = Array.isArray(snapshot?.collab?.dashboard?.agents) ? snapshot!.collab.dashboard.agents : [];
  const hotspots = Array.isArray(snapshot?.skills?.metrics?.run_hotspots) ? snapshot!.skills.metrics.run_hotspots : [];
  const handoffs = Array.isArray(snapshot?.collab?.dashboard?.handoff_history) ? snapshot!.collab.dashboard.handoff_history : [];

  return (
    <div className="min-h-screen bg-transparent text-slate-100">
      <div className="mx-auto flex max-w-[1600px] flex-col px-3 pb-8 pt-3 lg:flex-row lg:gap-4">
        <aside className="glass mb-3 w-full rounded-2xl border border-sky-200/20 p-3 lg:sticky lg:top-3 lg:mb-0 lg:h-[calc(100vh-1.5rem)] lg:w-72">
          <h1 className="text-lg font-bold tracking-wide">InfRing Dashboard</h1>
          <p className="mt-1 text-xs text-slate-300">React + Tailwind + ReactFlow control plane</p>
          <div className="mt-3 space-y-1">
            {SECTIONS.map((section) => (
              <a
                key={section.id}
                className="block rounded-lg border border-sky-200/20 bg-slate-900/50 px-3 py-2 text-sm transition hover:border-cyan-300/50 hover:bg-cyan-500/10"
                href={`#${section.id}`}
              >
                {section.label}
              </a>
            ))}
          </div>
          <div className="mt-3 rounded-lg border border-sky-200/20 bg-slate-900/60 p-2 text-xs">
            <div className="flex items-center gap-2">
              <span className={cls('inline-block h-2 w-2 rounded-full', connected ? 'bg-emerald-400' : 'bg-rose-400')} />
              <span>{connected ? 'Live stream connected' : 'Reconnecting stream'}</span>
            </div>
            <div className="mt-1 text-slate-300">Receipt: {shortHash(snapshot?.receipt_hash)}</div>
          </div>
        </aside>

        <main className="w-full space-y-3">
          <header className="glass sticky top-3 z-20 rounded-2xl border border-sky-200/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold">Unified Agent Command Deck</h2>
                <p className="text-xs text-slate-300">Dark neon grid theme with lane-backed actions.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-lg border border-cyan-300/60 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold"
                  onClick={() => fetchSnapshot().then(setSnapshot).catch((err) => setError(String((err as Error).message || err)))}
                >
                  Refresh
                </button>
                <button
                  className="rounded-lg border border-amber-300/60 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold"
                  onClick={() => runAction('dashboard.benchmark', {})}
                >
                  Benchmark Surface
                </button>
                <button
                  className="rounded-lg border border-emerald-300/60 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold"
                  onClick={() => {
                    const target = window.prompt('Assimilate target', 'codex');
                    if (target) runAction('dashboard.assimilate', { target });
                  }}
                >
                  Assimilate
                </button>
              </div>
            </div>
            {error ? <div className="mt-2 rounded-md bg-rose-500/20 px-2 py-1 text-xs text-rose-100">{error}</div> : null}
          </header>

          <section id="overview" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">Overview</h3>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="kpi-card"><div className="kpi-label">Active Agents</div><div className="kpi-value">{fmtNumber(kpis.agents)}</div></div>
              <div className="kpi-card"><div className="kpi-label">Open Alerts</div><div className="kpi-value">{fmtNumber(kpis.alerts)}</div></div>
              <div className="kpi-card"><div className="kpi-label">Daily Token Burn</div><div className="kpi-value">{fmtNumber(kpis.burn)}</div></div>
              <div className="kpi-card"><div className="kpi-label">Session Latency</div><div className="kpi-value">{kpis.latency == null ? 'n/a' : `${fmtNumber(kpis.latency)} ms`}</div></div>
            </div>
            <div className="mt-2 grid gap-1 text-xs text-slate-300">
              <div>Updated: <span className="font-mono">{snapshot?.ts || 'n/a'}</span></div>
              <div>Workspace: <span className="font-mono">{snapshot?.metadata?.root || 'n/a'}</span></div>
            </div>
          </section>

          <section id="agents" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">Agents + Swarms</h3>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              <article className="tile">
                <h4 className="font-semibold">chat-ui</h4>
                <div className="mt-1 text-xs text-slate-300">Provider: {snapshot?.app?.settings?.provider || 'n/a'}</div>
                <div className="text-xs text-slate-300">Model: {snapshot?.app?.settings?.model || 'n/a'}</div>
                <div className="text-xs text-slate-300">Turns: {fmtNumber(snapshot?.app?.turn_count || 0)}</div>
              </article>
              {agents.map((row: Dict, idx: number) => (
                <article key={`${row.shadow || 'shadow'}-${idx}`} className="tile">
                  <h4 className="font-semibold">{String(row.shadow || 'shadow')}</h4>
                  <div className="mt-1 text-xs text-slate-300">Role: {String(row.role || 'unknown')}</div>
                  <div className="mt-1"><StatusChip status={row.status || 'unknown'} /></div>
                  <div className="mt-1 text-xs text-slate-300">{String(row.activated_at || 'n/a')}</div>
                </article>
              ))}
            </div>
          </section>

          <section id="activity" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">Activity Graph</h3>
            <ActivityGraph snapshot={snapshot || { ts: '' }} />
            <div className="mt-2 overflow-auto">
              <table className="table-auto min-w-full text-left text-xs">
                <thead className="text-slate-300">
                  <tr><th className="px-2 py-1">Shadow</th><th className="px-2 py-1">Job</th><th className="px-2 py-1">Hash</th><th className="px-2 py-1">Timestamp</th></tr>
                </thead>
                <tbody>
                  {handoffs.slice(0, 10).map((row: Dict, idx: number) => (
                    <tr key={`${row.handoff_hash || idx}`} className="border-t border-slate-700/50">
                      <td className="px-2 py-1">{String(row.shadow || 'shadow')}</td>
                      <td className="px-2 py-1">{String(row.job_id || 'n/a')}</td>
                      <td className="px-2 py-1 font-mono">{shortHash(row.handoff_hash)}</td>
                      <td className="px-2 py-1">{String(row.kickoff_ts || 'n/a')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="memory" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">Memory + Knowledge</h3>
            <div className="overflow-auto">
              <table className="table-auto min-w-full text-left text-xs">
                <thead className="text-slate-300">
                  <tr><th className="px-2 py-1">Scope</th><th className="px-2 py-1">Kind</th><th className="px-2 py-1">Updated</th><th className="px-2 py-1">Path</th></tr>
                </thead>
                <tbody>
                  {memories.slice(0, 20).map((row: Dict, idx: number) => (
                    <tr key={`${row.path || idx}`} className="border-t border-slate-700/50">
                      <td className="px-2 py-1">{String(row.scope || 'state')}</td>
                      <td className="px-2 py-1">{String(row.kind || 'snapshot')}</td>
                      <td className="px-2 py-1">{String(row.mtime || 'n/a')}</td>
                      <td className="px-2 py-1 font-mono">{String(row.path || '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="tools" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">Tools + Marketplace</h3>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              <article className="tile">
                <h4 className="font-semibold">Skills Plane</h4>
                <div className="mt-1 text-xs text-slate-300">Total: {fmtNumber(snapshot?.skills?.metrics?.skills_total)}</div>
                <div className="text-xs text-slate-300">Installed: {fmtNumber(snapshot?.skills?.metrics?.skills_installed)}</div>
                <div className="text-xs text-slate-300">Runs Window: {fmtNumber(snapshot?.skills?.metrics?.runs_window)}</div>
              </article>
              {hotspots.slice(0, 5).map((row: Dict, idx: number) => (
                <article key={`${row.skill || row.name || idx}`} className="tile">
                  <h4 className="font-semibold">{String(row.skill || row.name || 'skill')}</h4>
                  <div className="mt-1 text-xs text-slate-300">Runs: {fmtNumber(row.runs)}</div>
                </article>
              ))}
            </div>
          </section>

          <section id="channels" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">Channels + Delivery</h3>
            <div className="overflow-auto">
              <table className="table-auto min-w-full text-left text-xs">
                <thead className="text-slate-300">
                  <tr><th className="px-2 py-1">Check</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Source</th></tr>
                </thead>
                <tbody>
                  {checks.slice(0, 12).map(([name, row]: [string, any]) => (
                    <tr key={name} className="border-t border-slate-700/50">
                      <td className="px-2 py-1">{name}</td>
                      <td className="px-2 py-1"><StatusChip status={row?.status || 'unknown'} /></td>
                      <td className="px-2 py-1 font-mono">{String(row?.source || 'n/a')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="receipts" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">Receipts + Audit Explorer</h3>
            <div className="overflow-auto">
              <table className="table-auto min-w-full text-left text-xs">
                <thead className="text-slate-300">
                  <tr><th className="px-2 py-1">Kind</th><th className="px-2 py-1">Updated</th><th className="px-2 py-1">Bytes</th><th className="px-2 py-1">Path</th></tr>
                </thead>
                <tbody>
                  {receipts.slice(0, 20).map((row: Dict, idx: number) => (
                    <tr key={`${row.path || idx}`} className="border-t border-slate-700/50">
                      <td className="px-2 py-1">{String(row.kind || 'artifact')}</td>
                      <td className="px-2 py-1">{String(row.mtime || 'n/a')}</td>
                      <td className="px-2 py-1">{fmtNumber(row.size_bytes)}</td>
                      <td className="px-2 py-1 font-mono">{String(row.path || '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="logs" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">Logs</h3>
            <div className="overflow-auto">
              <table className="table-auto min-w-full text-left text-xs">
                <thead className="text-slate-300">
                  <tr><th className="px-2 py-1">Timestamp</th><th className="px-2 py-1">Source</th><th className="px-2 py-1">Message</th></tr>
                </thead>
                <tbody>
                  {logs.slice(0, 24).map((row: Dict, idx: number) => (
                    <tr key={`${row.source || 'log'}-${idx}`} className="border-t border-slate-700/50">
                      <td className="px-2 py-1">{String(row.ts || 'n/a')}</td>
                      <td className="px-2 py-1 font-mono">{String(row.source || 'n/a')}</td>
                      <td className="px-2 py-1">{String(row.message || '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="apm" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">APM + Alerts</h3>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {apmRows.slice(0, 12).map((row: Dict) => (
                <article key={String(row.name || 'metric')} className="tile">
                  <h4 className="font-semibold">{String(row.name || 'metric')}</h4>
                  <div className="mt-1 text-xs text-slate-300">Value: {fmtNumber(row.value)}</div>
                  <div className="text-xs text-slate-300">Target: {String(row.target || 'n/a')}</div>
                  <div className="mt-1"><StatusChip status={row.status || 'unknown'} /></div>
                </article>
              ))}
            </div>
          </section>

          <section id="settings" className="glass rounded-2xl border border-sky-200/20 p-3">
            <h3 className="mb-2 text-sm font-semibold">Settings + Governance</h3>
            <div className="grid gap-2 xl:grid-cols-3">
              <form
                className="tile space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  runAction('app.switchProvider', { provider, model });
                }}
              >
                <h4 className="font-semibold">Provider / Model</h4>
                <div>
                  <label className="text-xs text-slate-300">Provider</label>
                  <input className="input" value={provider} onChange={(e) => setProvider(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs text-slate-300">Model</label>
                  <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
                </div>
                <button className="btn">Switch Provider</button>
              </form>

              <form
                className="tile space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  runAction('collab.launchRole', { team, role, shadow });
                }}
              >
                <h4 className="font-semibold">Launch Team Role</h4>
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
                <button className="btn">Launch Role</button>
              </form>

              <form
                className="tile space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!skill.trim()) return;
                  runAction('skills.run', { skill, input: skillInput });
                }}
              >
                <h4 className="font-semibold">Run Skill</h4>
                <div>
                  <label className="text-xs text-slate-300">Skill</label>
                  <input className="input" value={skill} onChange={(e) => setSkill(e.target.value)} placeholder="compat_skill" />
                </div>
                <div>
                  <label className="text-xs text-slate-300">Input</label>
                  <input className="input" value={skillInput} onChange={(e) => setSkillInput(e.target.value)} placeholder="optional payload" />
                </div>
                <button className="btn">Run Skill</button>
              </form>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

const rootNode = document.getElementById('root');
if (!rootNode) {
  throw new Error('dashboard_root_missing');
}
rootNode.setAttribute('data-dashboard-hydrated', 'react');
createRoot(rootNode).render(<App />);
