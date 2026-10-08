# DevContainer Composer

Generate a ready-to-use `.devcontainer/` for any folder. Tick the packages you need in a panel (Node.js, TypeScript, Python, Azure CLI, azd, AWS CLI, Copilot, ...). The generated container keeps your **CLI logins, GitHub Copilot state and shell history** across restarts and rebuilds.

## Quick start

1. Open a folder in VS Code. It can be empty.
2. Click **Dev Container** (package icon) in the status bar, or run **DevContainer Composer: Create / Edit Dev Container**.
3. Choose packages and versions, then click **Generate .devcontainer**.
4. Click **Reopen in Container**. This needs the [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension.

If you don't need the panel, use **Generate Dev Container with Default Packages**. If a `.devcontainer` already exists, it opens the panel instead of overwriting anything.

## What gets generated

```
.devcontainer/
  devcontainer.json   features, mounts, extensions, postCreateCommand, stored selection
  Dockerfile          managed block between markers; your own lines below the end marker are kept
  post-create.sh      volume ownership fix, symlinks, package setup, then post-create.local.sh if present
  .gitattributes      LF line endings for *.sh and Dockerfile
```

Put your own setup steps in `.devcontainer/post-create.local.sh`. The extension never overwrites that file.

## Persistence

Two Docker volumes are mounted:

| Volume | Mounted at | Contains |
|---|---|---|
| `devc-shared-auth` (shared by **all** projects) | `/persist/shared` | `~/.azure`, `~/.azd`, `~/.aws`, `~/.config/gh`, `~/.terraform.d`, `~/.kube` |
| `devc-${devcontainerId}-project` (**this** project) | `/persist/project` | Copilot and VS Code server state, `~/.copilot`, shell history |

Each home path is a symlink into its volume, so you log in once and the login is reused by every project. `${devcontainerId}` stays the same when you rebuild, so project state survives **Rebuild Container**. You can turn off persistence completely, or switch off single items, in the panel.

## Corporate networks

Under **Package sources** you can set:

- an **npm registry** (`NPM_CONFIG_REGISTRY`)
- a **pip index** and trusted host (`PIP_INDEX_URL`, `PIP_TRUSTED_HOST`)
- an **image mirror**, which replaces `mcr.microsoft.com`
- a **feature mirror**, which replaces `ghcr.io`

These settings are written to the Dockerfile as `ENV` lines, so they apply while features install and inside the container. Defaults come from the `devcontainerComposer.sources.*` settings.

> Some Dev Container Features download binaries directly from vendor hosts (nodejs.org, packages.microsoft.com, github.com, files.pythonhosted.org). Your proxy must allow those hosts, or your mirror must cache them.

## Re-running on an existing `.devcontainer`

- `devcontainer.json` is edited in place, so **comments and unknown keys are kept**.
- Features, extensions and mounts you added yourself are kept. Items the extension added earlier are removed when you deselect them.
- An existing `postCreateCommand` is kept and runs in parallel with `post-create.sh`.
- A Dockerfile without markers is only replaced after you confirm, and a backup is saved as `Dockerfile.bak`.
- `dockerComposeFile` setups are not supported yet.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `devcontainerComposer.defaultPackages` | `node, typescript, python, azure-cli, azd, copilot` | Pre-selected packages (`id` or `id@version`) |
| `devcontainerComposer.baseImage` | `mcr.microsoft.com/devcontainers/base:ubuntu` | `FROM` image |
| `devcontainerComposer.remoteUser` | `vscode` | Container user |
| `devcontainerComposer.sources.npmRegistry` | | npm registry or proxy |
| `devcontainerComposer.sources.pipIndexUrl` / `pipTrustedHost` | | pip index or proxy |
| `devcontainerComposer.sources.imageMirror` | | Replaces `mcr.microsoft.com` |
| `devcontainerComposer.sources.featureMirror` | | Replaces `ghcr.io` |
| `devcontainerComposer.sharedVolumeName` | `devc-shared-auth` | Volume shared by all projects |
| `devcontainerComposer.showStatusBar` | `true` | Status bar button |
| `devcontainerComposer.customPackages` | `[]` | Extra packages, or replacements for built-in ones |

**Save as my default** in the panel writes the current selection to these settings.

### Custom packages

```jsonc
"devcontainerComposer.customPackages": [
  {
    "id": "rust",
    "label": "Rust",
    "category": "Languages",
    "feature": "ghcr.io/devcontainers/features/rust:1",
    "versions": ["latest", "1.80"],
    "extensions": ["rust-lang.rust-analyzer"],
    "persist": [{ "id": "cargo-registry", "path": ".cargo/registry", "scope": "shared" }]
  },
  {
    "id": "corp-tools",
    "label": "Company tools",
    "install": "pip install --user corp-cli==${version}",
    "versions": ["2.1.0"],
    "requires": ["python"]
  }
]
```

A custom package with the same `id` as a built-in one replaces the built-in one.

## Development

See `PROJECT.md` in the repository for the design and architecture.

```bash
npm install
npm run typecheck
npm test          # unit tests (node:test)
npm run build     # esbuild bundle to dist/extension.js
npm run package   # .vsix
```

Press **F5** to start an Extension Development Host. The end-to-end test needs Docker; see `e2e/run-e2e.sh` and `e2e/run-e2e.ps1`.
