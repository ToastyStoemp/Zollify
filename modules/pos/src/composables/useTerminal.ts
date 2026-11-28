import { computed, onUnmounted, ref } from 'vue';
import { sandboxAccount, testMode } from '../cart';
import { getProvider } from '../payments/registry';
import { testTerminalProvider } from '../payments/test-terminal';
import type { Toast } from './useToast';

/** Which card terminal the till uses, and whether it is connected (polled while the till is open). */
export function useTerminal(toast: Toast) {
  const providerId = ref('manual');
  // Test mode and a test account both take cards on the pretend terminal, whatever is set up.
  const pretendCards = computed(() => testMode.value || sandboxAccount());
  const provider = computed(() => (pretendCards.value ? testTerminalProvider : getProvider(providerId.value as never)));
  const hasTerminal = computed(() => pretendCards.value || providerId.value !== 'manual');

  // ── Terminal connection indicator: polled while the till is open ────────────
  const terminalConnected = ref<boolean | null>(null); // null = still checking
  const terminalDetail = ref('');
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  async function refreshTerminalStatus(): Promise<void> {
    if (!hasTerminal.value) return;
    try {
      const s = await provider.value.getStatus();
      terminalConnected.value = s.connected;
      terminalDetail.value = s.detail ?? '';
    } catch (err) {
      terminalConnected.value = false;
      terminalDetail.value = String(err);
    }
  }
  function tapTerminalState(): void {
    void refreshTerminalStatus();
    const state = terminalConnected.value === true ? 'connected' : terminalConnected.value === false ? 'not connected' : 'checking…';
    toast(`${provider.value.label}: ${terminalDetail.value || state}`, terminalConnected.value ? 'ok' : 'bad');
  }
  /** Started by the till once it knows which terminal is set up. */
  function startStatusPolling(): void {
    statusTimer = setInterval(() => void refreshTerminalStatus(), 5000);
  }
  onUnmounted(() => clearInterval(statusTimer));

  return { providerId, provider, hasTerminal, terminalConnected, refreshTerminalStatus, tapTerminalState, startStatusPolling };
}
