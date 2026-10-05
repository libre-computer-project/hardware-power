# Libre Computer Board Power

Which regulator feeds which rail.

Companion to the GPIO pinout and the board layout. GPIO answers what a header
pin is. Layout answers where a part sits. This page answers what feeds what.

## Schema 1

`data/<id>.json` is one graph. `kind` on a node is the discriminator. There is
no control node: enable, PWM, and power-good are tags on the flow edge they
belong to. `shape` (`discrete`, `hybrid`, `pmic`, `empty`, `pending`) is the
picker line. The drawing follows whether the graph contains a `pmic` node.

A board with no netlist, and a board whose nets are unnamed, is an empty graph.
A part with no pin list is `unresolved`, not an edge. A regulator-to-rail edge
exists only when a pin list joins both ends.

## Classifier

`tools/classify.py` is the ordered name classifier: what is a rail, what is a
control tag, what is dropped, and which group and colour a rail takes.
`tools/test-classify.py` runs `tools/fixtures/classify.json` against that module.

```
python3 tools/test-classify.py
```

## Graphs

`tools/graph.py` builds one schema-1 graph from a layout document. A
regulator-to-rail edge exists only when a pin name joins both ends. A part
with no pin list is `unresolved`. Connector membership uses the published pad
coordinates. A board with no nets, and a board whose nets are unnamed, is an
empty graph.

```
python3 tools/gen-power-data.py
python3 tools/test-graph.py
```

## Page

One page, two readings of one graph. Tree is the default. Rails lists every
rail and every channel, with EN, PWM, and PG as columns. `?board=` selects a
board and `?rail=` selects a rail or a control net. `?view=` is not a permalink.

`defaultOpen` follows whether the graph contains a `pmic` node. It does not
read `shape`. A discrete graph opens first-stage regulators and collapses
loads. A graph with a PMIC draws one frame, channel groups collapsed, and any
external regulators outside that frame. A PMIC graph with no external
regulators uses the same frame and draws no external column.

The three fixtures under `tools/fixtures/` (`discrete.json`, `hybrid.json`,
`pmic.json`) are paint inputs. They are not board ids and they are not in
`data/`.

```
python3 tools/test-classify.py
node tools/test-paint.mjs
python3 tools/check-site.py
python3 tools/check-kit.py
```

Serve the directory over HTTP. Opening `index.html` as `file://` tells the
visitor to run `python3 -m http.server` instead of failing silently.
