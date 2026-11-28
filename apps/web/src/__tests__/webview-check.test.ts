import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * public/webview-check.js is the classic script that explains itself on a
 * device too old to run the app. It is not a module, so it is run here the way
 * a browser runs it: as a script, against a window and document - stubbed, to
 * stand in for WebViews this machine does not have.
 */
const source = readFileSync(fileURLToPath(new URL('../../public/webview-check.js', import.meta.url)), 'utf8');

/** The script without its comments, which may mention what the code must not use. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const UA_MODERN = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const UA_CARBON = 'Mozilla/5.0 (Linux; Android 9; myPOS Carbon Build/PPR1.180610.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/69.0.3497.100 Mobile Safari/537.36';
const uaChrome = (version: number) => `Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36`;

interface FakeNode {
  tag: string; id: string; text: string; children: FakeNode[]; parentNode: FakeNode | null; firstChild: FakeNode | null; style: { cssText: string };
  setAttribute(): void; appendChild(child: FakeNode): FakeNode; removeChild(child: FakeNode): void;
  /** Whatever else the script sets on an element (type, onclick). */
  [key: string]: unknown;
}

/** Just enough of a DOM node for the notice: children, text and an id to find it by. */
function node(tag: string, text = ''): FakeNode {
  const self: FakeNode = {
    tag, id: '', text, children: [], parentNode: null, firstChild: null, style: { cssText: '' },
    setAttribute() { /* attributes are not what these tests look at */ },
    appendChild(child: FakeNode) { self.children.push(child); child.parentNode = self; self.firstChild = self.children[0] ?? null; return child; },
    removeChild(child: FakeNode) { self.children = self.children.filter((c) => c !== child); self.firstChild = self.children[0] ?? null; },
  };
  return self;
}

const find = (root: FakeNode, id: string): FakeNode | null =>
  root.id === id ? root : root.children.reduce<FakeNode | null>((hit, child) => hit ?? find(child, id), null);
const textOf = (root: FakeNode): string => [root.text, ...root.children.map(textOf)].join(' ');

interface Env { ua?: string; modules?: boolean; supports?: ((type: string) => boolean) | null; randomUuid?: boolean; secure?: boolean }

/** A window and document as some browser would offer them, and the script already run against them. */
function run(env: Env = {}) {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const timers: (() => void)[] = [];
  const listen = (type: string, fn: (event: unknown) => void) => { (listeners[type] ??= []).push(fn); };
  const body = node('body');
  const app = node('div');
  app.id = 'app';
  body.appendChild(app);

  function HTMLScriptElement() { /* only its prototype and statics are read */ }
  if (env.modules !== false) HTMLScriptElement.prototype.noModule = false;
  if (env.supports !== null) HTMLScriptElement.supports = env.supports ?? ((type: string) => type === 'importmap');

  const window: Record<string, unknown> = {
    navigator: { userAgent: env.ua ?? UA_MODERN },
    HTMLScriptElement,
    isSecureContext: env.secure ?? true,
    crypto: env.randomUuid === false ? {} : { randomUUID: () => 'id' },
    addEventListener: listen,
    setTimeout: (fn: () => void) => timers.push(fn),
    location: { reload() { /* not followed here */ } },
  };
  const document = {
    readyState: 'loading',
    body,
    addEventListener: listen,
    createElement: (tag: string) => node(tag),
    createTextNode: (text: string) => node('#text', text),
    getElementById: (id: string) => find(body, id),
  };
  // The script closes with `})(window, document);` - handing those two in is all it takes to run it here.
  new Function('window', 'document', source)(window, document);

  const fire = (type: string, event: unknown = {}) => (listeners[type] ?? []).forEach((fn) => fn(event));
  return {
    api: window.zollifyStartCheck as {
      mounted(): void;
      minChrome: number;
      parseBrowser(ua: string): { name: string; version: number | null; android: string | null };
      findProblems(win: unknown): string[];
    },
    window,
    app,
    fire,
    /** The page from parsed to loaded, and the grace period after it run out. */
    finishLoading() { fire('DOMContentLoaded'); fire('load'); timers.splice(0).forEach((fn) => fn()); },
    notice: () => { const el = find(body, 'zollify-start-notice'); return el ? textOf(el) : null; },
  };
}

describe('webview start check', () => {
  it('is ES5, so the WebViews it is written for can parse it', () => {
    // esbuild refuses to turn const, let, classes or arrows into ES5 - it throws if any crept in.
    expect(() => transformSync(source, { target: 'es5' })).not.toThrow();
    expect(code).not.toMatch(/`/);
  });

  it('never uses eval or new Function, which the server CSP would block', () => {
    expect(code).not.toMatch(/\beval\(|new Function\(/);
  });

  it('reads the browser from the user agent', () => {
    const { api } = run();
    expect(api.parseBrowser(UA_CARBON)).toEqual({ name: 'Android System WebView', version: 69, android: '9' });
    expect(api.parseBrowser(UA_MODERN)).toEqual({ name: 'Chrome', version: 126, android: '14' });
    expect(api.parseBrowser('Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/128.0')).toEqual({ name: 'This browser', version: null, android: null });
  });

  it('finds nothing wrong on a modern browser and shows nothing once the app mounts', () => {
    const page = run();
    expect(page.api.findProblems(page.window)).toEqual([]);
    page.api.mounted();
    page.finishLoading();
    expect(page.notice()).toBeNull();
  });

  it('names the WebView and what to do when import maps are missing', () => {
    const page = run({ ua: UA_CARBON, supports: null, randomUuid: false });
    expect(page.api.findProblems(page.window)).toEqual(['import maps', 'crypto.randomUUID']);
    page.finishLoading();
    expect(page.notice()).toContain('Zollify cannot run on this device yet');
    expect(page.notice()).toContain(`Found: Android System WebView 69 on Android 9. Needed: version ${page.api.minChrome} or newer.`);
    expect(page.notice()).toContain('Play Store');
    expect(page.notice()).toContain('Missing: import maps, crypto.randomUUID');
  });

  it('believes the browser over its version when it can say whether it has import maps', () => {
    const page = run({ supports: () => false });
    expect(page.api.findProblems(page.window)).toEqual(['import maps']);
  });

  it('goes by version for Chrome 89 to 95, which have import maps but cannot say so', () => {
    const old = run({ ua: uaChrome(88), supports: null });
    const fine = run({ ua: uaChrome(92), supports: null });
    expect(old.api.findProblems(old.window)).toEqual(['import maps']);
    expect(fine.api.findProblems(fine.window)).toEqual([]);
  });

  it('reports a browser without module scripts', () => {
    const page = run({ ua: UA_CARBON, modules: false, supports: null, randomUuid: false });
    expect(page.api.findProblems(page.window)).toEqual(['JavaScript modules', 'import maps', 'crypto.randomUUID']);
  });

  it('does not call a plain-http page an old browser', () => {
    // crypto.randomUUID is missing there on every browser; that is a set-up problem with its own symptoms.
    const page = run({ secure: false, randomUuid: false });
    expect(page.api.findProblems(page.window)).toEqual([]);
  });

  it('says the app did not start, with the first error, when the page loaded and nothing mounted', () => {
    const page = run();
    page.fire('error', { message: 'Uncaught SyntaxError: Unexpected token' });
    page.fire('error', { message: 'a later error' });
    page.finishLoading();
    expect(page.notice()).toContain('Zollify did not start');
    expect(page.notice()).toContain('Chrome 126 on Android 14 - Uncaught SyntaxError: Unexpected token');
    expect(page.notice()).toContain('Try again');
  });

  it('names the file when a script failed to load', () => {
    const page = run();
    page.fire('error', { target: { src: 'http://localhost/assets/index-abc.js' } });
    page.finishLoading();
    expect(page.notice()).toContain('Could not load http://localhost/assets/index-abc.js');
  });

  it('stays quiet while the page is still loading, however long that takes', () => {
    const page = run();
    page.fire('DOMContentLoaded');
    expect(page.notice()).toBeNull();
  });

  it('counts content in #app as mounted, for a build that does not call mounted()', () => {
    const page = run();
    page.app.appendChild(node('div'));
    page.finishLoading();
    expect(page.notice()).toBeNull();
  });

  it('takes the "did not start" notice back if the app mounts after all', () => {
    const page = run();
    page.finishLoading();
    expect(page.notice()).toContain('Zollify did not start');
    page.api.mounted();
    expect(page.notice()).toBeNull();
  });
});
