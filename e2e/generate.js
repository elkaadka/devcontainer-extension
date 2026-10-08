#!/usr/bin/env node
// Writes a .devcontainer into a folder using the compiled generator (run `npm test` or
// `npx tsc -p tsconfig.test.json` first so that out-test/ exists).
//
// Usage: node e2e/generate.js --dir <folder> [--packages node,python] [--npm URL] [--pip URL]
//        [--pip-host HOST] [--shared-volume NAME] [--host-path PATH]
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { generate } = require(path.join(root, 'out-test/src/core/generator'));
const { buildCatalog, DEFAULT_PACKAGE_IDS } = require(path.join(root, 'out-test/src/core/catalog'));

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
if (!args.dir) {
  console.error('--dir is required');
  process.exit(2);
}
const dir = path.resolve(args.dir);
const ids = args.packages ? args.packages.split(',').filter(Boolean) : DEFAULT_PACKAGE_IDS;
const selection = {
  packages: Object.fromEntries(ids.map((id) => [id, ''])),
  sources: {
    npmRegistry: args.npm || '',
    pipIndexUrl: args.pip || '',
    pipTrustedHost: args['pip-host'] || '',
    imageMirror: args['image-mirror'] || '',
    featureMirror: args['feature-mirror'] || '',
  },
  persistence: { enabled: true, disabled: [] },
  baseImage: args['base-image'] || 'mcr.microsoft.com/devcontainers/base:ubuntu',
  remoteUser: 'vscode',
  sharedVolumeName: args['shared-volume'] || 'devc-shared-auth',
};

const devDir = path.join(dir, '.devcontainer');
const read = (f) => (fs.existsSync(path.join(devDir, f)) ? fs.readFileSync(path.join(devDir, f), 'utf8') : undefined);
const result = generate({
  catalog: buildCatalog(),
  selection,
  existing: { devcontainerJson: read('devcontainer.json'), dockerfile: read('Dockerfile') },
  projectName: path.basename(dir),
});
if (result.errors.length) {
  console.error(result.errors.join('\n'));
  process.exit(1);
}
result.warnings.forEach((w) => console.warn('warning:', w));
fs.mkdirSync(devDir, { recursive: true });
for (const f of result.files) {
  let content = f.content;
  if (f.name === 'devcontainer.json' && args['host-path']) {
    // The Docker daemon may see the folder under a different path (Docker Desktop, CLI in a container).
    const json = JSON.parse(content);
    json.workspaceMount = `source=${args['host-path']},target=/workspaces/${path.basename(dir)},type=bind`;
    json.workspaceFolder = `/workspaces/${path.basename(dir)}`;
    content = JSON.stringify(json, null, 2) + '\n';
  }
  fs.writeFileSync(path.join(devDir, f.name), content, { mode: f.executable ? 0o755 : 0o644 });
}
console.log(`Generated ${devDir} (${result.files.map((f) => f.name).join(', ')})`);
