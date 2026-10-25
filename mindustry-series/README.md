# Mindustry Series

Persistent agents play 1–100 consecutive PvP games of Mindustry v160.7. Each seat keeps
its agent session and notes between games; the native world resets with the same
map, rules and teams. The default is four seats playing three 10-minute PvP
games on **Harbor Ring** in two teams of two, followed by five minutes of team chat.

Built on [Mindustry](https://mindustrygame.github.io), created by Anuken and its contributors. See the [upstream game repository](https://github.com/Anuken/Mindustry).

![An agent-built base in a recorded 10v10 Mindustry Series game](images/pvp-base.png)

![The opposing core exploding in the same recorded PvP series](images/pvp-core-destruction.png)

*Our 10v10 Series rollout on Harbor Ring: the sharded base and destruction of the crux core.*

## Structure

```text
mindustry-series/
├── task.toml                 # Seats, verifier and collected artifacts
├── instruction.md            # Shared player instructions and PvP objective
├── config.json               # Seat count, series and recording settings
├── scripts/                  # Generate task, Compose and seat instructions
├── job.json                  # Four-seat Harbor job: harness, models and credentials
├── environment/
│   ├── Dockerfile            # Public dependencies and native runtime
│   ├── docker-compose.yaml   # Shared game, API gateway, agents and cameras
│   ├── plugin/               # Native game bridge and replay capture
│   ├── sim/                  # API, series lifecycle, evidence and grading
│   ├── renderer/             # Native spectator camera plugin
│   ├── seat-client/          # Per-seat recording and camera health
│   ├── render-recording/     # Render saved replays into additional views
│   ├── gateway/              # Authenticated API proxy
│   ├── seat-box/             # Agent workspace image
│   └── dependencies/         # Screen recorder and dependency notices
├── tests/
│   └── test.sh               # Production verifier entrypoint
└── solution/
    ├── solve.sh              # Oracle lifecycle probe, not a winning policy
    └── tests/                # Regression and native integration checks
```

## How it works

Each seat uses authenticated HTTP tools: `query` reads native state, `events`
reads its game log, `act` sends player inputs, `say` sends messages, and `wake`
selects events for `POST /wait`. `GET /brief` supplies the PvP objective and
`GET /update` supplies the current game, phase and player status. The generated
instruction documents the interface without prescribing strategy.

Game one waits for every agent and required camera. Between games the world and
chat history reset; agent sessions, notes and wake filters persist. After the last
game, `chat_after_sec` permits final chat before `game_over: true` tells agents to
stop. Harbor's collection hook waits for result and recording finalization.

Simulation artifacts include native logs, final results, per-seat MP4 recordings and replay segments. `environment/render-recording/`
renders recorded native packets into additional views without rerunning agents.

## Reward

The verifier reads native setup and final results. Each seat scores **1** if its
team has the most wins outright, **0.5** if tied for most wins, and **0** otherwise.
Timed games without a native winner are draws. The score measures series wins. No LLM judge is
used. Interrupted, missing or contradictory evidence fails verification without
numeric rewards.

`tests/test.sh` writes `/logs/verifier/reward.json` with per-seat rewards and
existing completion/win/draw metrics. Harbor returns this entire numeric dictionary;
`seat-N` keys are the corresponding seats’ scores, while `completed`,
`lobby_expired`, `games`, `wins_*` and `draws` are diagnostic dimensions, not
additional shared team scores. `series.json` records the game tally, and
`validity.json` records verification status.

For two teams of two, a single sharded win gives seats 1–2 a score of 1 and
seats 3–4 a score of 0; a single draw gives all four 0.5. In three games,
two sharded wins and one crux win give the same 1/0 seat scores. With three
teams, sharded and crux tied for most wins receive 0.5 each, while a lower
green team receives 0. Every teammate receives the same score, including
when team sizes differ.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes, for the default job | OpenAI API key used by each Codex participant running Luna. Export it in the shell running Harbor. |

Other agents use their provider's credentials. The game and verifier make no LLM calls. Harbor supplies `HARBOR_SEAT` and `HARBOR_SIM_URL` inside each agent container; the task generates per-trial authentication tokens mounted at `/run/mindustry/token`.

## Run

Requires Docker with Compose, Python 3.12+, Node.js 22 and [Harbor Multiagent](https://github.com/olamlabs/harbor-multiagent) revision
`4a194016336ccd1ce3fcc799b10158ca0375eb63` or a validated compatible revision.
The native runtime targets Linux amd64; Apple Silicon uses Docker emulation.

Install the pinned public runner with [uv](https://docs.astral.sh/uv/) 0.13.5 or newer:

```sh
uv tool install --python 3.12 "git+https://github.com/olamlabs/harbor-multiagent@4a194016336ccd1ce3fcc799b10158ca0375eb63"
```

This installs the `harbor` command. If another Harbor distribution is already installed through uv, add `--force` to replace it.

From the repository root:

```sh
cd mindustry-series
export OPENAI_API_KEY="your-openai-api-key"
python3 scripts/configure.py
harbor run -p . -c job.json
```

All commands below assume this task folder is your working directory. The default
job runs four Codex agents with `openai/gpt-6-luna` and high reasoning effort.
Harbor installs Codex in each agent container and configures API-key authentication.

Results, logs and recordings are saved under `jobs/<timestamp>/`. To name a run,
add a top-level `job_name` to `job.json`. Use a fresh name for each new run;
Harbor resumes an existing job when its configuration matches.

`config.json` controls the game; `job.json` controls the run and its participants.
For each participant, `name` selects the harness and `model_name` selects the
model. Adapter options such as `reasoning_effort` belong in `kwargs`; provider
credential references belong in `env`. Each seat can use a different supported
harness/model combination. Keep `${OPENAI_API_KEY}` in the job file and set the
actual key only in your shell.

Current Harbor Multiagent requires explicit participants for multi-seat tasks; the
single-agent `--agent` / `--model` flags do not fill these seats. It also requires
generated instruction files before loading the task.

### Other LLM providers

Provider support comes from the chosen Harbor agent adapter. For example, to use
[Claude Sonnet 4.6](https://platform.claude.com/docs/en/models/sonnet-4-6/overview)
through Claude Code and the direct Anthropic API, replace a participant in
`job.json` with:

```json
{
  "seat": "seat-1",
  "name": "claude-code",
  "model_name": "anthropic/claude-sonnet-4-6",
  "env": {
    "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
  }
}
```

Keep each participant's existing seat ID. Apply this to every participant for an
all-Claude team, or change individual seats to mix providers. Replace the entire
participant entry so Codex-specific options and credentials are not carried over.
From this task folder:

```sh
export ANTHROPIC_API_KEY="your-anthropic-api-key"
python3 scripts/configure.py
harbor run -p . -c job.json
```

Only seats still using OpenAI need `OPENAI_API_KEY`. Other providers require an
adapter that supports their API and credentials; changing the model prefix alone
is not sufficient. See [Harbor Multiagent](https://github.com/olamlabs/harbor-multiagent)
for available adapters. This example has been checked against the pinned runner's
configuration and adapter; it is not a reported Claude evaluation of this task.

### Match time, teams and number of games

Use `config.json` to save game settings and `job.json` to choose each seat's
harness, model and credentials. The configuration flags below are shortcuts that
update `config.json`; they are not temporary overrides for `harbor run`.

Edit `config.json`, then run `python3 scripts/configure.py` to apply changes.
The script regenerates Compose, the Harbor roster and seat instructions from
`instruction.md`. Its `--games` and `--seats` flags also update those two fields.
Changes persist in this checkout; rerunning the script does not reset defaults.
It does not edit `job.json`: its participants must match `seat-1` through
`seat-N` for the configured seat count.

| Setting in `config.json` | Meaning | Default |
|---|---|---|
| `settings.map` | Map used for every game; Harbor Ring generates the requested teams' bases | `"Harbor Ring"` |
| `settings.time_limit_sec` | Maximum seconds **per game**, from 10 to 86,400; `null` plays until a native victory | `600` (10 minutes) |
| `settings.games` | Number of consecutive games, 1–100; also `--games N` | `3` |
| `seats` | Total agents across all teams, 2–200; must match the team layout; also `--seats N` | `4` |
| `settings.team_count`, `settings.team_size` | Equal teams: set both, with `seats = team_count × team_size` | Both omitted: two equal teams, requiring an even seat count |
| `settings.chat_after_sec` | Team chat after the **last** game; `0` disables it | `300` (5 minutes) |

Starting from the default configuration and four-participant job, run exactly
one match followed by final chat:

```sh
python3 scripts/configure.py --games 1 --seats 4
harbor run -p . -c job.json
```

The first command prepares the task; the second launches it using the four
participants in `job.json`.

`settings.games` counts games within one series. `job.json`'s `n_attempts`
counts separate Harbor trials; leave it at `1` to run the series once.

For a **5v5, one-game match with a 30-minute limit**, merge these fields into
`config.json`, keeping any recording settings:

```json
{
  "seats": 10,
  "settings": {
    "map": "Harbor Ring",
    "team_count": 2,
    "team_size": 5,
    "games": 1,
    "time_limit_sec": 1800,
    "chat_after_sec": 300
  }
}
```

Update `job.json` to contain exactly `seat-1` through `seat-10`, each with a
harness, model and credential reference. Seats 1–5 form one team and seats 6–10
the other. Then prepare and launch the task:

```sh
python3 scripts/configure.py
harbor run -p . -c job.json
```

For unequal teams, use `settings.team_sizes`, such as `[1, 3]`, and remove
`team_count` and `team_size`; `seats` must equal the sum. PvP supports 2–6 teams, at most 100 agents per team
and 200 total. These are configuration limits, not tested capacity guarantees.

Set `settings.time_limit_sec` to `null` for untimed play. The 10-minute default
is a bounded example; it does not represent a calibrated duration for a decisive
PvP game. A game can finish earlier through victory; reaching its time limit
without a winner is a draw. With finite limits, the gameplay-and-chat budget is
`games × time_limit_sec + chat_after_sec`: 35 minutes by default, excluding setup,
world resets and artifact collection.

Harbor's process timeouts in `task.toml` are separate from the game clock.
`scripts/configure.py` gives `[agent]` and `[[verifier.collect]]` a minimum of
63,000 seconds (17.5 hours) each and raises them for longer finite series.
Untimed games still have those outer phase limits. A timeout or interruption
before all games finish leaves an unscored attempt. The verifier itself has a
600-second timeout; image builds have 3,600 seconds.

### Historical timing examples

These are development runs from October 2026 on Harbor Ring, **not an official
evaluation or runtime prediction**. Durations come from completed native game
results and exclude setup, final chat and collection. They used earlier task
revisions and different team sizes; the current release also includes subsequent
runtime and verifier fixes.

| Team sizes and configured models | Games | Per-game limit | Observed gameplay time |
|---|---|---|---|
| 2 Luna vs 2 Luna | 3 | 5 minutes | 5 minutes each; 15 minutes total, all draws |
| 10 Opus 5.5 vs 10 Sol 6.1 | 3 | None | 30m 15s, 1h 13m 49s, 47m 32s; 2h 31m 36s total |
| 50 Opus 5.5 vs 50 Sol 6.1 | 7 | None | 19m 40s–4h 16m 22s per game; 9h 29m total |

`settings.video` controls seat recordings and `settings.replay` controls native replay capture.
Choose resources appropriate to the roster and recordings.

To build locally without launching a trial:

```sh
docker compose -f environment/docker-compose.yaml build
```

Builds use public, checksum-pinned dependencies and require internet access;
no private game image or registry login is needed. Run trials through Harbor
so it mounts logs and invokes collection and verification.

## Tests

The native recorder regression (`solution/tests/native/screen-recorder.mjs`) checks one-camera and four-camera grids with FFmpeg. The replay-viewer check (`solution/tests/native/replay-viewer-state.mjs`) checks camera state when seeking between games. Run these inside the built runtime image, which supplies FFmpeg and the Mindustry JAR.

```sh
# From the task folder; Node.js 22 and JDK 17+ are required for regression tests.
node --test solution/tests/*.test.mjs
# Full Docker/Harbor integration using the uv-installed runner.
SMOKE_EVIDENCE=/tmp/mindustry-series-check \
  "$(uv tool dir)/harbor/bin/python" solution/tests/harbor_smoke.py
```

The checks cover game resets, recording integrity, failure handling and the full Harbor lifecycle.

## License

Source is GPL-3.0-only unless otherwise stated. See [LICENSE](LICENSE),
[NOTICE](NOTICE), and [dependency sources and licenses](environment/dependencies/SOURCES.md).
