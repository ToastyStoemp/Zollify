import { afterEach, describe, expect, it } from 'vitest';
import { pendingCount } from '../core/outbox';
import { leaveOnPurpose, resetLeaveGuard, shouldGuardLeave } from '../leave-guard';

describe('leave guard', () => {
  afterEach(() => {
    pendingCount.value = 0;
    resetLeaveGuard();
  });

  it('asks before closing only while changes are waiting to sync', () => {
    pendingCount.value = 0;
    expect(shouldGuardLeave()).toBe(false);
    pendingCount.value = 2;
    expect(shouldGuardLeave()).toBe(true);
  });

  it('lets the app reload itself without asking', () => {
    pendingCount.value = 3;
    leaveOnPurpose();
    expect(shouldGuardLeave()).toBe(false);
  });
});
