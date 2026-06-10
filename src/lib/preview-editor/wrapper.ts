/**
 * Botflow visual editor — sandbox injection.
 *
 * We build the `.botflow-vite.config.mjs` wrapper that the dev server runs with
 * `--config`. On top of the existing `server.allowedHosts` overlay it adds, in
 * dev (`command === "serve"`) only, a single self-contained Vite plugin that:
 *
 *   1. transform (enforce: "pre"): stamps every host JSX element with
 *      `data-bf-loc="<relpath>:<line>:<col>"` + `data-bf-id` via Babel, so the
 *      preview DOM carries an exact source pointer. Runs before
 *      @vitejs/plugin-react compiles the JSX away. JSX/TS are preserved.
 *
 *   2. transformIndexHtml: injects the dormant in-iframe runtime (below) which
 *      does hover/click selection and posts selection data to the parent IDE.
 *
 * Babel never has to be installed in the sandbox on our behalf: we reuse the
 * `@babel/core` that ships as a dependency of `@vitejs/plugin-react`, resolving
 * it defensively. If it can't be found, stamping is skipped (graceful degrade)
 * and the editor simply has nothing to select.
 *
 * The AST *write-back* runs server-side in our own API route, never here.
 */

/**
 * In-iframe runtime. Plain ES5-ish JS, kept free of backticks and `${` so it
 * can live inside a template literal and be JSON-encoded into the config.
 * Dormant until the parent posts BF_EDITOR_ENABLE.
 */
const EDITOR_RUNTIME = `
(function () {
  if (typeof window === "undefined") return;
  if (window.__bfEditorInstalled) return;
  if (window.parent === window) return; // only inside the IDE preview iframe
  window.__bfEditorInstalled = true;

  var enabled = false;
  var lastHover = null;
  var selectedEl = null;
  var rectRAF = 0;

  function post(msg) { try { window.parent.postMessage(msg, "*"); } catch (e) {} }
  function pick(el) { return el && el.closest ? el.closest("[data-bf-loc]") : null; }
  function findByLoc(loc) {
    if (!loc) return null;
    var all = document.querySelectorAll("[data-bf-loc]");
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute("data-bf-loc") === loc) return all[i];
    }
    return null;
  }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  function computedSubset(el) {
    var cs = window.getComputedStyle(el);
    var keys = ["color","backgroundColor","fontSize","fontWeight","lineHeight",
      "textAlign","paddingTop","paddingRight","paddingBottom","paddingLeft",
      "marginTop","marginRight","marginBottom","marginLeft","borderRadius",
      "display","width","height"];
    var out = {};
    for (var i = 0; i < keys.length; i++) out[keys[i]] = cs[keys[i]];
    return out;
  }
  function describe(el) {
    return {
      loc: el.getAttribute("data-bf-loc"),
      id: el.getAttribute("data-bf-id"),
      tag: el.tagName.toLowerCase(),
      className: el.getAttribute("class") || "",
      text: (el.textContent || "").slice(0, 200),
      computed: computedSubset(el),
      rect: rectOf(el)
    };
  }

  function onMove(e) {
    if (!enabled) return;
    var el = pick(e.target);
    if (!el) {
      if (lastHover) { lastHover = null; post({ type: "BF_EDITOR_HOVER", rect: null }); }
      return;
    }
    if (el === lastHover) return;
    lastHover = el;
    post({ type: "BF_EDITOR_HOVER", rect: rectOf(el), tag: el.tagName.toLowerCase(), loc: el.getAttribute("data-bf-loc") });
  }

  function onClick(e) {
    if (!enabled) return;
    var el = pick(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    selectedEl = el;
    post(Object.assign({ type: "BF_EDITOR_SELECTED" }, describe(el)));
  }

  function setEnabled(on) {
    enabled = on;
    if (document.body) document.body.style.cursor = on ? "crosshair" : "";
    if (!on) { lastHover = null; selectedEl = null; post({ type: "BF_EDITOR_HOVER", rect: null }); }
  }

  // Keep the parent's overlay aligned with the selected element while the page
  // scrolls or resizes (rAF-throttled).
  function postSelectedRect() {
    if (!enabled || !selectedEl || rectRAF) return;
    rectRAF = requestAnimationFrame(function () {
      rectRAF = 0;
      if (selectedEl && selectedEl.isConnected) {
        post({ type: "BF_EDITOR_RECT", loc: selectedEl.getAttribute("data-bf-loc"), rect: rectOf(selectedEl) });
      }
    });
  }

  // Serialize the *rendered* DOM into a static, self-contained-ish HTML string.
  // Used by the parent IDE to store a "last seen" snapshot of the app that it
  // can render (blurred) while the dev server is off. Scripts are stripped —
  // the snapshot must be static; Vite module scripts would point at a dead
  // origin. <style> tags survive the clone (Vite injects dev CSS inline), and
  // same-origin <img>s are inlined as data URLs since the origin won't be
  // reachable when the snapshot is shown.
  function buildSnapshotHtml() {
    var clone = document.documentElement.cloneNode(true);
    var i;
    var scripts = clone.querySelectorAll("script");
    for (i = 0; i < scripts.length; i++) {
      if (scripts[i].parentNode) scripts[i].parentNode.removeChild(scripts[i]);
    }
    var stamped = clone.querySelectorAll("[data-bf-loc]");
    for (i = 0; i < stamped.length; i++) {
      stamped[i].removeAttribute("data-bf-loc");
      stamped[i].removeAttribute("data-bf-id");
    }
    // Inline same-origin images (best effort, bounded). Live <img> elements and
    // their clones come back in the same document order, so we can pair them.
    var liveImgs = document.querySelectorAll("img");
    var cloneImgs = clone.querySelectorAll("img");
    var inlined = 0;
    for (i = 0; i < liveImgs.length && i < cloneImgs.length; i++) {
      if (inlined >= 30) break;
      var img = liveImgs[i];
      if (!img.complete || !img.naturalWidth) continue;
      var src = img.currentSrc || img.src || "";
      if (src.indexOf("data:") === 0) continue;
      try {
        var canvas = document.createElement("canvas");
        var w = Math.min(img.naturalWidth, 1280);
        var scale = w / img.naturalWidth;
        canvas.width = w;
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        cloneImgs[i].setAttribute("src", canvas.toDataURL("image/jpeg", 0.8));
        cloneImgs[i].removeAttribute("srcset");
        inlined++;
      } catch (err) { /* cross-origin taint — leave the original src */ }
    }
    var head = clone.querySelector("head");
    if (head) {
      var base = document.createElement("base");
      base.setAttribute("href", window.location.origin + "/");
      head.insertBefore(base, head.firstChild);
    }
    return "<!DOCTYPE html>" + String.fromCharCode(10) + clone.outerHTML;
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "BF_EDITOR_ENABLE") setEnabled(true);
    else if (d.type === "BF_EDITOR_DISABLE") setEnabled(false);
    else if (d.type === "BF_SNAPSHOT_REQUEST") {
      var html = null;
      try { html = buildSnapshotHtml(); } catch (err) {}
      post({ type: "BF_SNAPSHOT_RESULT", id: d.id || null, html: html });
    }
    else if (d.type === "BF_EDITOR_PREVIEW") {
      var t = findByLoc(d.loc);
      if (t) {
        if (typeof d.className === "string") t.setAttribute("class", d.className);
        if (d.style && typeof d.style === "object") {
          for (var k in d.style) { try { t.style[k] = d.style[k]; } catch (e2) {} }
        }
      }
    } else if (d.type === "BF_EDITOR_RESELECT") {
      var r = findByLoc(d.loc);
      if (r) { selectedEl = r; post(Object.assign({ type: "BF_EDITOR_SELECTED" }, describe(r))); }
    }
  });

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  window.addEventListener("scroll", postSelectedRect, true);
  window.addEventListener("resize", postSelectedRect, true);

  post({ type: "BF_EDITOR_READY" });
})();
`;

/**
 * Returns the full contents of `.botflow-vite.config.mjs`.
 * Mirrors the previous inline WRAPPER_CONFIG, plus the editor plugin in dev.
 */
export function buildBotflowViteConfig(): string {
  return `import { defineConfig, mergeConfig, loadConfigFromFile } from "vite";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EDITOR_RUNTIME = ${JSON.stringify(EDITOR_RUNTIME)};

// Reuse the @babel/core that @vitejs/plugin-react depends on (pnpm keeps it
// out of the project root, so a bare require usually misses it).
function loadBabel() {
  try { return require("@babel/core"); } catch (e) {}
  try {
    const pr = require.resolve("@vitejs/plugin-react");
    return createRequire(pr)("@babel/core");
  } catch (e) {}
  try {
    const pr = require.resolve("@vitejs/plugin-react-swc");
    return createRequire(pr)("@babel/core");
  } catch (e) {}
  return null;
}

// First host-element line in a source string (or null). Used to detect the
// line offset between Vite's transform input (which has a prepended HMR/refresh
// preamble) and the pristine on-disk file the write-back reads.
function firstHostLine(babel, src) {
  const t = babel.types;
  let line = null;
  try {
    const ast = babel.parse(src, {
      babelrc: false, configFile: false,
      parserOpts: { plugins: ["jsx", "typescript"] },
    });
    babel.traverse(ast, {
      JSXOpeningElement(p) {
        if (line !== null) return;
        const n = p.node;
        if (t.isJSXIdentifier(n.name) && /^[a-z]/.test(n.name.name) && n.loc) {
          line = n.loc.start.line;
        }
      },
    });
  } catch (e) {}
  return line;
}

function bfStampPlugin(babel, root, originalSrc) {
  const t = babel.types;
  // The pristine on-disk first host line. The difference between the transform
  // input's first host line and this is the preamble offset to subtract, so the
  // stamped line numbers index into the on-disk file (what the API edits).
  const diskFirst = firstHostLine(babel, originalSrc);
  let offset = 0;
  let offsetSet = false;
  return {
    name: "bf-stamp",
    visitor: {
      JSXOpeningElement(p, state) {
        const nameNode = p.node.name;
        if (!t.isJSXIdentifier(nameNode)) return;       // skip member/namespaced
        if (!/^[a-z]/.test(nameNode.name)) return;       // host elements only
        const has = p.node.attributes.some(
          (a) => t.isJSXAttribute(a) && a.name && a.name.name === "data-bf-loc"
        );
        if (has) return;
        const loc = p.node.loc;
        if (!loc) return;
        if (!offsetSet) {
          // First host element visited (document order) lines up with diskFirst.
          if (diskFirst !== null) offset = loc.start.line - diskFirst;
          if (offset < 0) offset = 0;
          offsetSet = true;
        }
        const abs = (state.file && state.file.opts && state.file.opts.filename) || "";
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const line = loc.start.line - offset; // columns are unaffected by a top preamble
        const col = loc.start.column + 1;
        p.node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier("data-bf-loc"), t.stringLiteral(rel + ":" + line + ":" + col)),
          t.jsxAttribute(t.jsxIdentifier("data-bf-id"), t.stringLiteral(path.basename(rel) + "_" + line + "_" + col))
        );
      }
    }
  };
}

function botflowEditorPlugin() {
  const babel = loadBabel();
  const root = process.cwd();
  if (!babel) {
    console.warn("[botflow] visual editor: @babel/core not found; source stamping disabled");
  }
  return {
    name: "botflow-visual-editor",
    enforce: "pre",
    transform(code, id) {
      if (!babel) return null;
      const clean = id.split("?")[0];
      if (!/\\.(tsx|jsx)$/.test(clean)) return null;
      if (clean.includes("/node_modules/")) return null;
      // Vite's transform input may carry a prepended HMR/refresh preamble, which
      // shifts line numbers. Read the pristine file so stamped lines index into
      // what the write-back API edits.
      let originalSrc = code;
      try { originalSrc = fs.readFileSync(clean, "utf8"); } catch (e) {}
      try {
        const result = babel.transformSync(code, {
          filename: clean,
          root,
          babelrc: false,
          configFile: false,
          sourceMaps: true,
          parserOpts: { plugins: ["jsx", "typescript"] },
          plugins: [bfStampPlugin(babel, root, originalSrc)]
        });
        if (!result || !result.code) return null;
        return { code: result.code, map: result.map };
      } catch (e) {
        console.warn("[botflow] stamp skipped for " + clean + ": " + (e && e.message));
        return null;
      }
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module" }, children: EDITOR_RUNTIME, injectTo: "body" }];
    }
  };
}

export default defineConfig(async ({ command, mode }) => {
  const candidates = ["vite.config.ts", "vite.config.js", "vite.config.mjs"];
  let userConfig = {};
  for (const file of candidates) {
    const abs = path.resolve(process.cwd(), file);
    try {
      const result = await loadConfigFromFile({ command, mode }, abs);
      if (result && result.config) { userConfig = result.config; break; }
    } catch (e) {
      console.warn("[botflow] Failed to load " + file + ":", (e && e.message) || e);
    }
  }
  const overlay = { server: { host: "0.0.0.0", allowedHosts: true } };
  if (command === "serve") {
    overlay.plugins = [botflowEditorPlugin()];
  }
  return mergeConfig(userConfig, overlay);
});
`;
}
