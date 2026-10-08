import * as vscode from 'vscode';
import { ExistingFiles, GenerateResult } from './core/types';

export const DIR = '.devcontainer';

export function devcontainerUri(folder: vscode.Uri, name?: string): vscode.Uri {
  return name ? vscode.Uri.joinPath(folder, DIR, name) : vscode.Uri.joinPath(folder, DIR);
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (e) {
    if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') {
      return undefined;
    }
    throw e;
  }
}

export async function readExisting(folder: vscode.Uri): Promise<ExistingFiles> {
  const devcontainerJson = await readText(devcontainerUri(folder, 'devcontainer.json'));
  const rootConfig = devcontainerJson === undefined && (await readText(vscode.Uri.joinPath(folder, '.devcontainer.json'))) !== undefined;
  return {
    devcontainerJson,
    dockerfile: await readText(devcontainerUri(folder, 'Dockerfile')),
    rootConfig,
  };
}

export async function hasDevcontainer(folder: vscode.Uri): Promise<boolean> {
  for (const uri of [devcontainerUri(folder, 'devcontainer.json'), vscode.Uri.joinPath(folder, '.devcontainer.json')]) {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      // not found
    }
  }
  return false;
}

/**
 * Writes the generated files. Returns false if the user cancelled.
 * An unmanaged Dockerfile is only replaced after confirmation and is backed up to Dockerfile.bak.
 */
export async function writeResult(folder: vscode.Uri, result: GenerateResult): Promise<boolean> {
  if (result.errors.length) {
    throw new Error(result.errors.join('\n'));
  }
  if (result.dockerfileReplacesUnmanaged) {
    const choice = await vscode.window.showWarningMessage(
      'The existing .devcontainer/Dockerfile was not created by DevContainer Composer. Replace it? A backup is saved as Dockerfile.bak.',
      { modal: true },
      'Replace',
    );
    if (choice !== 'Replace') {
      return false;
    }
    await vscode.workspace.fs.copy(devcontainerUri(folder, 'Dockerfile'), devcontainerUri(folder, 'Dockerfile.bak'), { overwrite: true });
  }
  await vscode.workspace.fs.createDirectory(devcontainerUri(folder));
  const encoder = new TextEncoder();
  for (const f of result.files) {
    const uri = devcontainerUri(folder, f.name);
    await vscode.workspace.fs.writeFile(uri, encoder.encode(f.content));
    if (f.executable && uri.scheme === 'file' && process.platform !== 'win32') {
      try {
        const fs = await import('node:fs/promises');
        await fs.chmod(uri.fsPath, 0o755);
      } catch {
        // post-create.sh is started with "bash", so the mode is cosmetic.
      }
    }
  }
  return true;
}

const DEV_CONTAINERS_EXT = 'ms-vscode-remote.remote-containers';

/** Offers to (re)open the folder in the container after generation. */
export async function promptReopen(): Promise<void> {
  const inContainer = vscode.env.remoteName === 'dev-container';
  const action = inContainer ? 'Rebuild Container' : 'Reopen in Container';
  const choice = await vscode.window.showInformationMessage('.devcontainer generated.', action);
  if (choice !== action) {
    return;
  }
  const command = inContainer ? 'remote-containers.rebuildContainer' : 'remote-containers.reopenInContainer';
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes(command)) {
    await vscode.commands.executeCommand(command);
    return;
  }
  const install = await vscode.window.showWarningMessage(
    'The Dev Containers extension is required to open the folder in a container.',
    'Install Dev Containers',
  );
  if (install) {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', DEV_CONTAINERS_EXT);
  }
}
