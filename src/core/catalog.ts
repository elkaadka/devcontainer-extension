import { PackageDef, PersistDef } from './types';

const F = 'ghcr.io/devcontainers/features/';

/** Persisted for every project, independent of the selected packages. */
export const CORE_PERSIST: PersistDef[] = [
  {
    id: 'shell-history',
    label: 'Shell history (bash, zsh)',
    scope: 'project',
    rc: {
      // Symlinked history files break with zsh's save-by-copy, so HISTFILE points into the volume instead.
      bash: [
        'export HISTFILE="$DIR/bash_history"',
        'case ";${PROMPT_COMMAND:-};" in *"history -a"*) ;; *) PROMPT_COMMAND="history -a${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;; esac',
      ],
      zsh: ['export HISTFILE="$DIR/zsh_history"', 'setopt INC_APPEND_HISTORY'],
    },
  },
];

export const CATEGORIES = ['Languages', 'Cloud CLIs', 'Infrastructure', 'AI'];

export const BUILTIN_PACKAGES: PackageDef[] = [
  // Languages
  {
    id: 'node',
    label: 'Node.js',
    category: 'Languages',
    description: 'Node.js and npm (via nvm)',
    feature: { ref: F + 'node:1', versionOption: 'version' },
    versions: ['lts', '22', '20', 'latest'],
    extensions: ['dbaeumer.vscode-eslint'],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    category: 'Languages',
    description: 'Global TypeScript compiler (tsc)',
    install: 'npm install -g typescript@${version}',
    versions: ['latest', '5'],
    requires: ['node'],
  },
  {
    id: 'python',
    label: 'Python',
    category: 'Languages',
    description: 'Python 3 with pip',
    feature: { ref: F + 'python:1', versionOption: 'version' },
    versions: ['os-provided', '3.13', '3.12', '3.11'],
    extensions: ['ms-python.python', 'ms-python.vscode-pylance'],
  },
  {
    id: 'dotnet',
    label: '.NET SDK',
    category: 'Languages',
    feature: { ref: F + 'dotnet:2', versionOption: 'version' },
    versions: ['latest', '9.0', '8.0'],
    extensions: ['ms-dotnettools.csdevkit'],
  },
  {
    id: 'go',
    label: 'Go',
    category: 'Languages',
    feature: { ref: F + 'go:1', versionOption: 'version' },
    versions: ['latest', '1.24', '1.23'],
    extensions: ['golang.go'],
  },
  {
    id: 'java',
    label: 'Java',
    category: 'Languages',
    feature: { ref: F + 'java:1', versionOption: 'version' },
    versions: ['latest', '21', '17'],
    extensions: ['vscjava.vscode-java-pack'],
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    category: 'Languages',
    feature: { ref: F + 'powershell:1', versionOption: 'version' },
    versions: ['latest'],
    extensions: ['ms-vscode.powershell'],
  },
  // Cloud CLIs
  {
    id: 'azure-cli',
    label: 'Azure CLI',
    category: 'Cloud CLIs',
    description: 'az',
    feature: { ref: F + 'azure-cli:1', versionOption: 'version' },
    versions: ['latest'],
    extensions: ['ms-vscode.azurecli'],
    persist: [{ id: 'azure', label: 'Azure CLI login (~/.azure)', scope: 'shared', path: '.azure' }],
  },
  {
    id: 'azd',
    label: 'Azure Developer CLI',
    category: 'Cloud CLIs',
    description: 'azd',
    feature: { ref: 'ghcr.io/azure/azure-dev/azd:latest', versionOption: 'version' },
    versions: ['stable'],
    extensions: ['ms-azuretools.azure-dev'],
    persist: [{ id: 'azd', label: 'azd login (~/.azd)', scope: 'shared', path: '.azd' }],
  },
  {
    id: 'aws-cli',
    label: 'AWS CLI',
    category: 'Cloud CLIs',
    feature: { ref: F + 'aws-cli:1', versionOption: 'version' },
    versions: ['latest'],
    extensions: ['amazonwebservices.aws-toolkit-vscode'],
    persist: [{ id: 'aws', label: 'AWS credentials (~/.aws)', scope: 'shared', path: '.aws' }],
  },
  {
    id: 'github-cli',
    label: 'GitHub CLI',
    category: 'Cloud CLIs',
    description: 'gh',
    feature: { ref: F + 'github-cli:1', versionOption: 'version' },
    versions: ['latest'],
    extensions: ['github.vscode-pull-request-github'],
    persist: [{ id: 'gh', label: 'GitHub CLI login (~/.config/gh)', scope: 'shared', path: '.config/gh' }],
  },
  // Infrastructure
  {
    id: 'terraform',
    label: 'Terraform',
    category: 'Infrastructure',
    feature: { ref: F + 'terraform:1', versionOption: 'version' },
    versions: ['latest'],
    extensions: ['hashicorp.terraform'],
    persist: [{ id: 'terraform', label: 'Terraform credentials (~/.terraform.d)', scope: 'shared', path: '.terraform.d' }],
  },
  {
    id: 'kubectl',
    label: 'kubectl + Helm',
    category: 'Infrastructure',
    feature: { ref: F + 'kubectl-helm-minikube:1', versionOption: 'version', options: { minikube: 'none' } },
    versions: ['latest'],
    extensions: ['ms-kubernetes-tools.vscode-kubernetes-tools'],
    persist: [{ id: 'kube', label: 'Kubernetes config (~/.kube)', scope: 'shared', path: '.kube' }],
  },
  {
    id: 'docker-in-docker',
    label: 'Docker-in-Docker',
    category: 'Infrastructure',
    feature: { ref: F + 'docker-in-docker:2', versionOption: 'version' },
    versions: ['latest'],
    extensions: ['ms-azuretools.vscode-docker'],
  },
  // AI
  {
    id: 'copilot',
    label: 'GitHub Copilot (VS Code)',
    category: 'AI',
    description: 'Copilot and Copilot Chat extensions',
    extensions: ['GitHub.copilot', 'GitHub.copilot-chat'],
    persist: [
      {
        id: 'vscode-global-storage',
        label: 'Copilot / VS Code global state',
        scope: 'project',
        path: '.vscode-server/data/User/globalStorage',
      },
      {
        id: 'vscode-workspace-storage',
        label: 'Copilot / VS Code workspace state',
        scope: 'project',
        path: '.vscode-server/data/User/workspaceStorage',
      },
    ],
  },
  {
    id: 'copilot-cli',
    label: 'GitHub Copilot CLI',
    category: 'AI',
    description: 'copilot (npm @github/copilot)',
    install: 'npm install -g @github/copilot@${version}',
    versions: ['latest'],
    requires: ['node'],
    persist: [{ id: 'copilot-cli', label: 'Copilot CLI sessions (~/.copilot)', scope: 'project', path: '.copilot' }],
  },
];

export const DEFAULT_PACKAGE_IDS = ['node', 'typescript', 'python', 'azure-cli', 'azd', 'copilot'];

/** Built-in packages plus custom ones; a custom package with a built-in id replaces it in place. */
export function buildCatalog(custom: PackageDef[] = []): PackageDef[] {
  const result = BUILTIN_PACKAGES.map((p) => p);
  for (const c of custom) {
    const pkg: PackageDef = { ...c, custom: true };
    const idx = result.findIndex((p) => p.id === c.id);
    if (idx >= 0) {
      result[idx] = pkg;
    } else {
      result.push(pkg);
    }
  }
  return result;
}

export interface ResolvedPackages {
  /** Selected ids plus requirements, in catalog order. */
  ids: string[];
  autoAdded: string[];
  unknown: string[];
}

export function resolveRequires(selected: string[], catalog: PackageDef[]): ResolvedPackages {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const set = new Set<string>();
  const unknown: string[] = [];
  const visit = (id: string) => {
    if (set.has(id)) {
      return;
    }
    const pkg = byId.get(id);
    if (!pkg) {
      if (!unknown.includes(id)) {
        unknown.push(id);
      }
      return;
    }
    set.add(id);
    for (const r of pkg.requires ?? []) {
      visit(r);
    }
  };
  selected.forEach(visit);
  const autoAdded = [...set].filter((id) => !selected.includes(id));
  const ids = catalog.filter((p) => set.has(p.id)).map((p) => p.id);
  return { ids, autoAdded, unknown };
}

/** All persist items that apply to the given packages (core items first). */
export function persistItemsFor(packageIds: string[], catalog: PackageDef[]): PersistDef[] {
  const items: PersistDef[] = [...CORE_PERSIST];
  for (const p of catalog) {
    if (packageIds.includes(p.id)) {
      for (const item of p.persist ?? []) {
        if (!items.some((i) => i.id === item.id)) {
          items.push(item);
        }
      }
    }
  }
  return items;
}
