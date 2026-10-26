import type { Router } from 'vue-router';
import { isNative } from '@zollify/platform';

/**
 * Shortcuts into a screen: the Android launcher's (long-press the icon, or
 * drag one to the home screen - see android/app/src/main/res/xml/shortcuts.xml)
 * open the app on a `zollify://` link, and this takes it to that screen, on a
 * cold start or with the app already open. On the web the same screens are a
 * bookmark away (`#/m/tax/quick-expense`).
 */

const TARGETS: Record<string, string> = {
  expense: '/m/tax/quick-expense',
  sell: '/m/pos',
};

/** `zollify://expense` → `/m/tax/quick-expense`; null for a link this build does not know. */
export function shortcutPath(url: string): string | null {
  const m = /^zollify:\/\/([a-z-]+)/i.exec(url.trim());
  return m ? (TARGETS[m[1]!.toLowerCase()] ?? null) : null;
}

/** Goes to a shortcut's screen once the app has booted (a module's route exists only then). */
export async function wireShortcuts(router: Router, booted: Promise<void>): Promise<void> {
  if (!isNative()) return;
  const { App: CapApp } = await import('@capacitor/app');
  const open = async (url: string | undefined): Promise<void> => {
    const path = url ? shortcutPath(url) : null;
    if (!path) return;
    await booted;
    // A module that is off (or a helper without it) has no such route: stay where the app is.
    if (router.resolve(path).name === 'not-found') return;
    await router.push(path);
  };
  await CapApp.addListener('appUrlOpen', ({ url }) => void open(url));
  const launch = await CapApp.getLaunchUrl().catch(() => undefined);
  void open(launch?.url);
}
