#!/usr/bin/env python3
"""Write the per-seat instructions Harbor Multiagent loads for this task."""
import argparse
import json
from pathlib import Path
import tomllib

HERE = Path(__file__).resolve().parents[1]

WAVE_SCHEDULE = """The enemy waves follow one fixed schedule, the same in every game, in native simulation time (the game's own clock, not the wall-time `status.t`). The first wave spawns {{FIRST}} after the simulation starts; after that a new wave spawns every {{SPACING}}, whether or not earlier waves have been destroyed, so wave *n* spawns at the first-wave delay plus (*n* − 1) wave intervals. `query {of:"match"}` shows the current `wave` and `wave_time`, the seconds until the next wave.

Each wave is stronger than the last. A wave's base composition strength, its enemies' health and shield adjusted for armor, is 600 × 1.22^(*n* − 1): 22% more than the wave before, doubling about every 3.5 waves.

| Wave | Spawns at (native) | Strength | Enemies |
|---|---|---|---|
| 1 | {{WAVE_1}} | 600 | 5 |
| 5 | {{WAVE_5}} | 1,329 | 13 |
| 10 | {{WAVE_10}} | 3,592 | 29 |
| 15 | {{WAVE_15}} | 9,709 | 47 |
| 20 | {{WAVE_20}} | 26,241 | 56 |
| 25 | {{WAVE_25}} | 70,923 | 116 |
| 30 | {{WAVE_30}} | 191,684 | 173 |

New enemy types join as the waves grow: daggers and flares from wave 1, crawlers from wave 5, novas from 7, pulsars from 10, horizons from 11, maces and atraxes from 14, zeniths and quasars from 16, fortresses and spirocts from 18, quads from 27, and arkyids and antumbras from 29.
"""

def wave_schedule(profile):
    def duration(ticks):
        seconds = ticks / 60
        if seconds % 60 == 0:
            value, unit = seconds / 60, 'minute'
        else:
            value, unit = seconds, 'second'
        return f"{value:g} {unit}{'' if value == 1 else 's'} ({ticks:,.10g} ticks)"
    first, spacing = profile['first_wave_ticks'], profile['wave_spacing_ticks']
    text = WAVE_SCHEDULE.replace('{{FIRST}}', duration(first)).replace('{{SPACING}}', duration(spacing))
    for wave in (1, 5, 10, 15, 20, 25, 30):
        seconds = (first + (wave - 1) * spacing) / 60
        minutes, remainder = divmod(seconds, 60)
        stamp = f'{int(minutes)}:{int(remainder):02d}' if remainder.is_integer() else f'{int(minutes)}:{remainder:06.3f}'.rstrip('0')
        text = text.replace('{{WAVE_' + str(wave) + '}}', stamp)
    text += f"\nConfigured enemy health multiplier: {profile['enemy_unit_health_multiplier']:g}; damage multiplier: {profile['enemy_unit_damage_multiplier']:g}. These apply separately from the base composition budget above.\n"
    return text

def prepare_instructions(root=HERE):
    root = Path(root).resolve()
    config = tomllib.loads((root / "task.toml").read_text())
    seats = list(config.get("agents", {}))
    if not 1 <= len(seats) <= 20 or seats != [f"seat-{i}" for i in range(1, len(seats) + 1)]:
        raise ValueError("Expected the canonical seat-1 through seat-N roster, with 1..20 seats")
    instruction = (root / "instruction.md").read_text()
    team = ("You are your team's only agent seat (seat-1)." if len(seats) == 1 else
            f"Your team has {len(seats)} agent seats: seat-1 to seat-{len(seats)}.")
    instruction = instruction.replace("{{TEAM_ROSTER}}", team)
    contract = json.loads((root / "environment/task-runtime/contract.json").read_text())
    if contract["world_settings"]["wave_schedule_briefing"]:
        instruction += "\n## Wave schedule\n\n" + wave_schedule(contract["settings"]["endless_survival"])
    instruction = instruction.encode()
    directory = root / "instructions"
    directory.mkdir(exist_ok=True)
    for seat in seats:
        path = directory / f"{seat}.md"
        if path.is_symlink():
            path.unlink()
        if not path.exists() or path.read_bytes() != instruction:
            path.write_bytes(instruction)
    for path in directory.glob("seat-*.md"):
        if path.stem not in seats:
            path.unlink()
    return [directory / f"{seat}.md" for seat in seats]

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", nargs="?", type=Path, default=HERE)
    args = parser.parse_args()
    print(f"Prepared {len(prepare_instructions(args.task))} seat instructions")
