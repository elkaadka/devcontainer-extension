import * as vscode from 'vscode';
import { CATEGORIES, CORE_PERSIST } from '../core/catalog';
import { generate, readStoredState } from '../core/generator';
import { PackageDef, Selection } from '../core/types';
import { coerceSelection, defaultSelection, loadCatalog, saveAsDefault, sourcesFromSettings } from '../config';
import { hasDevcontainer, promptReopen, readExisting, writeResult } from '../writer';

type InMessage =
  | { type: 'ready' }
  | { type: 'preview'; selection: unknown }
  | { type: 'generate'; selection: unknown }
  | { type: 'saveDefault'; selection: unknown }
  | { type: 'resetDefaults' }
  | { type: 'resetSources' };

export class ComposerPanel {
  private static panels = new Map<string, ComposerPanel>();

  static show(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    const existing = ComposerPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    ComposerPanel.panels.set(key, new ComposerPanel(context, folder));
  }

  private readonly panel: vscode.WebviewPanel;
  private catalog: PackageDef[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
  ) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('devcontainerComposer', `Dev Container: ${folder.name}`, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.png');
    this.panel.webview.html = this.html(media);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m: InMessage) => this.onMessage(m).catch((e) => this.showError(e)), null, this.disposables);
  }

  private dispose(): void {
    ComposerPanel.panels.delete(this.folder.uri.toString());
    this.disposables.forEach((d) => d.dispose());
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private showError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`DevContainer Composer: ${msg}`);
    this.post({ type: 'busy', busy: false });
  }

  private async onMessage(m: InMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.sendInit();
      case 'preview':
        return this.preview(m.selection);
      case 'generate':
        return this.generate(m.selection);
      case 'saveDefault': {
        const sel = this.selection(m.selection);
        await saveAsDefault(sel);
        void vscode.window.showInformationMessage('DevContainer Composer: saved as your default selection.');
        return;
      }
      case 'resetDefaults':
        return this.sendInit(true);
      case 'resetSources':
        this.post({ type: 'sources', sources: sourcesFromSettings() });
        return;
    }
  }

  private selection(raw: unknown): Selection {
    return coerceSelection(raw, defaultSelection(this.catalog));
  }

  private async sendInit(useDefaults = false): Promise<void> {
    const { catalog, errors } = loadCatalog();
    this.catalog = catalog;
    const existing = await readExisting(this.folder.uri);
    const defaults = defaultSelection(catalog);
    const stored = useDefaults ? undefined : readStoredState(existing.devcontainerJson);
    const selection = stored ? coerceSelection(stored.selection, defaults) : defaults;
    this.post({
      type: 'init',
      catalog,
      categories: [...CATEGORIES, ...new Set(catalog.map((p) => p.category).filter((c) => !CATEGORIES.includes(c)))],
      corePersist: CORE_PERSIST,
      selection,
      settingsErrors: errors,
      hasExisting: await hasDevcontainer(this.folder.uri),
      fromStored: !!stored,
      folderName: this.folder.name,
    });
  }

  private async run(raw: unknown) {
    const selection = this.selection(raw);
    const existing = await readExisting(this.folder.uri);
    return generate({ catalog: this.catalog, selection, existing, projectName: this.folder.name });
  }

  private async preview(raw: unknown): Promise<void> {
    const result = await this.run(raw);
    this.post({ type: 'preview', result });
  }

  private async generate(raw: unknown): Promise<void> {
    this.post({ type: 'busy', busy: true });
    const result = await this.run(raw);
    if (result.errors.length) {
      this.post({ type: 'preview', result });
      this.post({ type: 'busy', busy: false });
      void vscode.window.showErrorMessage(`DevContainer Composer: ${result.errors.join(' ')}`);
      return;
    }
    const written = await writeResult(this.folder.uri, result);
    this.post({ type: 'busy', busy: false });
    if (!written) {
      return;
    }
    this.post({ type: 'generated', hasExisting: true });
    // Refresh the preview: the written files are now the "existing" ones.
    await this.preview(raw);
    await promptReopen();
  }

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>DevContainer Composer</title>
</head>
<body>
<div id="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
