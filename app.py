import os
import re
import subprocess
import tempfile
from pathlib import Path

import pydot
from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.exceptions import RequestEntityTooLarge


ROOT = Path(__file__).resolve().parent
CHECKER = ROOT / "model_checkers" / "stv_v2" / "stv"
MAX_INPUT_SIZE = 2 * 1024 * 1024
MAX_DOT_SIZE = 25 * 1024 * 1024
MAX_FORMULA_SIZE = 32 * 1024
TIMEOUT_SECONDS = 120

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_INPUT_SIZE + 64 * 1024


class ModelError(Exception):
    pass


def dot_text(value):
    if not value:
        return ""
    if value.startswith('"') and value.endswith('"'):
        value = value[1:-1]
    return value.replace(r"\n", "\n").replace(r"\"", '"').replace(r"\\", "\\")


def parse_graph(path, name, kind):
    if path.stat().st_size > MAX_DOT_SIZE:
        raise ModelError(f"The {name} graph is too large to display.")
    try:
        graphs = pydot.graph_from_dot_file(str(path), encoding="utf-8")
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ModelError(f"Could not parse the {name} graph: {exc}") from exc
    if not graphs or len(graphs) != 1:
        raise ModelError(f"Could not parse the {name} graph.")
    graph = graphs[0]
    nodes = []
    for node in graph.get_nodes():
        node_id = dot_text(node.get_name())
        if node_id in {"node", "edge", "graph", "", r"\n"}:
            continue
        nodes.append({
            "data": {
                "id": node_id,
                "label": node_id,
                "details": dot_text(node.get_label()) or node_id,
            }
        })
    edges = []
    for index, edge in enumerate(graph.get_edges()):
        color = dot_text(edge.get_color()).lower()
        edges.append({
            "data": {
                "id": f"edge-{index}",
                "source": dot_text(edge.get_source()),
                "target": dot_text(edge.get_destination()),
                "label": dot_text(edge.get_label()),
                "kind": "strategy" if color == "red" else "shared" if color == "blue" else "normal",
            }
        })
    if not nodes:
        raise ModelError(f"The {name} graph contains no states.")
    ids = {node["data"]["id"] for node in nodes}
    if any(edge["data"]["source"] not in ids or edge["data"]["target"] not in ids for edge in edges):
        raise ModelError(f"The {name} graph contains transitions with missing states.")
    return {"id": path.name, "name": name, "kind": kind, "nodes": nodes, "edges": edges}


def extract_formula(specification):
    match = re.search(
        r"^[ \t]*FORMULA[ \t]*:[ \t]*(.*?)(?=^[ \t]*Agent[ \t]+[^\r\n:]+[ \t]*:|\Z)",
        specification,
        re.MULTILINE | re.DOTALL,
    )
    return match.group(1).strip() if match else ""


def run_checker(content, verify, formula=None):
    executable = Path(os.environ.get("STV_CHECKER", str(CHECKER)))
    if not executable.is_file():
        raise ModelError(f"Model checker not found: {executable}")
    with tempfile.TemporaryDirectory(prefix="stv-web-") as directory:
        workdir = Path(directory)
        (workdir / "model.txt").write_bytes(content)
        command = [str(executable.resolve()), "-f", "model.txt", "-m", "3" if verify else "1", "--OUTPUT_DOT_FILES"]
        if verify and formula is not None:
            command.extend(["--OVERWRITE_FORMULA", f"FORMULA: {formula}"])
        try:
            with tempfile.TemporaryFile(mode="w+b") as output:
                completed = subprocess.run(
                    command,
                    cwd=workdir,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    timeout=TIMEOUT_SECONDS,
                    check=False,
                )
                output.seek(0)
                log = output.read(128 * 1024).decode("utf-8", errors="replace")
        except subprocess.TimeoutExpired as exc:
            raise ModelError(f"Model checker timed out after {TIMEOUT_SECONDS} seconds.") from exc
        except OSError as exc:
            raise ModelError(f"Could not run model checker: {exc}") from exc
        if completed.returncode != 0:
            raise ModelError(f"Model checker failed (exit {completed.returncode}):\n{log.strip()}")

        result = None
        if verify:
            match = re.search(r"^Verification result:\s*(\S+)", log, re.MULTILINE)
            if not match or match.group(1) not in {"TRUE", "FALSE"}:
                raise ModelError(f"The checker did not report a TRUE or FALSE verification result:\n{log.strip()}")
            result = match.group(1) == "TRUE"

        global_path = workdir / "model-GlobalModel.dot"
        local_paths = sorted(workdir.glob("model-LocalModel_*.dot"))
        if not global_path.is_file() or not local_paths:
            raise ModelError(f"The checker did not produce the expected global and local models.\n{log.strip()}")
        graphs = [parse_graph(global_path, "Global model", "global")]
        graphs.extend(
            parse_graph(path, path.stem.removeprefix("model-LocalModel_"), "local")
            for path in local_paths
        )
        if result is not True:
            for graph in graphs:
                for edge in graph["edges"]:
                    if edge["data"]["kind"] == "strategy":
                        edge["data"]["kind"] = "normal"
        return {"graphs": graphs, "result": result}


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/assets/cytoscape.min.js")
def cytoscape():
    return send_from_directory(ROOT / "node_modules" / "cytoscape" / "dist", "cytoscape.min.js")


@app.post("/api/models")
def models():
    upload = request.files.get("file")
    action = request.form.get("action")
    if not upload or not upload.filename:
        return jsonify(error="Choose a model specification file."), 400
    if action not in {"generate", "verify"}:
        return jsonify(error="Choose a valid action."), 400
    content = upload.stream.read(MAX_INPUT_SIZE + 1)
    if not content or len(content) > MAX_INPUT_SIZE:
        return jsonify(error="The file must be non-empty and no larger than 2 MB."), 400
    try:
        specification = content.decode("utf-8")
    except UnicodeDecodeError:
        return jsonify(error="The model specification must be UTF-8 text."), 400
    formula = request.form.get("formula") if action == "verify" else None
    if formula is not None and (not formula.strip() or "\0" in formula or len(formula.encode("utf-8")) > MAX_FORMULA_SIZE):
        return jsonify(error="The formula must be non-empty, contain no null bytes, and be no larger than 32 KB."), 400
    try:
        result = run_checker(content, action == "verify", formula)
        if action == "generate":
            result["formula"] = extract_formula(specification)
        return jsonify(result)
    except ModelError as exc:
        app.logger.warning("Model checker request failed: %s", exc)
        message = "\n".join(
            line for line in str(exc).splitlines()
            if line != "Warning: could not open the config file 'config.txt', using the defaults"
        )
        return jsonify(error=message), 422


@app.errorhandler(RequestEntityTooLarge)
def too_large(_error):
    return jsonify(error="The file must be no larger than 2 MB."), 413


if __name__ == "__main__":
    app.run()
