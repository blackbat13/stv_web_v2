# STV model workbench

A Flask interface for generating and exploring global and agent-local models with
STV v2. Upload a specification, generate the models, then verify the formula
included in the file. The checker marks strategy transitions in red in the
global model when verification succeeds; blue transitions are shared actions.
Drag states, zoom, fit or rearrange the graph, and click an element for details.

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

The browser sends the selected file to the server for each action. Each run
uses an isolated temporary directory which is deleted afterwards. Verification
regenerates the models using the same file and the formula it contains. The
checker has a 120-second timeout and input files are limited to 2 MB; graph
files are limited to 25 MB each. Transition labels are hidden on graphs with
more than 100 transitions, but remain available by selecting a transition.
The development server is intended for local, trusted use; do not expose it to
untrusted users without appropriate isolation, resource limits and authentication.

## Tests

```sh
python -m unittest discover -s tests
```
