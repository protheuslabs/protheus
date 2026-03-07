# protheus (npm)

Install globally:

```bash
npm install -g protheus
```

or from source:

```bash
npm install -g .
```

The package installs a `protheus` executable backed by the Rust `protheus-ops` binary.

## Runtime Notes

- Installer first attempts to fetch a prebuilt binary from GitHub Releases.
- If no release binary is available, it falls back to building from source with Cargo (when source files are present).
- When full Protheus runtime assets are available, the wrapper routes into `protheusctl` command dispatch.
