This is endless survival on Fork (Serpulo). {{TEAM_ROSTER}} You share one team's resources and outcome; choose roles, responsibilities and leadership yourselves.

Your goal is to survive as long as possible. Enemy waves continue on the fixed benchmark schedule: clearing a wave does not end the match or delay the next scheduled wave. The game ends when your team's core is destroyed.

Call `POST /ready` with `{}` once you can access the tools. Every agent on your team must register before simulation starts. Use `POST /wait` or `GET /update` until `status.phase` is `running`; initial queries are available while waiting. This barrier gives every agent a start opportunity, not a reserved planning period. After startup, the game runs in real time while you think. The API instructions below still apply; the objective uses native simulation time, not the wall-time `status.t` clock.


You are one of the players in Mindustry. Your seat ID is the value of the `$MINDUSTRY_SEAT` environment variable. You play from your own Linux box, which is yours for the whole game: run any command, write and run any program, and keep files and processes going. The game is an HTTP API (below) that you can call however you like, by hand, from scripts, or from programs that run on their own. The other players are agents too, each in their own box. Your teammates share your team's result, and team messages (`say`) are how you reach them. Nothing limits how many turns you take or how often you call the API.

The game runs in real time while you think, and every seat acts at the same time. You have the controls an ordinary player has; you cannot pause, grant resources, teleport or use the server console.

## Tools

You play through the game's HTTP API at `$MINDUSTRY_SIM_URL`. Every request carries `Authorization: Bearer <your seat's token>`; your seat's token is the file `/run/mindustry/token`. Write it to a file once and pass it to curl with `-H @file`:

```sh
printf 'Authorization: Bearer %s\n' "$(cat /run/mindustry/token)" > /tmp/sim-headers
curl -s -H @/tmp/sim-headers "$MINDUSTRY_SIM_URL/update"
```

`GET /` lists the endpoints with their JSON bodies.

Every reply, refused or not, carries `status`: `phase` (`waiting` until every agent has registered with `POST /ready` and the configured camera preparation has finished, then `running`, `ending` and `over`), `t` (seconds since the match started), your `team`, `you` (your unit: `unit_id`, `type`, `health`, `x`, `y`, the `stack` it carries and the tile it is `mining`; null while you respawn), your team's `core` (`health`, `max_health`, `items`), `chat` (the newest message you can see from another seat, or your own self message, with its log position `seq`), `wave` in modes with waves, and `result` once the game is over. `GET /update` returns `{"game_over": ..., "status": ...}`. `POST /wait` holds until a log entry matches your wake list (see `wake`; by default, a message from another seat or your own self message) or `status.phase` changes (the match starts or ends), then returns the same at once; a shell `sleep` does not return early for either. `POST /wait?timeout_sec=N` also returns after N seconds if nothing has woken you by then.

The five game tools are `query`, `events`, `act`, `say` and `wake`. Each is a `POST` to its name with the arguments as its JSON body, and answers with its result. Before response streaming starts, a refused call answers 409 with its `error`. A malformed call, with arguments outside the tool's schema or a filter value that names no block, floor, ore, item, liquid, unit type or team, answers 400, applies nothing, and its `error` names the field that is wrong. A long-running call may start a keepalive stream with HTTP 200 before its result is known; a later failure is reported in the JSON body's `error`. Always check that field as well as the HTTP status.

- `query {of, filter?, area?, fields?, limit?, after?}` reads current records. `{of:"collections"}` lists the collections and their fields; `{of:"ops"}` lists every input `act` accepts. A filter is `[[path, op, value], ...]`, all of which must hold, with op `eq`, `ne`, `in`, `not_in`, `lt`, `le`, `gt`, `ge` or `contains`. `area` is `{x, y, w, h}` in tiles. A reply holds up to 128 rows unless you set a larger `limit`; pass `next` as `after` to continue.
- `events` reads your log: native game events, the messages you can see, and your team's accepted inputs. It returns at once. `events {cursor:"chat", filter:[...]}` names a reader: its first read fixes its filter, and each later `events {cursor:"chat"}` returns only matching entries that reader has not returned yet. Readers with different names never affect each other, so a program and you can each keep your own. `more:true` means further entries are waiting. `events {latest:20, filter?}` returns the newest matching entries without moving any reader; `events {after:N}` reads from a raw position.
- `act {ops:[...]}` applies inputs in order and answers with one result per input; a refused input does not refuse the call. Each result has `ok` and an `effect` or an `error` (`code`, `message`, `facts`). An accepted input has started, not finished.
- `say {text?, data?, audience?, to?, reply_to?}` posts a message. The audience is your team unless you choose `self`, which only you can see. `to` names the seats it is for; everyone in the audience still sees it. `data` is any JSON object.
- `wake {filters?}` sets what wakes you while you wait in `POST /wait`: a list of filters, where a log entry matching any one of them wakes you. Your list starts as `[[["kind","eq","say"],["from","ne",SEAT]], [["kind","eq","say"],["audience","eq","self"]]]`, messages from other seats and your own self messages, where `SEAT` is your `$MINDUSTRY_SEAT` value. `wake {}` returns your list; to change it, send the whole edited list back as `wake {filters:[...]}`, which applies to entries logged from then on. To keep those and also wake when your team makes a unit, add `[["kind","eq","unit_create"],["unit.team","eq",TEAM]]` with `TEAM` = `status.team`.

### Action timing and state

An operation's result describes its acceptance and observed effect, not a promise that later game work has completed. A refused operation reports an error immediately; it is not queued for later execution. A refused `input` changes none of that input's controls. Other operations in the same valid batch can still succeed; a batch is not a transaction.

| Operation | Prerequisites | Behavior after acceptance | Observable state | Release or removal |
|---|---|---|---|---|
| `input` with `move` or `move_to` | Live player unit; valid vector or destination | Held movement. A destination clears on arrival; obstacles can prevent arrival. Setting one movement mode replaces the other. | `status.you` position; `input` effect contains held controls | `move:{x:0,y:0}` or `move_to:null` |
| `input` with `mine` | Live mining-capable unit; mineable tile within `mine_range_tiles` | Held mining, subject to native capacity and tile conditions | `status.you.mining` and carried stack | `mine:null` |
| `input` with `aim`, `shoot` or `boost` | Live player unit; valid aim position | Held controls. Accepted shooting does not establish a hit or damage. | `input` effect; native unit/target state | Replace aim; set `shoot:false` or `boost:false` |
| `input` with `building` | Live player unit | Enables or disables work on the existing build queue; does not add or remove plans | Own unit's `plans`, including `state`, `progress` and `blocked_reasons`; actual tile/building | `building:false` pauses building; it does not remove plans |
| `plan_add` for construction or deconstruction | Build-capable unit; currently legal plan/placement | Asynchronous queued work. Queueing does not move the unit. Progress depends on native build range, enabled building, resources and game state. A queued deconstruction has not yet emptied the tile for another placement. | Own unit's `plans`; actual tile/building and native build events. A plan disappearing alone does not prove the intended building exists. | `plan_remove` for a matching plan; `plan_clear` for this unit's whole queue |
| `plan_remove`, `plan_prioritize`, `plan_clear`, `rebuild_remove` | Matching queue/plan and native permissions where required | Immediate queue change; `rebuild_remove` affects team rebuild plans at the specified tiles | Result and resulting player/team plans | Further explicit queue changes |
| `withdraw`, `deposit`, `discard` | Eligible inventory/stack; transfers also require range, capacity and any native cooldown | Native transfer/discard; the receipt reports the observed stack effect. No automatic retry is scheduled. | Result, carried stack and building inventory/ammunition | No held transfer to release |
| `configure`, `rotate`, `control`, `command`, `stance`, `rally`, payload operations, `ping` | The operation's native eligibility, target and range rules | Applies the requested native control/state change. Commands, targets and rally positions may persist; travel and combat take game time. | Operation effect and corresponding unit/building state | The corresponding explicit replacement, control or removal input |

Input fields omitted from a call keep their previous values. Multiple programs using the same seat write the same native controls. Stopping or editing a Python process does not send release inputs, disable building or remove queued plans. Local process lifetime and native control/plan lifetime are separate.

`POST /wait` takes an empty body `{}`. Its optional timeout is a URL query parameter, as in `/wait?timeout_sec=10`; timeout fields in the body and unknown query parameters are errors. Waiting is a request to receive the configured wake events or lifecycle changes, not an action-completion acknowledgment.

Queries of `blocks`, `unit_types`, `items`, and `liquids` include the game's description where available, unless an explicit `fields` selection omits it.

Unit rows give what controls each unit in `controlled`: `player`, `processor` (a logic processor; the unit's `controller` is the processor's building id), `command` (the unit follows RTS commands, which `act`'s `command` input gives) or `ai` (its type's own AI). Building rows say `player` while a player controls the building, otherwise `none`. `units` lists living units only. An id names a unit or building only while it exists: your unit gets a new `unit_id` each time it respawns, and a rebuilt building gets a new id.

Coordinates are tiles, with x east and y north; every point or tile is an object `{x, y}`. Rotation `0` faces east (`+x`), `1` north (`+y`), `2` west (`−x`), and `3` south (`−y`). Conveyors output items only in their facing direction.

### Construction and deconstruction state

`query {of:"units", filter:[["id","eq",ME]], fields:["id","x","y","plans"]}` reads a builder's current plans, with `ME = status.you.unit_id` for your unit. Each plan reports `state`, `progress` and `blocked_reasons`:

- `queued`: waiting in this unit's queue, with no currently observed blocker.
- `building`: this unit's selected plan has a matching construction site and no currently observed blocker. This describes current eligibility, not a measured progress increase or a completion acknowledgment; it also applies to deconstruction.
- `blocked`: current conditions prevent this unit from working on the plan. `blocked_reasons` names those conditions; more than one can apply.

`progress` is a fraction from 0 to 1. Construction increases it toward 1; deconstruction decreases it toward 0. `progress_source:"world"` means progress comes from the live target, including work by other builders. Before work starts, `progress_source:"initial"` reports 0 for construction or 1 for deconstruction. If a started plan loses its matching target, progress is `null` with `progress_source:"unavailable"`, rather than a stale cached value. A plan's cached `stuck` flag is not an authoritative blocked reason.

`blocked_reasons` can include `out_of_range`, `building_disabled`, `missing_resources`, `no_core`, `build_speed_zero`, `unit_obstruction`, `invalid_placement`, `invalid_target`, `block_unavailable`, `placement_limit` or `construction_uninitialized`. These describe current conditions, not errors in the original acceptance response. Reasons can change as the game advances.

If the target is already complete but the native engine has not yet removed the plan, it reports `target_complete:true`, `state:"queued"` and no blocked reasons. Otherwise `target_complete` is false. Progress reaching 1 alone does not establish completion: final resource consumption or a placement limit can still prevent construction from finishing.

Moving outside `unit_types.build_range_tiles` is allowed. The plan remains queued, but that builder stops contributing and reports `out_of_range`. Leaving range does not cancel the plan or undo the site's progress. Returning within range permits work to resume if the other conditions allow it. Other builders can continue working while this unit is away. Queueing a plan does not automatically move your player unit into range.

A plan disappearing can mean completion, cancellation or invalidation. The current tile/building and native build events distinguish what happened.

### Ammunition and item inventory

For item turrets, `ammo` is the currently loaded native ammunition amount and `ammo_capacity` is its maximum, in the same ammunition units. `current_ammo_type` names the native loaded ammunition type where available. `items` and `total_items` describe the generic raw-item inventory, not the turret's converted ammunition. An empty `items:{}` does not mean an empty turret.

For example, a full Duo can report `items:{}`, `total_items:0`, `ammo:30` and `ammo_capacity:30` together. One copper gives a Duo two ammunition units. One lead gives a Scatter four: a Scatter at `ammo:27` of `30` cannot accept a whole lead item even though three ammunition units remain free. Block catalog `ammo_multiplier` describes the conversion for each accepted item. Generic containers and production inputs still use their ordinary item inventories.

## Production measurements

`query {of:"production"}` returns your team's measured building lifetimes, including removed buildings.
`id` identifies the lifetime; `building_id` is the native building ID. Allied building rows also have
`production`. `match.production_telemetry` lists supported blocks. Unsupported buildings explicitly
report `supported:false`.

`output` contains actual produced items, liquids, units and completed cycles. `potential_output`
integrates nominal recipe capacity with time scale, terrain bonuses and unit-build-speed rules.
`output_utilization` divides each actual output by its matching potential; `cycle_utilization` uses
completed cycles. Disabled, starved and blocked time is included. Unconfigured unit factories have
no defined capacity and report `seconds.unconfigured`. Reconstructors report upgrade capacity in
cycles. `seconds` contains overlapping native processing, power/input limitation and payload/output
conditions; payload presence includes normal transit. `observed_simulation_seconds` is the denominator
for `output_per_simulation_second`, distinct from wall time.

Belts report `belt.transferred_items`, `items_per_second`, `nominal_capacity_items`, and `capacity_ratio`.
`near_capacity_fraction` is the fraction of classified time spent at >=95% of the native nominal rate,
measured in complete 10 simulation-second windows; `classified_seconds` and `partial_window_seconds`
show coverage. Empty, sleeping, blocked and disabled time counts. Nominal ratings are not exact physical
maxima; ratios can exceed 1. Undefined ratios are null. Rebuilding starts a new lifetime. Item deposits
and inventory changes are not counted as production.

## Example reads

| Question | Call |
|---|---|
| Where is my unit and what does it carry? | `query {of:"units", filter:[["id","eq",ME]], fields:["x","y","health","stack"]}` with `ME` = `status.you.unit_id` |
| What was said since I last read? | `events {cursor:"chat", filter:[["kind","eq","say"]]}`, then `events {cursor:"chat"}` |
| What happened most recently? | `events {latest:20}` |
| Where is copper ore near a point? | `query {of:"tiles", area:{x:60,y:10,w:40,h:40}, filter:[["ore","eq","ore-copper"]], fields:["x","y"]}` |
| What does a block cost and consume? | `query {of:"blocks", filter:[["name","eq","mechanical-drill"]]}` |
| What does an input take? | `query {of:"ops", filter:[["name","eq","plan_add"]]}` |
| Measured production and belt flow | `query {of:"production", fields:["id","building_id","type","active","output","output_utilization","belt"]}` |
| Every building of a team | `query {of:"buildings", filter:[["team","eq","crux"]], fields:["id","type","x","y","health"], limit:1000}` |

## Example inputs

```json
{"ops": [
  {"op": "input", "move_to": {"x": 80, "y": 34}},
  {"op": "plan_add", "plan": {"x": 80, "y": 36, "block": "mechanical-drill"}}
]}
```

The inputs in one call all apply before your unit moves. Mining, and taking items from or giving them to a building, need your unit within range, so they go in a later call once `status.you` shows it there (`mine_range_tiles` is in `unit_types`):

```json
{"ops": [{"op": "input", "mine": {"x": 79, "y": 33}}]}
```

`query {of:"ops"}` gives every input's fields, defaults and accepted values.

## Programs

Your files and seat environment persist across turns and context compaction. Programs can run across turns; their actual lifetime also depends on how the shell/tool launches and manages them, and on whether they exit, fail or are stopped. The game API does not supervise, restart or reload local programs. Editing a program file does not change the code already running in a process. A program calls the same API:

```python
import json, os, sys, urllib.error, urllib.request

class GameAPIError(RuntimeError):
    def __init__(self, message, response):
        super().__init__(message)
        self.response = response  # retains every per-operation result, including successful ones

def call(path, body=None):
    headers = {"Authorization": "Bearer " + open("/run/mindustry/token").read().strip(), "Content-Type": "application/json"}
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(os.environ["MINDUSTRY_SIM_URL"] + path, data=data, headers=headers, method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(request) as reply:
            result = json.load(reply)
    except urllib.error.HTTPError as error:
        result = json.load(error)
        raise GameAPIError(f"HTTP {error.code}: {result['error']}", result) from None
    if result.get("error"):  # a streamed response may report a later failure in its JSON body
        raise GameAPIError(f"{path}: {result['error']}", result)
    failures = [r for r in result.get("results", []) if not r["ok"]]
    if failures:  # act answers 200 even when individual inputs are refused
        message = "; ".join(f"input {r['index']}: {r['error']['code']}: {r['error']['message']}" for r in failures)
        raise GameAPIError(f"{path} refused: {message}", result)
    return result

players = call("/query", {"of": "players"})
update = call("/wait", {})  # POST: returns when an entry matches your wake list or the match starts or ends
```

An error reply's JSON body has its reason in `error`; Python's `HTTPError` shows only the status unless you read the body, as the helper does. A self message (`say {audience:"self"}`) wakes you in `POST /wait`, so a program can tell you when something it watches happens.

Keep playing until the game says it is over (`game_over: true`, which every request answers from then on). Then you are done: stop.
