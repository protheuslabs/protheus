# os_extension_wrapper (Layer 3)

Full OS extension wrapper contracts that sit above Layer 2 deterministic scheduling.

- Input: `OsExtensionDescriptor`
- Output: `OsExtensionEnvelope`
- Scope: syscall/driver/namespace extension surfaces with no Layer 0 bypass

This crate expresses extension shape only; authority remains below Layer 3.
