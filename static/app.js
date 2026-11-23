const fileInput = document.querySelector("#model-file");
const generateButton = document.querySelector("#generate");
const verifyButton = document.querySelector("#verify");
const select = document.querySelector("#graph-select");
const layoutButton = document.querySelector("#layout");
const fitButton = document.querySelector("#fit");
const resultBox = document.querySelector("#result");
const errorBox = document.querySelector("#error");
const details = document.querySelector("#details");
const formulaInput = document.querySelector("#formula");
let graphs = [];
let generated = false;
let cy = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function setBusy(busy) {
  fileInput.disabled = busy;
  formulaInput.disabled = busy || !generated;
  generateButton.disabled = busy || !fileInput.files.length;
  verifyButton.disabled = busy || !generated || !formulaInput.value.trim();
  select.disabled = busy || !graphs.length;
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
  select.replaceChildren(new Option("No model generated", ""));
  document.querySelector("#empty").hidden = false;
  document.querySelector("#canvas-hint").hidden = true;
  document.querySelector("#counts").textContent = "— states  /  — transitions";
  document.querySelector("#graph-title").textContent = "Explore your model";
  document.querySelector("#graph-subtitle").textContent = "A clearer view of your system's state space.";
  document.querySelector("#breadcrumb").textContent = "OVERVIEW";
  details.textContent = "Select an element in the graph to see its details.";
  resultBox.hidden = true;
  showError("");
  setBusy(false);
}

function runLayout() {
  if (!cy) return;
  cy.layout({
    name: "cose",
    animate: false,
    randomize: true,
    fit: true,
    padding: 55,
    nodeRepulsion: 4000,
    idealEdgeLength: 80,
    numIter: 1000
  }).run();
}

function displayGraph() {
  const graph = graphs.find(item => item.id === select.value);
  if (!graph) return;
  if (cy) cy.destroy();
  const title = graph.kind === "global" ? "Global model" : `${graph.name} · Local model`;
  document.querySelector("#graph-title").textContent = title;
  document.querySelector("#graph-subtitle").textContent = graph.kind === "global" ? "The combined state space of the system." : `The state space of agent ${graph.name}.`;
  document.querySelector("#breadcrumb").textContent = graph.kind === "global" ? "GLOBAL MODEL" : "LOCAL MODEL";
  document.querySelector("#counts").textContent = `${graph.nodes.length} states  /  ${graph.edges.length} transitions`;
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
        "text-background-color": "#ffffff", "text-background-opacity": 0.85,
        "text-background-padding": 2, "text-margin-y": -6
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
  runLayout();
  setBusy(false);
}

async function submit(action) {
  if (!fileInput.files.length) return;
  showError("");
  setBusy(true);
  const body = new FormData();
  body.append("file", fileInput.files[0]);
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
    displayGraph();
  } catch (error) {
    showError(error.message || "Could not reach the server.");
  } finally {
    setBusy(false);
  }
}

fileInput.addEventListener("change", () => {
  document.querySelector("#file-label").textContent = fileInput.files[0]?.name || "Choose a model file";
  reset();
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
select.addEventListener("change", displayGraph);
layoutButton.addEventListener("click", runLayout);
fitButton.addEventListener("click", () => cy && cy.fit(undefined, 55));
