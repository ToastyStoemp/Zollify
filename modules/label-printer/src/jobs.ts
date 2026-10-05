import { ref } from 'vue';
import type { LabelPrintJob } from '@zollify/sdk';

/**
 * Labels other parts of the app asked to print - a staff badge from
 * Settings, say. They wait here until printed or discarded, so the screen
 * can open and connect the printer first.
 */
export const pendingJobs = ref<(LabelPrintJob & { id: string })[]>([]);

export function queueJob(job: LabelPrintJob): void {
  pendingJobs.value = [...pendingJobs.value, { ...job, id: crypto.randomUUID() }];
}

export function dropJob(id: string): void {
  pendingJobs.value = pendingJobs.value.filter((j) => j.id !== id);
}
