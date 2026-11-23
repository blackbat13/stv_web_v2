const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

let mode;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "static", "stv-mode.js"), "utf8"),
  { CodeMirror: { defineMode(_name, factory) { mode = factory(); } } }
);

function tokenize(line) {
  const result = [];
  const stream = {
    pos: 0, start: 0,
    match(pattern) {
      const match = line.slice(this.pos).match(pattern);
      if (!match) return false;
      this.pos += match[0].length;
      return match;
    },
    current() { return line.slice(this.start, this.pos); },
    next() { return line[this.pos++]; },
  };
  while (stream.pos < line.length) {
    stream.start = stream.pos;
    const style = mode.token(stream);
    if (style) result.push([stream.current(), style]);
  }
  return result;
}

test("highlights scanner keywords, identifiers, sections and comments", () => {
  assert.deepEqual(tokenize("Agent Agent1 shared empty init LOCAL: INITIAL: PERSISTENT: FORMULA: # -> 12"), [
    ["Agent", "keyword"], ["Agent1", "variable"], ["shared", "keyword"], ["empty", "keyword"],
    ["init", "keyword"], ["LOCAL:", "meta"], ["INITIAL:", "meta"], ["PERSISTENT:", "meta"],
    ["FORMULA:", "meta"], ["# -> 12", "comment"],
  ]);
});

test("recognizes exact scanner operators, probabilities and invalid characters", () => {
  assert.deepEqual(tokenize("&K_A &H_B &P[<=.5] &REST x:=1 -> q || y!=2 && z>=3"), [
    ["&K_", "keyword"], ["A", "variable"], ["&H_", "keyword"], ["B", "variable"],
    ["&P", "keyword"], ["[", "bracket"], ["<=", "operator"], [".5", "number"], ["]", "bracket"],
    ["&REST", "keyword"], ["x", "variable"], [":=", "operator"], ["1", "number"],
    ["->", "operator"], ["q", "variable"], ["||", "operator"], ["y", "variable"],
    ["!=", "operator"], ["2", "number"], ["&&", "operator"], ["z", "variable"],
    [">=", "operator"], ["3", "number"],
  ]);
  assert.deepEqual(tokenize("shared2 _name . @"), [
    ["shared2", "variable"], ["_", "error"], ["name", "variable"], [".", "error"], ["@", "error"],
  ]);
});
