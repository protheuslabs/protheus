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
  const receipts = rows(snapshot?.receipts?.recent).slice(0, 12);
  const logs = rows(snapshot?.logs?.recent).slice(0, 12);
  const checks = Object.entries(snapshot?.health?.checks || {}).slice(0, 12);

  root.innerHTML = `
    <main style="max-width:1200px;margin:20px auto;padding:16px;color:#e8f0ff;background:rgba(9,16,30,.72);border:1px solid rgba(122,163,255,.28);border-radius:14px">
      <header style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div>
          <h1 style="margin:0 0 6px 0">InfRing Dashboard</h1>
          <p style="margin:0;color:#bfd3f5">Fallback mode active (React/ESM dependency blocked). This is still live authority data.</p>
        </div>
        <div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#a9c2ee">
          <div>Updated: ${esc(snapshot.ts || 'n/a')}</div>
          <div>Receipt: ${esc(short(snapshot.receipt_hash || 'n/a', 32))}</div>
        </div>
      </header>

      <section style="margin-top:14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
        <article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)">
          <div style="font-size:12px;color:#b9ceef">Active Agents</div>
          <div style="font-size:22px;font-weight:700">${esc(agents.length)}</div>
        </article>
        <article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)">
          <div style="font-size:12px;color:#b9ceef">Open Alerts</div>
          <div style="font-size:22px;font-weight:700">${esc(snapshot?.health?.alerts?.count ?? 0)}</div>
        </article>
        <article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)">
          <div style="font-size:12px;color:#b9ceef">Provider</div>
          <div style="font-size:16px;font-weight:700">${esc(snapshot?.app?.settings?.provider || 'n/a')}</div>
        </article>
        <article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)">
          <div style="font-size:12px;color:#b9ceef">Model</div>
          <div style="font-size:16px;font-weight:700">${esc(snapshot?.app?.settings?.model || 'n/a')}</div>
        </article>
      </section>

      <section style="margin-top:14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">
        <article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)">
          <h2 style="margin:0 0 8px 0;font-size:14px">Health Checks</h2>
          <ul style="margin:0;padding-left:18px;font-size:12px;color:#d3e1fa">
            ${checks.map(([name, row]) => `<li><b>${esc(name)}</b> — ${esc((row as Dict)?.status || 'unknown')}</li>`).join('')}
          </ul>
        </article>
        <article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)">
          <h2 style="margin:0 0 8px 0;font-size:14px">Recent Receipts</h2>
          <ul style="margin:0;padding-left:18px;font-size:12px;color:#d3e1fa">
            ${receipts.map((row) => `<li>${esc(short(row.path || 'artifact', 72))}</li>`).join('')}
          </ul>
        </article>
      </section>

      <section style="margin-top:14px;padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)">
        <h2 style="margin:0 0 8px 0;font-size:14px">Recent Logs</h2>
        <ul style="margin:0;padding-left:18px;font-size:12px;color:#d3e1fa">
          ${logs.map((row) => `<li>${esc(short(row.ts || 'n/a', 24))} — ${esc(short(row.message || '', 100))}</li>`).join('')}
        </ul>
      </section>
    </main>
  `;
}

function bootFallback() {
  const root = document.getElementById('root');
  if (!root) return;
  if (root.getAttribute('data-dashboard-hydrated') === 'react') return;
  if (root.childElementCount > 0) return;
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

