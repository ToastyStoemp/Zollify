import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Canon's IJ status monitor: the driver's own window (rundll32, class CNMSTMN_FRAME) that follows
 * the printer while it prints, and its prompt (CNMSTMN_ERRDLG) when the printer waits for someone -
 * "Starting manual feed printing. Load a sheet... Press the printer's OK button". The Windows
 * spooler never hears of that wait (the job just says Printing, all pages sent), and the printer
 * itself reports plain idle, so the monitor is where it shows. One helper process looks for the
 * two windows once a second by class (FindWindow, no UI scan) and prints a line when what they
 * say changes.
 */

export interface MonitorState {
  /** What the printer waits for: the prompt's headline and steps; null while it waits for nothing. */
  prompt: string | null;
  /** The monitor's status line ("Printing from the manual feed tray."). */
  status: string;
  /** The document printing, as the monitor names it. */
  document: string;
  /** The sheet being printed and how many the job has ("5 / 6"), from the printer. */
  page: { at: number; of: number } | null;
}

const SCRIPT = String.raw`
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class CanonMonitor {
  delegate bool Each(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, Each f, IntPtr l);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, StringBuilder l);
  public static string Text(IntPtr top, int id) {
    if (top == IntPtr.Zero) return "";
    string r = "";
    EnumChildWindows(top, (h, l) => { if (GetDlgCtrlID(h) != id) return true; var s = new StringBuilder(1024); SendMessage(h, 0x000D, (IntPtr)1024, s); r = s.ToString(); return false; }, IntPtr.Zero);
    return r;
  }
}
'@
$last = ''
while ($true) {
  $d = [CanonMonitor]::FindWindow('CNMSTMN_ERRDLG', [NullString]::Value)
  $f = [CanonMonitor]::FindWindow('CNMSTMN_FRAME', [NullString]::Value)
  $o = [ordered]@{
    open = $d -ne [IntPtr]::Zero
    prompt = @(1044, 1059, 1060 | ForEach-Object { [CanonMonitor]::Text($d, $_) })
    status = [CanonMonitor]::Text($f, 1033)
    document = [CanonMonitor]::Text($f, 1078)
    page = [CanonMonitor]::Text($f, 1015)
  } | ConvertTo-Json -Compress
  if ($o -ne $last) { [Console]::Out.WriteLine($o); [Console]::Out.Flush(); $last = $o }
  Start-Sleep -Milliseconds 1000
}
`;

/** One line of the helper's output. */
export function parseMonitor(line: string): MonitorState | null {
  try {
    const raw = JSON.parse(line) as { open?: boolean; prompt?: string[] | string; status?: string; document?: string; page?: string };
    const steps = (Array.isArray(raw.prompt) ? raw.prompt : [raw.prompt ?? '']).map((s) => s.trim()).filter(Boolean);
    const page = /(\d+)\s*\/\s*(\d+)/.exec(raw.page ?? '');
    return {
      prompt: raw.open ? steps.join(' ') || 'The printer is waiting.' : null,
      status: (raw.status ?? '').replace(/\r?\n/g, ' ').trim(),
      document: (raw.document ?? '').trim(),
      page: page ? { at: Number(page[1]), of: Number(page[2]) } : null,
    };
  } catch {
    return null;
  }
}

/** Follows the status monitor until stopped; Windows only (elsewhere it does nothing). */
export function watchStatusMonitor(onChange: (state: MonitorState) => void): () => void {
  if (process.platform !== 'win32') return () => undefined;
  let child: ChildProcess | null = null;
  let stopped = false;
  let restart: ReturnType<typeof setTimeout> | undefined;
  const start = (): void => {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const state = parseMonitor(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
        if (state) onChange(state);
      }
    });
    // Ended by itself (PowerShell missing, or killed): try again in a while.
    child.on('exit', () => {
      if (!stopped) restart = setTimeout(start, 30_000);
    });
  };
  start();
  return () => {
    stopped = true;
    clearTimeout(restart);
    child?.kill();
  };
}
