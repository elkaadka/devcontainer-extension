import {
  applyEdits,
  findNodeAtLocation,
  FormattingOptions,
  JSONPath,
  modify,
  parse,
  ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import { persistItemsFor, resolveRequires } from './catalog';
import {
  ExistingFiles,
  GeneratedFile,
  GenerateResult,
  PackageDef,
  PersistDef,
  Selection,
  StoredState,
} from './types';
import { normalizeMirror, validatePersist, validateSelection } from './validate';

export const STATE_KEY = 'devcontainerComposer';
export const MARKER_BEGIN = '# >>> DevContainer Composer: managed block (regenerated, do not edit) >>>';
export const MARKER_END = '# <<< DevContainer Composer: end of managed block. Your own instructions go below. <<<';
export const POST_CREATE_KEY = 'devcontainer-composer';
export const POST_CREATE_COMMAND = 'bash "${containerWorkspaceFolder}/.devcontainer/post-create.sh"';
export const PERSIST_ROOT = '/persist';
export const PROJECT_VOLUME = 'devc-${devcontainerId}-project';

export interface GenerateInput {
  catalog: PackageDef[];
  selection: Selection;
  existing?: ExistingFiles;
  /** Used for "name" when creating a new devcontainer.json. */
  projectName?: string;
}

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

// ---------------------------------------------------------------------------
// Feature references and mirrors
// ---------------------------------------------------------------------------

/** "ghcr.io/devcontainers/features/node:1" -> "devcontainers/features/node" */
export function featurePath(ref: string): string {
  let r = ref.trim().replace(/@sha256:[0-9a-f]+$/i, '');
  const slash = r.lastIndexOf('/');
  const colon = r.lastIndexOf(':');
  if (colon > slash) {
    r = r.slice(0, colon);
  }
  const parts = r.split('/');
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) {
    parts.shift();
  }
  return parts.join('/').toLowerCase();
}

/** True when both refs point to the same feature, ignoring registry, mirror prefix and version. */
export function sameFeature(a: string, b: string): boolean {
  const pa = featurePath(a);
  const pb = featurePath(b);
  return pa === pb || pa.endsWith('/' + pb) || pb.endsWith('/' + pa);
}

export function applyMirror(ref: string, registry: string, mirror: string): string {
  const m = normalizeMirror(mirror);
  if (!m) {
    return ref;
  }
  return ref.startsWith(registry + '/') ? m + ref.slice(registry.length) : ref;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function versionOf(pkg: PackageDef, selection: Selection): string {
  const v = (selection.packages[pkg.id] ?? '').trim();
  return v || pkg.versions?.[0] || 'latest';
}

function persistDir(item: PersistDef): string {
  return `${PERSIST_ROOT}/${item.scope}/${item.id}`;
}

function mountsFor(selection: Selection): string[] {
  if (!selection.persistence.enabled) {
    return [];
  }
  return [
    `source=${selection.sharedVolumeName},target=${PERSIST_ROOT}/shared,type=volume`,
    `source=${PROJECT_VOLUME},target=${PERSIST_ROOT}/project,type=volume`,
  ];
}

function isOurMount(m: unknown): boolean {
  return typeof m === 'string' && new RegExp(`target=${PERSIST_ROOT}/(shared|project)(,|$)`).test(m);
}

function dedupeCaseInsensitive(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------

export function managedDockerfileBlock(selection: Selection, persist: PersistDef[]): string {
  const image = applyMirror(selection.baseImage.trim(), 'mcr.microsoft.com', selection.sources.imageMirror);
  const lines: string[] = [MARKER_BEGIN, `FROM ${image}`, ''];

  const env: [string, string][] = [];
  const s = selection.sources;
  if (s.npmRegistry.trim()) {
    env.push(['NPM_CONFIG_REGISTRY', s.npmRegistry.trim()]);
  }
  if (s.pipIndexUrl.trim()) {
    env.push(['PIP_INDEX_URL', s.pipIndexUrl.trim()]);
  }
  if (s.pipTrustedHost.trim()) {
    env.push(['PIP_TRUSTED_HOST', s.pipTrustedHost.trim()]);
  }
  if (env.length) {
    lines.push('# Package sources: used while features install and inside the running container.');
    lines.push('ENV ' + env.map(([k, v]) => `${k}="${v}"`).join(' \\\n    '));
    lines.push('');
  }

  if (selection.persistence.enabled) {
    const linked = persist.filter((p) => p.path);
    const plain = persist.filter((p) => !p.path);
    const parents = new Set<string>();
    for (const p of linked) {
      const segs = p.path!.split('/');
      for (let i = 1; i < segs.length; i++) {
        parents.add(segs.slice(0, i).join('/'));
      }
    }
    const run: string[] = [
      'set -eu',
      `u=${sq(selection.remoteUser)}`,
      `mkdir -p ${PERSIST_ROOT}/shared ${PERSIST_ROOT}/project`,
      'if id "$u" >/dev/null 2>&1; then',
      '  h="$(getent passwd "$u" | cut -d: -f6)"; g="$(id -g "$u")"',
      '  link() { src="$h/$1"; dst="$2"; mkdir -p "$dst" "$(dirname "$src")"; if [ -L "$src" ]; then rm -f "$src"; elif [ -d "$src" ]; then cp -a "$src/." "$dst/" && rm -rf "$src"; elif [ -e "$src" ]; then mv "$src" "$src.bak"; fi; ln -s "$dst" "$src"; chown -h "$u:$g" "$src"; }',
    ];
    for (const p of plain) {
      run.push(`  mkdir -p ${persistDir(p)}`);
    }
    for (const p of linked) {
      run.push(`  link ${p.path} ${persistDir(p)}`);
    }
    if (parents.size) {
      run.push(`  for d in ${[...parents].sort().join(' ')}; do chown "$u:$g" "$h/$d"; done`);
    }
    run.push(`  chown -R "$u:$g" ${PERSIST_ROOT}`, 'fi');
    lines.push('# Persistent volumes: home paths are symlinked into /persist/{shared,project}.');
    lines.push('# A new named volume is seeded from this image, so ownership is correct on first start.');
    const runText = run
      .map((l, i) => {
        const t = i === 0 ? l : '    ' + l;
        if (i === run.length - 1) {
          return t;
        }
        return /\bthen$/.test(l) ? `${t} \\` : `${t}; \\`;
      })
      .join('\n');
    lines.push('RUN ' + runText);
    lines.push('');
  }
  lines.push(MARKER_END);
  return lines.join('\n');
}

export function mergeDockerfile(existing: string | undefined, block: string): { content: string; replacesUnmanaged: boolean } {
  if (!existing || !existing.trim()) {
    return { content: block + '\n', replacesUnmanaged: false };
  }
  const text = existing.replace(/\r\n/g, '\n');
  const begin = text.indexOf(MARKER_BEGIN);
  const end = text.indexOf(MARKER_END);
  if (begin < 0 || end < begin) {
    return { content: block + '\n', replacesUnmanaged: true };
  }
  const before = text.slice(0, begin);
  let after = text.slice(end + MARKER_END.length);
  if (after.startsWith('\n')) {
    after = after.slice(1);
  }
  return { content: before + block + '\n' + after, replacesUnmanaged: false };
}

// ---------------------------------------------------------------------------
// post-create.sh
// ---------------------------------------------------------------------------

export function postCreateScript(catalog: PackageDef[], ids: string[], selection: Selection, persist: PersistDef[]): string {
  const out: string[] = [
    '#!/usr/bin/env bash',
    '# Generated by DevContainer Composer. This file is overwritten on every generation.',
    '# Put your own steps into .devcontainer/post-create.local.sh (it runs at the end).',
    'set -uo pipefail',
    '',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'FAILED=0',
    'log() { echo "[devcontainer-composer] $*"; }',
    'warn() { echo "[devcontainer-composer] WARNING: $*" >&2; FAILED=1; }',
    '',
  ];

  if (selection.persistence.enabled) {
    out.push(
      'SUDO=""',
      'if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi',
      '',
      '# The volume owner can differ from the current user (e.g. UID remapped on Linux hosts).',
      'fix_owner() {',
      '  local d="$1"',
      '  [ -d "$d" ] || { $SUDO mkdir -p "$d" || return 1; }',
      '  if [ "$(stat -c %u "$d")" != "$(id -u)" ]; then',
      '    log "Fixing ownership of $d"',
      '    $SUDO chown -R "$(id -u):$(id -g)" "$d" || warn "could not change owner of $d"',
      '  fi',
      '}',
      '',
      '# Moves an existing home directory into the volume (volume content wins) and symlinks it.',
      '# The original is only removed after every entry was verified to exist in the volume.',
      'link_home() {',
      '  local src="$HOME/$1" dst="$2"',
      '  mkdir -p "$dst" "$(dirname "$src")" || { warn "cannot create $dst"; return; }',
      '  if [ -L "$src" ]; then',
      '    [ "$(readlink "$src")" = "$dst" ] && return',
      '    rm -f "$src"',
      '  elif [ -d "$src" ]; then',
      '    cp -an "$src/." "$dst/" 2>/dev/null',
      "    if (cd \"$src\" && find . -mindepth 1 -print0 | while IFS= read -r -d '' f; do [ -e \"$dst/$f\" ] || [ -L \"$dst/$f\" ] || exit 1; done); then",
      '      rm -rf "$src"',
      '    else',
      '      warn "could not move $src into the volume; it is left unchanged and not persisted"',
      '      return',
      '    fi',
      '  elif [ -e "$src" ]; then',
      '    warn "$src is a file, expected a directory; it is left unchanged and not persisted"',
      '    return',
      '  fi',
      '  ln -s "$dst" "$src" || warn "cannot link $src"',
      '}',
      '',
      '# Replaces the DevContainer Composer block in a shell rc file.',
      'set_rc_block() {',
      '  local file="$1" content="$2"',
      '  touch "$file"',
      "  sed -i '/^# >>> devcontainer-composer >>>$/,/^# <<< devcontainer-composer <<<$/d' \"$file\"",
      '  printf \'# >>> devcontainer-composer >>>\\n%s\\n# <<< devcontainer-composer <<<\\n\' "$content" >> "$file"',
      '}',
      '',
      `fix_owner ${PERSIST_ROOT}/shared`,
      `fix_owner ${PERSIST_ROOT}/project`,
    );
    for (const p of persist) {
      if (p.path) {
        out.push(`link_home ${p.path} ${persistDir(p)}`);
      } else {
        out.push(`mkdir -p ${persistDir(p)}`);
      }
    }
    const bash = persist.flatMap((p) => (p.rc?.bash ?? []).map((l) => l.replace(/\$DIR/g, persistDir(p))));
    const zsh = persist.flatMap((p) => (p.rc?.zsh ?? []).map((l) => l.replace(/\$DIR/g, persistDir(p))));
    if (bash.length) {
      out.push(`set_rc_block "$HOME/.bashrc" ${sq(bash.join('\n'))}`);
    }
    if (zsh.length) {
      out.push(`if command -v zsh >/dev/null 2>&1 || [ -f "$HOME/.zshrc" ]; then`);
      out.push(`  set_rc_block "$HOME/.zshrc" ${sq(zsh.join('\n'))}`);
      out.push('fi');
    }
    out.push('');
  }

  const installs = catalog.filter((p) => ids.includes(p.id) && p.install);
  if (installs.length) {
    out.push('# Package setup');
    for (const p of installs) {
      const cmd = p.install!.replace(/\$\{version\}/g, versionOf(p, selection));
      out.push(`log ${sq('Installing ' + p.label)}`);
      out.push(`( ${cmd} ) || warn ${sq(p.label + ' setup failed')}`);
    }
    out.push('');
  }

  out.push(
    'if [ -f "$SCRIPT_DIR/post-create.local.sh" ]; then',
    '  log "Running post-create.local.sh"',
    '  bash "$SCRIPT_DIR/post-create.local.sh" || warn "post-create.local.sh failed"',
    'fi',
    '',
    'if [ "$FAILED" -ne 0 ]; then',
    '  log "Finished with warnings (see above)."',
    '  exit 1',
    'fi',
    'log "Done."',
    '',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// devcontainer.json
// ---------------------------------------------------------------------------

interface JsonResult {
  content: string;
  warnings: string[];
  errors: string[];
}

/**
 * Removes an object property without touching comments on neighbouring lines
 * (jsonc-parser's modify() also deletes comments between the previous comma and the property).
 */
export function removeProperty(text: string, path: JSONPath): string {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  const valueNode = tree && findNodeAtLocation(tree, path);
  const prop = valueNode?.parent;
  const obj = prop?.parent;
  if (!prop || prop.type !== 'property' || !obj) {
    return text;
  }
  const siblings = obj.children ?? [];
  const idx = siblings.indexOf(prop);
  const propEnd = prop.offset + prop.length;
  const lineStart = (pos: number) => {
    const nl = text.lastIndexOf('\n', pos - 1);
    return /^[ \t]*$/.test(text.slice(nl + 1, pos)) ? nl + 1 : pos;
  };
  const afterLine = (pos: number) => {
    const m = /^[ \t]*(\r?\n)?/.exec(text.slice(pos));
    return pos + (m ? m[0].length : 0);
  };

  const start = lineStart(prop.offset);
  let end = propEnd;
  const rest = text.slice(propEnd);
  const comma = /^\s*,/.exec(rest);
  if (comma) {
    end = afterLine(propEnd + comma[0].length);
    if (idx < siblings.length - 1 && end > siblings[idx + 1].offset) {
      end = siblings[idx + 1].offset;
    }
  } else if (idx > 0) {
    // Last property: drop the comma that follows the previous property.
    const prev = siblings[idx - 1];
    const prevEnd = prev.offset + prev.length;
    const c = /^\s*,/.exec(text.slice(prevEnd));
    end = afterLine(propEnd);
    if (c) {
      const commaPos = prevEnd + c[0].length - 1;
      return text.slice(0, commaPos) + text.slice(commaPos + 1, start) + text.slice(end);
    }
  } else {
    end = afterLine(propEnd);
  }
  return text.slice(0, start) + text.slice(end);
}

function readState(root: Record<string, unknown>): StoredState | undefined {
  const c = root.customizations as Record<string, unknown> | undefined;
  const s = c && (c[STATE_KEY] as StoredState | undefined);
  return s && typeof s === 'object' && s.schemaVersion === 1 ? s : undefined;
}

/** Reads the selection stored in an existing devcontainer.json, if any. */
export function readStoredState(devcontainerJson: string | undefined): StoredState | undefined {
  if (!devcontainerJson) {
    return undefined;
  }
  const root = parse(devcontainerJson, [], { allowTrailingComma: true });
  return root && typeof root === 'object' && !Array.isArray(root) ? readState(root) : undefined;
}

function buildDevcontainerJson(
  existing: string | undefined,
  catalog: PackageDef[],
  ids: string[],
  selection: Selection,
  projectName: string | undefined,
): JsonResult {
  const warnings: string[] = [];
  let text = existing && existing.trim() ? existing.replace(/\r\n/g, '\n') : '{\n}\n';

  const parseErrors: ParseError[] = [];
  let root = parse(text, parseErrors, { allowTrailingComma: true }) as Record<string, unknown>;
  if (parseErrors.length) {
    const e = parseErrors[0];
    return { content: '', warnings, errors: [`devcontainer.json has a syntax error (${printParseErrorCode(e.error)} at offset ${e.offset}). Fix it and try again.`] };
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { content: '', warnings, errors: ['devcontainer.json must contain a JSON object.'] };
  }
  if (root.dockerComposeFile !== undefined) {
    return {
      content: '',
      warnings,
      errors: ['This devcontainer.json uses dockerComposeFile. Docker Compose setups are not supported yet.'],
    };
  }

  const set = (path: JSONPath, value: unknown) => {
    text = value === undefined ? removeProperty(text, path) : applyEdits(text, modify(text, path, value, { formattingOptions: FORMAT }));
    root = parse(text, [], { allowTrailingComma: true });
  };

  const prev = readState(root);
  const pkgs = catalog.filter((p) => ids.includes(p.id));

  if (root.name === undefined) {
    set(['name'], projectName || 'Dev Container');
  }
  if (root.image !== undefined) {
    warnings.push(`The existing "image" (${String(root.image)}) is replaced by the generated Dockerfile.`);
    set(['image'], undefined);
  }
  const build = (root.build ?? {}) as Record<string, unknown>;
  if (build.dockerfile !== undefined && build.dockerfile !== 'Dockerfile') {
    warnings.push(`build.dockerfile "${String(build.dockerfile)}" is replaced by "Dockerfile".`);
  }
  if (build.dockerfile !== 'Dockerfile') {
    set(['build', 'dockerfile'], 'Dockerfile');
  }
  if (build.context === undefined) {
    set(['build', 'context'], '.');
  }

  // Features. managedFeatures holds the exact keys written last time; anything else is user-owned.
  const existingFeatures = (root.features && typeof root.features === 'object' ? root.features : {}) as Record<string, unknown>;
  const prevManaged = prev?.managedFeatures ?? [];
  const wanted = pkgs
    .filter((p) => p.feature)
    .map((p) => {
      const f = p.feature!;
      const options: Record<string, unknown> = { ...(f.options ?? {}) };
      if (f.versionOption && p.versions?.length) {
        options[f.versionOption] = versionOf(p, selection);
      }
      const ref = applyMirror(f.ref, 'ghcr.io', selection.sources.featureMirror);
      return { ref, key: ref, options, userOwned: false };
    });
  for (const key of Object.keys(existingFeatures)) {
    const w = wanted.find((x) => sameFeature(key, x.ref));
    if (prevManaged.includes(key)) {
      if (!w) {
        set(['features', key], undefined);
      } else if (key !== w.ref) {
        // Registry or mirror changed: move to the new key, keeping options edited by the user.
        const old = existingFeatures[key];
        if (old && typeof old === 'object') {
          w.options = { ...(old as Record<string, unknown>), ...w.options };
        }
        set(['features', key], undefined);
      }
    } else if (w && !w.userOwned) {
      // The user added this feature: keep their key and only update the selected version.
      w.key = key;
      w.userOwned = true;
    }
  }
  const managedFeatures: string[] = [];
  for (const w of wanted) {
    const current = (root.features as Record<string, unknown> | undefined)?.[w.key];
    const merged = current && typeof current === 'object' ? { ...(current as Record<string, unknown>), ...w.options } : w.options;
    if (!deepEqual(current, merged)) {
      set(['features', w.key], merged);
    }
    if (!w.userOwned) {
      managedFeatures.push(w.key);
    }
  }
  if (root.features === undefined) {
    set(['features'], {});
  }

  if (root.remoteUser !== selection.remoteUser) {
    set(['remoteUser'], selection.remoteUser);
  }

  // Mounts
  const existingMounts = Array.isArray(root.mounts) ? (root.mounts as unknown[]) : [];
  const prevMounts = prev?.managedMounts ?? [];
  const ourMounts = mountsFor(selection);
  const userMounts = existingMounts.filter((m) => !prevMounts.includes(m as string));
  const collision = userMounts.find(isOurMount);
  if (collision) {
    return {
      content: '',
      warnings,
      errors: [`The mount "${String(collision)}" uses a target reserved for persistence (${PERSIST_ROOT}/shared or ${PERSIST_ROOT}/project). Remove or change it and try again.`],
    };
  }
  const mounts = [...userMounts, ...ourMounts];
  if (!deepEqual(existingMounts, mounts)) {
    set(['mounts'], mounts.length || root.mounts !== undefined ? mounts : undefined);
  }

  // postCreateCommand
  const pcc = root.postCreateCommand;
  if (pcc === undefined || pcc === POST_CREATE_COMMAND) {
    if (pcc === undefined) {
      set(['postCreateCommand'], POST_CREATE_COMMAND);
    }
  } else if (pcc && typeof pcc === 'object' && !Array.isArray(pcc)) {
    const obj = pcc as Record<string, unknown>;
    if (!Object.values(obj).includes(POST_CREATE_COMMAND)) {
      let key = POST_CREATE_KEY;
      for (let i = 2; obj[key] !== undefined; i++) {
        key = `${POST_CREATE_KEY}-${i}`;
      }
      set(['postCreateCommand', key], POST_CREATE_COMMAND);
    }
  } else {
    warnings.push('The existing postCreateCommand is kept and now runs in parallel with post-create.sh.');
    set(['postCreateCommand'], { user: pcc, [POST_CREATE_KEY]: POST_CREATE_COMMAND });
  }

  // Extensions
  const vscodeCust = ((root.customizations as Record<string, unknown> | undefined)?.vscode ?? {}) as Record<string, unknown>;
  const existingExt = Array.isArray(vscodeCust.extensions) ? (vscodeCust.extensions as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  const prevExt = (prev?.managedExtensions ?? []).map((e) => e.toLowerCase());
  const ourExt = dedupeCaseInsensitive(pkgs.flatMap((p) => p.extensions ?? []));
  const ourLower = ourExt.map((e) => e.toLowerCase());
  const keptExt = existingExt.filter((e) => !prevExt.includes(e.toLowerCase()) || ourLower.includes(e.toLowerCase()));
  const finalExt = dedupeCaseInsensitive([...keptExt, ...ourExt]);
  const userExtLower = existingExt.map((e) => e.toLowerCase()).filter((e) => !prevExt.includes(e));
  const managedExtensions = ourLower.filter((e) => !userExtLower.includes(e));
  if (!deepEqual(existingExt, finalExt) || !Array.isArray(vscodeCust.extensions)) {
    set(['customizations', 'vscode', 'extensions'], finalExt);
  }

  const state: StoredState = {
    schemaVersion: 1,
    // Only the explicit choice is stored, so deselecting TypeScript later also drops the auto-added Node.js.
    selection: {
      ...selection,
      packages: Object.fromEntries(
        Object.entries(selection.packages)
          .filter(([id]) => catalog.some((p) => p.id === id))
          .map(([id, v]) => [id, v.trim()]),
      ),
    },
    managedFeatures,
    managedExtensions,
    managedMounts: ourMounts,
  };
  set(['customizations', STATE_KEY], state);

  if (!text.endsWith('\n')) {
    text += '\n';
  }
  return { content: text, warnings, errors: [] };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const GITATTRIBUTES = '# Generated by DevContainer Composer: keep LF line endings on Windows checkouts.\n*.sh text eol=lf\nDockerfile text eol=lf\n';

export function generate(input: GenerateInput): GenerateResult {
  const { catalog, selection, existing = {} } = input;
  const fail = (errors: string[], warnings: string[] = []): GenerateResult => ({
    files: [],
    warnings,
    errors,
    dockerfileReplacesUnmanaged: false,
    autoAdded: [],
  });

  const { errors, warnings } = validateSelection(selection);
  const resolved = resolveRequires(Object.keys(selection.packages), catalog);
  if (resolved.unknown.length) {
    warnings.push(`Unknown packages ignored: ${resolved.unknown.join(', ')}.`);
  }
  const persist = persistItemsFor(resolved.ids, catalog).filter((p) => !selection.persistence.disabled.includes(p.id));
  for (const p of persist) {
    errors.push(...validatePersist(p));
  }
  if (errors.length) {
    return fail(errors, warnings);
  }

  if (existing.rootConfig) {
    return fail(['This folder uses .devcontainer.json in the project root. Move it to .devcontainer/devcontainer.json to edit it with DevContainer Composer.'], warnings);
  }

  const json = buildDevcontainerJson(existing.devcontainerJson, catalog, resolved.ids, selection, input.projectName);
  if (json.errors.length) {
    return fail(json.errors, [...warnings, ...json.warnings]);
  }
  warnings.push(...json.warnings);

  const docker = mergeDockerfile(existing.dockerfile, managedDockerfileBlock(selection, persist));
  if (docker.replacesUnmanaged) {
    warnings.push('The existing Dockerfile has no DevContainer Composer markers. It will be replaced; a backup is saved as Dockerfile.bak.');
  }

  const files: GeneratedFile[] = [
    { name: 'devcontainer.json', content: json.content },
    { name: 'Dockerfile', content: docker.content },
    { name: 'post-create.sh', content: postCreateScript(catalog, resolved.ids, selection, persist), executable: true },
    { name: '.gitattributes', content: GITATTRIBUTES },
  ];
  return { files, warnings, errors: [], dockerfileReplacesUnmanaged: docker.replacesUnmanaged, autoAdded: resolved.autoAdded };
}
