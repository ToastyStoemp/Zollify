import { ref } from 'vue';

/**
 * Theme choice for this device. 'system' stamps nothing and lets the OS
 * preference through the tokens' media query; 'light' / 'dark' stamp
 * data-theme on <html>, which the token file gives priority over the OS.
 *
 * Per device, not per account: the light a booth is lit by is a property of
 * the room and the screen, not of whose account is signed in.
 */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'zollify.theme';

export const theme = ref<Theme>('system');

function read(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  } catch {
    return 'system';
  }
}

function stamp(value: Theme): void {
  if (typeof document === 'undefined') return;
  if (value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
}

export function setTheme(value: Theme): void {
  theme.value = value;
  stamp(value);
  try {
    if (value === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
  } catch {
    // No storage: the choice lasts for this page load, which is still useful.
  }
}

/** Called once at boot, before the app mounts, so the first paint is right. */
export function applyStoredTheme(): void {
  const stored = read();
  theme.value = stored;
  stamp(stored);
}
