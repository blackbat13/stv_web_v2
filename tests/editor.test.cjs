const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "static", "app.js"), "utf8");

function createApp(requestAnimationFrame = callback => callback()) {
  const elements = new Map();
  const requests = [];
  const layouts = [];
  const responseGraphs = [
    { id: "global", name: "Global model", kind: "global", nodes: [{ data: { id: "a" } }, { data: { id: "b" } }, { data: { id: "c" } }], edges: [{ data: { source: "a", target: "b" } }, { data: { source: "b", target: "c" } }, { data: { source: "c", target: "a" } }] },
    { id: "local", name: "Agent", kind: "local", nodes: [{ data: { id: "a" } }, { data: { id: "b" } }], edges: [{ data: { source: "a", target: "b" } }, { data: { source: "a", target: "b" } }] },
    { id: "local-2", name: "Other", kind: "local", nodes: [{ data: { id: "a" } }], edges: [] },
  ];
  const responseData = { formula: "<<A>><>(x == 1)", result: true, graphs: responseGraphs, checker_seconds: 0.1234 };
  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        value: "", _textContent: "", disabled: false, hidden: false, files: [],
        get textContent() { return this._textContent; },
        set textContent(value) { this._textContent = String(value); },
        listeners: {},
        addEventListener(type, handler) { this.listeners[type] = handler; },
        async emit(type) { return this.listeners[type](); },
        replaceChildren(...options) { this.value = options[0]?.value || ""; },
        showModal() { this.open = true; },
        close() { this.open = false; if (this.listeners.close) this.listeners.close(); },
        focus() {},
      });
    }
    return elements.get(selector);
  }
  const graph = {
    on() {},
    destroy() {},
    edges() { return { data() {} }; },
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
      return { run() { if (graph.layoutDelay) setTimeout(options.stop, graph.layoutDelay); else options.stop(); } };
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
    requestAnimationFrame,
    CodeMirror: { fromTextArea() { return editor; } },
    cytoscape(options) { graph.styles = options.style; return graph; },
    async fetch(_url, options) {
      requests.push({
        specification: await options.body.get("file").text(),
        action: options.body.get("action"),
        formula: options.body.get("formula"),
        epsilon: options.body.get("epsilon"),
        onTheFly: options.body.get("on_the_fly"),
        counterexample: options.body.get("counterexample"),
        naturalStrategy: options.body.get("natural_strategy"),
      });
      return {
        ok: true,
        async json() {
          return responseData;
        },
      };
    },
  };
  element("#layout-select").value = "cose";
  vm.runInNewContext(source, context);
  return { element, requests, editor, layouts, graph, responseGraphs, responseData, context };
}

test("file picker accepts both txt and stv specifications", () => {
  const template = fs.readFileSync(path.join(root, "templates", "index.html"), "utf8");
  const input = template.match(/<input\b[^>]*\bid="model-file"[^>]*>/);
  assert.ok(input);
  const accept = input[0].match(/\baccept="([^"]*)"/);
  assert.ok(accept);
  const types = accept[1].split(",");
  assert.ok(types.includes(".txt"));
  assert.ok(types.includes(".stv"));
});

for (const extension of ["txt", "stv"]) test(`loaded ${extension} file edits are used for generation and verification`, async () => {
  const app = createApp();
  const samplePath = path.join(root, "model_checkers", "stv_v2", "sample_input", "Voters1Candidates2.txt");
  const original = fs.readFileSync(samplePath, "utf8");
  const bytes = Buffer.from(original);
  app.element("#model-file").files = [{
    name: `sample.${extension}`, size: bytes.length,
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

test("the formula is loaded from specifications before or after agents", () => {
  const { extractFormula } = createApp().context;
  assert.equal(extractFormula("FORMULA: <<A>><>\r\n(x == 1)\r\nAgent A:\r\ninit q0"), "<<A>><>\r\n(x == 1)");
  assert.equal(extractFormula("Agent A:\ninit q0\nFORMULA: <<A>><>(x == 1)"), "<<A>><>(x == 1)");
  assert.equal(extractFormula("Agent A:\ninit q0"), "");
});

test("on-the-fly verification works without generating models and uses the editable formula", async () => {
  const app = createApp();
  const text = "FORMULA: <<A>><>\n(x == 1)\n\nAgent A:\ninit q0";
  await app.element("#open-editor").emit("click");
  app.editor.type(text);
  await app.element("#done-editing").emit("click");
  assert.equal(app.element("#formula").value, "<<A>><>\n(x == 1)");
  assert.equal(app.element("#verify").disabled, false);
  app.element("#on-the-fly").checked = true;
  await app.element("#on-the-fly").emit("change");
  assert.equal(app.element("#natural-strategy").disabled, true);
  assert.equal(app.element("#verify").disabled, false);
  app.element("#formula").value = "<<A>><>(x == 2)";
  app.element("#counterexample").checked = true;
  app.responseData.result = false;
  app.responseData.graphs = [];
  app.responseData.counterexample = "States:\nq0\nDecisions:\ngo";
  app.responseData.warnings = ["Warning: deadlock"];
  await app.element("#verify").emit("click");
  assert.deepEqual(app.requests[0], {
    specification: text, action: "verify", formula: "<<A>><>(x == 2)",
    epsilon: "0", onTheFly: "1", counterexample: "1", naturalStrategy: "0",
  });
  assert.equal(app.element("#graph-select").disabled, true);
  assert.match(app.element("#result").textContent, /FALSE/);
  assert.equal(app.element("#show-counterexample").hidden, false);
  assert.equal(app.element("#checker-warnings").textContent, "Warning: deadlock");
  assert.equal(app.element("#checker-warnings").hidden, false);
  assert.equal(app.element("#output-title").textContent, "Counterexample");
  assert.match(app.element("#output-content").textContent, /States:/);
  assert.equal(app.element("#output-dialog").open, true);
  await app.element("#done-output").emit("click");
  await app.element("#show-counterexample").emit("click");
  assert.equal(app.element("#output-dialog").open, true);
});

test("natural strategy verification can generate models directly", async () => {
  const app = createApp();
  app.editor.type("FORMULA: <<A>><>(x == 1)\nAgent A:\ninit q0");
  await app.element("#done-editing").emit("click");
  app.element("#natural-strategy").checked = true;
  await app.element("#natural-strategy").emit("change");
  app.responseData.natural_strategy = "x == 0 --> go\nComplexity after reduction: 1";
  await app.element("#verify").emit("click");
  assert.equal(app.requests[0].action, "verify");
  assert.equal(app.requests[0].naturalStrategy, "1");
  assert.equal(app.element("#graph-select").disabled, false);
  assert.match(app.element("#output-content").textContent, /x == 0 --> go/);
});

test("verification output dialogs and epsilon changes invalidate stale results", async () => {
  const app = createApp();
  app.editor.type("Agent A:\ninit q0");
  await app.element("#generate").emit("click");
  app.element("#natural-strategy").checked = true;
  await app.element("#natural-strategy").emit("change");
  assert.equal(app.element("#on-the-fly").disabled, true);
  app.element("#counterexample").checked = true;
  app.responseData.result = false;
  app.responseData.natural_strategy = "No natural strategy present.";
  app.responseData.counterexample = "States:\nq0";
  await app.element("#verify").emit("click");
  assert.equal(app.requests[1].naturalStrategy, "1");
  assert.equal(app.requests[1].counterexample, "1");
  assert.equal(app.element("#output-title").textContent, "Natural strategy");
  assert.equal(app.element("#output-content").textContent, "No natural strategy present.");
  assert.equal(app.element("#output-dialog").open, true);
  await app.element("#done-output").emit("click");
  await app.element("#show-counterexample").emit("click");
  assert.equal(app.element("#output-title").textContent, "Counterexample");
  app.element("#formula").value = "modified formula";
  await app.element("#formula").emit("input");
  assert.equal(app.element("#output-dialog").open, false);
  assert.equal(app.element("#show-natural-strategy").hidden, true);
  assert.equal(app.element("#show-counterexample").hidden, true);
  app.element("#epsilon").checked = true;
  await app.element("#epsilon").emit("change");
  assert.equal(app.element("#formula").value, "modified formula");
  assert.equal(app.element("#graph-select").disabled, true);
  await app.element("#generate").emit("click");
  assert.equal(app.requests[2].epsilon, "1");
});

test("on-the-fly verification preserves an existing graph without stale strategy markings", async () => {
  const app = createApp();
  app.editor.type("Agent A:\ninit q0");
  await app.element("#generate").emit("click");
  app.responseGraphs[0].edges[0].data.kind = "strategy";
  app.element("#on-the-fly").checked = true;
  await app.element("#on-the-fly").emit("change");
  assert.equal(app.responseGraphs[0].edges[0].data.kind, "normal");
  app.responseData.graphs = [];
  await app.element("#verify").emit("click");
  assert.equal(app.element("#graph-select").disabled, false);
  assert.equal(app.element("#state-count").textContent, "3");
  assert.match(app.element("#result").textContent, /no strategy graph was generated/);
});

test("run times use checker measurements and follow result validity", async () => {
  const app = createApp();
  app.editor.type("Agent A:\ninit q0");
  app.graph.layoutDelay = 25;
  await app.element("#generate").emit("click");
  assert.equal(app.element("#generation-time").textContent, "0.123 s");
  assert.equal(app.element("#verification-time").textContent, "—");

  app.responseData.checker_seconds = 2.3456;
  await app.element("#verify").emit("click");
  assert.equal(app.element("#generation-time").textContent, "0.123 s");
  assert.equal(app.element("#verification-time").textContent, "2.346 s");
  assert.match(app.element("#verification-time-label").textContent, /includes generation/);

  app.element("#graph-select").value = "local";
  await app.element("#graph-select").emit("change");
  assert.equal(app.element("#generation-time").textContent, "0.123 s");
  assert.equal(app.element("#verification-time").textContent, "2.346 s");
  await app.element("#formula").emit("input");
  assert.equal(app.element("#verification-time").textContent, "—");
  assert.equal(app.element("#generation-time").textContent, "0.123 s");
  app.element("#on-the-fly").checked = true;
  await app.element("#on-the-fly").emit("change");
  app.responseData.checker_seconds = 0.0004;
  await app.element("#verify").emit("click");
  assert.equal(app.element("#verification-time").textContent, "< 0.001 s");
  assert.match(app.element("#verification-time-label").textContent, /on-the-fly/);
  app.element("#epsilon").checked = true;
  await app.element("#epsilon").emit("change");
  assert.equal(app.element("#generation-time").textContent, "—");
  assert.equal(app.element("#verification-time").textContent, "—");
  app.responseData.checker_seconds = 1;
  await app.element("#generate").emit("click");
  app.editor.type("Agent A:\ninit q1");
  assert.equal(app.element("#generation-time").textContent, "—");
  assert.equal(app.element("#verification-time").textContent, "—");
});

test("invalid checker timing is reported rather than displayed", async () => {
  const app = createApp();
  app.editor.type("Agent A:\ninit q0");
  for (const timing of [undefined, -1, Infinity, "1"]) {
    app.responseData.checker_seconds = timing;
    await app.element("#generate").emit("click");
    assert.match(app.element("#error").textContent, /valid run time/);
    assert.equal(app.element("#generation-time").textContent, "—");
  }
});

test("statistics follow the selected model and clear when its specification changes", async () => {
  const app = createApp();
  app.editor.type("Agent A:\ninit q0");
  await app.element("#generate").emit("click");
  assert.equal(app.element("#state-count").textContent, "3");
  assert.equal(app.element("#transition-count").textContent, "3");
  assert.equal(app.element("#agent-count").textContent, "2");

  app.element("#graph-select").value = "local";
  await app.element("#graph-select").emit("change");
  assert.equal(app.element("#state-count").textContent, "2");
  assert.equal(app.element("#transition-count").textContent, "2");
  assert.equal(app.element("#agent-count").textContent, "2");

  app.element("#graph-select").value = "local-2";
  await app.element("#graph-select").emit("change");
  assert.equal(app.element("#state-count").textContent, "1");
  assert.equal(app.element("#transition-count").textContent, "0");
  assert.equal(app.element("#agent-count").textContent, "2");

  app.element("#graph-select").value = "local";
  await app.element("#graph-select").emit("change");
  app.responseGraphs[1].nodes.push({ data: { id: "c" } });
  app.responseGraphs[1].edges.pop();
  await app.element("#verify").emit("click");
  assert.equal(app.element("#state-count").textContent, "3");
  assert.equal(app.element("#transition-count").textContent, "1");
  assert.equal(app.element("#agent-count").textContent, "2");

  app.editor.type("Changed specification");
  for (const id of ["#state-count", "#transition-count", "#agent-count"]) {
    assert.equal(app.element(id).textContent, "—");
  }
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

test("self-loops avoid incident edges and update after a neighboring node moves", () => {
  const frames = [];
  const app = createApp(callback => frames.push(callback));
  const positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 0, y: -100 }, d: { x: 200, y: 200 } };
  const styles = new Map();
  const elements = {
    a: { position: () => positions.a },
    b: { position: () => positions.b },
    c: { position: () => positions.c },
    d: { position: () => positions.d },
    loop: { style: value => styles.set("loop", value) },
    loop2: { style: value => styles.set("loop2", value) },
    isolated: { style: value => styles.set("isolated", value) },
    out: { sourceEndpoint: () => ({ x: positions.b.x / 5, y: positions.b.y / 5 }) },
    incoming: { targetEndpoint: () => ({ x: positions.c.x / 5, y: positions.c.y / 5 }) },
  };
  let onDragFree;
  const instance = {
    getElementById: id => elements[id],
    batch: callback => callback(),
    on: (_event, _selector, handler) => { onDragFree = handler; },
    destroyed: () => false,
  };
  const graph = {
    nodes: [{}, {}, {}, {}],
    edges: [
      { data: { id: "loop", source: "a", target: "a" } },
      { data: { id: "loop2", source: "a", target: "a" } },
      { data: { id: "isolated", source: "d", target: "d" } },
      { data: { id: "out", source: "a", target: "b" } },
      { data: { id: "incoming", source: "c", target: "a" } },
    ],
  };
  const adjust = app.context.setupLoopAdjustment(instance, graph);
  adjust();
  const direction = () => parseFloat(styles.get("loop")["loop-direction"]);
  const outside = () => {
    const style = styles.get("loop");
    const angle = direction() * Math.PI / 180;
    return style["text-margin-x"] * Math.sin(angle) - style["text-margin-y"] * Math.cos(angle);
  };
  assert.ok(Math.abs(direction() - 225) < 0.001);
  assert.ok(outside() > 10);
  assert.equal(styles.get("loop2")["loop-direction"], styles.get("loop")["loop-direction"]);
  assert.equal(styles.has("isolated"), false);
  positions.b = { x: -100, y: 0 };
  elements.out.sourceEndpoint = () => ({ x: NaN, y: NaN });
  onDragFree({ target: { id: () => "b" } });
  onDragFree({ target: { id: () => "c" } });
  assert.equal(frames.length, 1);
  frames[0]();
  assert.ok(Math.abs(direction() - 135) < 0.001);
  assert.ok(outside() > 10);
});

test("default loop labels are offset outward without changing ordinary edge labels", async () => {
  const app = createApp();
  app.editor.type("Agent A:\ninit q0");
  await app.element("#generate").emit("click");
  const cy = require("cytoscape")({
    headless: true, styleEnabled: true, style: app.graph.styles,
    elements: [
      { data: { id: "a" } }, { data: { id: "b" } },
      { data: { id: "loop", source: "a", target: "a", label: "loop" } },
      { data: { id: "edge", source: "a", target: "b", label: "edge" } },
    ],
  });
  const loop = cy.getElementById("loop");
  const angle = loop.pstyle("loop-direction").pfValue;
  const x = loop.pstyle("text-margin-x").pfValue;
  const y = loop.pstyle("text-margin-y").pfValue;
  assert.ok(x * Math.sin(angle) - y * Math.cos(angle) > 10);
  assert.equal(cy.getElementById("edge").pstyle("text-margin-y").pfValue, -14);
  cy.destroy();
});

test("loop label offsets remain outside across all directions", () => {
  const app = createApp();
  for (let i = 0; i < 32; i++) {
    const angle = i * Math.PI / 16;
    const margins = app.context.loopLabelMargins(angle);
    const x = margins["text-margin-x"];
    const y = margins["text-margin-y"];
    assert.ok(x * Math.sin(angle) - y * Math.cos(angle) > 4.5);
    assert.ok(Math.abs(x * Math.cos(angle) + y * Math.sin(angle)) < 1e-9);
  }
});

test("self-loop adjustment is bounded by both graph size thresholds", () => {
  const app = createApp();
  const instance = { on() {} };
  const loop = { data: { id: "loop", source: "a", target: "a" } };
  const other = { data: { id: "other", source: "b", target: "c" } };
  const graph = { nodes: Array(500).fill({}), edges: [loop, ...Array(1499).fill(other)] };
  assert.equal(typeof app.context.setupLoopAdjustment(instance, graph), "function");
  assert.equal(app.context.setupLoopAdjustment(instance, { ...graph, nodes: Array(501).fill({}) }), null);
  assert.equal(app.context.setupLoopAdjustment(instance, { ...graph, edges: [...graph.edges, other] }), null);
});

test("self-loop adjustment limits geometry reads for highly connected states", () => {
  const app = createApp();
  let endpointReads = 0;
  let style;
  const elements = {
    a: { position: () => ({ x: 0, y: 0 }) },
    b: { position: () => ({ x: 100, y: 0 }) },
    loop: { style: value => { style = value; } },
    edge: { sourceEndpoint: () => { endpointReads++; return { x: 24, y: 0 }; } },
  };
  const instance = {
    getElementById: id => elements[id],
    batch: callback => callback(),
    on() {},
  };
  const graph = {
    nodes: [{}, {}],
    edges: [
      { data: { id: "loop", source: "a", target: "a" } },
      ...Array.from({ length: 201 }, () => ({ data: { id: "edge", source: "a", target: "b" } })),
    ],
  };
  app.context.setupLoopAdjustment(instance, graph)();
  assert.equal(endpointReads, 100);
  assert.ok(Number.isFinite(parseFloat(style["loop-direction"])));
});
