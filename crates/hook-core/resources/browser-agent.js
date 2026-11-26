// Hook Browser: the helpers `run_js` gives an agent.
//
// One file. It is embedded into `hook-core` with `include_str!`, prepended to
// every `run_js` expression, and installed into the page as `globalThis.__hook`
// on first use. The point is that a model writes three lines against a
// documented object instead of rebuilding a DOM recipe every turn — and that
// the recipes live here, where they can be read, reviewed and changed without
// a Chromium rebuild.
//
// Nothing here is *trusted* input: `el.click()` dispatches an untrusted event,
// and a page that checks `event.isTrusted` will ignore it. The trusted path is
// `browser_cdp` with `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, and
// the tool description says so.
//
// Refs: `snapshot()` numbers the interactive elements it found (`e1`, `e2`, …)
// and keeps the mapping here, so `click('e3')` in the *next* call finds the
// same element. A ref belongs to one document: after a navigation it is gone and
// a fresh `snapshot()` is the answer.

(function () {
  'use strict';

  var VERSION = 1;
  var MAX_ELEMENTS = 200;
  var MAX_NAME = 120;
  var MAX_HITS = 20;
  var MAX_ERRORS = 20;

  // 'e12' -> Element, and Element -> 12. Both, so a snapshot keeps refs stable
  // across calls and a row can name the element it describes.
  var refs = new Map();
  var numbers = new WeakMap();
  var nextRef = 1;
  var errors = [];

  var INTERACTIVE =
    'a[href],button,input,select,textarea,summary,[role],[onclick],' +
    '[contenteditable=""],[contenteditable="true"],' +
    '[tabindex]:not([tabindex="-1"])';

  function number(el) {
    var known = numbers.get(el);
    if (known) return known;
    var n = nextRef++;
    numbers.set(el, n);
    refs.set('e' + n, el);
    return n;
  }

  function refOf(el) {
    return el ? 'e' + number(el) : null;
  }

  // A ref, a CSS selector, an Element, or nothing. A string that looks like a
  // ref is tried as one first; a page is allowed to have `#e3` as well.
  function resolve(target) {
    if (target === null || target === undefined || target === '') return null;
    if (typeof target !== 'string') return target;
    if (refs.has(target)) return refs.get(target);
    try {
      return document.querySelector(target);
    } catch (error) {
      return null;
    }
  }

  function visible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return false;
    var style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (style.opacity === '0') return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  function clean(text, limit) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit);
  }

  function nameOf(el) {
    var label = el.getAttribute('aria-label') || el.getAttribute('alt') ||
      el.getAttribute('title');
    if (!label && el.labels && el.labels.length) label = el.labels[0].innerText;
    if (!label && el.innerText) label = el.innerText;
    if (!label && el.value !== null && el.value !== undefined) {
      label = String(el.value);
    }
    if (!label) label = el.getAttribute('placeholder') || el.getAttribute('name');
    return clean(label, MAX_NAME);
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SUMMARY') return 'summary';
    if (tag === 'INPUT') {
      var type = (el.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'checkbox' || type === 'radio') return 'checkbox';
      return 'textbox';
    }
    return tag.toLowerCase();
  }

  function scrollState() {
    var document_height = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    var max = Math.max(0, Math.round(document_height - innerHeight));
    return { y: Math.round(scrollY), max: max, at_bottom: Math.round(scrollY) >= max - 2 };
  }

  function viewport() {
    return {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio || 1
    };
  }

  // What an agent needs to decide what to do next on a page it has not seen:
  // the interactive elements, in reading order, with a stable ref each.
  function snapshot(options) {
    options = options || {};
    var limit = Math.min(options.limit || 120, MAX_ELEMENTS);
    var nodes = document.querySelectorAll(options.selector || INTERACTIVE);
    var elements = [];
    var seen = new Set();
    for (var i = 0; i < nodes.length && elements.length < limit; i++) {
      var el = nodes[i];
      if (seen.has(el) || !visible(el)) continue;
      seen.add(el);
      var row = {
        ref: refOf(el),
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        name: nameOf(el)
      };
      if (el.tagName === 'A' && el.href) row.href = el.href;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        var type = (el.type || el.tagName).toLowerCase();
        row.input = type;
        if (el.disabled) row.disabled = true;
        if (el.name) row.field = el.name;
        if (type === 'checkbox' || type === 'radio') row.checked = !!el.checked;
        else if (el.value) row.value = clean(el.value, 120);
        if (el.tagName === 'SELECT') {
          row.options = Array.prototype.slice.call(el.options, 0, 30).map(function (option) {
            return clean(option.text, 80);
          });
        }
      }
      elements.push(row);
    }
    return {
      url: location.href,
      title: document.title,
      ready: document.readyState,
      scroll: scrollState(),
      viewport: viewport(),
      elements: elements,
      count: elements.length
    };
  }

  // Where the words are, with the element that holds them — the thing a
  // character offset cannot say.
  function find(needle, options) {
    options = options || {};
    var pattern;
    if (needle instanceof RegExp) {
      pattern = needle;
    } else if (options.regex) {
      pattern = new RegExp(String(needle), 'i');
    } else {
      var escaped = String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = new RegExp(escaped, 'i');
    }
    var limit = options.limit || 10;
    var hits = [];
    var root = document.body || document.documentElement;
    if (!root) return { query: String(needle), hits: hits, count: 0 };
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode()) && hits.length < Math.min(limit, MAX_HITS)) {
      var text = node.nodeValue;
      if (!text || !pattern.test(text)) continue;
      var parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,template')) continue;
      hits.push({
        ref: visible(parent) ? refOf(parent) : null,
        tag: parent.tagName.toLowerCase(),
        text: clean(text, 200),
        context: clean(parent.innerText, 300)
      });
    }
    return { query: String(needle), hits: hits, count: hits.length };
  }

  function text(target) {
    var el = target === undefined || target === null ? document.body : resolve(target);
    if (!el) return '';
    var body = el.innerText || el.textContent || '';
    return String(body).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function scrollIntoView(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (error) {
      el.scrollIntoView();
    }
  }

  function click(target, options) {
    options = options || {};
    var el = resolve(target);
    if (!el) {
      throw new Error('Nothing on the page matches ' + JSON.stringify(String(target)) + '.');
    }
    scrollIntoView(el);
    if (el.focus) {
      try {
        el.focus({ preventScroll: true });
      } catch (error) {
        el.focus();
      }
    }
    if (options.double) {
      el.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, view: window
      }));
    } else {
      el.click();
    }
    return {
      ok: true,
      ref: refOf(el),
      tag: el.tagName.toLowerCase(),
      name: nameOf(el),
      trusted: false
    };
  }

  // A value a framework actually notices: the native setter, then the events
  // React and Vue listen for. `el.value = x` alone leaves half the web unchanged.
  function setValue(el, value) {
    var tag = el.tagName;
    if (tag === 'SELECT') {
      el.value = value;
      return;
    }
    var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
  }

  function type(target, value, options) {
    options = options || {};
    var el = resolve(target);
    if (!el) {
      throw new Error('Nothing on the page matches ' + JSON.stringify(String(target)) + '.');
    }
    scrollIntoView(el);
    if (el.focus) {
      try {
        el.focus({ preventScroll: true });
      } catch (error) {
        el.focus();
      }
    }
    var text = value === null || value === undefined ? '' : String(value);
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, data: text, inputType: 'insertText'
      }));
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      setValue(el, text);
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, data: text, inputType: 'insertText'
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var value_now = el.value !== undefined && el.value !== null ? el.value : el.textContent;
    return { ok: true, ref: refOf(el), value: String(value_now) };
  }

  var KEY_CODES = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32
  };

  // Untrusted keys do not type text, but they do drive the handlers pages
  // install (`keydown` for Enter, Escape to close a dialog), which is what an
  // agent reaching for this wants.
  function press(key, options) {
    options = options || {};
    var el = resolve(options.on) || document.activeElement || document.body;
    if (!el) throw new Error('There is nothing on the page to send a key to.');
    var init = { key: key, bubbles: true, cancelable: true, composed: true };
    init.code = key;
    if (KEY_CODES[key] !== undefined) {
      init.keyCode = KEY_CODES[key];
      init.which = KEY_CODES[key];
    }
    if (options.ctrl) init.ctrlKey = true;
    if (options.shift) init.shiftKey = true;
    if (options.alt) init.altKey = true;
    if (options.meta) init.metaKey = true;
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    // Enter in a field is a form submit for most people, and a synthetic key
    // event never does it.
    if (key === 'Enter' && options.submit !== false && el.form) {
      try {
        el.form.requestSubmit();
      } catch (error) {
        el.form.submit();
      }
    }
    return { ok: true, key: key, trusted: false };
  }

  function scroll(options) {
    if (typeof options === 'number') options = { by: options };
    options = options || {};
    if (options.to === 'bottom') {
      window.scrollTo(0, document.documentElement.scrollHeight);
    } else if (options.to === 'top') {
      window.scrollTo(0, 0);
    } else if (options.target || options.ref || options.selector) {
      var el = resolve(options.target || options.ref || options.selector);
      if (el) scrollIntoView(el);
    } else if (typeof options.by === 'number') {
      window.scrollBy(0, options.by);
    } else if (typeof options.y === 'number') {
      window.scrollTo(0, options.y);
    } else {
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
    return scrollState();
  }

  // Waits inside the page, which is one round trip instead of the host polling.
  // A navigation ends it, because the document it runs in is gone.
  async function waitFor(what, options) {
    options = options || {};
    var timeout = options.timeout_ms || options.timeout || 10000;
    var started = Date.now();
    var check;
    if (typeof what === 'function') {
      check = what;
    } else {
      var value = String(what);
      if (/^(sel|css):/.test(value)) {
        var selector = value.replace(/^(sel|css):/, '');
        check = function () { return !!document.querySelector(selector); };
      } else if (/^(url|href):/.test(value)) {
        var fragment = value.replace(/^(url|href):/, '');
        check = function () { return location.href.indexOf(fragment) !== -1; };
      } else {
        check = function () {
          return (document.body ? document.body.innerText : '').indexOf(value) !== -1;
        };
      }
    }
    while (Date.now() - started < timeout) {
      var matched = false;
      try {
        matched = !!check();
      } catch (error) {
        matched = false;
      }
      if (matched) {
        return { ok: true, waited_ms: Date.now() - started, url: location.href };
      }
      await new Promise(function (done) { setTimeout(done, 100); });
    }
    throw new Error(
      'Waited ' + timeout + 'ms for ' + JSON.stringify(String(what)) +
      ' and it never appeared. The page is at ' + location.href + '.'
    );
  }

  function state() {
    var active = document.activeElement;
    return {
      url: location.href,
      title: document.title,
      ready: document.readyState,
      scroll: scrollState(),
      viewport: viewport(),
      focused: active
        ? { tag: active.tagName.toLowerCase(), name: nameOf(active), ref: visible(active) ? refOf(active) : null }
        : null
    };
  }

  // A cross-origin frame cannot be looked into; saying so is better than an
  // exception that reads like a bug in the tool.
  function frames() {
    var out = [];
    for (var i = 0; i < window.frames.length; i++) {
      var frame = window.frames[i];
      var row = { index: i, name: '' };
      try {
        row.url = frame.location.href;
        row.name = frame.name || '';
      } catch (error) {
        row.crossOrigin = true;
      }
      out.push(row);
    }
    return out;
  }

  function remember(kind, message) {
    errors.push({ kind: kind, message: clean(message, 400), at: Date.now() });
    if (errors.length > MAX_ERRORS) errors.shift();
  }

  try {
    addEventListener('error', function (event) {
      remember('error', event && event.message ? event.message : 'A script on the page failed.');
    });
    addEventListener('unhandledrejection', function (event) {
      var reason = event ? event.reason : '';
      remember('rejection', reason && reason.message ? reason.message : reason);
    });
  } catch (error) {
    // A page that will not take a listener still gets the helpers.
  }

  globalThis.__hook = {
    // Keep this line in step with RUNTIME_VERSION in `browser.rs`; the test
    // there fails when the two drift apart.
    version: 1,
    snapshot: snapshot,
    find: find,
    text: text,
    click: click,
    type: type,
    press: press,
    scroll: scroll,
    waitFor: waitFor,
    state: state,
    frames: frames,
    errors: function () { return errors.slice(); },
    resolve: resolve,
    ref: refOf,
    sleep: function (ms) {
      return new Promise(function (done) {
        setTimeout(done, Math.min(Number(ms) || 0, 30000));
      });
    }
  };
})();
