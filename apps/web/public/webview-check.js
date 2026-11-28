/*
 * Start check - makes sure a device that cannot run Zollify says so instead of
 * showing a blank white screen.
 *
 * The app itself is ES modules built for a recent browser. A WebView that is
 * too old stops at the first thing it does not understand and shows nothing,
 * which at an event is a dead till with no explanation. This file runs before
 * the app and has to work exactly where the app does not, so:
 *
 *  - it is a classic script in ES5 syntax, with no dependencies and no build
 *    step (Vite copies public/ as it is);
 *  - it is a file rather than inline in index.html, and probes without
 *    eval / new Function: the server's Content-Security-Policy (server-core
 *    app.ts) allows scripts from 'self' but no inline script and no eval, so
 *    either would be blocked there - silently for the inline script, and as a
 *    false "too old" on every browser for an eval probe;
 *  - it builds the notice with DOM calls and element styles only.
 *
 * Two cases are covered: the browser lacks something the app needs (known
 * before the app runs), and the browser looked fine but the app never mounted
 * (known once the page has finished loading - see watchForMount).
 */
(function (window, document) {
  'use strict';

  /**
   * The oldest Chrome / Android System WebView the app runs on. Only shown in
   * the notice - what decides is the feature checks below. What sets it:
   * crypto.randomUUID (Chrome 92), used for every sale's id; import maps
   * (Chrome 89) and the build's syntax (logical assignment, Chrome 85) are
   * below it. Keep it the same as `build.target` in apps/web/vite.config.ts
   * and scripts/module-vite.mjs.
   */
  var MIN_CHROME = 92;

  /**
   * How long after the page's load event the app may still be unmounted. The
   * app mounts synchronously while its entry module runs (main.ts mounts
   * before boot), and the load event waits for that module - so by then a
   * healthy device has mounted however slow it or its network is, and this is
   * only slack, not a guess at how long a start takes.
   */
  var MOUNT_GRACE_MS = 5000;

  var NOTICE_ID = 'zollify-start-notice';

  var mounted = false;
  var firstError = '';
  var shownKind = '';

  /** Who is running the page, read from the user agent: name, major version, Android version. */
  function parseBrowser(userAgent) {
    var ua = String(userAgent || '');
    var chrome = /(?:Chrome|CriOS)\/(\d+)/.exec(ua);
    var android = /Android (\d+(?:\.\d+)?)/.exec(ua);
    var isWebView = /; wv\)/.test(ua);
    return {
      name: isWebView ? 'Android System WebView' : chrome ? 'Chrome' : 'This browser',
      version: chrome ? parseInt(chrome[1], 10) : null,
      android: android ? android[1] : null,
    };
  }

  /** Module scripts: without them the app's entry is never even fetched. */
  function supportsModules(win) {
    var script = win.HTMLScriptElement;
    return !!script && !!script.prototype && 'noModule' in script.prototype;
  }

  /**
   * Import maps resolve what runtime modules import from the shell. Browsers
   * answer this directly from Chrome 96; Chrome 89 to 95 have import maps but
   * not the question, so there the version has to stand in for it.
   */
  function supportsImportMaps(win, browser) {
    var script = win.HTMLScriptElement;
    if (script && typeof script.supports === 'function') return !!script.supports('importmap');
    return browser.version !== null && browser.version >= 89;
  }

  /**
   * crypto.randomUUID names every sale, device and outbox entry. It also only
   * exists on a secure origin, whatever the browser's age - a page opened over
   * plain http on a LAN address is a set-up problem, not an old WebView, and
   * is not this notice's to report.
   */
  function supportsRandomUuid(win) {
    if (win.isSecureContext === false) return true;
    return !!win.crypto && typeof win.crypto.randomUUID === 'function';
  }

  /** What the app needs that this browser does not have, in plain names. Empty means it can run. */
  function findProblems(win) {
    var browser = parseBrowser(win.navigator && win.navigator.userAgent);
    var problems = [];
    if (!supportsModules(win)) problems.push('JavaScript modules');
    if (!supportsImportMaps(win, browser)) problems.push('import maps');
    if (!supportsRandomUuid(win)) problems.push('crypto.randomUUID');
    return problems;
  }

  /** "Android System WebView 69 on Android 9" - as much of it as the user agent gave. */
  function browserLabel(browser) {
    var label = browser.name;
    if (browser.version !== null) label += ' ' + browser.version;
    if (browser.android) label += ' on Android ' + browser.android;
    return label;
  }

  /** The words of the notice for a browser that is too old. */
  function describeUnsupported(problems, browser) {
    var steps = browser.android
      ? [
          'Open the Play Store, update "Android System WebView" and "Chrome", then open Zollify again.',
          'No Play Store on this device? Then it cannot be updated this way. Please contact Zollify support, and use another device in the meantime.',
        ]
      : ['Update this browser, or open Zollify in a current Chrome, Edge, Firefox or Safari.'];
    return {
      kind: 'unsupported',
      title: 'Zollify cannot run on this device yet',
      text: [
        'The browser built into this device is too old for this version of Zollify.',
        'Found: ' + browserLabel(browser) + '. Needed: version ' + MIN_CHROME + ' or newer.',
      ],
      steps: steps,
      detail: 'Missing: ' + problems.join(', '),
      retry: false,
    };
  }

  /** The words of the notice for an app that should have started and did not. */
  function describeNotStarted(browser, error) {
    return {
      kind: 'not-started',
      title: 'Zollify did not start',
      text: [
        'The app could not load on this device. Anything already saved on this device is still there.',
      ],
      steps: [
        'Try again with the button below, or close Zollify and open it again.',
        'If it keeps happening, please contact Zollify support and pass on the details below.',
      ],
      detail: browserLabel(browser) + (error ? ' - ' + error : ' - no error was reported'),
      retry: true,
    };
  }

  function element(tag, text, css) {
    var el = document.createElement(tag);
    if (text) el.appendChild(document.createTextNode(text));
    if (css) el.style.cssText = css;
    return el;
  }

  function retryButton() {
    var button = element('button', 'Try again', 'margin:0 0 1.25rem;padding:.7rem 1.4rem;font:inherit;font-weight:600;color:#0f172a;background:#e2e8f0;border:0;border-radius:8px;');
    button.type = 'button';
    button.onclick = function () { window.location.reload(); };
    return button;
  }

  /** Puts the notice over the whole page. Text nodes only, so nothing in it is ever parsed as markup. */
  function showNotice(notice) {
    removeNotice();
    var i;
    // Longhand top/right/bottom/left and no flex gap: this has to lay out on the oldest WebView there is.
    var box = element('div', '', 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;overflow:auto;box-sizing:border-box;padding:2rem 1.25rem;background:#0f172a;color:#e2e8f0;font:16px/1.5 system-ui,-apple-system,Roboto,"Segoe UI",sans-serif;');
    var inner = element('div', '', 'max-width:34rem;margin:0 auto;');
    box.id = NOTICE_ID;
    box.setAttribute('role', 'alert');
    inner.appendChild(element('h1', notice.title, 'margin:0 0 1rem;font-size:1.4rem;line-height:1.25;color:#fff;'));
    for (i = 0; i < notice.text.length; i++) inner.appendChild(element('p', notice.text[i], 'margin:0 0 .75rem;'));
    inner.appendChild(element('h2', 'What to do', 'margin:1.25rem 0 .5rem;font-size:1rem;color:#fff;'));
    var list = element('ol', '', 'margin:0 0 1.25rem;padding-left:1.25rem;');
    for (i = 0; i < notice.steps.length; i++) list.appendChild(element('li', notice.steps[i], 'margin:0 0 .5rem;'));
    inner.appendChild(list);
    if (notice.retry) inner.appendChild(retryButton());
    inner.appendChild(element('p', notice.detail, 'margin:0;font-size:.8rem;color:#94a3b8;word-break:break-word;'));
    box.appendChild(inner);
    document.body.appendChild(box);
    shownKind = notice.kind;
  }

  function removeNotice() {
    var old = document.getElementById(NOTICE_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    shownKind = '';
  }

  /** A failed script or stylesheet has no message of its own - name the file instead. */
  function errorText(event) {
    var target = event && event.target;
    var url = target && target !== window && (target.src || target.href);
    if (url) return 'Could not load ' + url;
    var reason = event && event.reason;
    if (reason) return String(reason.message || reason);
    return String((event && event.message) || '');
  }

  /**
   * Remembers the first error before the app mounts: it is the cause, and what
   * follows it is usually fallout. Errors after mounting are the app's own
   * diagnostics' business, not this file's.
   */
  function rememberError(event) {
    if (mounted || firstError) return;
    firstError = errorText(event).slice(0, 300);
  }

  /** main.ts says so explicitly; content inside #app covers a build that predates that call. */
  function hasMounted() {
    var app = document.getElementById('app');
    return mounted || (!!app && !!app.firstChild);
  }

  function reportIfNotMounted() {
    if (hasMounted() || shownKind) return;
    showNotice(describeNotStarted(parseBrowser(window.navigator.userAgent), firstError));
  }

  /**
   * Catches a browser that passed the checks and still never started the app:
   * a chunk that failed to load, syntax this file did not think to test, an
   * error before mounting. Waits for the load event rather than running a
   * timer from the start, so a slow device or network is never mistaken for a
   * broken one - see MOUNT_GRACE_MS.
   */
  function watchForMount() {
    // Capturing, because a script or stylesheet that fails to load reports on its own element and does not bubble.
    window.addEventListener('error', rememberError, true);
    window.addEventListener('unhandledrejection', rememberError);
    window.addEventListener('load', function () {
      window.setTimeout(reportIfNotMounted, MOUNT_GRACE_MS);
    });
  }

  function reportIfUnsupported() {
    var problems = findProblems(window);
    if (problems.length) showNotice(describeUnsupported(problems, parseBrowser(window.navigator.userAgent)));
  }

  /** Called by main.ts once the app is on screen. Takes back a "did not start" notice, should one ever be up. */
  function markMounted() {
    mounted = true;
    if (shownKind === 'not-started') removeNotice();
  }

  window.zollifyStartCheck = {
    mounted: markMounted,
    // The rest is exposed for the tests (apps/web/src/__tests__/webview-check.test.ts).
    minChrome: MIN_CHROME,
    parseBrowser: parseBrowser,
    findProblems: findProblems,
    describeUnsupported: describeUnsupported,
    describeNotStarted: describeNotStarted,
  };

  watchForMount();
  // The notice goes into <body>, which does not exist yet while this runs from <head>.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportIfUnsupported);
  else reportIfUnsupported();
})(window, document);
