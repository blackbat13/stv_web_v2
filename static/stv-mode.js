CodeMirror.defineMode("stv", () => ({
  token(stream) {
    if (stream.match(/^[ \t\r]+/)) return null;
    if (stream.match(/^#[^\n]*/)) return "comment";
    if (stream.match(/^(?:LOCAL|INITIAL|PERSISTENT|FORMULA):/)) return "meta";
    if (stream.match(/^&(?:K_|H_|P|REST)/)) return "keyword";
    if (stream.match(/^(?:[0-9]*\.[0-9]+|[0-9]+)/)) return "number";
    if (stream.match(/^[a-zA-Z][_a-zA-Z0-9]*/)) {
      return /^(?:Agent|shared|empty|init)$/.test(stream.current()) ? "keyword" : "variable";
    }
    if (stream.match(/^(?:->|:=|\|\||&&|==|!=|>=|<=|[><!+\-*/%])/)) return "operator";
    if (stream.match(/^[\[\]():,]/)) return "bracket";
    stream.next();
    return "error";
  }
}));
