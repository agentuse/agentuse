import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class FolderPickerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderPickerError';
  }
}

export interface FolderPickerCommand {
  command: string;
  args: string[];
}

export function folderPickerCommand(platform: NodeJS.Platform): FolderPickerCommand {
  if (platform === 'darwin') {
    return { command: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "Choose a project folder")'] };
  }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-STA', '-Command', [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
        '$dialog.Description = "Choose a project folder";',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { exit 1 }',
      ].join(' ')],
    };
  }
  if (platform === 'linux') {
    return { command: 'zenity', args: ['--file-selection', '--directory', '--title=Choose a project folder'] };
  }
  throw new FolderPickerError('Folder selection is not supported on this operating system. Enter the project path instead.');
}

function wasCancelled(error: unknown): boolean {
  const value = error as NodeJS.ErrnoException & { stderr?: string };
  return value.code === '1'
    || value.code === 'CANCELLED'
    || value.stderr?.toLowerCase().includes('user canceled') === true
    || value.stderr?.toLowerCase().includes('user cancelled') === true;
}

/** Open the host operating system's native folder chooser. This is only used
 * by a loopback AgentUse server; exposed hosts must never open server-side UI. */
export async function pickLocalProjectFolder(platform = process.platform): Promise<string | null> {
  const { command, args } = folderPickerCommand(platform);

  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5 * 60_000 });
    const path = stdout.trim().replace(/\/$/, '');
    return path || null;
  } catch (error) {
    if (wasCancelled(error)) return null;
    const value = error as NodeJS.ErrnoException;
    if (value.code === 'ENOENT') {
      throw new FolderPickerError('No native folder chooser is available. Enter the project path instead.');
    }
    throw new FolderPickerError(`Could not open the folder chooser: ${value.message}`);
  }
}
