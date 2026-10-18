import { pendingCount } from './core/outbox';

/**
 * Closing the tab or the browser with changes still in the outbox gets the
 * browser's own "leave this page?" prompt. The changes are not lost - they
 * wait on this device and go up on the next visit - but someone about to
 * carry on on another phone or laptop would not see them there, and a tester
 * took exactly that for data loss. Nothing is shown once everything has synced.
 *
 * The app's own reloads (signing out, deleting or wiping the account,
 * picking up a new version) are not the person leaving: they call
 * leaveOnPurpose() first.
 */

let onPurpose = false;
let installed = false;

/** Whether closing the page now should ask first. */
export function shouldGuardLeave(): boolean {
  return !onPurpose && pendingCount.value > 0;
}

export function guardUnsyncedOnClose(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('beforeunload', (e) => {
    if (!shouldGuardLeave()) return;
    e.preventDefault();
    // Older browsers want this set; every current one shows its own wording.
    e.returnValue = '';
  });
}

/** The app is about to reload or navigate away by itself: let it, without the prompt. */
export function leaveOnPurpose(): void {
  onPurpose = true;
}

/** Tests only. */
export function resetLeaveGuard(): void {
  onPurpose = false;
}
