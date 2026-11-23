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
    layout(options) { return { run() { options.stop(); } }; },
  };
  const context = {
    document: { querySelector: element },
    Option: function (text, value) { this.text = text; this.value = value; },
    Blob, FormData, TextDecoder, TypeError,
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
            graphs: [{ id: "global", name: "Global model", kind: "global", nodes: [], edges: [] }],
          };
        },
      };
    },
  };
  vm.runInNewContext(source, context);
  return { element, requests };
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
  assert.equal(app.element("#specification").value.replace(/\r\n/g, "\n"), original.replace(/\r\n/g, "\n"));
  const edited = app.element("#specification").value + "\n";
  app.element("#specification").value = edited;
  await app.element("#specification").emit("input");
  await app.element("#generate").emit("click");
  await app.element("#verify").emit("click");
  assert.deepEqual(app.requests.map(request => request.specification), [edited, edited]);
  assert.equal(app.requests[1].formula, "<<A>><>(x == 1)");
  assert.equal(fs.readFileSync(samplePath, "utf8"), original);
  app.element("#specification").value += "\n";
  await app.element("#specification").emit("input");
  assert.equal(app.element("#verify").disabled, true);
  assert.equal(app.element("#graph-select").disabled, true);
  assert.equal(app.element("#result").hidden, true);
});

test("pasted specifications work without a file and reject oversized input", async () => {
  const app = createApp();
  await app.element("#open-editor").emit("click");
  assert.equal(app.element("#editor-dialog").open, true);
  app.element("#specification").value = "Agent A:\ninit q0";
  await app.element("#specification").emit("input");
  await app.element("#done-editing").emit("click");
  await app.element("#generate").emit("click");
  assert.equal(app.requests[0].specification, "Agent A:\ninit q0");
  app.element("#specification").value = "é".repeat(1024 * 1024 + 1);
  await app.element("#specification").emit("input");
  await app.element("#generate").emit("click");
  assert.equal(app.requests.length, 1);
  assert.match(app.element("#error").textContent, /no larger than 2 MB/);
  app.element("#specification").value = "";
  await app.element("#specification").emit("input");
  assert.equal(app.element("#generate").disabled, true);
});

test("invalid UTF-8 input does not replace the current specification", async () => {
  const app = createApp();
  app.element("#specification").value = "Existing text";
  await app.element("#specification").emit("input");
  app.element("#model-file").files = [{
    name: "invalid.txt", size: 1,
    async arrayBuffer() { return new Uint8Array([255]); },
  }];
  await app.element("#model-file").emit("change");
  assert.equal(app.element("#specification").value, "Existing text");
  assert.match(app.element("#error").textContent, /UTF-8/);
});
