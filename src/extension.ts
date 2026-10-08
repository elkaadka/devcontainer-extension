import * as vscode from 'vscode';
import { cfg, defaultSelection, loadCatalog, SECTION } from './config';
import { generate } from './core/generator';
import { ComposerPanel } from './ui/panel';
import { hasDevcontainer, promptReopen, readExisting, writeResult } from './writer';

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    const choice = await vscode.window.showWarningMessage('DevContainer Composer: open a folder first.', 'Open Folder');
    if (choice) {
      await vscode.commands.executeCommand('vscode.openFolder');
    }
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder for the dev container' });
}

async function generateDefault(context: vscode.ExtensionContext): Promise<void> {
  const folder = await pickFolder();
  if (!folder) {
    return;
  }
  if (await hasDevcontainer(folder.uri)) {
    void vscode.window.showInformationMessage('A dev container already exists here. Opening the editor instead of overwriting it.');
    ComposerPanel.show(context, folder);
    return;
  }
  const { catalog, errors: settingsErrors } = loadCatalog();
  if (settingsErrors.length) {
    void vscode.window.showWarningMessage(`DevContainer Composer: ignored invalid custom packages. ${settingsErrors.join(' ')}`);
  }
  const result = generate({
    catalog,
    selection: defaultSelection(catalog),
    existing: await readExisting(folder.uri),
    projectName: folder.name,
  });
  if (result.errors.length) {
    void vscode.window.showErrorMessage(`DevContainer Composer: ${result.errors.join(' ')}`);
    return;
  }
  for (const w of result.warnings) {
    void vscode.window.showWarningMessage(`DevContainer Composer: ${w}`);
  }
  if (await writeResult(folder.uri, result)) {
    await promptReopen();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const run = (fn: () => Promise<void>) => () =>
    fn().catch((e) => vscode.window.showErrorMessage(`DevContainer Composer: ${e instanceof Error ? e.message : String(e)}`));

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'devcontainerComposer.open',
      run(async () => {
        const folder = await pickFolder();
        if (folder) {
          ComposerPanel.show(context, folder);
        }
      }),
    ),
    vscode.commands.registerCommand(
      'devcontainerComposer.generateDefault',
      run(() => generateDefault(context)),
    ),
  );

  const status = vscode.window.createStatusBarItem('devcontainerComposer.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'DevContainer Composer';
  status.text = '$(package) Dev Container';
  status.tooltip = 'Create or edit the dev container for this folder';
  status.command = 'devcontainerComposer.open';
  context.subscriptions.push(status);

  const updateStatus = () => {
    const show = cfg().get<boolean>('showStatusBar', true) && (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    if (show) {
      status.show();
    } else {
      status.hide();
    }
  };
  updateStatus();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.showStatusBar`)) {
        updateStatus();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(updateStatus),
  );
}

export function deactivate(): void {
  // Nothing to clean up; disposables are registered on the context.
}
