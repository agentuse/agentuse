import { spawn } from 'child_process';

/** Best-effort native browser launch. A false result means callers should
 * leave the URL visible for remote/headless users instead. */
export async function openBrowser(url: string): Promise<boolean> {
  if (process.env.AGENTUSE_NO_BROWSER === '1') return false;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false;
  }

  const command = process.platform === 'darwin'
    ? { file: 'open', args: [url] }
    : process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/c', 'start', '', url] }
      : { file: 'xdg-open', args: [url] };

  return await new Promise<boolean>((resolve) => {
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', () => finish(false));
    child.once('spawn', () => {
      child.unref();
      finish(true);
    });
  });
}
