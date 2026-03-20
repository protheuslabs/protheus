// Dependency-free fallback UI for environments where external module CDNs are blocked.

type Dict = Record<string, any>;

function esc(value: unknown): string {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function short(value: unknown, max = 96): string {
  const text = String(value == null ? '' : value).trim();
  if (!text) return 'n/a';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function rows(value: unknown): Dict[] {
  return Array.isArray(value) ? value : [];
}

async function fetchSnapshot(): Promise<Dict | null> {
  try {
    const res = await fetch('/api/dashboard/snapshot', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as Dict;
  } catch {
    return null;
  }
}

function render(snapshot: Dict | null) {
  const root = document.getElementById('root');
  if (!root) return;
  if (!snapshot) {
    root.innerHTML = `
      <main style="max-width:980px;margin:32px auto;padding:16px;color:#e8f0ff;background:rgba(9,16,30,.72);border:1px solid rgba(122,163,255,.28);border-radius:14px">
        <h1 style="margin:0 0 8px 0">InfRing Dashboard</h1>
        <p style="margin:0 0 8px 0;color:#bfd3f5">Fallback mode active (React bundle unavailable).</p>
        <p style="margin:0;color:#bfd3f5">Snapshot endpoint not reachable yet. Retry in a few seconds.</p>
      </main>
    `;
    return;
  }

  const agents = rows(snapshot?.collab?.dashboard?.agents);
  const receipts = rows(snapshot?.receipts?.recent).slice(0, 20);
  const logs = rows(snapshot?.logs?.recent).slice(0, 20);
  const checks = Object.entries(snapshot?.health?.checks || {}).slice(0, 16);
  const turns = rows(snapshot?.app?.turns).slice(-20);
  const controlsOpen = (() => {
    try {
      return window.localStorage.getItem('infring_dashboard_controls_open') === '1';
    } catch {
      return false;
    }
  })();

  root.innerHTML = `
    <main style="max-width:1120px;margin:20px auto;padding:14px;color:#e8f0ff;background:rgba(9,16,30,.72);border:1px solid rgba(122,163,255,.28);border-radius:14px">
      <header style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <div>
          <h1 style="margin:0 0 4px 0;font-size:18px">InfRing - Unified Agent Deck</h1>
          <p style="margin:0;color:#bfd3f5;font-size:12px">Compatibility mode: clean chat default, advanced controls optional.</p>
        </div>
        <button id="fallback-controls-toggle" type="button" style="border:1px solid rgba(77,226,197,.45);border-radius:8px;background:rgba(77,226,197,.14);color:#e8fff9;padding:8px 10px;font-size:12px;font-weight:700;cursor:pointer">${controlsOpen ? 'Close Controls' : 'Open Controls'}</button>
      </header>

      <section style="margin-top:12px;padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
          <div style="font-size:12px;color:#b9ceef">Session: ${esc(snapshot?.app?.session_id || 'chat-ui-default')}</div>
          <div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#a9c2ee">Receipt: ${esc(short(snapshot.receipt_hash || 'n/a', 32))}</div>
        </div>

        <div style="max-height:320px;overflow:auto;border:1px solid rgba(122,163,255,.2);border-radius:8px;padding:8px;background:rgba(5,10,20,.5);margin-top:8px">
          ${
            turns.length === 0
              ? '<div style="font-size:12px;color:#b9ceef">No turns yet. Ask anything or type "new agent" to begin.</div>'
              : turns
                  .map(
                    (turn) => `
                      <article style="margin-bottom:8px;padding:6px;border:1px solid rgba(122,163,255,.16);border-radius:8px;background:rgba(10,16,28,.5)">
                        <div style="font-size:11px;color:#95b7e7">${esc(short(turn.ts || 'n/a', 32))} · ${esc(turn.status || 'complete')}</div>
                        <div style="font-size:12px;color:#8fd0ff;margin-top:4px"><b>You:</b> ${esc(turn.user || '')}</div>
                        <div style="font-size:12px;color:#9ff2cf;margin-top:4px"><b>Agent:</b> ${esc(turn.assistant || '')}</div>
                      </article>
                    `
                  )
                  .join('')
          }
        </div>

        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button id="fallback-new-agent" type="button" style="border:1px solid rgba(122,163,255,.4);border-radius:999px;background:rgba(122,163,255,.12);color:#dce9ff;padding:6px 10px;font-size:11px;cursor:pointer">New Agent</button>
          <button id="fallback-new-swarm" type="button" style="border:1px solid rgba(122,163,255,.4);border-radius:999px;background:rgba(122,163,255,.12);color:#dce9ff;padding:6px 10px;font-size:11px;cursor:pointer">New Swarm</button>
          <button id="fallback-assimilate" type="button" style="border:1px solid rgba(122,163,255,.4);border-radius:999px;background:rgba(122,163,255,.12);color:#dce9ff;padding:6px 10px;font-size:11px;cursor:pointer">Assimilate Codex</button>
          <button id="fallback-benchmark" type="button" style="border:1px solid rgba(122,163,255,.4);border-radius:999px;background:rgba(122,163,255,.12);color:#dce9ff;padding:6px 10px;font-size:11px;cursor:pointer">Run Benchmark</button>
        </div>

        <div style="display:flex;gap:8px;margin-top:8px">
          <input id="fallback-chat-input" type="text" placeholder="Ask anything or type 'new agent' to begin..." style="flex:1;border:1px solid rgba(122,163,255,.4);border-radius:8px;background:rgba(5,10,20,.9);color:#e6efff;padding:8px;font-size:12px" />
          <button id="fallback-chat-send" type="button" style="border:1px solid rgba(77,226,197,.45);border-radius:8px;background:rgba(77,226,197,.14);color:#e8fff9;padding:8px 10px;font-size:12px;font-weight:700;cursor:pointer">Send</button>
        </div>
      </section>

      <section id="fallback-controls-panel" style="display:${controlsOpen ? 'block' : 'none'};margin-top:12px;padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)">
        <h2 style="margin:0 0 8px 0;font-size:14px">Advanced Controls</h2>

        <details data-section="agents">
          <summary style="cursor:pointer;font-size:12px;font-weight:700;color:#d9e8ff">Agents & Swarms (${esc(agents.length)})</summary>
          <ul style="margin:8px 0 0 0;padding-left:18px;font-size:12px;color:#d3e1fa">
            ${agents.map((row) => `<li>${esc(row.shadow || 'shadow')} · ${esc(row.role || 'role')} · ${esc(row.status || 'unknown')}</li>`).join('')}
          </ul>
        </details>

        <details data-section="channels" style="margin-top:8px">
          <summary style="cursor:pointer;font-size:12px;font-weight:700;color:#d9e8ff">Channels & Delivery (${esc(checks.length)})</summary>
          <ul style="margin:8px 0 0 0;padding-left:18px;font-size:12px;color:#d3e1fa">
            ${checks.map(([name, row]) => `<li><b>${esc(name)}</b> — ${esc((row as Dict)?.status || 'unknown')}</li>`).join('')}
          </ul>
        </details>

        <details data-section="receipts" style="margin-top:8px">
          <summary style="cursor:pointer;font-size:12px;font-weight:700;color:#d9e8ff">Receipts & Audit (${esc(receipts.length)})</summary>
          <ul style="margin:8px 0 0 0;padding-left:18px;font-size:12px;color:#d3e1fa">
            ${receipts.map((row) => `<li>${esc(short(row.path || 'artifact', 84))}</li>`).join('')}
          </ul>
        </details>

        <details data-section="logs" style="margin-top:8px">
          <summary style="cursor:pointer;font-size:12px;font-weight:700;color:#d9e8ff">Logs (${esc(logs.length)})</summary>
          <ul style="margin:8px 0 0 0;padding-left:18px;font-size:12px;color:#d3e1fa">
            ${logs.map((row) => `<li>${esc(short(row.ts || 'n/a', 24))} — ${esc(short(row.message || '', 120))}</li>`).join('')}
          </ul>
        </details>
      </section>
    </main>
  `;

  const sendBtn = root.querySelector('#fallback-chat-send') as HTMLButtonElement | null;
  const inputEl = root.querySelector('#fallback-chat-input') as HTMLInputElement | null;
  const controlsToggle = root.querySelector('#fallback-controls-toggle') as HTMLButtonElement | null;
  const controlsPanel = root.querySelector('#fallback-controls-panel') as HTMLElement | null;
  const newAgentBtn = root.querySelector('#fallback-new-agent') as HTMLButtonElement | null;
  const newSwarmBtn = root.querySelector('#fallback-new-swarm') as HTMLButtonElement | null;
  const assimilateBtn = root.querySelector('#fallback-assimilate') as HTMLButtonElement | null;
  const benchmarkBtn = root.querySelector('#fallback-benchmark') as HTMLButtonElement | null;

  const postAction = async (action: string, payload: Dict) => {
    try {
      await fetch('/api/dashboard/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
    } catch {
      // keep fallback resilient
    }
  };

  if (controlsToggle && controlsPanel) {
    controlsToggle.onclick = async () => {
      const open = controlsPanel.style.display !== 'block';
      controlsPanel.style.display = open ? 'block' : 'none';
      controlsToggle.textContent = open ? 'Close Controls' : 'Open Controls';
      try {
        window.localStorage.setItem('infring_dashboard_controls_open', open ? '1' : '0');
      } catch {
        // ignore storage failures
      }
      await postAction('dashboard.ui.toggleControls', { open });
    };
  }

  root.querySelectorAll('details[data-section]').forEach((detailsEl) => {
    detailsEl.addEventListener('toggle', () => {
      const section = String((detailsEl as HTMLElement).getAttribute('data-section') || 'unknown');
      const open = (detailsEl as HTMLDetailsElement).open;
      void postAction('dashboard.ui.toggleSection', { section, open });
    });
  });

  if (newAgentBtn) {
    newAgentBtn.onclick = async () => {
      await postAction('collab.launchRole', { team: 'ops', role: 'analyst', shadow: 'ops-analyst' });
      const next = await fetchSnapshot();
      render(next);
    };
  }
  if (newSwarmBtn) {
    newSwarmBtn.onclick = async () => {
      await postAction('collab.launchRole', { team: 'ops', role: 'orchestrator', shadow: 'ops-orchestrator' });
      const next = await fetchSnapshot();
      render(next);
    };
  }
  if (assimilateBtn) {
    assimilateBtn.onclick = async () => {
      await postAction('dashboard.assimilate', { target: 'codex' });
      const next = await fetchSnapshot();
      render(next);
    };
  }
  if (benchmarkBtn) {
    benchmarkBtn.onclick = async () => {
      await postAction('dashboard.benchmark', {});
      const next = await fetchSnapshot();
      render(next);
    };
  }

  if (sendBtn && inputEl) {
    sendBtn.onclick = async () => {
      const text = String(inputEl.value || '').trim();
      if (!text) return;
      sendBtn.disabled = true;
      try {
        await fetch('/api/dashboard/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'app.chat', payload: { input: text } }),
        });
        inputEl.value = '';
        const next = await fetchSnapshot();
        render(next);
      } catch {
        // keep fallback resilient; update loop will retry snapshot anyway
      } finally {
        sendBtn.disabled = false;
      }
    };
  }
}

function bootFallback() {
  const root = document.getElementById('root');
  if (!root) return;
  if (root.getAttribute('data-dashboard-hydrated') === 'react') return;
  if (root.getAttribute('data-dashboard-hydrated') === 'inline-fallback') return;
  root.setAttribute('data-dashboard-hydrated', 'fallback');

  const update = async () => {
    if (root.getAttribute('data-dashboard-hydrated') !== 'fallback') return;
    const snapshot = await fetchSnapshot();
    render(snapshot);
  };

  void update();
  window.setInterval(update, 5000);
}

window.addEventListener('DOMContentLoaded', () => {
  window.setTimeout(bootFallback, 900);
});
