/**
 * Host-provided shared domain code.
 *
 * Without this, every module that imports a type or helper from
 * @boothly/shared bundles its own copy — including zod, which the sync
 * protocol pulls in. POS went from 25 kB to 172 kB before this was external.
 */
export * from '@boothly/shared';
