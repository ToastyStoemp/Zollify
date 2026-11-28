import { onUnmounted, ref } from 'vue';

export type ToastKind = 'ok' | 'bad';
/** Shows one line above the products for a moment; the next one replaces it. */
export type Toast = (text: string, kind?: ToastKind) => void;

/** The till's own notice line: what just happened, gone again after 2.8 s. */
export function useToast() {
  const notice = ref<{ text: string; kind: ToastKind } | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(text: string, kind: ToastKind = 'ok'): void {
    notice.value = { text, kind };
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice.value = null), 2800);
  }
  onUnmounted(() => clearTimeout(noticeTimer));
  return { notice, toast };
}
