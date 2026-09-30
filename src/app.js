/* PolyFEM JSON Builder (web) - app.js
 * Spec engine (port of spec_engine.py) + tree-form renderer + file IO.
 * No frameworks; vanilla DOM. Spec lives in resolved-spec.json (bundled,
 * pre-resolved) and is re-resolved live from GitHub on every page load.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const POLYFEM_RAW = "https://raw.githubusercontent.com/polyfem/polyfem/main/json-specs/";
  const POLYSOLVE_RAW = "https://raw.githubusercontent.com/polyfem/polysolve/main/";
  const MAIN_SPEC = "input-spec.json";
  // Full set of json-specs files PolyFEM's input-spec.json (transitively)
  // includes, plus the two polysolve fragments it pulls in. Mirrors
  // spec_engine.py's POLYSOLVE_FILES + everything list_remote_spec_files()
  // would return at the time this page was built. The page re-fetches
  // exactly these files fresh on load; if PolyFEM adds a brand-new top-level
  // spec_file this list would need one more name added here.
  const POLYFEM_FILES = [
    "input-spec.json", "boundary-condition.json", "dirichlet-boundary-condition.json",
    "discr_order.json", "elastic-material-parameters.json", "interpolation.json",
    "log.json", "material-parameters.json", "objective-spec.json", "opt-input-spec.json",
    "polysolve.json", "selection.json", "time-integrator.json", "value-no.json",
    "value.json", "value0.json", "value1.json",
  ];
  const POLYSOLVE_FILES = ["linear-solver-spec.json", "nonlinear-solver-spec.json"];


  // ---------------------------------------------------------------------
  // Spec engine: pointer helpers
  // ---------------------------------------------------------------------
  function joinPointer(base, tail) {
    const baseParts = base && base !== "/" ? base.split("/").filter(Boolean) : [];
    const tailParts = tail.split("/").filter(Boolean);
    const all = baseParts.concat(tailParts);
    return all.length ? "/" + all.join("/") : "/";
  }

  function specPointerFor(dataPathParts) {
    const parts = dataPathParts.map(p => (/^\d+$/.test(String(p)) || p === "*") ? "*" : String(p));
    return parts.length ? "/" + parts.join("/") : "/";
  }

  // ---------------------------------------------------------------------
  // Spec engine: resolving includes into one flat node list, then indexing
  // ---------------------------------------------------------------------
  class SpecIndex {
    constructor() {
      this.byPointer = new Map(); // pointer -> [nodes] (include markers excluded)
    }
    variants(pointer) { return this.byPointer.get(pointer) || []; }
    get(pointer, typeName) {
      const vs = this.variants(pointer);
      if (!vs.length) return null;
      if (typeName == null) {
        for (const v of vs) if ("#type_name" in v) return v;
        return vs[0];
      }
      for (const v of vs) if (v.type_name === typeName || v["#type_name"] === typeName) return v;
      return vs[0];
    }
    variantNames(pointer) {
      const names = [];
      for (const v of this.variants(pointer)) {
        const n = v.type_name || v["#type_name"];
        if (n && !names.includes(n)) names.push(n);
      }
      return names;
    }
    defaultVariantName(pointer) {
      for (const v of this.variants(pointer)) if ("#type_name" in v) return v["#type_name"];
      return null;
    }
    isUnion(pointer) { return this.variantNames(pointer).length > 1; }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  // Resolve entry_file (an object: filename -> parsed JSON array) by
  // splicing `include` nodes' spec_file contents at their pointer.
  function resolveFromFiles(files, entryFile) {
    const out = [];
    function resolveInto(filename, basePointer, depth) {
      if (depth > 25) throw new Error("include recursion too deep: " + filename);
      const nodes = files[filename];
      if (!nodes) throw new Error("missing spec file: " + filename);
      for (const raw of nodes) {
        const node = JSON.parse(JSON.stringify(raw));
        node.pointer = joinPointer(basePointer, node.pointer);
        node._source_file = filename;
        if (node.type === "include") {
          out.push(node);
          resolveInto(node.spec_file, node.pointer, depth + 1);
        } else {
          out.push(node);
        }
      }
    }
    resolveInto(entryFile, "", 0);
    return out;
  }

  function buildIndexFromNodes(nodes) {
    const idx = new SpecIndex();
    for (const n of nodes) {
      if (n.type === "include") continue; // markers only needed during resolution
      if (!idx.byPointer.has(n.pointer)) idx.byPointer.set(n.pointer, []);
      idx.byPointer.get(n.pointer).push(n);
    }
    return idx;
  }

  // ---------------------------------------------------------------------
  // Default value construction (port of make_default_value)
  // ---------------------------------------------------------------------
  const TYPE_CHECK = {
    object: v => v !== null && typeof v === "object" && !Array.isArray(v),
    list: v => Array.isArray(v),
    string: v => typeof v === "string",
    float: v => typeof v === "number",
    int: v => typeof v === "number",
    bool: v => typeof v === "boolean",
    file: v => typeof v === "string",
  };

  function defaultMatchesType(node) {
    if (!("default" in node)) return false;
    const t = node.type;
    const check = TYPE_CHECK[t];
    if (!check) return true;
    return node.default === null || check(node.default);
  }

  function makeDefaultValue(idx, pointer, typeName, depth) {
    depth = depth || 0;
    if (depth > 12) return null;
    const node = idx.get(pointer, typeName);
    if (!node) return null;
    const t = node.type;
    if ("default" in node && defaultMatchesType(node)) {
      return JSON.parse(JSON.stringify(node.default));
    }
    if (t === "object") {
      const result = {};
      for (const key of (node.required || [])) {
        const childPtr = joinPointer(pointer, "/" + key);
        result[key] = makeDefaultValue(idx, childPtr, null, depth + 1);
      }
      return result;
    }
    if (t === "list") return [];
    if (t === "string") return (node.options && node.options.length) ? node.options[0] : "";
    if (t === "float") return 0.0;
    if (t === "int") return 0;
    if (t === "bool") return false;
    if (t === "file") return "";
    return null;
  }

  // ---------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------
  const state = {
    idx: null,
    document: { geometry: [], materials: [] },
    fileName: "untitled.json",
    dirty: false,
    fileHandle: null, // File System Access API handle, if supported+used
  };

  function markDirty() {
    state.dirty = true;
    updateTitleBar();
  }

  function updateTitleBar() {
    document.getElementById("current-file").textContent = state.fileName + (state.dirty ? " *" : "");
  }

  function setStatus(msg, isError) {
    const el = document.getElementById("status-bar");
    el.textContent = msg;
    el.classList.toggle("status-error", !!isError);
  }

  // ---------------------------------------------------------------------
  // Path-addressed get/set
  // ---------------------------------------------------------------------
  function getAt(root, path) {
    let node = root;
    for (const k of path) node = node[k];
    return node;
  }
  function deleteAt(root, path) {
    const parent = getAt(root, path.slice(0, -1));
    const key = path[path.length - 1];
    if (Array.isArray(parent)) parent.splice(key, 1);
    else delete parent[key];
  }

  // ---------------------------------------------------------------------
  // Loading the spec (bundled fallback, or live from GitHub)
  // ---------------------------------------------------------------------
  async function loadBundledSpec() {
    // Loaded from spec-data.js as a plain global (assigned via <script src>,
    // not fetch()) so this works when the page is opened directly from disk
    // via file:// - browsers block fetch() of local files under file://,
    // but a normal <script> tag loads fine there.
    const flat = window.__POLYFEM_BUNDLED_SPEC__;
    if (!flat) throw new Error("spec-data.js did not load (bundled spec unavailable)");
    const idx = new SpecIndex();
    for (const [ptr, nodes] of Object.entries(flat)) idx.byPointer.set(ptr, nodes);
    state.idx = idx;
  }

  async function updateSpecFromGitHub() {
    setStatus("Fetching latest spec from github.com/polyfem ...");
    try {
      const files = {};
      const jobs = [];
      for (const name of POLYFEM_FILES) {
        jobs.push(fetchJson(POLYFEM_RAW + name).then(j => { files[name] = j; }));
      }
      for (const name of POLYSOLVE_FILES) {
        jobs.push(fetchJson(POLYSOLVE_RAW + name).then(j => { files[name] = j; }));
      }
      await Promise.all(jobs);
      const nodes = resolveFromFiles(files, MAIN_SPEC);
      state.idx = buildIndexFromNodes(nodes);
      setStatus(`Spec updated from GitHub just now (${state.idx.byPointer.size} fields).`);
      rebuildForm();
    } catch (err) {
      console.error(err);
      setStatus("Spec update failed: " + err.message + " (kept previous spec). This can happen if GitHub is unreachable from your network.", true);
    }
  }

  // ---------------------------------------------------------------------
  // Form rendering
  // ---------------------------------------------------------------------
  const formRoot = () => document.getElementById("form-root");

  function el(tag, opts, children) {
    const e = document.createElement(tag);
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (v === null || v === undefined) continue; // omit the attribute entirely
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      }
    }
    (children || []).forEach(c => c && e.appendChild(c));
    return e;
  }

  function resolveNode(pointer, typeName) {
    return state.idx.get(pointer, typeName);
  }

  // Remembers which field sections the user has opened/closed, keyed by a
  // stable path string (e.g. "geometry.0.type"), so rebuildForm() (called
  // after nearly every edit, since it's a full re-render) doesn't reset
  // everyone's manually-expanded/collapsed sections back to defaults.
  // Persists for the life of the page; entries for paths that no longer
  // exist (item removed, etc.) are simply never looked up again.
  const fieldOpenState = new Map();

  function pathKey(path) {
    return path.join(".");
  }

  function snapshotOpenState() {
    const root = formRoot();
    root.querySelectorAll("details.field[data-path]").forEach(d => {
      fieldOpenState.set(d.getAttribute("data-path"), d.open);
    });
  }

  function rebuildForm(preserveOpenState = true) {
    const root = formRoot();
    if (preserveOpenState) snapshotOpenState();
    root.innerHTML = "";
    root.appendChild(renderObjectFields(state.document, []));
    refreshPreview();
  }

  function renderObjectFields(obj, path, typeName) {
    const pointer = specPointerFor(path);
    const node = resolveNode(pointer, typeName);
    const required = node ? (node.required || []) : [];
    const optional = node ? (node.optional || []) : [];
    const known = new Set([...required, ...optional]);

    // When this object is itself the active variant of a union (its own
    // pointer has multiple type_names, and a variant is selected), the
    // discriminator field ("type") is already driven by the Variant
    // dropdown one level up - don't also show it as a plain editable
    // field, that would be two controls fighting over the same value.
    const suppressDiscriminator = typeName != null && state.idx.isUnion(pointer);
    const visibleRequired = suppressDiscriminator ? required.filter(k => k !== "type") : required;
    const visibleOptional = suppressDiscriminator ? optional.filter(k => k !== "type") : optional;

    const wrap = el("div", { class: "obj-fields" });
    for (const key of visibleRequired) wrap.appendChild(renderField(obj, path, key, true));
    for (const key of visibleOptional) if (key in obj) wrap.appendChild(renderField(obj, path, key, false));

    const extraKeys = Object.keys(obj).filter(k => !known.has(k));
    if (extraKeys.length) {
      wrap.appendChild(el("div", { class: "unknown-banner", text: "Unrecognized keys (kept as-is, not in current spec):" }));
      for (const key of extraKeys) wrap.appendChild(renderRawField(obj, path, key));
    }

    const missing = visibleOptional.filter(k => !(k in obj));
    if (missing.length) {
      const row = el("div", { class: "add-optional-row" });
      const select = el("select", { class: "add-optional-select" },
        missing.map(k => el("option", { value: k, text: k })));
      const btn = el("button", {
        class: "btn btn-add", text: "+ Add field", onclick: () => {
          const key = select.value;
          const childPtr = joinPointer(pointer, "/" + key);
          const variant = state.idx.defaultVariantName(childPtr);
          obj[key] = makeDefaultValue(state.idx, childPtr, variant);
          markDirty();
          rebuildForm();
        }
      });
      row.appendChild(select);
      row.appendChild(btn);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderRawField(obj, path, key) {
    const row = el("div", { class: "field-row raw-row" });
    row.appendChild(el("span", { class: "raw-key", text: key }));
    const input = el("input", { type: "text", class: "raw-input", value: JSON.stringify(obj[key]) });
    input.addEventListener("change", () => {
      try {
        obj[key] = JSON.parse(input.value);
        markDirty();
        refreshPreview();
        input.classList.remove("input-invalid");
      } catch {
        input.classList.add("input-invalid");
      }
    });
    row.appendChild(input);
    row.appendChild(el("button", {
      class: "btn btn-remove", text: "Remove", onclick: () => {
        delete obj[key]; markDirty(); rebuildForm();
      }
    }));
    return row;
  }

  function renderField(obj, path, key, isRequired) {
    const fullPath = [...path, key];
    const pointer = specPointerFor(fullPath);
    const variantNames = state.idx.variantNames(pointer);
    const isUnion = variantNames.length > 1;

    let currentTypeName = null;
    if (isUnion) {
      const value = obj[key];
      if (value && typeof value === "object" && !Array.isArray(value) && "type" in value) {
        currentTypeName = value.type;
      } else {
        currentTypeName = state.idx.defaultVariantName(pointer);
      }
    }
    const node = resolveNode(pointer, currentTypeName);
    const doc = node ? (node.doc || "") : "";

    const key_ = pathKey(fullPath);
    const remembered = fieldOpenState.get(key_);
    const shouldBeOpen = remembered !== undefined ? remembered : isRequired;

    const details = el("details", {
      class: "field",
      "data-path": key_,
      open: shouldBeOpen ? "" : null,
    });
    const summary = el("summary", { class: "field-summary" }, [
      el("span", { class: "field-key", text: key }),
      isRequired ? el("span", { class: "req-star", text: " *" }) : null,
    ]);
    details.appendChild(summary);

    const body = el("div", { class: "field-body" });
    if (doc) body.appendChild(el("p", { class: "field-doc", text: doc }));

    try {
      if (isUnion) {
        body.appendChild(renderUnionField(obj, path, key, variantNames, currentTypeName));
      } else {
        body.appendChild(renderTypedValue(obj, path, key, node, pointer, null));
      }
    } catch (err) {
      console.error("render error at", pointer, err);
      body.appendChild(el("p", { class: "field-error", text: "(could not render this field: " + err.message + ")" }));
      body.appendChild(renderRawField(obj, path, key));
    }

    if (!isRequired) {
      body.appendChild(el("button", {
        class: "btn btn-remove", text: "Remove field", onclick: () => {
          delete obj[key]; markDirty(); rebuildForm();
        }
      }));
    }
    details.appendChild(body);
    return details;
  }

  function renderUnionField(obj, path, key, variantNames, currentTypeName) {
    const fullPath = [...path, key];
    const wrap = el("div", { class: "union-wrap" });
    const row = el("div", { class: "variant-row" });
    row.appendChild(el("span", { class: "variant-label", text: "Variant:" }));
    const select = el("select", { class: "variant-select" },
      variantNames.map(n => el("option", { value: n, text: n })));
    select.value = currentTypeName;
    select.addEventListener("change", () => {
      const pointer = joinPointer(specPointerFor(path), "/" + key);
      const newVal = makeDefaultValue(state.idx, pointer, select.value);
      if (newVal && typeof newVal === "object" && !Array.isArray(newVal)) newVal.type = select.value;
      obj[key] = newVal;
      markDirty();
      rebuildForm();
    });
    row.appendChild(select);
    wrap.appendChild(row);

    const pointer = specPointerFor(fullPath);
    const node = resolveNode(pointer, currentTypeName);
    wrap.appendChild(renderTypedValue(obj, path, key, node, pointer, currentTypeName));
    return wrap;
  }

  function renderTypedValue(obj, path, key, node, pointer, typeName) {
    const value = obj[key];
    const t = node ? node.type : null;

    if (t === "object" && !(value === null || (typeof value === "object" && !Array.isArray(value)))) {
      return renderRawField(obj, path, key);
    }
    if (t === "list" && !(value === null || Array.isArray(value))) {
      return renderRawField(obj, path, key);
    }

    if (t === "object" || (value && typeof value === "object" && !Array.isArray(value) && t !== "include")) {
      if (value === null || value === undefined) obj[key] = {};
      return renderObjectFields(obj[key], [...path, key], typeName);
    }

    if (t === "list") return renderListField(obj, path, key, node, pointer);

    if (t === "bool") {
      const input = el("input", { type: "checkbox", class: "bool-input" });
      input.checked = !!value;
      input.addEventListener("change", () => { obj[key] = input.checked; markDirty(); refreshPreview(); });
      return input;
    }

    if ((t === "int" || t === "float") && !(value === null || value === undefined || typeof value === "number")) {
      return renderRawField(obj, path, key);
    }

    if (t === "int") {
      const input = el("input", { type: "number", class: "num-input", step: "1", value: value ?? 0 });
      if ("min" in node) input.min = node.min;
      if ("max" in node) input.max = node.max;
      input.addEventListener("change", () => {
        const v = parseInt(input.value, 10);
        obj[key] = Number.isNaN(v) ? 0 : v; markDirty(); refreshPreview();
      });
      return input;
    }

    if (t === "float") {
      const input = el("input", { type: "number", class: "num-input", step: "any", value: value ?? 0 });
      if ("min" in node) input.min = node.min;
      if ("max" in node) input.max = node.max;
      input.addEventListener("change", () => {
        const v = parseFloat(input.value);
        obj[key] = Number.isNaN(v) ? 0 : v; markDirty(); refreshPreview();
      });
      return input;
    }

    if (t === "string" && node && node.options && node.options.length) {
      const options = node.options;
      const select = el("select", { class: "enum-select" },
        options.map(o => el("option", { value: o, text: o })));
      select.value = options.includes(value) ? value : options[0];
      select.addEventListener("change", () => { obj[key] = select.value; markDirty(); refreshPreview(); });
      return select;
    }

    if (t === "file") {
      const wrap = el("div", { class: "file-row" });
      const input = el("input", { type: "text", class: "text-input", value: value ?? "" });
      input.addEventListener("change", () => { obj[key] = input.value; markDirty(); refreshPreview(); });
      wrap.appendChild(input);
      const exts = (node && node.extensions) || [];
      if (exts.length) wrap.appendChild(el("span", { class: "ext-hint", text: "(" + exts.join(", ") + ")" }));
      return wrap;
    }

    if (t === "string" || typeof value === "string") {
      const long = String(value ?? "").length > 60;
      const input = el(long ? "textarea" : "input", { class: "text-input", rows: long ? "3" : null });
      if (!long) input.type = "text";
      input.value = value ?? "";
      input.addEventListener("change", () => { obj[key] = input.value; markDirty(); refreshPreview(); });
      return input;
    }

    // Fallback: unknown node shape -> raw JSON editor
    return renderRawField(obj, path, key);
  }

  function renderListField(obj, path, key, node, pointer) {
    let value = obj[key];
    if (value == null) { value = []; obj[key] = value; }
    if (!Array.isArray(value)) return renderRawField(obj, path, key);

    const fullPath = [...path, key];
    const itemPointer = joinPointer(pointer, "/*");
    const hasItemSpec = state.idx.variants(itemPointer).length > 0;

    const wrap = el("div", { class: "list-field" });
    value.forEach((item, i) => {
      const row = el("div", { class: "list-item-row" });
      row.appendChild(el("span", { class: "list-index", text: `[${i}]` }));
      const itemBody = el("div", { class: "list-item-body" });
      if (hasItemSpec) {
        itemBody.appendChild(renderListItem(value, [...fullPath, i], i, itemPointer));
      } else {
        itemBody.appendChild(renderScalarListItem(value, i));
      }
      row.appendChild(itemBody);
      row.appendChild(el("button", {
        class: "btn btn-remove btn-small", text: "\u00D7", onclick: () => {
          value.splice(i, 1); markDirty(); rebuildForm();
        }
      }));
      wrap.appendChild(row);
    });

    const addRow = el("div", { class: "list-add-row" });
    addRow.appendChild(el("button", {
      class: "btn btn-add", text: "+ Add item", onclick: () => {
        let newVal;
        if (hasItemSpec) {
          const variant = state.idx.defaultVariantName(itemPointer);
          newVal = makeDefaultValue(state.idx, itemPointer, variant);
          if (newVal && typeof newVal === "object" && !Array.isArray(newVal) && variant) newVal.type = variant;
        } else {
          newVal = "";
        }
        value.push(newVal);
        markDirty();
        rebuildForm();
      }
    }));
    if (node && node.min) addRow.appendChild(el("span", { class: "ext-hint", text: `(min ${node.min})` }));
    wrap.appendChild(addRow);
    return wrap;
  }

  function renderScalarListItem(list, i) {
    const val = list[i];
    if (typeof val === "boolean") {
      const input = el("input", { type: "checkbox" });
      input.checked = val;
      input.addEventListener("change", () => { list[i] = input.checked; markDirty(); refreshPreview(); });
      return input;
    }
    if (typeof val === "number") {
      const input = el("input", { type: "number", class: "num-input", step: "any", value: val });
      input.addEventListener("change", () => { list[i] = parseFloat(input.value) || 0; markDirty(); refreshPreview(); });
      return input;
    }
    const input = el("input", { type: "text", class: "text-input", value: val ?? "" });
    input.addEventListener("change", () => { list[i] = input.value; markDirty(); refreshPreview(); });
    return input;
  }

  function renderListItem(list, itemPath, i, itemPointer) {
    const val = list[i];
    const variantNames = state.idx.variantNames(itemPointer);
    const isUnion = variantNames.length > 1;
    let typeName = null;
    if (isUnion) {
      if (val && typeof val === "object" && "type" in val) typeName = val.type;
      else typeName = state.idx.defaultVariantName(itemPointer);
    }

    const wrap = el("div", { class: "list-item-content" });
    if (val && typeof val === "object" && !Array.isArray(val)) {
      if (isUnion) {
        const row = el("div", { class: "variant-row" });
        row.appendChild(el("span", { class: "variant-label", text: "Variant:" }));
        const select = el("select", { class: "variant-select" },
          variantNames.map(n => el("option", { value: n, text: n })));
        select.value = typeName;
        select.addEventListener("change", () => {
          const nv = makeDefaultValue(state.idx, itemPointer, select.value);
          if (nv && typeof nv === "object") nv.type = select.value;
          list[i] = nv;
          markDirty();
          rebuildForm();
        });
        row.appendChild(select);
        wrap.appendChild(row);
      }
      wrap.appendChild(renderObjectFields(val, itemPath, typeName));
    } else {
      wrap.appendChild(renderScalarListItem(list, i));
    }
    return wrap;
  }

  // ---------------------------------------------------------------------
  // JSON preview
  // ---------------------------------------------------------------------
  function refreshPreview() {
    document.getElementById("json-preview").textContent = JSON.stringify(state.document, null, 2);
  }

  // ---------------------------------------------------------------------
  // File operations
  // ---------------------------------------------------------------------
  function newDocument() {
    state.document = makeDefaultValue(state.idx, "/") || { geometry: [], materials: [] };
    state.fileName = "untitled.json";
    state.dirty = false;
    updateTitleBar();
    fieldOpenState.clear(); // fresh document: don't inherit the old one's open/closed sections
    rebuildForm(false);
    setStatus("New document created from spec defaults.");
  }

  function loadDocumentFromText(text, name) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      setStatus("Could not parse file as JSON: " + err.message, true);
      return;
    }
    state.document = doc;
    state.fileName = name || "loaded.json";
    state.dirty = false;
    updateTitleBar();
    fieldOpenState.clear(); // different document: don't inherit the old one's open/closed sections
    rebuildForm(false);
    setStatus("Loaded " + state.fileName);
  }

  function downloadDocument() {
    const blob = new Blob([JSON.stringify(state.document, null, 4) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.fileName.endsWith(".json") ? state.fileName : state.fileName + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    state.dirty = false;
    updateTitleBar();
    setStatus("Downloaded " + a.download);
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function wireUi() {
    document.getElementById("btn-new").addEventListener("click", () => {
      if (state.dirty && !confirmDiscard()) return;
      newDocument();
    });
    document.getElementById("file-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadDocumentFromText(reader.result, file.name);
      reader.readAsText(file);
      e.target.value = "";
    });
    document.getElementById("btn-open").addEventListener("click", () => {
      if (state.dirty && !confirmDiscard()) return;
      document.getElementById("file-input").click();
    });
    document.getElementById("btn-save").addEventListener("click", downloadDocument);
    document.getElementById("btn-refresh-preview").addEventListener("click", refreshPreview);
    document.getElementById("btn-copy-preview").addEventListener("click", async () => {
      const text = document.getElementById("json-preview").textContent;
      try {
        await navigator.clipboard.writeText(text);
        setStatus("Copied JSON to clipboard.");
      } catch {
        setStatus("Could not access clipboard; select the text manually.", true);
      }
    });

    window.addEventListener("beforeunload", (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function confirmDiscard() {
    return window.confirm("Discard unsaved changes?");
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  async function boot() {
    wireUi();
    setStatus("Loading PolyFEM spec\u2026");
    try {
      await loadBundledSpec();
      setStatus(`Spec loaded: ${state.idx.byPointer.size} fields. Checking GitHub for the latest spec\u2026`);
    } catch (err) {
      setStatus("Failed to load bundled spec: " + err.message, true);
      return;
    }
    newDocument();
    // Not awaited: the form is usable immediately from the bundled spec, and
    // is re-rendered with the latest spec once the fetch completes. On failure,
    // updateSpecFromGitHub() keeps the bundled spec and shows an error.
    updateSpecFromGitHub();
  }

  boot();
})();