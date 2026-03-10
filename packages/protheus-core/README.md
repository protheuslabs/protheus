# `@protheus/core`

Modular extraction for core runtime APIs:

- `spineStatus()`
- `reflexStatus()`
- `gateStatus()`

This package intentionally exposes only lightweight core surfaces. Heavy optional layers remain outside this package.

Quick start:

```bash
node packages/protheus-core/starter.js
```

Optional flags:

```bash
node packages/protheus-core/starter.js --spine=1 --reflex=0 --gates=1
```

Cold-start contract:

```bash
node packages/protheus-core/starter.js --mode=contract --max-mb=5 --max-ms=200
```
