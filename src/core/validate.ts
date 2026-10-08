import { PackageDef, PersistDef, Selection, Sources } from './types';

const SAFE_URL = /^https?:\/\/[^\s"'`\\$]+$/i;
const HOST_PORT = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const MIRROR = /^[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._-]+)*$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VERSION = /^[A-Za-z0-9._+~^-]{0,64}$/;
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const REL_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const EXTENSION = /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/;
const FEATURE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

export function isValidId(id: string): boolean {
  return ID.test(id);
}

/** Strips scheme and trailing slashes so "https://reg.example.com/x/" becomes "reg.example.com/x". */
export function normalizeMirror(value: string): string {
  return value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function isSafeRelativePath(p: string): boolean {
  return REL_PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..');
}

export function hasCredentials(url: string): boolean {
  return /^[a-z]+:\/\/[^/]*@/i.test(url.trim());
}

export function validateSources(s: Sources): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const check = (label: string, value: string, ok: (v: string) => boolean, hint: string) => {
    const v = value.trim();
    if (!v) {
      return;
    }
    if (/[\r\n]/.test(value) || !ok(v)) {
      errors.push(`${label}: "${v}" is not valid (${hint}).`);
    } else if (hasCredentials(v)) {
      warnings.push(`${label} contains credentials. They are written to the Dockerfile, which is usually committed.`);
    }
  };
  check('npm registry', s.npmRegistry, (v) => SAFE_URL.test(v), 'expected an http(s) URL without quotes, spaces or $');
  check('pip index URL', s.pipIndexUrl, (v) => SAFE_URL.test(v), 'expected an http(s) URL without quotes, spaces or $');
  check('pip trusted host', s.pipTrustedHost, (v) => HOST_PORT.test(v), 'expected host or host:port');
  check('Image mirror', s.imageMirror, (v) => MIRROR.test(normalizeMirror(v)), 'expected registry[/path]');
  check('Feature mirror', s.featureMirror, (v) => MIRROR.test(normalizeMirror(v)), 'expected registry[/path]');
  return { errors, warnings };
}

export function validateSelection(sel: Selection): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const { errors: srcErrors, warnings } = validateSources(sel.sources);
  errors.push(...srcErrors);
  if (!USER.test(sel.remoteUser)) {
    errors.push(`Remote user "${sel.remoteUser}" is not a valid Linux user name.`);
  }
  if (!VOLUME.test(sel.sharedVolumeName)) {
    errors.push(`Shared volume name "${sel.sharedVolumeName}" is not valid (letters, digits, _ . - only).`);
  }
  if (!IMAGE.test(sel.baseImage)) {
    errors.push(`Base image "${sel.baseImage}" is not a valid image reference.`);
  }
  for (const [id, version] of Object.entries(sel.packages)) {
    if (!VERSION.test(version)) {
      errors.push(`Version "${version}" for ${id} contains unsupported characters.`);
    }
  }
  return { errors, warnings };
}

export function validatePersist(item: PersistDef): string[] {
  const errors: string[] = [];
  if (!isValidId(item.id)) {
    errors.push(`Persist id "${item.id}" is not valid.`);
  }
  if (item.scope !== 'shared' && item.scope !== 'project') {
    errors.push(`Persist "${item.id}": scope must be "shared" or "project".`);
  }
  if (item.path !== undefined && !isSafeRelativePath(item.path)) {
    errors.push(`Persist "${item.id}": path "${item.path}" must be relative to home, without "..".`);
  }
  return errors;
}

/** Converts a raw customPackages entry from settings into a PackageDef. */
export function parseCustomPackage(raw: unknown): { pkg?: PackageDef; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['Custom package must be an object.'] };
  }
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : undefined);
  const strArray = (k: string) =>
    Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;

  const id = str('id') ?? '';
  const name = id || '(no id)';
  if (!isValidId(id)) {
    errors.push(`Custom package "${name}": id must match ${ID.source}.`);
  }
  const label = str('label') || id;
  const pkg: PackageDef = { id, label, category: str('category') || 'Custom', description: str('description') };

  const feature = str('feature');
  if (feature) {
    if (!FEATURE_REF.test(feature)) {
      errors.push(`Custom package "${name}": feature reference "${feature}" is not valid.`);
    }
    const options = r.featureOptions && typeof r.featureOptions === 'object' ? (r.featureOptions as Record<string, unknown>) : undefined;
    pkg.feature = { ref: feature, versionOption: str('versionOption') || 'version', options };
  }
  const install = typeof r.install === 'string' ? r.install : undefined;
  if (install) {
    pkg.install = install;
  }
  if (!pkg.feature && !pkg.install && !strArray('extensions')?.length && !Array.isArray(r.persist)) {
    errors.push(`Custom package "${name}": needs at least one of feature, install, extensions or persist.`);
  }
  const versions = strArray('versions');
  if (versions?.length) {
    const bad = versions.filter((v) => !VERSION.test(v));
    if (bad.length) {
      errors.push(`Custom package "${name}": invalid versions ${bad.join(', ')}.`);
    }
    pkg.versions = versions;
  }
  pkg.requires = strArray('requires');
  const extensions = strArray('extensions');
  if (extensions) {
    const bad = extensions.filter((e) => !EXTENSION.test(e));
    if (bad.length) {
      errors.push(`Custom package "${name}": invalid extension ids ${bad.join(', ')}.`);
    }
    pkg.extensions = extensions;
  }
  if (Array.isArray(r.persist)) {
    pkg.persist = [];
    for (const p of r.persist as unknown[]) {
      const pr = (p ?? {}) as Record<string, unknown>;
      const item: PersistDef = {
        id: String(pr.id ?? ''),
        label: typeof pr.label === 'string' ? pr.label : String(pr.path ?? pr.id ?? ''),
        scope: pr.scope as PersistDef['scope'],
        path: typeof pr.path === 'string' ? pr.path : undefined,
      };
      if (!item.path) {
        errors.push(`Custom package "${name}": persist entry "${item.id}" needs a path.`);
      }
      errors.push(...validatePersist(item).map((e) => `Custom package "${name}": ${e}`));
      pkg.persist.push(item);
    }
  }
  return errors.length ? { errors } : { pkg, errors };
}

export function isValidExtensionId(id: string): boolean {
  return EXTENSION.test(id);
}
