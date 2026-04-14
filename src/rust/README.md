# Rust Workspace

This directory contains the Rust implementation of the project.

It is split into three crates:
- `shared`: common Git and repository helpers
- `iago`: the CLI binary
- `iago-server`: the server binary

## Layout

- `src/rust/shared`
- `src/rust/cli`
- `src/rust/server`

## Build

After installing Rust, build the Windows executables from the repository root:

```powershell
powershell -File ./build/rust/cli/build-windows-exe.ps1
powershell -File ./build/rust/server/build-windows-exe.ps1
```

The build scripts place the finished executables in:
- `dist/rust/cli/iago.exe`
- `dist/rust/server/iago-server.exe`

## CLI behavior

The Rust CLI now implements the main local workflow:
- `sync`
- `list`
- `show`
- `start-issue`
- `completed`
- `report`
- `create-issue`
- `set-port`

The CLI talks to GitHub directly when you supply a token. It also reads and updates the shared relay port from `relay-config.json` at the workspace root.

## Server behavior

The Rust `iago-server` keeps the process alive in both `serve` and `repl` mode until you type `quit`, `exit`, or send EOF. The REPL accepts `list`, `add`, and `set-port`.

`iago-server` also reads `relay-config.json` at the workspace root. Use `set-port --port <number>` to update the shared config so both the client and the server use the new port.

Vault tokens are encrypted at rest in `src/rust/server/vault/repos.json` using the compiled master key in
[`src/rust/server/src/config.rs`](/workspace/tools-github-issues-resolver/src/rust/server/src/config.rs).
Existing plaintext vault entries remain readable and are converted when the vault is saved again.

## Status

The workspace is functional for the CLI build and server loop, and it is ready for the rest of the relay translation.
