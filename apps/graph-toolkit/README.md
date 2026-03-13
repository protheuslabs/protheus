# Graph Toolkit App Surface

Thin, non-authoritative app surface for graph analytics workflows.

Core authority:
- `core/layer0/ops/src/graph_toolkit/` (algorithms, receipts, policy gate)

CLI entrypoints:
- `protheus graph pagerank`
- `protheus graph louvain`
- `protheus graph jaccard`
- `protheus graph label-propagation`
- `protheus graph betweenness`
- `protheus graph predict-links`

Conduit path:
- `client/cli/bin/protheus-graph.ts` routes through `ops_domain_conduit_runner` with `--domain=graph-toolkit`.

This app directory should contain workflow/UI composition only. It must not own policy, receipt, or execution authority.
