import * as vscode from 'vscode';
import { buildCatalog, DEFAULT_PACKAGE_IDS } from './core/catalog';
import { PackageDef, Selection, Sources } from './core/types';
import { parseCustomPackage } from './core/validate';

export const SECTION = 'devcontainerComposer';

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function loadCatalog(): { catalog: PackageDef[]; errors: string[] } {
  const raw = cfg().get<unknown[]>('customPackages', []);
  const custom: PackageDef[] = [];
  const errors: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const { pkg, errors: e } = parseCustomPackage(entry);
    if (pkg) {
      custom.push(pkg);
    }
    errors.push(...e);
  }
  return { catalog: buildCatalog(custom), errors };
}

export function sourcesFromSettings(): Sources {
  const c = cfg();
  return {
    npmRegistry: c.get('sources.npmRegistry', ''),
    pipIndexUrl: c.get('sources.pipIndexUrl', ''),
    pipTrustedHost: c.get('sources.pipTrustedHost', ''),
    imageMirror: c.get('sources.imageMirror', ''),
    featureMirror: c.get('sources.featureMirror', ''),
  };
}

/** Selection built from user settings ("id" or "id@version" entries). */
export function defaultSelection(catalog: PackageDef[]): Selection {
  const c = cfg();
  const entries = c.get<string[]>('defaultPackages', DEFAULT_PACKAGE_IDS);
  const packages: Record<string, string> = {};
  for (const e of Array.isArray(entries) ? entries : DEFAULT_PACKAGE_IDS) {
    const [id, version = ''] = String(e).split('@');
    if (catalog.some((p) => p.id === id)) {
      packages[id] = version;
    }
  }
  return {
    packages,
    sources: sourcesFromSettings(),
    persistence: { enabled: true, disabled: [] },
    baseImage: c.get('baseImage', 'mcr.microsoft.com/devcontainers/base:ubuntu'),
    remoteUser: c.get('remoteUser', 'vscode'),
    sharedVolumeName: c.get('sharedVolumeName', 'devc-shared-auth'),
  };
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);

/** Coerces untrusted input (webview message, stored JSON) into a Selection, using `fallback` for missing parts. */
export function coerceSelection(raw: unknown, fallback: Selection): Selection {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const packages: Record<string, string> = {};
  if (r.packages && typeof r.packages === 'object' && !Array.isArray(r.packages)) {
    for (const [k, v] of Object.entries(r.packages as Record<string, unknown>)) {
      packages[k] = str(v, '');
    }
  }
  const s = (r.sources ?? {}) as Record<string, unknown>;
  const p = (r.persistence ?? {}) as Record<string, unknown>;
  return {
    packages: r.packages ? packages : { ...fallback.packages },
    sources: {
      npmRegistry: str(s.npmRegistry, fallback.sources.npmRegistry),
      pipIndexUrl: str(s.pipIndexUrl, fallback.sources.pipIndexUrl),
      pipTrustedHost: str(s.pipTrustedHost, fallback.sources.pipTrustedHost),
      imageMirror: str(s.imageMirror, fallback.sources.imageMirror),
      featureMirror: str(s.featureMirror, fallback.sources.featureMirror),
    },
    persistence: {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : fallback.persistence.enabled,
      disabled: Array.isArray(p.disabled) ? p.disabled.filter((x): x is string => typeof x === 'string') : [...fallback.persistence.disabled],
    },
    baseImage: str(r.baseImage, fallback.baseImage).trim(),
    remoteUser: str(r.remoteUser, fallback.remoteUser).trim(),
    sharedVolumeName: str(r.sharedVolumeName, fallback.sharedVolumeName).trim(),
  };
}

export async function saveAsDefault(sel: Selection): Promise<void> {
  const c = cfg();
  const target = vscode.ConfigurationTarget.Global;
  await c.update(
    'defaultPackages',
    Object.entries(sel.packages).map(([id, v]) => (v ? `${id}@${v}` : id)),
    target,
  );
  await c.update('baseImage', sel.baseImage, target);
  await c.update('remoteUser', sel.remoteUser, target);
  await c.update('sharedVolumeName', sel.sharedVolumeName, target);
  await c.update('sources.npmRegistry', sel.sources.npmRegistry.trim(), target);
  await c.update('sources.pipIndexUrl', sel.sources.pipIndexUrl.trim(), target);
  await c.update('sources.pipTrustedHost', sel.sources.pipTrustedHost.trim(), target);
  await c.update('sources.imageMirror', sel.sources.imageMirror.trim(), target);
  await c.update('sources.featureMirror', sel.sources.featureMirror.trim(), target);
}
