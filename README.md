# STV model workbench

A Flask interface for generating and exploring global and agent-local models with
STV v2. Load a specification from a file or write or paste it in the
specification editor, generate the models, then view or edit the
formula before verifying it. The checker marks strategy transitions in red in the
global model when verification succeeds; blue transitions are shared actions.
Choose between force-directed, layered, circle and grid layouts. The selected
layout is used when switching models and can be reapplied with the rearrange
button. Drag states, zoom, fit the graph, and click an element for details.
Model statistics show the states and transitions in the selected graph and
the number of agents in the system. Parallel transitions are counted separately.

## Run on Linux

Requirements: Python 3.9+, Node.js and npm, and an executable Linux STV v2
binary at `model_checkers/stv_v2/stv`. The supplied checker is a Linux binary;
its required system libraries must also be available. The app does not invoke
WSL itself. On Windows, run the commands inside a Linux environment such as WSL.

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
flask --app app run
```

Open the address printed by Flask. To use another STV v2 binary, set the
`STV_CHECKER` environment variable to its absolute path before starting Flask.
A sample specification is in `model_checkers/stv_v2/sample_input/`.

The browser sends the current specification editor contents to the server for
each action. Changes remain in the app and are never saved to the original file;
they are lost on page reload. Editing the specification clears the previous
models and verification result, so generate again before verifying.
The editor highlights STV v2 scanner tokens, including section headers,
keywords, comments, numbers, and operators. Highlighting is not syntax
validation; STV reports errors when the model is generated or verified.
Each run uses an isolated temporary directory which is deleted afterwards.
Verification regenerates the models using the current specification and the
formula in the formula editor, passed to STV as an override. Enter only the
expression, without the `FORMULA:` prefix. Editing a verified formula clears the
previous result and strategy highlight until the new formula is verified. The
checker has a 120-second timeout and specifications are limited to 2 MB; graph
files are limited to 25 MB each. Transition labels are hidden on graphs with
more than 100 transitions, but remain available by selecting a transition.
Self-loop labels are placed outside the loop.
For graphs with at most 500 states and 1,500 transitions, self-loops are directed
toward gaps between incident transitions after a layout or node drag. At most
100 incident transitions per state are sampled; larger graphs retain
Cytoscape's default loop positioning for responsiveness.
The development server is intended for local, trusted use; do not expose it to
untrusted users without appropriate isolation, resource limits and authentication.

## Tests

```sh
python -m unittest discover -s tests
node --test tests/editor.test.cjs tests/stv-mode.test.cjs
```
