const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "static", "app.js"), "utf8");

function createApp() {
  const elements = new Map();
  const requests = [];
  const layouts = [];
  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        value: "", textContent: "", disabled: false, hidden: false, files: [],
        listeners: {},
        addEventListener(type, handler) { this.listeners[type] = handler; },
        async emit(type) { return this.listeners[type](); },
        replaceChildren(...options) { this.value = options[0]?.value || ""; },
        showModal() { this.open = true; },
        close() { this.open = false; },
        focus() {},
      });
    }
    return elements.get(selector);
  }
  const graph = {
    on() {},
    destroy() {},
    collection() { return { ids: [], merge(nodes) { this.ids.push(...nodes); } }; },
    elements() {
      return { components() { return [
        { nodes() { return { roots() { return []; }, first() { return ["cyclic"]; } }; } },
        { nodes() { return { roots() { return ["root"]; }, first() { return ["unused"]; } }; } },
      ]; } };
    },
    layout(options) {
      layouts.push({ options, busy: element("#layout-select").disabled });
      if (this.failLayout) throw new Error("layout failed");
      return { run() { options.stop(); } };
    },
  };
  const editor = {
    value: "",
    getInputField() { return { setAttribute() {} }; },
    getValue() { return this.value; },
    setValue(value) { this.value = value; this.change(); },
    clearHistory() {},
    setOption() {},
    refresh() {},
    focus() {},
    on(_event, handler) { this.change = handler; },
    type(value) { this.value = value; this.change(); },
  };
  const context = {
    document: { querySelector: element },
    Option: function (text, value) { this.text = text; this.value = value; },
    Blob, FormData, TextDecoder, TypeError,
    requestAnimationFrame(callback) { callback(); },
    CodeMirror: { fromTextArea() { return editor; } },
    cytoscape() { return graph; },
    async fetch(_url, options) {
      requests.push({
        specification: await options.body.get("file").text(),
        action: options.body.get("action"),
        formula: options.body.get("formula"),
      });
      return {
        ok: true,
        async json() {
          return {
            formula: "<<A>><>(x == 1)", result: true,
            graphs: [
              { id: "global", name: "Global model", kind: "global", nodes: [], edges: [] },
              { id: "local", name: "Agent", kind: "local", nodes: [], edges: [] },
            ],
          };
        },
      };
    },
  };
  element("#layout-select").value = "cose";
  vm.runInNewContext(source, context);
  return { element, requests, editor, layouts, graph };
}

test("loaded file edits are used for generation and verification", async () => {
  const app = createApp();
  const samplePath = path.join(root, "model_checkers", "stv_v2", "sample_input", "Voters1Candidates2.txt");
  const original = fs.readFileSync(samplePath, "utf8");
  const bytes = Buffer.from(original);
  app.element("#model-file").files = [{
    name: "sample.txt", size: bytes.length,
    async arrayBuffer() { return bytes; },
  }];
  await app.element("#model-file").emit("change");
  assert.equal(app.editor.getValue().replace(/\r\n/g, "\n"), original.replace(/\r\n/g, "\n"));
  const edited = app.editor.getValue() + "\n";
  app.editor.type(edited);
  await app.element("#generate").emit("click");
  await app.element("#verify").emit("click");
  assert.deepEqual(app.requests.map(request => request.specification), [edited, edited]);
  assert.equal(app.requests[1].formula, "<<A>><>(x == 1)");
  assert.equal(fs.readFileSync(samplePath, "utf8"), original);
  app.editor.type(app.editor.getValue() + "\n");
  assert.equal(app.element("#verify").disabled, true);
  assert.equal(app.element("#graph-select").disabled, true);
  assert.equal(app.element("#result").hidden, true);
});

test("pasted specifications work without a file and reject oversized input", async () => {
  const app = createApp();
  await app.element("#open-editor").emit("click");
  assert.equal(app.element("#editor-dialog").open, true);
  app.editor.type("Agent A:\ninit q0");
  await app.element("#done-editing").emit("click");
  await app.element("#generate").emit("click");
  assert.equal(app.requests[0].specification, "Agent A:\ninit q0");
  app.editor.type("é".repeat(1024 * 1024 + 1));
  await app.element("#generate").emit("click");
  assert.equal(app.requests.length, 1);
  assert.match(app.element("#error").textContent, /no larger than 2 MB/);
  app.editor.type("");
  assert.equal(app.element("#generate").disabled, true);
});

test("invalid UTF-8 input does not replace the current specification", async () => {
  const app = createApp();
  app.editor.type("Existing text");
  app.element("#model-file").files = [{
    name: "invalid.txt", size: 1,
    async arrayBuffer() { return new Uint8Array([255]); },
  }];
  await app.element("#model-file").emit("change");
  assert.equal(app.editor.getValue(), "Existing text");
  assert.match(app.element("#error").textContent, /UTF-8/);
});

test("selected layout is applied, reapplied and preserved across model switches", async () => {
  const app = createApp();
  app.editor.type("Agent A:\ninit q0");
  await app.element("#generate").emit("click");
  assert.equal(app.layouts[0].options.name, "cose");

  app.element("#layout-select").value = "breadthfirst";
  await app.element("#layout-select").emit("change");
  assert.equal(app.layouts[1].options.name, "breadthfirst");
  assert.equal(app.layouts[1].options.directed, true);
  assert.deepEqual(app.layouts[1].options.roots.ids, ["cyclic", "root"]);
  assert.equal(app.layouts[1].busy, true);
  assert.equal(app.element("#layout-select").disabled, false);
  await app.element("#layout").emit("click");
  assert.equal(app.layouts[2].options.name, "breadthfirst");

  for (const name of ["circle", "grid"]) {
    app.element("#layout-select").value = name;
    await app.element("#layout-select").emit("change");
    assert.equal(app.layouts.at(-1).options.name, name);
  }
  app.element("#graph-select").value = "local";
  await app.element("#graph-select").emit("change");
  assert.equal(app.layouts.at(-1).options.name, "grid");
  assert.equal(app.requests.length, 1);

  app.graph.failLayout = true;
  await app.element("#layout").emit("click");
  assert.match(app.element("#error").textContent, /Could not arrange model: layout failed/);
  assert.equal(app.element("#layout-select").disabled, false);
  assert.equal(app.element("#loading").hidden, true);
});
