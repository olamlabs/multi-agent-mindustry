# Multi-Agent Mindustry

PvP and cooperative PvE benchmarks built on [Mindustry](https://mindustrygame.github.io) and [Harbor Multiagent](https://github.com/olamlabs/harbor-multiagent).

| Task | Mode | What agents do | Reward |
|---|---|---|---|
| [Mindustry Series](mindustry-series/README.md) | PvP | Competing teams play 1–100 consecutive games with persistent agent sessions. Defaults to two teams of two across three 10-minute games on Harbor Ring. | Each seat receives 1 if its team has the most wins outright, 0.5 if tied for most wins, and 0 otherwise. |
| [Mindustry Endless Survival](mindustry-endless-survival/README.md) | PvE | One team cooperates to defend its core against endless enemy waves. Defaults to two seats; supports 1–20. | All seats share the number of native simulation minutes survived. |

## Run

Requires Docker with Compose, Python 3.12+, Node.js 22 and uv 0.13.5+. The native environments target Linux amd64; Apple Silicon uses Docker emulation. Images build locally from public dependencies.

```sh
uv tool install --python 3.12 "git+https://github.com/olamlabs/harbor-multiagent@4a194016336ccd1ce3fcc799b10158ca0375eb63"
```

Choose a task above and follow its README. From either task folder, the launch sequence is:

```sh
export OPENAI_API_KEY="your-openai-api-key"
python3 scripts/configure.py
harbor run -p . -c job.json
```

Each task has two editable configuration files:

| File | Controls |
|---|---|
| `config.json` | Game settings and seat count; apply changes with `scripts/configure.py` |
| `job.json` | Harbor attempts and each seat's harness, model, credentials and reasoning options |

Both default jobs use Codex with `openai/gpt-6-luna` at high reasoning effort and read `OPENAI_API_KEY` from your shell. When changing the seat count, update the participants in `job.json` too: configuration does not add or remove model participants. The scripted integration checks make no model calls.

## Validation

Each task’s `solution/` contains regression and integration checks; `tests/` contains the verifier entrypoint. CI runs the local regression suites. See the task READMEs for Docker lifecycle checks, recordings and replay tools. Passing these checks does not establish model performance or maximum-seat capacity.

## License and credits

Original code and documentation are licensed under **GPL-3.0-only**, unless a file states otherwise. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Third-party components retain their own licenses.

Mindustry is created by Anuken and its contributors: [official website](https://mindustrygame.github.io), [game source](https://github.com/Anuken/Mindustry). Harbor Multiagent is an Olam Labs fork of [Harbor](https://github.com/harbor-framework/harbor). This repository is not an official Mindustry or Harbor project.

Game binaries are downloaded during local builds. Anyone distributing built images or JARs must also fulfill the applicable corresponding-source obligations described in the task notices.
