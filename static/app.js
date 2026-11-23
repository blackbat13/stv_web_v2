const fileInput = document.querySelector("#model-file");
const generateButton = document.querySelector("#generate");
const verifyButton = document.querySelector("#verify");
const select = document.querySelector("#graph-select");
const layoutSelect = document.querySelector("#layout-select");
const layoutButton = document.querySelector("#layout");
const fitButton = document.querySelector("#fit");
const resultBox = document.querySelector("#result");
const errorBox = document.querySelector("#error");
const details = document.querySelector("#details");
const formulaInput = document.querySelector("#formula");
const specificationEditor = CodeMirror.fromTextArea(document.querySelector("#specification"), {
  mode: "stv",
  lineNumbers: true,
  lineWrapping: false,
  maxHighlightLength: 2 * 1024 * 1024,
  inputStyle: "textarea"
});
specificationEditor.getInputField().setAttribute("aria-label", "Model specification");
specificationEditor.getInputField().setAttribute("aria-describedby", "editor-help");
const editorDialog = document.querySelector("#editor-dialog");
const openEditorButton = document.querySelector("#open-editor");
const modelSource = document.querySelector("#model-source");
const MAX_SPECIFICATION_SIZE = 2 * 1024 * 1024;
const MAX_LOOP_ADJUSTMENT_NODES = 500;
const MAX_LOOP_ADJUSTMENT_EDGES = 1500;
const MAX_LOOP_INCIDENT_SAMPLES = 100;
let sourceName = "";
let loadingSpecification = false;
let graphs = [];
let generated = false;
let cy = null;
let adjustLoops = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function setBusy(busy) {
  fileInput.disabled = busy;
  openEditorButton.disabled = busy;
  specificationEditor.setOption("readOnly", busy);
  formulaInput.disabled = busy || !generated;
  generateButton.disabled = busy || !specificationEditor.getValue().trim();
  verifyButton.disabled = busy || !generated || !formulaInput.value.trim();
  select.disabled = busy || !graphs.length;
  layoutSelect.disabled = busy || !cy;
  layoutButton.disabled = busy || !cy;
  fitButton.disabled = busy || !cy;
  document.querySelector("#loading").hidden = !busy;
}

function reset() {
  graphs = [];
  generated = false;
  formulaInput.value = "";
  if (cy) cy.destroy();
  cy = null;
  adjustLoops = null;
  select.replaceChildren(new Option("No model generated", ""));
  document.querySelector("#empty").hidden = false;
  document.querySelector("#canvas-hint").hidden = true;
  document.querySelector("#state-count").textContent = "—";
  document.querySelector("#transition-count").textContent = "—";
  document.querySelector("#agent-count").textContent = "—";
  document.querySelector("#graph-title").textContent = "Explore your model";
  document.querySelector("#graph-subtitle").textContent = "A clearer view of your system's state space.";
  document.querySelector("#breadcrumb").textContent = "OVERVIEW";
  details.textContent = "Select an element in the graph to see its details.";
  resultBox.hidden = true;
  showError("");
  setBusy(false);
}

function loopLabelMargins(direction) {
  return {
    "text-margin-x": 14 * Math.sin(direction),
    "text-margin-y": -14 * Math.cos(direction)
  };
}

function setupLoopAdjustment(instance, graph) {
  if (graph.nodes.length > MAX_LOOP_ADJUSTMENT_NODES || graph.edges.length > MAX_LOOP_ADJUSTMENT_EDGES) return null;

  const loops = new Map();
  for (const edge of graph.edges) {
    const { id, source, target } = edge.data;
    if (source === target) {
      if (!loops.has(source)) loops.set(source, { edges: [], incident: [] });
      loops.get(source).edges.push(id);
    }
  }
  if (!loops.size) return null;

  const affected = new Map();
  for (const id of loops.keys()) affected.set(id, new Set([id]));
  for (const edge of graph.edges) {
    const { id, source, target } = edge.data;
    if (source === target) continue;
    for (const [node, neighbor] of [[source, target], [target, source]]) {
      if (!loops.has(node)) continue;
      loops.get(node).incident.push({ id, source: node === source, neighbor });
      if (!affected.has(neighbor)) affected.set(neighbor, new Set());
      affected.get(neighbor).add(node);
    }
  }

  function adjust(ids = loops.keys()) {
    const updates = [];
    for (const id of ids) {
      const { edges, incident } = loops.get(id);
      const position = instance.getElementById(id).position();
      const angles = [];
      const sampleCount = Math.min(incident.length, MAX_LOOP_INCIDENT_SAMPLES);
      for (let i = 0; i < sampleCount; i++) {
        const index = sampleCount === 1 ? 0 : Math.floor(i * (incident.length - 1) / (sampleCount - 1));
        const item = incident[index];
        const edge = instance.getElementById(item.id);
        const endpoint = item.source ? edge.sourceEndpoint() : edge.targetEndpoint();
        let dx = endpoint && endpoint.x - position.x;
        let dy = endpoint && endpoint.y - position.y;
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
          const neighbor = instance.getElementById(item.neighbor).position();
          dx = neighbor.x - position.x;
          dy = neighbor.y - position.y;
        }
        if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
          angles.push((Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI));
        }
      }
      if (!angles.length) continue;
      angles.sort((a, b) => a - b);
      let widest = -1;
      let direction = 0;
      for (let i = 0; i < angles.length; i++) {
        const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
        const gap = next - angles[i];
        if (gap > widest) {
          widest = gap;
          direction = angles[i] + gap / 2;
        }
      }
      // Cytoscape measures loop direction clockwise from up, rather than from the x-axis.
      const loopDirection = (direction + Math.PI / 2) % (2 * Math.PI);
      updates.push({
        edges,
        direction: `${loopDirection * 180 / Math.PI}deg`,
        labelMargins: loopLabelMargins(loopDirection),
        sweep: `${-Math.max(30, Math.min(90, widest * 0.8 * 180 / Math.PI))}deg`
      });
    }
    instance.batch(() => {
      for (const update of updates) {
        for (const id of update.edges) {
          instance.getElementById(id).style({
            "loop-direction": update.direction, "loop-sweep": update.sweep, ...update.labelMargins
          });
        }
      }
    });
  }

  const pending = new Set();
  let scheduled = false;
  instance.on("dragfree", "node", event => {
    const ids = affected.get(event.target.id());
    if (!ids) return;
    for (const id of ids) pending.add(id);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        if (!instance.destroyed()) adjust(pending);
      } catch (error) {
        showError(`Could not adjust self-loops: ${error.message}`);
      } finally {
        pending.clear();
      }
    });
  });
  return adjust;
}

function runLayout(animate = false) {
  if (!cy) return Promise.resolve();
  const name = layoutSelect.value;
  const options = { name, fit: true, padding: 55, animate: name === "cose" && animate };
  if (name === "cose") {
    Object.assign(options, { randomize: true, nodeRepulsion: 4000, idealEdgeLength: 80, numIter: 1000 });
  } else if (name === "breadthfirst") {
    const roots = cy.collection();
    cy.elements().components().forEach(component => {
      const nodes = component.nodes();
      const candidates = nodes.roots();
      roots.merge(candidates.length ? candidates : nodes.first());
    });
    Object.assign(options, { directed: true, roots });
  }
  return new Promise((resolve, reject) => {
    const instance = cy;
    instance.layout({ ...options, stop: () => {
      try {
        if (instance === cy && adjustLoops) {
          adjustLoops();
          instance.fit(undefined, 55);
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    } }).run();
  });
}

async function displayGraph(animate = false) {
  const graph = graphs.find(item => item.id === select.value);
  if (!graph) return;
  if (cy) {
    cy.destroy();
    cy = null;
    adjustLoops = null;
  }
  const title = graph.kind === "global" ? "Global model" : `${graph.name} · Local model`;
  document.querySelector("#graph-title").textContent = title;
  document.querySelector("#graph-subtitle").textContent = graph.kind === "global" ? "The combined state space of the system." : `The state space of agent ${graph.name}.`;
  document.querySelector("#breadcrumb").textContent = graph.kind === "global" ? "GLOBAL MODEL" : "LOCAL MODEL";
  document.querySelector("#state-count").textContent = graph.nodes.length;
  document.querySelector("#transition-count").textContent = graph.edges.length;
  document.querySelector("#agent-count").textContent = graphs.filter(item => item.kind === "local").length;
  document.querySelector("#empty").hidden = true;
  document.querySelector("#canvas-hint").hidden = false;
  details.textContent = "Select an element in the graph to see its details.";
  cy = cytoscape({
    container: document.querySelector("#graph"),
    elements: [...graph.nodes, ...graph.edges],
    minZoom: 0.05,
    maxZoom: 3,
    style: [
      { selector: "node", style: {
        "label": "data(label)", "background-color": "#f8fbff", "border-color": "#627eac",
        "border-width": 1.5, "color": "#253a5b", "font-size": 11, "font-weight": 600,
        "text-valign": "center", "text-halign": "center", "width": 48, "height": 48,
        "text-max-width": 65, "text-wrap": "ellipsis"
      }},
      { selector: "edge", style: {
        "curve-style": "bezier", "width": 1.5, "line-color": "#a7b3c4",
        "target-arrow-color": "#a7b3c4", "target-arrow-shape": "triangle",
        "arrow-scale": 0.8, "label": graph.edges.length <= 100 ? "data(label)" : "",
        "font-size": 9, "color": "#6a7890", "text-rotation": "autorotate",
        "text-background-opacity": 0, "text-margin-y": -14
      }},
      { selector: "edge:loop", style: {
        "loop-direction": "-45deg", ...loopLabelMargins(-Math.PI / 4)
      }},
      { selector: 'edge[kind = "shared"]', style: { "line-color": "#648fc4", "target-arrow-color": "#648fc4" }},
      { selector: 'edge[kind = "strategy"]', style: { "line-color": "#e35d55", "target-arrow-color": "#e35d55", "width": 3 }},
      { selector: ":selected", style: { "overlay-color": "#4369db", "overlay-opacity": 0.15, "overlay-padding": 7 }}
    ]
  });
  cy.on("tap", "node", event => {
    const node = event.target;
    details.textContent = `State ${node.id()}\n${node.data("details").replace(/[{}]/g, "").replace(/\|/g, " · ")}`;
  });
  cy.on("tap", "edge", event => {
    const edge = event.target;
    details.textContent = `${edge.data("source")} → ${edge.data("target")}\n${edge.data("label") || "Unlabelled transition"}\n${edge.data("kind") === "strategy" ? "Strategy transition" : edge.data("kind") === "shared" ? "Shared transition" : "Transition"}`;
  });
  adjustLoops = setupLoopAdjustment(cy, graph);
  await runLayout(animate);
}

async function submit(action) {
  const text = specificationEditor.getValue();
  if (!text.trim()) return;
  showError("");
  const specification = new Blob([text], { type: "text/plain;charset=utf-8" });
  if (specification.size > MAX_SPECIFICATION_SIZE) {
    showError("The specification must be no larger than 2 MB.");
    return;
  }
  setBusy(true);
  const body = new FormData();
  body.append("file", specification, "model.txt");
  body.append("action", action);
  if (action === "verify") body.append("formula", formulaInput.value);
  try {
    const response = await fetch("/api/models", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The request failed.");
    const previous = select.value;
    if (action === "generate" && !generated) formulaInput.value = data.formula;
    graphs = data.graphs;
    generated = true;
    select.replaceChildren(...graphs.map(graph => new Option(graph.kind === "global" ? "Global model" : `${graph.name} · Local model`, graph.id)));
    if (graphs.some(graph => graph.id === previous)) select.value = previous;
    resultBox.hidden = action !== "verify";
    if (action === "verify") {
      resultBox.className = `result ${data.result ? "success" : "negative"}`;
      resultBox.textContent = data.result ? "TRUE · Strategy found. Red transitions mark the strategy in the global model." : "FALSE · No strategy found for this formula.";
    }
    await displayGraph();
  } catch (error) {
    showError(error.message || "Could not reach the server.");
  } finally {
    setBusy(false);
  }
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  setBusy(true);
  try {
    if (file.size > MAX_SPECIFICATION_SIZE) throw new Error("The specification file must be no larger than 2 MB.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    loadingSpecification = true;
    try {
      specificationEditor.setValue(text);
      specificationEditor.clearHistory();
    } finally {
      loadingSpecification = false;
    }
    sourceName = file.name;
    document.querySelector("#file-label").textContent = file.name;
    modelSource.textContent = `Loaded from ${file.name}. The original file will not be changed.`;
    reset();
  } catch (error) {
    showError(error instanceof TypeError ? "The specification file must be UTF-8 text." : `Could not load file: ${error.message}`);
  } finally {
    fileInput.value = "";
    setBusy(false);
  }
});
openEditorButton.addEventListener("click", () => {
  editorDialog.showModal();
  specificationEditor.refresh();
  specificationEditor.focus();
});
document.querySelector("#close-editor").addEventListener("click", () => editorDialog.close());
document.querySelector("#done-editing").addEventListener("click", () => editorDialog.close());
specificationEditor.on("change", () => {
  if (loadingSpecification) return;
  if (generated || graphs.length) reset();
  else {
    showError("");
    setBusy(false);
  }
  modelSource.textContent = sourceName
    ? `Edited from ${sourceName}. The original file will not be changed.`
    : "Specification written in the editor. Changes last until the page is reloaded.";
});
formulaInput.addEventListener("input", () => {
  resultBox.hidden = true;
  showError("");
  for (const graph of graphs) {
    for (const edge of graph.edges) {
      if (edge.data.kind === "strategy") edge.data.kind = "normal";
    }
  }
  if (cy) cy.edges('[kind = "strategy"]').data("kind", "normal");
  details.textContent = "Select an element in the graph to see its details.";
  setBusy(false);
});
generateButton.addEventListener("click", () => submit("generate"));
verifyButton.addEventListener("click", () => submit("verify"));
async function showLoading(title, errorPrefix, action) {
  showError("");
  document.querySelector("#loading-title").textContent = title;
  setBusy(true);
  try {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await action();
  } catch (error) {
    showError(`${errorPrefix}: ${error.message}`);
  } finally {
    document.querySelector("#loading-title").textContent = "Working on your model";
    setBusy(false);
  }
}

select.addEventListener("change", () => showLoading("Loading model", "Could not load model", () => displayGraph(true)));
layoutSelect.addEventListener("change", () => showLoading("Arranging model", "Could not arrange model", () => runLayout(true)));
layoutButton.addEventListener("click", () => showLoading("Arranging model", "Could not arrange model", () => runLayout(true)));
fitButton.addEventListener("click", () => cy && cy.fit(undefined, 55));
