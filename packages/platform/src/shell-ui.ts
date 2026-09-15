import { reactive } from 'vue';
import { openDocument, saveFile } from './native';
import type { ShellUi, ToastOptions } from '@zollify/sdk';

export interface Toast {
  id: number;
  message: string;
  kind: NonNullable<ToastOptions['kind']>;
  moduleId: string;
}

export const toasts = reactive<Toast[]>([]);

let nextId = 1;

export interface ConfirmRequest {
  title: string;
  message: string;
  resolve(answer: boolean): void;
}

/** The shell renders whatever sits here; null means no dialog is open. */
export const pendingConfirm = reactive<{ current: ConfirmRequest | null }>({ current: null });

/** The shell's own confirm - the same dialog modules get, for core screens. */
export const shellConfirm = (message: string, title?: string): Promise<boolean> =>
  createShellUi('core').confirm(message, title);

/**
 * Shell services handed to modules.
 *
 * Toasts carry the originating module id so a misbehaving module's noise can be
 * attributed rather than blamed on the app - and messages are treated as text
 * by the renderer, never as markup.
 */
export function createShellUi(moduleId: string): ShellUi {
  return {
    toast(message: string, options: ToastOptions = {}) {
      const toast: Toast = {
        id: nextId++,
        message: String(message),
        kind: options.kind ?? 'info',
        moduleId,
      };
      toasts.push(toast);
      const timeout = options.timeoutMs ?? 4000;
      if (timeout > 0) {
        setTimeout(() => {
          const i = toasts.findIndex((t) => t.id === toast.id);
          if (i >= 0) toasts.splice(i, 1);
        }, timeout);
      }
    },

    saveFile: (filename, content, mimeType) => saveFile(filename, content, mimeType),
    openDocument: (filename, content, mimeType) => openDocument(filename, content, mimeType),

    confirm(message: string, title = 'Confirm') {
      // Queue-free by design: a second confirm while one is open resolves the
      // first as declined rather than stacking dialogs the user can't reach.
      const previous = pendingConfirm.current;
      if (previous) previous.resolve(false);

      return new Promise<boolean>((resolve) => {
        pendingConfirm.current = {
          title: String(title),
          message: String(message),
          resolve(answer: boolean) {
            pendingConfirm.current = null;
            resolve(answer);
          },
        };
      });
    },
  };
}
