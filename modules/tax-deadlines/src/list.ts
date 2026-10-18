import { addDays, deadlinesBetween, type DeadlineSource, type TaxDeadline } from '@zollify/shared';

/** How far back a missed deadline still shows, and how far ahead the list looks. */
export const LOOK_BACK_DAYS = 120;
export const LOOK_AHEAD_DAYS = 400;
export const SOON_DAYS = 30;

export interface DeadlineGroups {
  overdue: TaxDeadline[];
  soon: TaxDeadline[];
  later: TaxDeadline[];
  /** Ticked off, most recent due first. */
  done: TaxDeadline[];
}

/** The page's sections: missed and still open, the next month, after that, and what is done. */
export function groupDeadlines(settings: DeadlineSource, done: Set<string>, today: string): DeadlineGroups {
  const all = deadlinesBetween(settings, addDays(today, -LOOK_BACK_DAYS), addDays(today, LOOK_AHEAD_DAYS));
  const soonEnd = addDays(today, SOON_DAYS);
  const open = all.filter((d) => !done.has(d.id));
  return {
    overdue: open.filter((d) => d.due < today),
    soon: open.filter((d) => d.due >= today && d.due <= soonEnd),
    later: open.filter((d) => d.due > soonEnd),
    done: all.filter((d) => done.has(d.id)).reverse(),
  };
}
