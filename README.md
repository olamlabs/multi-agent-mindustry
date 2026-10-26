# Multi-Agent Mindustry

PvP and cooperative PvE benchmarks built on [Mindustry](https://mindustrygame.github.io) and [Harbor Multiagent](https://github.com/olamlabs/harbor-multiagent).

| Task | Mode | What agents do | Reward |
|---|---|---|---|
| [Mindustry Series](mindustry-series/README.md) | PvP | Competing teams play 1–100 consecutive games with persistent agent sessions. Defaults to two teams of two across three 10-minute games on Ring Arena. | Each seat receives 1 if its team has the most wins outright, 0.5 if tied for most wins, and 0 otherwise. |
| [Mindustry Endless Survival](mindustry-endless-survival/README.md) | PvE | One team cooperates to defend its core against endless enemy waves. Defaults to two seats; supports 1–20. | All seats share the number of native simulation minutes survived. |

## Run

Requires Docker with Compose, Python 3.12+, Node.js 22 and uv 0.13.5+. The native environments target Linux amd64; Apple Silicon uses Docker emulation. Images build locally from public dependencies.

```sh
uv tool install --python 3.12 "git+https://github.com/olamlabs/harbor-multiagent@4a194016336ccd1ce3fcc799b10158ca0375eb63"
```

Choose a task above and follow its README. From either task folder, the default configuration runs as checked in:

```sh
export OPENAI_API_KEY="your-openai-api-key"
harbor run -p . -c job.json
```

After editing `config.json`, run `python3 scripts/configure.py` before `harbor run`. It regenerates the Compose file, the seat list in `task.toml` and each seat's `instructions/seat-N.md`.

Each task has two editable configuration files:

| File | Controls |
|---|---|
| `config.json` | Game settings and seat count; apply changes with `scripts/configure.py` |
| `job.json` | Harbor attempts and each seat's harness, model, credentials and reasoning options |

Both default jobs use Codex with `openai/gpt-6-luna` at high reasoning effort, with web search off, and read `OPENAI_API_KEY` from your shell. When changing the seat count, update the participants in `job.json` too: configuration does not add or remove model participants.

Both tasks are standard Harbor Compose tasks, so any Harbor environment that runs Docker Compose works. Pick one with `environment.type` in `job.json` and install Harbor Multiagent with that provider's extra, as for any Harbor task. Each trial requests the 8 CPUs and 8 GB in `task.toml`; Harbor's `override_cpus` and `override_memory_mb` lower that for a provider with smaller sandboxes.

## Recordings

Live cameras are off by default. Both tasks always record a game log: the server's stream to every player, with a keyframe every minute. From a finished job, any seat's view or a free camera can be reconstructed and watched as video, without rerunning the agents. Each task README gives the steps, written so you or a coding agent can follow them. Live per-seat cameras can still be turned on in `config.json`.

## Validation

Each task’s `solution/` contains regression and integration checks; `tests/` contains the verifier entrypoint. CI checks that the committed task files match `config.json`, runs the regression suites, builds each image from public dependencies, and runs the real game engine through the API, recording and replay checks. Passing these checks does not establish model performance or maximum-seat capacity.

## License and credits

Original code and documentation are licensed under **GPL-3.0-only**, unless a file states otherwise. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Third-party components retain their own licenses.

Mindustry is created by Anuken and its contributors: [official website](https://mindustrygame.github.io), [game source](https://github.com/Anuken/Mindustry). Harbor Multiagent is an Olam Labs fork of [Harbor](https://github.com/harbor-framework/harbor). This repository is not an official Mindustry or Harbor project.

Game binaries are downloaded during local builds. Anyone distributing built images or JARs must also fulfill the applicable corresponding-source obligations described in the task notices.
