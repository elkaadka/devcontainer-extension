import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { buildCatalog, resolveRequires, DEFAULT_PACKAGE_IDS } from '../src/core/catalog';
import {
  generate,
  featurePath,
  sameFeature,
  readStoredState,
  MARKER_BEGIN,
  MARKER_END,
  POST_CREATE_COMMAND,
  GenerateInput,
  removeProperty,
} from '../src/core/generator';
import { parseCustomPackage, validateSources } from '../src/core/validate';
import { GenerateResult, Selection } from '../src/core/types';

const catalog = buildCatalog();

function selection(overrides: Partial<Selection> = {}, ids: string[] = DEFAULT_PACKAGE_IDS): Selection {
  return {
    packages: Object.fromEntries(ids.map((id) => [id, ''])),
    sources: { npmRegistry: '', pipIndexUrl: '', pipTrustedHost: '', imageMirror: '', featureMirror: '' },
    persistence: { enabled: true, disabled: [] },
    baseImage: 'mcr.microsoft.com/devcontainers/base:ubuntu',
    remoteUser: 'vscode',
    sharedVolumeName: 'devc-shared-auth',
    ...overrides,
  };
}

function run(input: Partial<GenerateInput> & { selection: Selection }): GenerateResult {
  return generate({ catalog, projectName: 'demo', ...input });
}

function file(r: GenerateResult, name: string): string {
  const f = r.files.find((x) => x.name === name);
  assert.ok(f, `missing ${name}; errors: ${r.errors.join('; ')}`);
  return f.content;
}

function json(r: GenerateResult): any {
  return parse(file(r, 'devcontainer.json'), [], { allowTrailingComma: true });
}

test('default selection produces all files with features, mounts and extensions', () => {
  const r = run({ selection: selection() });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['.gitattributes', 'Dockerfile', 'devcontainer.json', 'post-create.sh']);
  const j = json(r);
  assert.equal(j.name, 'demo');
  assert.deepEqual(j.build, { dockerfile: 'Dockerfile', context: '.' });
  assert.ok(j.features['ghcr.io/devcontainers/features/node:1']);
  assert.ok(j.features['ghcr.io/devcontainers/features/python:1']);
  assert.ok(j.features['ghcr.io/devcontainers/features/azure-cli:1']);
  assert.ok(j.features['ghcr.io/azure/azure-dev/azd:latest']);
  assert.deepEqual(j.mounts, [
    'source=devc-shared-auth,target=/persist/shared,type=volume',
    'source=devc-${devcontainerId}-project,target=/persist/project,type=volume',
  ]);
  assert.equal(j.postCreateCommand, POST_CREATE_COMMAND);
  assert.ok(j.customizations.vscode.extensions.includes('GitHub.copilot-chat'));
  assert.equal(j.remoteUser, 'vscode');
  const ps = file(r, 'post-create.sh');
  assert.match(ps, /npm install -g typescript@latest/);
  assert.match(ps, /link_home \.azure \/persist\/shared\/azure/);
  assert.match(ps, /link_home \.vscode-server\/data\/User\/globalStorage \/persist\/project\/vscode-global-storage/);
  assert.match(ps, /HISTFILE="\/persist\/project\/shell-history\/bash_history"/);
  assert.ok(r.files.find((f) => f.name === 'post-create.sh')!.executable);
});

test('requirements are added automatically', () => {
  const r = run({ selection: selection({}, ['typescript', 'copilot-cli']) });
  assert.deepEqual(r.autoAdded, ['node']);
  assert.ok(json(r).features['ghcr.io/devcontainers/features/node:1']);
  assert.deepEqual(resolveRequires(['nope'], catalog).unknown, ['nope']);
});

test('selected versions are written as feature options and install arguments', () => {
  const sel = selection();
  sel.packages.node = '20';
  sel.packages.python = '3.11';
  sel.packages.typescript = '5';
  const r = run({ selection: sel });
  const j = json(r);
  assert.equal(j.features['ghcr.io/devcontainers/features/node:1'].version, '20');
  assert.equal(j.features['ghcr.io/devcontainers/features/python:1'].version, '3.11');
  assert.match(file(r, 'post-create.sh'), /typescript@5\b/);
});

test('package sources become ENV lines and mirrors rewrite registries', () => {
  const r = run({
    selection: selection({
      sources: {
        npmRegistry: 'https://npm.corp.example/npm/',
        pipIndexUrl: 'https://pypi.corp.example/simple/',
        pipTrustedHost: 'pypi.corp.example',
        imageMirror: 'https://mirror.corp.example/mcr/',
        featureMirror: 'mirror.corp.example/ghcr',
      },
    }),
  });
  assert.deepEqual(r.errors, []);
  const df = file(r, 'Dockerfile');
  assert.match(df, /^FROM mirror\.corp\.example\/mcr\/devcontainers\/base:ubuntu$/m);
  assert.match(df, /NPM_CONFIG_REGISTRY="https:\/\/npm\.corp\.example\/npm\/"/);
  assert.match(df, /PIP_INDEX_URL="https:\/\/pypi\.corp\.example\/simple\/"/);
  assert.match(df, /PIP_TRUSTED_HOST="pypi\.corp\.example"/);
  const keys = Object.keys(json(r).features);
  assert.ok(keys.includes('mirror.corp.example/ghcr/devcontainers/features/node:1'));
  assert.ok(keys.includes('mirror.corp.example/ghcr/azure/azure-dev/azd:latest'));
  assert.ok(!keys.some((k) => k.startsWith('ghcr.io/')));
});

test('credentials in source URLs produce a warning', () => {
  const r = run({ selection: selection({ sources: { ...selection().sources, npmRegistry: 'https://user:pw@npm.example/' } }) });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /credentials/.test(w)));
});

test('invalid input is rejected and nothing is generated', () => {
  const cases: Partial<Selection>[] = [
    { remoteUser: 'root; rm -rf /' },
    { sharedVolumeName: 'bad volume' },
    { baseImage: 'ubuntu\nRUN evil' },
    { sources: { ...selection().sources, npmRegistry: 'https://a.example/\nRUN evil' } },
    { sources: { ...selection().sources, pipIndexUrl: 'https://a.example/"$(evil)' } },
    { sources: { ...selection().sources, featureMirror: 'bad mirror' } },
  ];
  for (const c of cases) {
    const r = run({ selection: selection(c) });
    assert.ok(r.errors.length > 0, `expected error for ${JSON.stringify(c)}`);
    assert.equal(r.files.length, 0);
  }
  const sel = selection();
  sel.packages.typescript = 'latest; rm -rf /';
  assert.ok(run({ selection: sel }).errors.length > 0);
});

test('re-generation keeps comments, unknown keys and user items', () => {
  const existing = `// my project container
{
  "name": "mine", // keep me
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/rust:1": {}
  },
  "forwardPorts": [3000],
  "mounts": ["source=mydata,target=/data,type=volume"],
  "postCreateCommand": "echo hi",
  "customizations": { "vscode": { "extensions": ["rust-lang.rust-analyzer"] } },
}`;
  const r = run({ selection: selection(), existing: { devcontainerJson: existing } });
  assert.deepEqual(r.errors, []);
  const text = file(r, 'devcontainer.json');
  assert.match(text, /\/\/ my project container/);
  assert.match(text, /\/\/ keep me/);
  const j = json(r);
  assert.equal(j.name, 'mine');
  assert.equal(j.image, undefined);
  assert.deepEqual(j.forwardPorts, [3000]);
  assert.ok(j.features['ghcr.io/devcontainers/features/rust:1']);
  assert.ok(j.mounts.includes('source=mydata,target=/data,type=volume'));
  assert.equal(j.mounts.length, 3);
  assert.deepEqual(j.postCreateCommand, { user: 'echo hi', 'devcontainer-composer': POST_CREATE_COMMAND });
  assert.ok(j.customizations.vscode.extensions.includes('rust-lang.rust-analyzer'));
  assert.ok(r.warnings.some((w) => /image/.test(w)));
  assert.ok(r.warnings.some((w) => /postCreateCommand/.test(w)));
});

test('deselected managed items are removed, user-owned items are kept', () => {
  const existing = `{
  "features": { "ghcr.io/devcontainers/features/python:1": { "version": "3.11", "installTools": false } },
  "customizations": { "vscode": { "extensions": ["ms-python.python", "my.ext"] } }
}`;
  const first = run({ selection: selection(), existing: { devcontainerJson: existing } });
  const j1 = json(first);
  // User's own python options are merged with the selected version.
  assert.deepEqual(j1.features['ghcr.io/devcontainers/features/python:1'], { version: 'os-provided', installTools: false });

  const second = run({
    selection: selection({}, ['node']),
    existing: { devcontainerJson: file(first, 'devcontainer.json'), dockerfile: file(first, 'Dockerfile') },
  });
  const j2 = json(second);
  assert.ok(j2.features['ghcr.io/devcontainers/features/node:1']);
  assert.ok(j2.features['ghcr.io/devcontainers/features/python:1'], 'user-owned python feature must stay');
  assert.equal(j2.features['ghcr.io/devcontainers/features/azure-cli:1'], undefined);
  assert.equal(j2.features['ghcr.io/azure/azure-dev/azd:latest'], undefined);
  const ext = j2.customizations.vscode.extensions;
  assert.ok(ext.includes('ms-python.python'), 'user-owned extension must stay');
  assert.ok(ext.includes('my.ext'));
  assert.ok(!ext.includes('GitHub.copilot'));
  assert.ok(!ext.includes('ms-vscode.azurecli'));
});

test('switching to a feature mirror replaces the managed reference without duplicates', () => {
  const first = run({ selection: selection() });
  const mirrored = selection({ sources: { ...selection().sources, featureMirror: 'reg.example/ghcr' } });
  const second = run({ selection: mirrored, existing: { devcontainerJson: file(first, 'devcontainer.json') } });
  const keys = Object.keys(json(second).features);
  assert.equal(keys.filter((k) => k.endsWith('features/node:1')).length, 1);
  assert.ok(keys.includes('reg.example/ghcr/devcontainers/features/node:1'));
  // And back again.
  const third = run({ selection: selection(), existing: { devcontainerJson: file(second, 'devcontainer.json') } });
  assert.deepEqual(Object.keys(json(third).features).sort(), Object.keys(json(first).features).sort());
});

test('generation is idempotent', () => {
  const first = run({ selection: selection() });
  const second = run({
    selection: selection(),
    existing: { devcontainerJson: file(first, 'devcontainer.json'), dockerfile: file(first, 'Dockerfile') },
  });
  for (const name of ['devcontainer.json', 'Dockerfile', 'post-create.sh']) {
    assert.equal(file(second, name), file(first, name), name);
  }
  assert.deepEqual(second.warnings, []);
});

test('stored selection can be read back', () => {
  const sel = selection();
  sel.packages.node = '20';
  const r = run({ selection: sel });
  const state = readStoredState(file(r, 'devcontainer.json'));
  assert.ok(state);
  assert.equal(state.selection.packages.node, '20');
  assert.equal(readStoredState('{}'), undefined);
});

test('docker compose setups and broken JSON are rejected', () => {
  const compose = run({ selection: selection(), existing: { devcontainerJson: '{ "dockerComposeFile": "docker-compose.yml" }' } });
  assert.ok(compose.errors.some((e) => /Compose/.test(e)));
  const broken = run({ selection: selection(), existing: { devcontainerJson: '{ "name": ' } });
  assert.ok(broken.errors.some((e) => /syntax error/.test(e)));
  assert.equal(broken.files.length, 0);
});

test('Dockerfile: user lines after the end marker are kept; unmanaged files are flagged', () => {
  const first = run({ selection: selection() });
  const custom = '# syntax=docker/dockerfile:1\n' + file(first, 'Dockerfile') + 'RUN apt-get update && apt-get install -y jq\n';
  const sel = selection({ baseImage: 'mcr.microsoft.com/devcontainers/base:debian' });
  const second = run({ selection: sel, existing: { devcontainerJson: file(first, 'devcontainer.json'), dockerfile: custom } });
  const df = file(second, 'Dockerfile');
  assert.ok(df.startsWith('# syntax=docker/dockerfile:1\n' + MARKER_BEGIN));
  assert.match(df, /FROM mcr\.microsoft\.com\/devcontainers\/base:debian/);
  assert.ok(df.indexOf('RUN apt-get update') > df.indexOf(MARKER_END));
  assert.equal(second.dockerfileReplacesUnmanaged, false);

  const unmanaged = run({ selection: selection(), existing: { dockerfile: 'FROM ubuntu\n' } });
  assert.equal(unmanaged.dockerfileReplacesUnmanaged, true);
  assert.ok(unmanaged.warnings.some((w) => /Dockerfile\.bak/.test(w)));
});

test('persistence can be disabled entirely or per item', () => {
  const off = run({ selection: selection({ persistence: { enabled: false, disabled: [] } }) });
  const j = json(off);
  assert.equal(j.mounts, undefined);
  assert.doesNotMatch(file(off, 'Dockerfile'), /\/persist/);
  assert.doesNotMatch(file(off, 'post-create.sh'), /link_home/);

  const partial = run({ selection: selection({ persistence: { enabled: true, disabled: ['azure', 'shell-history'] } }) });
  const ps = file(partial, 'post-create.sh');
  assert.doesNotMatch(ps, /link_home \.azure/);
  assert.doesNotMatch(ps, /HISTFILE/);
  assert.match(ps, /link_home \.azd/);

  // Turning persistence off removes the managed mounts but keeps user mounts.
  const withUser = run({ selection: selection(), existing: { devcontainerJson: '{ "mounts": ["source=x,target=/x,type=volume"] }' } });
  const removed = run({
    selection: selection({ persistence: { enabled: false, disabled: [] } }),
    existing: { devcontainerJson: file(withUser, 'devcontainer.json') },
  });
  assert.deepEqual(json(removed).mounts, ['source=x,target=/x,type=volume']);
});

test('custom packages: parsing, overriding built-ins and validation', () => {
  const ok = parseCustomPackage({
    id: 'rust',
    label: 'Rust',
    feature: 'ghcr.io/devcontainers/features/rust:1',
    versions: ['latest', '1.80'],
    extensions: ['rust-lang.rust-analyzer'],
    persist: [{ id: 'cargo', path: '.cargo/registry', scope: 'project' }],
  });
  assert.deepEqual(ok.errors, []);
  const override = parseCustomPackage({ id: 'node', label: 'Node (corp)', install: 'echo corp-node' });
  const cat = buildCatalog([ok.pkg!, override.pkg!]);
  assert.equal(cat.find((p) => p.id === 'node')!.label, 'Node (corp)');
  assert.equal(cat.filter((p) => p.id === 'node').length, 1);

  const r = generate({ catalog: cat, selection: selection({}, ['rust', 'node']) });
  assert.deepEqual(r.errors, []);
  assert.ok(json(r).features['ghcr.io/devcontainers/features/rust:1']);
  assert.match(file(r, 'post-create.sh'), /echo corp-node/);
  assert.match(file(r, 'post-create.sh'), /link_home \.cargo\/registry \/persist\/project\/cargo/);

  assert.ok(parseCustomPackage({ id: 'x', label: 'x', persist: [{ id: 'p', path: '../etc', scope: 'shared' }] }).errors.length);
  assert.ok(parseCustomPackage({ id: 'x', label: 'x', persist: [{ id: 'p', path: '/etc', scope: 'shared' }] }).errors.length);
  assert.ok(parseCustomPackage({ id: 'Bad Id', label: 'x', install: 'true' }).errors.length);
  assert.ok(parseCustomPackage({ id: 'x', label: 'x' }).errors.length);
  assert.ok(parseCustomPackage('nope').errors.length);
});

test('feature references are matched regardless of registry and version', () => {
  assert.equal(featurePath('ghcr.io/devcontainers/features/node:1'), 'devcontainers/features/node');
  assert.equal(featurePath('localhost:5000/devcontainers/features/node@sha256:abc123'), 'devcontainers/features/node');
  assert.ok(sameFeature('ghcr.io/devcontainers/features/node:1', 'reg.example/ghcr/devcontainers/features/node:2'));
  assert.ok(!sameFeature('ghcr.io/devcontainers/features/node:1', 'ghcr.io/devcontainers/features/python:1'));
  assert.deepEqual(validateSources({ npmRegistry: '', pipIndexUrl: '', pipTrustedHost: 'host:8080', imageMirror: '', featureMirror: '' }).errors, []);
});

test('generated shell code is syntactically valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devc-'));
  try {
    for (const sel of [selection(), selection({}, DEFAULT_PACKAGE_IDS.concat(['github-cli', 'kubectl', 'copilot-cli']))]) {
      const r = run({ selection: sel });
      const ps = join(dir, 'post-create.sh');
      writeFileSync(ps, file(r, 'post-create.sh'));
      execFileSync('bash', ['-n', ps]);
      const runLines = file(r, 'Dockerfile')
        .split('\n')
        .reduce<{ inRun: boolean; out: string[] }>(
          (acc, line) => {
            if (line.startsWith('RUN ')) {
              acc.inRun = true;
              line = line.slice(4);
            }
            if (acc.inRun) {
              acc.out.push(line);
              acc.inRun = line.endsWith('\\');
            }
            return acc;
          },
          { inRun: false, out: [] },
        ).out;
      assert.ok(runLines.length > 0);
      const sh = join(dir, 'run.sh');
      writeFileSync(sh, runLines.join('\n') + '\n');
      execFileSync('sh', ['-n', sh]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removing properties keeps neighbouring comments', () => {
  const src = '{\n  "a": 1, // about a\n  // about b\n  "b": 2,\n  "c": 3 // about c\n}\n';
  const noB = removeProperty(src, ['b']);
  assert.equal(noB, '{\n  "a": 1, // about a\n  // about b\n  "c": 3 // about c\n}\n');
  const noC = removeProperty(src, ['c']);
  assert.deepEqual(parse(noC), { a: 1, b: 2 });
  assert.match(noC, /\/\/ about a/);
  assert.match(noC, /\/\/ about b/);
  const noA = removeProperty('{ "a": 1 }', ['a']);
  assert.deepEqual(parse(noA), {});
  assert.equal(removeProperty(src, ['missing']), src);
});

test('user-owned features keep their key and are never removed', () => {
  const existing = '{ "features": { "corp.example/acme/devcontainers/features/node:1": { "flavor": "corp" } } }';
  const first = run({ selection: selection({}, ['node']), existing: { devcontainerJson: existing } });
  const j1 = json(first);
  assert.deepEqual(Object.keys(j1.features), ['corp.example/acme/devcontainers/features/node:1']);
  assert.deepEqual(j1.features['corp.example/acme/devcontainers/features/node:1'], { flavor: 'corp', version: 'lts' });
  const second = run({ selection: selection({}, ['python']), existing: { devcontainerJson: file(first, 'devcontainer.json') } });
  assert.ok(json(second).features['corp.example/acme/devcontainers/features/node:1']);
});

test('auto-added requirements are not stored as explicit choices', () => {
  const first = run({ selection: selection({}, ['typescript']) });
  const state = readStoredState(file(first, 'devcontainer.json'))!;
  assert.deepEqual(Object.keys(state.selection.packages), ['typescript']);
  const second = run({ selection: selection({}, ['python']), existing: { devcontainerJson: file(first, 'devcontainer.json') } });
  assert.equal(json(second).features['ghcr.io/devcontainers/features/node:1'], undefined);
});

test('user mounts on reserved persistence targets are rejected, not removed', () => {
  const r = run({ selection: selection(), existing: { devcontainerJson: '{ "mounts": ["source=mine,target=/persist/shared,type=volume"] }' } });
  assert.ok(r.errors.some((e) => /reserved/.test(e)));
  assert.equal(r.files.length, 0);
});

test('a root .devcontainer.json is rejected with a clear message', () => {
  const r = run({ selection: selection(), existing: { rootConfig: true } });
  assert.ok(r.errors.some((e) => /\.devcontainer\.json in the project root/.test(e)));
});

test('an object postCreateCommand with a colliding key is not overwritten', () => {
  const existing = '{ "postCreateCommand": { "devcontainer-composer": "echo mine" } }';
  const r = run({ selection: selection(), existing: { devcontainerJson: existing } });
  const pcc = json(r).postCreateCommand;
  assert.equal(pcc['devcontainer-composer'], 'echo mine');
  assert.equal(pcc['devcontainer-composer-2'], POST_CREATE_COMMAND);
  const again = run({ selection: selection(), existing: { devcontainerJson: file(r, 'devcontainer.json') } });
  assert.deepEqual(json(again).postCreateCommand, pcc);
});

test('post-create.sh migrates directories safely and never deletes unexpected files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devc-run-'));
  try {
    const home = join(dir, 'home');
    const r = run({ selection: selection({}, ['azure-cli', 'azd']) });
    const script = join(dir, 'post-create.sh');
    writeFileSync(script, file(r, 'post-create.sh').replaceAll('/persist', join(dir, 'persist')));
    execFileSync('mkdir', ['-p', join(home, '.azure'), join(dir, 'persist/shared/azure')]);
    writeFileSync(join(home, '.azure', 'token'), 'from-home');
    writeFileSync(join(home, '.azure', 'config'), 'home-config');
    writeFileSync(join(dir, 'persist/shared/azure/config'), 'volume-config');
    writeFileSync(join(home, '.azd'), 'unexpected file');
    let status = 0;
    try {
      execFileSync('bash', [script], { env: { ...process.env, HOME: home }, stdio: 'pipe' });
    } catch (e: any) {
      status = e.status;
    }
    assert.equal(status, 1, 'a warning must make the script fail');
    const cat = (p: string) => execFileSync('cat', [p]).toString();
    assert.equal(execFileSync('readlink', [join(home, '.azure')]).toString().trim(), join(dir, 'persist/shared/azure'));
    assert.equal(cat(join(home, '.azure', 'token')), 'from-home');
    assert.equal(cat(join(home, '.azure', 'config')), 'volume-config', 'volume content wins');
    assert.equal(cat(join(home, '.azd')), 'unexpected file', 'files are left untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
