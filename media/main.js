// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();

  /** @type {any} */
  let state = vscode.getState() || {};
  /** @type {any} */
  let lastResult = null;
  let activeFile = 'devcontainer.json';
  let previewTimer = 0;
  let busy = false;

  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /**
   * Creates an element. Text is always set via textContent (no HTML injection).
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {...(Node|string|null|undefined|false)} children
   */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k in el && typeof v !== 'string') /** @type {any} */ (el)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      el.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function sel() {
    return state.selection;
  }

  function byId(id) {
    return state.catalog.find((p) => p.id === id);
  }

  /** Map of package id -> list of selected packages that require it. */
  function requiredBy() {
    /** @type {Record<string, string[]>} */
    const req = {};
    const visit = (id, root, seen) => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = byId(id);
      for (const r of (p && p.requires) || []) {
        (req[r] = req[r] || []).includes(root) || req[r].push(root);
        visit(r, root, seen);
      }
    };
    Object.keys(sel().packages).forEach((id) => visit(id, byId(id) ? byId(id).label : id, new Set()));
    for (const id of Object.keys(sel().packages)) delete req[id];
    return req;
  }

  function effectivePackages() {
    return new Set([...Object.keys(sel().packages), ...Object.keys(requiredBy())]);
  }

  function persistItems() {
    const items = [...state.corePersist];
    const ids = effectivePackages();
    for (const p of state.catalog) {
      if (!ids.has(p.id)) continue;
      for (const item of p.persist || []) {
        if (!items.some((i) => i.id === item.id)) items.push(item);
      }
    }
    return items;
  }

  function save() {
    vscode.setState(state);
  }

  function changed(rerender = false) {
    save();
    if (rerender) render();
    clearTimeout(previewTimer);
    previewTimer = /** @type {any} */ (setTimeout(() => vscode.postMessage({ type: 'preview', selection: sel() }), 150));
  }

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------

  function packagesSection() {
    const req = requiredBy();
    const section = h('section', {}, h('h2', {}, 'Packages'));
    for (const cat of state.categories) {
      const pkgs = state.catalog.filter((p) => p.category === cat);
      if (!pkgs.length) continue;
      const list = h('div', { class: 'pkg-list' });
      for (const p of pkgs) {
        const checked = p.id in sel().packages;
        const forced = !checked && !!req[p.id];
        const version = sel().packages[p.id] || '';
        const versions = p.versions || [];
        const row = h(
          'div',
          { class: 'pkg' + (checked || forced ? ' on' : '') },
          h(
            'label',
            { class: 'pkg-main' },
            h('input', {
              type: 'checkbox',
              checked: checked || forced,
              disabled: forced,
              onchange: (/** @type {Event} */ e) => {
                const t = /** @type {HTMLInputElement} */ (e.target);
                if (t.checked) sel().packages[p.id] = '';
                else delete sel().packages[p.id];
                changed(true);
              },
            }),
            h('span', { class: 'pkg-label' }, p.label),
            p.custom ? h('span', { class: 'badge' }, 'custom') : null,
            p.description ? h('span', { class: 'muted pkg-desc' }, p.description) : null,
            forced ? h('span', { class: 'muted pkg-desc' }, `required by ${req[p.id].join(', ')}`) : null,
          ),
          versions.length > 1
            ? h(
                'select',
                {
                  disabled: !(checked || forced),
                  title: 'Version',
                  onchange: (/** @type {Event} */ e) => {
                    const v = /** @type {HTMLSelectElement} */ (e.target).value;
                    sel().packages[p.id] = v === versions[0] ? '' : v;
                    changed();
                  },
                },
                ...versions.map((v, i) =>
                  h('option', { value: v, selected: (version || versions[0]) === v }, i === 0 ? `${v} (default)` : v),
                ),
              )
            : null,
        );
        list.append(row);
      }
      section.append(h('h3', {}, cat), list);
    }
    return section;
  }

  /**
   * @param {string} label
   * @param {string} value
   * @param {(v: string) => void} set
   * @param {string} placeholder
   * @param {string} [hint]
   */
  function field(label, value, set, placeholder, hint) {
    return h(
      'label',
      { class: 'field' },
      h('span', {}, label),
      h('input', {
        type: 'text',
        value,
        placeholder,
        spellcheck: 'false',
        oninput: (/** @type {Event} */ e) => {
          set(/** @type {HTMLInputElement} */ (e.target).value);
          changed();
        },
      }),
      hint ? h('span', { class: 'muted hint' }, hint) : null,
    );
  }

  function sourcesSection() {
    const s = sel().sources;
    return h(
      'section',
      {},
      h('h2', {}, 'Package sources'),
      h('p', { class: 'muted' }, 'Leave empty to use the public registries. Defaults come from your settings.'),
      field('npm registry', s.npmRegistry, (v) => (s.npmRegistry = v), 'https://registry.npmjs.org/'),
      field('pip index URL', s.pipIndexUrl, (v) => (s.pipIndexUrl = v), 'https://pypi.org/simple'),
      field('pip trusted host', s.pipTrustedHost, (v) => (s.pipTrustedHost = v), 'pypi.example.com'),
      field('Image mirror', s.imageMirror, (v) => (s.imageMirror = v), 'registry.example.com/mcr', 'Replaces mcr.microsoft.com in the base image.'),
      field('Feature mirror', s.featureMirror, (v) => (s.featureMirror = v), 'registry.example.com/ghcr', 'Replaces ghcr.io in feature references.'),
      h('div', { class: 'row' }, h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'resetSources' }) }, 'Reset to settings')),
    );
  }

  function persistenceSection() {
    const p = sel().persistence;
    const items = persistItems();
    const list = h('div', { class: 'pkg-list' });
    for (const item of items) {
      const on = !p.disabled.includes(item.id);
      list.append(
        h(
          'div',
          { class: 'pkg' + (on && p.enabled ? ' on' : '') },
          h(
            'label',
            { class: 'pkg-main' },
            h('input', {
              type: 'checkbox',
              checked: on,
              disabled: !p.enabled,
              onchange: (/** @type {Event} */ e) => {
                const c = /** @type {HTMLInputElement} */ (e.target).checked;
                p.disabled = p.disabled.filter((x) => x !== item.id);
                if (!c) p.disabled.push(item.id);
                changed(true);
              },
            }),
            h('span', { class: 'pkg-label' }, item.label),
          ),
          h('span', { class: 'badge ' + item.scope, title: item.scope === 'shared' ? 'Shared by all projects' : 'Only this project' }, item.scope === 'shared' ? 'shared' : 'this project'),
        ),
      );
    }
    return h(
      'section',
      {},
      h('h2', {}, 'Persistence'),
      h(
        'label',
        { class: 'pkg-main toggle' },
        h('input', {
          type: 'checkbox',
          checked: p.enabled,
          onchange: (/** @type {Event} */ e) => {
            p.enabled = /** @type {HTMLInputElement} */ (e.target).checked;
            changed(true);
          },
        }),
        h('span', {}, 'Keep logins, Copilot state and shell history across rebuilds'),
      ),
      h('p', { class: 'muted' }, `Shared items live in the volume "${sel().sharedVolumeName}" (all projects); project items in a volume unique to this folder.`),
      list,
    );
  }

  function advancedSection() {
    const s = sel();
    return h(
      'details',
      { class: 'section' },
      h('summary', {}, h('h2', {}, 'Advanced')),
      field('Base image', s.baseImage, (v) => (s.baseImage = v), 'mcr.microsoft.com/devcontainers/base:ubuntu'),
      field('Remote user', s.remoteUser, (v) => (s.remoteUser = v), 'vscode'),
      field('Shared volume name', s.sharedVolumeName, (v) => (s.sharedVolumeName = v), 'devc-shared-auth'),
    );
  }

  function previewPane() {
    const pane = h('div', { class: 'preview', id: 'preview' });
    fillPreview(pane);
    return pane;
  }

  /** @param {HTMLElement} pane */
  function fillPreview(pane) {
    pane.replaceChildren();
    const r = lastResult;
    pane.append(h('h2', {}, 'Preview'));
    if (!r) {
      pane.append(h('p', { class: 'muted' }, 'Computing…'));
      return;
    }
    const messages = h('div', { class: 'messages' });
    for (const e of r.errors) messages.append(h('div', { class: 'msg error' }, e));
    for (const w of r.warnings) messages.append(h('div', { class: 'msg warning' }, w));
    if (r.autoAdded && r.autoAdded.length) {
      const names = r.autoAdded.map((id) => (byId(id) ? byId(id).label : id));
      messages.append(h('div', { class: 'msg info' }, `Added automatically: ${names.join(', ')}`));
    }
    pane.append(messages);
    if (!r.files.length) return;
    if (!r.files.some((f) => f.name === activeFile)) activeFile = r.files[0].name;
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    for (const f of r.files) {
      tabs.append(
        h(
          'button',
          {
            class: 'tab' + (f.name === activeFile ? ' active' : ''),
            role: 'tab',
            onclick: () => {
              activeFile = f.name;
              fillPreview(pane);
            },
          },
          f.name,
        ),
      );
    }
    const file = r.files.find((f) => f.name === activeFile);
    pane.append(tabs, h('pre', { class: 'code' }, h('code', {}, file ? file.content : '')));
  }

  function actions() {
    const hasErrors = !!(lastResult && lastResult.errors.length);
    return h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          id: 'generate',
          disabled: busy || hasErrors,
          onclick: () => vscode.postMessage({ type: 'generate', selection: sel() }),
        },
        state.hasExisting ? 'Update .devcontainer' : 'Generate .devcontainer',
      ),
      h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'saveDefault', selection: sel() }) }, 'Save as my default'),
      h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'resetDefaults' }) }, 'Load my defaults'),
    );
  }

  function render() {
    if (!state.catalog) return;
    const scrollY = window.scrollY;
    const notices = h('div', {});
    for (const e of state.settingsErrors || []) notices.append(h('div', { class: 'msg warning' }, `Settings: ${e}`));
    if (state.fromStored) notices.append(h('div', { class: 'msg info' }, 'Loaded the selection stored in the existing .devcontainer.'));
    app.replaceChildren(
      h(
        'header',
        {},
        h('h1', {}, 'Dev Container'),
        h('span', { class: 'muted' }, state.folderName),
      ),
      notices,
      h(
        'div',
        { class: 'layout' },
        h('div', { class: 'form' }, packagesSection(), sourcesSection(), persistenceSection(), advancedSection(), actions()),
        previewPane(),
      ),
    );
    window.scrollTo(0, scrollY);
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'init':
        state = {
          catalog: m.catalog,
          categories: m.categories,
          corePersist: m.corePersist,
          selection: m.selection,
          settingsErrors: m.settingsErrors,
          hasExisting: m.hasExisting,
          fromStored: m.fromStored,
          folderName: m.folderName,
        };
        lastResult = null;
        changed(true);
        break;
      case 'sources':
        sel().sources = m.sources;
        changed(true);
        break;
      case 'preview': {
        lastResult = m.result;
        const pane = document.getElementById('preview');
        if (pane) fillPreview(pane);
        const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('generate'));
        if (btn) btn.disabled = busy || lastResult.errors.length > 0;
        break;
      }
      case 'busy':
        busy = m.busy;
        render();
        break;
      case 'generated':
        state.hasExisting = m.hasExisting;
        save();
        render();
        break;
    }
  });

  if (state.catalog) render();
  vscode.postMessage({ type: 'ready' });
})();
