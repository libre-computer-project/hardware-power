# Libre Computer Board Power

Which regulator feeds which rail, what switches it, and which rails are on
in each power state.

Companion to the GPIO pinout and the board layout. GPIO answers what a header
pin is. Layout answers where a part sits. This page answers what feeds what,
and when.

## Data

`data/boards.json` is the board index. `coverage` says what a board has:

| `coverage` | Board file | What the page shows |
|---|---|---|
| `model` | `data/<id>.json`, schema 2 | the power tree and its power states |
| `no-netlist` | `data/<id>.json` + `.nets.json`, schema 1, empty | a note that the tree needs the board's layout netlist |

A board or pinout-only row marked `hidden` (the pinout tool's pre-production
boards) is listed and opened only under `?hidden=1`, as in the GPIO and layout
tools. That is a menu filter, not access control, by decision (operator,
2026-11-01): `data/boards.json` names it and its files are published.

`data/lc-products.json` is VENDORED: each board's product page and 3D model,
shown beside the board picker, written by the shell kit's sync from
libre.computer's catalogue and checked by `tools/check-kit.py`.

### Schema 2

A state model of one board, written here by its generator.
`tools/gen-power-data.py` keeps a schema-2 file as it is. `tier` says where
the topology came from: `netlist`, the board's layout netlist; or
`transcribed`, read off the board's published schematic because it has no
layout netlist (the page says so beside the board's name).

| Key | Holds |
|---|---|
| `rails[]` | `id`, `name` (a net the layout site publishes), `v` (the nominal its name states, else null), `input` (the input label when power enters here), `made_by[]`, `loads` (SoC supply balls, connector pins, parts) |
| `makers[]` | `id`, `refdes`, `kind` (`buck`, `ldo`, `switch`, `link`, `protection`), `in`, `out`, `control` |
| `signals[]` | `id`, `role` (`enable`, `gate`), `driver` (`tie` to a rail, a SoC `pad`, a transistor `circuit`, or a `pull` up / down / divider) |
| `walks[]` | a named sequence of `steps`, each a stage with the state it lands in |
| `states[]` | `rails`: every rail `on`, `off`, or `x` -- not determined |
| `transitions[]` | the step from one state to the next |

`x` is drawn grey with no reason given. A rail is `x` when what switches it
cannot be settled from what is stated: a floating enable, a level between a
part's stated thresholds, or a driver the model does not cover.

## Checks

```
python3 tools/check-site.py --self-test   # the closed schema refuses each leak shape
python3 tools/check-site.py               # every published file
node tools/test-model.mjs                 # js/model.js on a fixture and on every board file
python3 tools/test-classify.py            # the rail-name grammar
python3 tools/check-kit.py                # the vendored shell kit
```

`check-site.py` holds a schema-2 file to a closed schema: every key is
named, and every string is an id, an enum value, or a name of a stated shape
(net, refdes, SoC pad). A path, a URL, a hex digest, a register name or free
text fails.

## Page

`js/model.js` is every decision the page makes about a board file, with no
DOM, so `tools/test-model.mjs` runs it under node. `js/app.js` paints.

| Query | Selects |
|---|---|
| `?board=` | the board |
| `?walk=`, `?step=` | the power state |
| `?rail=` | the rail in the detail panel |
| `?view=rails` | the rail table instead of the tree |

The tree puts each rail in a column by how many stages it sits from the
input. Selecting a rail fades every rail it neither depends on nor feeds
(`related()` in `js/model.js`): upstream through each maker's input and the
rails its enable is tied or pulled to, downstream through every maker that
takes it as input or control. A rail's edge colour is its voltage class; its state is the fill, the
dot and the word together, never colour alone. The arrow keys step through
the states.

Serve the directory over HTTP. Opening `index.html` as `file://` tells the
visitor to run `python3 -m http.server` instead of failing silently.
