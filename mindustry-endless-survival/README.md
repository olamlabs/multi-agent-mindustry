# Mindustry Endless Survival

A cooperative Harbor Multiagent task: 1–20 agents defend one core on Mindustry's Fork map against endless waves. Each agent has its own workspace and controls a player in the same native game. The team's score is how many minutes it survives.

Built on [Mindustry](https://mindustrygame.github.io), created by Anuken and its contributors. See the [upstream game repository](https://github.com/Anuken/Mindustry).

![A developed agent-built base during a 20-agent survival rollout](images/survival-base.png)

*Our historical 20-agent survival rollout at wave 16*

## Structure

```text
mindustry-endless-survival/
├── task.toml                 # Seats, verifier and collected artifacts
├── instruction.md            # Shared agent instructions and HTTP API examples
├── config.json               # Version, seat count, briefing and game settings
├── scripts/                  # Configure the task, prepare instructions and preflight jobs
├── job.json                  # Two-seat Harbor job: harness, models and credentials
├── environment/
│   ├── Dockerfile            # Public dependencies and native runtime
│   ├── docker-compose.yaml   # Shared game, API gateway, agents and cameras
│   ├── plugin/               # Native game bridge and survival rules
│   ├── sim/                  # API, lifecycle, evidence and deterministic grading
│   ├── task-runtime/         # Scenario contract, startup and collection
│   ├── renderer/             # Game client plugin for recording
│   ├── seat-client/          # Per-seat recording and camera health
│   ├── gateway/              # Authenticated API proxy
│   ├── seat-box/             # Agent workspace image
│   └── dependencies/         # Screen recorder and dependency notices
├── tests/
│   └── test.sh               # Production verifier entrypoint
└── solution/
    ├── solve.sh              # Oracle sanity check, not a winning strategy
    ├── run.sh                # Host-side integration test with two fresh worlds
    └── tests/                # Regression tests and native fixtures
```

## How it works

`environment/renderer/` is a small plugin for the native Mindustry game client. It follows each agent’s player so the recording sidecar can capture that seat’s view. `seat-client/` manages those client processes and video files. Agents control the game through the HTTP API; the camera plugin provides recordings for inspecting runs.

Agents join a readiness barrier, then use the HTTP API to inspect the world, move, build, mine and communicate. The game runs until the core is destroyed. If agents stop first, collection lets the native game finish before verification.

`instruction.md` is the only checked-in instruction source. `scripts/configure.py`
also prepares the ignored `instructions/seat-N.md` files required by Harbor
Multiagent. Run it before launching from a fresh clone or after changing settings
or instructions.

## Reward

The verifier validates native core-loss evidence and writes elapsed seconds divided by 60 to **`/logs/verifier/reward.json`**. For two seats surviving 12.5 minutes:

```json
{"reward": 12.5, "seat-1": 12.5, "seat-2": 12.5}
```

`reward` is the team outcome; each seat receives the same value. Do not sum these fields or treat seats as independent trials. Compare teams at the same roster size and settings. Scores are minutes, not normalized probabilities or binary success values.

Missing or contradictory evidence is an invalid, unscored attempt. Stopping a game while its core is alive is censored, not a completed survival score. The verifier removes stale rewards before grading. Details go to `survival-outcome.json` and `metrics.json` beside the reward file.

The verifier writes Harbor's standard JSON format directly. No LLM judge or Rewardkit dependency is needed.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes, for the default job | OpenAI API key used by both Codex participants running Luna. Export it in the shell running Harbor. |

Other agents use their provider’s credentials. The game and verifier make no LLM calls. Harbor supplies seat identities and the task generates API tokens automatically; no game-service credentials are needed.

## Run

Requires Docker with Compose, Python 3.12+, Node.js 22 and [Harbor Multiagent](https://github.com/olamlabs/harbor-multiagent) revision `4a194016336ccd1ce3fcc799b10158ca0375eb63` or a validated compatible revision. The native runtime targets Linux amd64; Apple Silicon uses Docker emulation.

Install the pinned public runner with [uv](https://docs.astral.sh/uv/) 0.13.5 or newer:

```sh
uv tool install --python 3.12 "git+https://github.com/olamlabs/harbor-multiagent@4a194016336ccd1ce3fcc799b10158ca0375eb63"
```

This installs the `harbor` command. If another Harbor distribution is already installed through uv, add `--force` to replace it.

From the repository root:

```sh
cd mindustry-endless-survival
export OPENAI_API_KEY="your-openai-api-key"
python3 scripts/configure.py
harbor run -p . -c job.json
```

All commands below assume this task folder is your working directory. The default
job runs two Codex agents with `openai/gpt-6-luna` and high reasoning effort.
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

Current Harbor Multiagent requires explicit participants for multi-seat tasks;
the single-agent `--agent` / `--model` flags do not fill these seats. The default
job has `n_attempts: 1`, so it launches one survival match.

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

### Team and wave configuration

Use `config.json` to save game settings and `job.json` to choose each seat's
harness, model and credentials. The configuration flags below are shortcuts that
update `config.json`; they are not temporary overrides for `harbor run`.

Edit `config.json`, then run `python3 scripts/configure.py` to validate it and
regenerate Compose, the Harbor roster and seat instructions. The script does not
edit `job.json`: its participants must match `seat-1` through `seat-N` for the
configured seat count.

| Setting | How to set it | Release default |
|---|---|---|
| Team size | `python3 scripts/configure.py --seats N`, with 1–20 seats; update the job's participants to match `seat-1` through `seat-N` | 2 seats |
| Team models | Set `model_name` for each participant in `job.json`; `name` selects that seat's harness | Codex with `openai/gpt-6-luna` and high reasoning effort for both seats |
| Wave schedule briefing | `--wave-schedule-briefing` reveals the schedule in agent instructions; `--no-wave-schedule-briefing` hides it | Off (`wave_schedule_briefing: false`) |

Our previous survival runs used `wave_schedule_briefing: false`: agents were not
given the wave schedule in their instructions. This remains the default. To
opt in, run `python3 scripts/configure.py --wave-schedule-briefing`; to hide it
again, use `--no-wave-schedule-briefing`.

The default first wave arrives after **4 minutes** of native simulation time, then waves arrive **every 2 minutes**, regardless of whether earlier enemies have been cleared. `config.json` stores these as `settings.endless_survival.first_wave_ticks: 14400` and `wave_spacing_ticks: 7200` at 60 ticks per simulation second. The briefing flag changes only what agents are told, not wave timing or difficulty.

The match explicitly uses **Fork**, map and spawn seed **1**,
and enemy health/damage multipliers **1**. These are the same gameplay settings
used in our earlier two- and four-agent survival runs. `settings.time_limit_sec`
is `null`: the match ends at core loss. Harbor separately permits 63,000 seconds
(17.5 hours) for each agent, collection and verifier phase. Those phase limits
are not a completed-survival horizon; a run cut short while the core is alive
remains unscored.

For four seats with the default hidden schedule, first update `job.json` to
contain `seat-1` through `seat-4`, each with a harness, model and credential
reference. Then prepare and launch the task:

```sh
python3 scripts/configure.py --seats 4 --no-wave-schedule-briefing
harbor run -p . -c job.json
```

To switch back to two seats with the schedule hidden, run
`python3 scripts/configure.py --seats 2 --no-wave-schedule-briefing` and restore
the two-participant job. Other settings remain unchanged. Configuration writes
persist in this checkout; rerunning the script does not reset defaults.

To build locally without launching a trial:

```sh
docker compose -f environment/docker-compose.yaml build
```

Builds use public dependencies and require internet access, with no private image or registry login. Run trials through Harbor so it mounts logs and invokes collection and verification. The default simulation requests 8 CPUs/8 GiB; each agent and camera requests 2 CPUs/2 GiB. Start with a small roster.

`environment/sim/metrics.mjs` summarizes native production, resource flow, stockpiles, combat and progression into `metrics.json` in the verifier and simulation logs. These diagnostics help explain a run; they do not add reward dimensions or change the shared survival score. Missing measurements are reported explicitly.

Only endless survival on Fork is supported; PvP, attack, sandbox and finite-duration games are rejected.

## Tests

The native recorder regression (`solution/tests/native/screen-recorder.mjs`) checks one-camera and four-camera grids with FFmpeg. Run it inside the built runtime image.

```sh
python3 -m unittest discover -s solution/tests -p 'test_*.py'
node --test solution/tests/*.test.mjs
HARBOR_PYTHON="$(uv tool dir)/harbor/bin/python" \
  sh solution/run.sh --output /absolute/path/to/new-evidence-directory
```

The integration test creates two fresh two-seat Docker worlds and checks the documented client, movement, team chat, isolation, native core loss, evidence export and reward validation. It makes no paid model calls. For an Oracle sanity run, set every job participant to `name: "oracle"` and omit model credentials.

Fast regression tests stay at `solution/tests/`; shared data and process helpers live in `fixtures/`. The `native/` folder contains real-engine checks: `run-survival.sh` checks waves and core loss; `run-check.sh api|telemetry|evaluation` checks player actions and native counters; `renderer.mjs` and `construction.mjs` check recorded video and building through the agent API. Run these checks in the built runtime image. For example:

```sh
docker build -f environment/Dockerfile --platform linux/amd64 --target runtime -t endless-runtime .
docker run --rm --platform linux/amd64 -v "$PWD:/task:ro" endless-runtime \
  sh /task/solution/tests/native/run-check.sh api
```

## Limitations

This task uses Docker Compose; other sandbox backends need separate validation. Package and base-image updates mean builds are not fully byte-reproducible.

## License

Task code is GPL-3.0-only except separately identified dependencies. See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md) and [dependency sources](environment/dependencies/SOURCES.md). Mindustry bundles the Arc framework, which retains its Apache-2.0 license; `ARC-LICENSE` preserves that notice. Distributing built images or JARs also requires providing the corresponding source described in `NOTICE.md`.
