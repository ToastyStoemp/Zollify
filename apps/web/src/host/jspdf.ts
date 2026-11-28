/**
 * Host-provided jsPDF, loaded on demand.
 *
 * A runtime module leaves `jspdf` external and reaches it with
 * `await import('jspdf')` inside the handler that builds a PDF, so the
 * library (~380 kB) is parsed when someone exports, not on every app start.
 * It re-exports the copy the shell's own exports use, so there is one chunk
 * for the shell and every module, shipped with the shell and so available
 * offline.
 *
 * Nothing in the shell may import this file statically: it must stay out of
 * the `modulepreload` list in index.html (host-entries.test.ts checks the
 * import map side; the build output is checked by hand, see the PR).
 */
export * from 'jspdf';
