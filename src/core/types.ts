export type Scope = 'shared' | 'project';

/** A home-directory path that is moved into a persistent volume and symlinked back. */
export interface PersistDef {
  /** Unique id; also the directory name inside /persist/<scope>/. */
  id: string;
  label: string;
  scope: Scope;
  /**
   * Path relative to the remote user's home that is symlinked into the volume.
   * Omitted when the item only needs a directory in the volume (see `rc`).
   */
  path?: string;
  /** Lines appended to shell rc files; `$DIR` is replaced by the volume directory. */
  rc?: { bash?: string[]; zsh?: string[] };
}

export interface FeatureDef {
  /** Full reference, e.g. ghcr.io/devcontainers/features/node:1 */
  ref: string;
  /** Feature option that receives the selected version. */
  versionOption?: string;
  options?: Record<string, unknown>;
}

export interface PackageDef {
  id: string;
  label: string;
  category: string;
  description?: string;
  feature?: FeatureDef;
  /** First entry is the default. */
  versions?: string[];
  /** Shell command run by post-create.sh; `${version}` is substituted. */
  install?: string;
  requires?: string[];
  extensions?: string[];
  persist?: PersistDef[];
  /** True for entries that came from the customPackages setting. */
  custom?: boolean;
}

export interface Sources {
  npmRegistry: string;
  pipIndexUrl: string;
  pipTrustedHost: string;
  imageMirror: string;
  featureMirror: string;
}

export interface PersistenceSettings {
  enabled: boolean;
  /** Persist ids the user switched off. */
  disabled: string[];
}

export interface Selection {
  /** package id -> chosen version ('' = package default). */
  packages: Record<string, string>;
  sources: Sources;
  persistence: PersistenceSettings;
  baseImage: string;
  remoteUser: string;
  sharedVolumeName: string;
}

/** Stored in devcontainer.json under customizations.devcontainerComposer. */
export interface StoredState {
  schemaVersion: 1;
  selection: Selection;
  /** Exact feature keys written by the extension. */
  managedFeatures: string[];
  /** Lower-cased extension ids written by the extension. */
  managedExtensions: string[];
  managedMounts: string[];
}

export interface ExistingFiles {
  devcontainerJson?: string;
  dockerfile?: string;
  /** A .devcontainer.json exists in the project root (not supported). */
  rootConfig?: boolean;
}

export interface GeneratedFile {
  /** Relative to .devcontainer/ */
  name: string;
  content: string;
  executable?: boolean;
}

export interface GenerateResult {
  files: GeneratedFile[];
  warnings: string[];
  /** Fatal problems; when non-empty, `files` is empty and nothing must be written. */
  errors: string[];
  /** The existing Dockerfile has no managed markers and will be replaced (backup required). */
  dockerfileReplacesUnmanaged: boolean;
  /** Packages added automatically because a selected package requires them. */
  autoAdded: string[];
}
