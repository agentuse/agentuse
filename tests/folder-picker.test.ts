import { describe, expect, it } from 'bun:test';
import { folderPickerCommand } from '../src/utils/folder-picker';

describe('native project folder picker', () => {
  it('uses the macOS native choose-folder dialog', () => {
    const picker = folderPickerCommand('darwin');
    expect(picker.command).toBe('osascript');
    expect(picker.args.join(' ')).toContain('choose folder');
  });

  it('uses platform-native directory-only pickers where supported', () => {
    expect(folderPickerCommand('win32')).toEqual(expect.objectContaining({ command: 'powershell.exe' }));
    expect(folderPickerCommand('linux')).toEqual(expect.objectContaining({ command: 'zenity' }));
  });

  it('keeps manual path entry as the fallback on unsupported hosts', () => {
    expect(() => folderPickerCommand('aix')).toThrow('Enter the project path instead');
  });
});
