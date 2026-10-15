import { ref } from 'vue';
import { authFetch, currentAccount } from '@zollify/platform';

/**
 * How many errors are open on the account (Settings → Problems), for the dot
 * on the Settings entry. Only owners and admins can ask; for staff it stays 0.
 */
export const openProblemErrors = ref(0);

export async function refreshProblemCount(): Promise<void> {
  const role = currentAccount.value?.role;
  if (role !== 'owner' && role !== 'admin') {
    openProblemErrors.value = 0;
    return;
  }
  try {
    openProblemErrors.value = ((await authFetch('/problems')) as { openErrors: number }).openErrors;
  } catch {
    /* offline: keep what the dot showed */
  }
}
