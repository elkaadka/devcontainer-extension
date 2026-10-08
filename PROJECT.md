# DevContainer Composer

A VS Code extension that generates a ready-to-use `.devcontainer/` for any folder. You tick the packages you need in a webview (Node.js, TypeScript, Python, Azure CLI, azd, AWS CLI, ...), and the extension writes a dev container with **persistent volumes**, so CLI logins and GitHub Copilot sessions survive container restarts and rebuilds.

## Goals

| # | Goal |
|---|------|
| 1 | Create a new folder, click one button, get a working dev container. |
| 2 | Choose packages by category in a webview, with optional version selection. |
| 3 | Default selection: **Node.js, TypeScript, Python, Azure CLI, azd, GitHub Copilot**. |
| 4 | **Persistence**: restarting or rebuilding the container must not lose Copilot sessions, chat state, CLI logins or shell history. |
| 5 | **Corporate networks**: configurable npm registry, pip index, and mirrors for container images (`mcr.microsoft.com`) and Dev Container Features (`ghcr.io`). |
| 6 | Re-runnable: editing an existing `.devcontainer` keeps the user's own settings and comments. |
| 7 | Published to the **VS Code Marketplace**. |

## Agreed design decisions

| Topic | Decision |
|---|---|
| Trigger | **Manual only**: Command Palette or the `$(package) Dev Container` status bar button. No auto-prompt on empty folders. |
| UI | **Webview panel** with categories and checkboxes, version dropdowns, a package-sources form, persistence toggles and a live preview of the generated files. |
| Persistence model | **Hybrid**: one **shared** volume for CLI logins (log in once, used by every project) and one **per-project** volume for Copilot and VS Code state and shell history. |
| Package sources | npm registry, pip index URL and trusted host, **image mirror** (replaces `mcr.microsoft.com`), **feature mirror** (replaces `ghcr.io`). Defaults come from settings and can be overridden per project in the panel. |
| Distribution | VS Code Marketplace, published from GitHub Actions on a `v*` tag. |
| Build tooling | No Node.js on the Windows host. Everything is built and tested inside a `node:22` Docker container. |

## User experience

1. Open an (empty) folder in VS Code.
2. Click **`$(package) Dev Container`** in the status bar, or run **DevContainer Composer: Create / Edit Dev Container**.
3. In the panel:
   - **Packages**: tick packages by category and choose versions.
   - **Package sources**: company npm, pip and registry mirrors.
   - **Persistence**: on by default, with each persisted item toggleable and labelled *shared* or *this project*.
   - **Advanced**: base image and remote user.
   - The **Preview** pane shows the exact files that will be written.
4. Click **Generate .devcontainer**, then **Reopen in Container**.

Other commands and actions:
- **Generate Dev Container with Default Packages**: one click, no panel. If a `.devcontainer` already exists, it opens the panel instead of overwriting.
- **Save as my default**: stores the current panel selection in user settings.

## Package catalog

| Category | Package | Implementation | Persisted (scope) |
|---|---|---|---|
| Languages | Node.js | `ghcr.io/devcontainers/features/node:1` (lts / 22 / 20 / latest) | – |
| | TypeScript | `npm install -g typescript` (requires Node) | – |
| | Python | `ghcr.io/devcontainers/features/python:1` (os-provided / 3.13 / 3.12 / 3.11) | – |
| | .NET, Go, Java, PowerShell | official features | – |
| Cloud CLIs | Azure CLI | `features/azure-cli:1` | `~/.azure` (shared) |
| | Azure Developer CLI | `ghcr.io/azure/azure-dev/azd:latest` | `~/.azd` (shared) |
| | AWS CLI | `features/aws-cli:1` | `~/.aws` (shared) |
| | GitHub CLI | `features/github-cli:1` | `~/.config/gh` (shared) |
| Infrastructure | Terraform | `features/terraform:1` | `~/.terraform.d` (shared) |
| | kubectl + Helm | `features/kubectl-helm-minikube:1` | `~/.kube` (shared) |
| | Docker-in-Docker | `features/docker-in-docker:2` | – |
| AI | GitHub Copilot (VS Code) | `GitHub.copilot`, `GitHub.copilot-chat` extensions | `~/.vscode-server/data/User/{globalStorage,workspaceStorage}` (project) |
| | GitHub Copilot CLI | `npm install -g @github/copilot` (requires Node) | `~/.copilot` (project) |
| *(always)* | Shell history | `HISTFILE` set in `~/.bashrc` / `~/.zshrc` (symlinked history files break with zsh's save-by-copy) | `/persist/project/shell-history` (project) |

Each package also adds its recommended VS Code extensions.

Companies can add their own packages, or replace built-in ones, through the `devcontainerComposer.customPackages` setting. A custom package with the same `id` as a built-in one replaces it.

## Generated output

```
.devcontainer/
  devcontainer.json   # build -> Dockerfile, features, mounts, extensions, postCreateCommand, stored selection
  Dockerfile          # managed block between markers; user lines after the end marker are kept
  post-create.sh      # volume ownership fix, symlinks, package setup, then post-create.local.sh if present
  .gitattributes      # forces LF for *.sh and Dockerfile (Windows checkouts)
```

### Persistence mechanism

```jsonc
"mounts": [
  "source=devc-shared-auth,target=/persist/shared,type=volume",                    // all projects
  "source=devc-${devcontainerId}-project,target=/persist/project,type=volume"      // this project
]
```

- `${devcontainerId}` is stable across rebuilds and unique per project (dev container spec), so each project's volume survives **Rebuild Container**.
- The **Dockerfile** creates `/persist/{shared,project}/...` owned by the remote user and symlinks each home path into it, for example `~/.azure -> /persist/shared/azure`. A brand-new named volume is seeded from the image, so ownership is correct from the first start.
- **`post-create.sh`** repeats the setup at runtime in an idempotent way. If the volume's owner differs from the current user (the UID can change on Linux hosts), it runs `chown`. It also moves any existing real directory or file into the volume before linking it.
- Using one volume per scope plus symlinks means adding a package later doesn't change the mounts.

### Package sources and mirrors

- `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL` and `PIP_TRUSTED_HOST` are written as `ENV` lines in the Dockerfile, so they apply both while features install and inside the running container.
- The image mirror rewrites `FROM mcr.microsoft.com/...` to `<mirror>/...`.
- The feature mirror rewrites `ghcr.io/...` feature references to `<mirror>/...`.
- Credentials embedded in URLs trigger a warning, because the Dockerfile is usually committed.
- **Limitation:** some features download binaries straight from vendor hosts (nodejs.org, packages.microsoft.com, github.com, files.pythonhosted.org). The proxy must allow those hosts, or the mirror must cache them. The end-to-end run on the corporate network confirmed this: the Python feature failed until `PIP_INDEX_URL` pointed to the company feed.

### Re-generation and merging (non-destructive)

- `devcontainer.json` is edited with `jsonc-parser`, so **comments and unknown keys are kept**.
- The previous selection and the lists of features and extensions the extension manages are stored in `customizations.devcontainerComposer`. On re-generation:
  - User features, extensions and mounts are kept.
  - Managed items that are no longer selected are removed.
  - Features are matched without regard to registry or version, so mirrored references are recognised.
- An existing `image` is replaced by the generated Dockerfile, with a warning.
- An existing `postCreateCommand` is kept. It becomes an object of parallel commands alongside `post-create.sh`.
- A `Dockerfile` without the markers is only replaced after a confirmation prompt, and a backup is saved to `Dockerfile.bak`.
- `dockerComposeFile` setups are rejected with a clear message (not supported yet).
- A `.devcontainer.json` in the project root and user mounts that target `/persist/shared` or `/persist/project` are rejected with a clear message.
- Only the packages the user picked are stored. Packages added because another package requires them are not stored, so they go away when that package is deselected.
- Existing home directories are only removed after their contents have been confirmed in the volume. Unexpected files are left alone.
- Inputs are validated: remote user, volume name, base image, no line breaks in source URLs, and no `..` or unsafe characters in persistence paths.

## Settings (`devcontainerComposer.*`)

| Setting | Default | Purpose |
|---|---|---|
| `defaultPackages` | `node, typescript, python, azure-cli, azd, copilot` | Pre-selected packages |
| `baseImage` | `mcr.microsoft.com/devcontainers/base:ubuntu` | `FROM` image |
| `remoteUser` | `vscode` | Container user |
| `sources.npmRegistry` | "" | npm registry or proxy |
| `sources.pipIndexUrl` / `sources.pipTrustedHost` | "" | pip index or proxy |
| `sources.imageMirror` | "" | Replaces `mcr.microsoft.com` |
| `sources.featureMirror` | "" | Replaces `ghcr.io` |
| `sharedVolumeName` | `devc-shared-auth` | Volume shared by all projects |
| `showStatusBar` | `true` | Status bar button |
| `customPackages` | `[]` | Extra or overriding catalog entries |

## Architecture

```
src/
  core/                 # pure TypeScript, no vscode import -> unit-testable
    types.ts            # PackageDef, PersistDef, Selection, StoredState ...
    catalog.ts          # built-in packages, CORE_PERSIST, buildCatalog(), resolveRequires()
    validate.ts         # input validation, customPackages parsing
    generator.ts        # generate(): devcontainer.json / Dockerfile / post-create.sh, merge, mirrors
  config.ts             # settings -> catalog and default Selection; "save as default"
  writer.ts             # reads/writes .devcontainer/*, Dockerfile.bak, "Reopen in Container" prompt
  ui/panel.ts           # webview panel (CSP + nonce), message handling
  extension.ts          # activation, status bar item, commands
media/
  main.js, main.css     # webview UI (vanilla JS, VS Code theme variables)
  icon.png              # 128x128 Marketplace icon
test/
  generator.test.ts     # node:test unit tests (24)
e2e/
  Dockerfile.cli        # node:22-trixie + docker CLI/buildx + @devcontainers/cli
  generate.js           # writes a .devcontainer using the compiled generator
  run-e2e.sh            # build -> check tools -> recreate -> check persistence -> second project (hybrid check)
  run-e2e.ps1           # Windows wrapper (Docker Desktop host-path mapping)
.github/workflows/ci.yml  # typecheck, test, package; publish on v* tag (secret VSCE_PAT)
```

Runtime dependency: `jsonc-parser`, bundled by esbuild into `dist/extension.js`. Dev dependencies: TypeScript, esbuild, `@vscode/vsce`, `@types/*`.

## Development (no Node.js on the host)

On the corporate network, the public npm registry is blocked, so use the company feed:

```powershell
docker run --rm -e NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ `
  -v "${PWD}:/work" -w /work node:22 bash -c "npm install && npm run typecheck && npm test && npm run package"
```

| Script | Does |
|---|---|
| `npm run build` / `watch` | esbuild bundle to `dist/extension.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | compiles `src/core` + `test` and runs `node --test` |
| `npm run package` | `.vsix` (`vsce package --no-dependencies`; deps are bundled) |

Install locally with `code --install-extension devcontainer-composer-0.1.0.vsix`.

End-to-end test, which needs Docker and takes several minutes:

```powershell
powershell -ExecutionPolicy Bypass -File .\e2e\run-e2e.ps1 `
  -NpmRegistry https://packagefeedproxy.microsoft.io/npm/ `
  -PipIndexUrl https://packagefeedproxy.microsoft.io/pypi/simple/
```

The test removes only the containers and volumes it created. Set `E2E_KEEP=1` to keep them for inspection.

## Status

Rebuilt from scratch on 2026-10-08.

| Area | State |
|---|---|
| Catalog, generator, merge, validation | ✅ Done |
| Webview, status bar, commands, settings | ✅ Done. The webview was tested in a browser with a stubbed VS Code API; a manual check inside VS Code (F5) is still to do. |
| Unit tests | ✅ 24/24 passing (includes `bash -n` / `sh -n` syntax checks of the generated scripts) |
| Generated shell logic | ✅ Dockerfile `RUN` and `post-create.sh` executed against a temporary home directory: migration, symlinks, idempotent rc block, volume data takes precedence |
| Type-check, bundle, `.vsix` packaging | ✅ Done (~27 KB) |
| CI and publish workflow | ✅ Green on GitHub (`elkaadka/devcontainer-extension`); publish runs on a `v*` tag and needs the `VSCE_PAT` secret |
| End-to-end dev container test | ⚠️ Scripts written (`e2e/`), not run yet. The build environment has no Docker. |
| Copilot Chat history persistence | ⚠️ Not verified yet. Part of the chat history may be stored by the **local** VS Code client (keyed per workspace) rather than in the container. A manual test is needed: chat, rebuild, check. Adjust the persisted paths based on the result. |
| Marketplace metadata | ⚠️ `publisher` is the placeholder `your-publisher`; `repository` points to GitHub; LICENSE is MIT. Screenshots are still missing from the README. |

## Next steps

1. Run the end-to-end test until it passes: tools installed, data survives a recreate, logins are shared between projects and project state is isolated.
2. Test the webview manually in VS Code (F5 / Extension Development Host or the `.vsix`), then do the Copilot Chat rebuild test.
3. Decide how the Microsoft corporate feeds are offered. Proposal: a one-click "Corporate feeds" source preset in the panel plus user settings, leaving the public defaults empty.
4. Marketplace prerequisites:
   - Create a publisher and set `publisher` in `package.json`.
   - Add screenshots to `README.md`.
   - Add the `VSCE_PAT` secret.
5. Later ideas:
   - Optional HTTP(S)_PROXY / custom CA certificate support.
   - Docker Compose support.
   - Named presets ("Azure full-stack", ...).
   - A "Clean up volumes" command.
