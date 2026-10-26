#!/usr/bin/env python3
"""Configure a Harbor Multiagent series: --games 1..100, --seats 2..200; or edit config.json and run again."""
import argparse
import json
from pathlib import Path
import re
import subprocess

MARK = '# --- Generated seats: scripts/configure.py ---'
FILES = ['status.json', 'ffmpeg.log', 'recording-validation.jsonl', 'failure.txt', 'renderers']
VALIDATE = '''
const [url, raw] = process.argv.slice(1);
const {validateSettings, seatsFromRoster, resolveTeams, resolveCameras} = await import(url);
const config = JSON.parse(raw);
if (!Number.isInteger(config.seats) || config.seats < 2 || config.seats > 200) throw Error('seats must be 2..200');
const seats = seatsFromRoster(Object.fromEntries(Array.from({length: config.seats}, (_, i) => [`seat-${i+1}`, {}])));
console.log(JSON.stringify(resolveCameras(resolveTeams(validateSettings(config.settings), seats), seats).video.seats));
'''

def generate(root, config):

    resolved = subprocess.run(['node', '--input-type=module', '-e', VALIDATE,
                               (root/'environment/sim/settings.mjs').as_uri(), json.dumps(config)],
                              check=True, stdout=subprocess.PIPE, text=True).stdout
    seats = [f'seat-{i+1}' for i in range(config['seats'])]
    recording = config['settings'].get('video', {}).get('record', True)
    cameras = json.loads(resolved) if recording else []
    sim_settings = config['settings'] if recording else {**config['settings'], 'video': {**config['settings'].get('video', {}), 'seats': []}}
    services = {
        'main': {
            'build': {'context': '..', 'dockerfile': 'environment/Dockerfile', 'target': 'simulation'},
            'networks': ['control'], 'platform': 'linux/amd64',
            'command': ['/bin/sh', '-c', 'PATH=/usr/local/bin:/usr/bin:/bin exec node /app/sim/seats.mjs --seat-clients'],
            'healthcheck': {
                'test': ['CMD', '/bin/sh', '-c', 'PATH=/usr/local/bin:/usr/bin:/bin node -e "fetch(\'http://127.0.0.1:8080/health\').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"'],
                'interval': '5s', 'timeout': '10s', 'retries': 3, 'start_period': '1h'},
            'environment': {'MINDUSTRY_SEATS': json.dumps(seats), 'MINDUSTRY_SIM_SETTINGS': json.dumps(sim_settings)},
            'volumes': ['camera-control:/run/mindustry-control'] + [f'{s}-token:/run/seat-tokens/{s}' for s in seats],
        }
    }
    services['api'] = {'build': './gateway', 'networks': ['agents', 'control'],
                       'depends_on': {'main': {'condition': 'service_healthy'}}}
    lines = [MARK]
    template = (root/'instruction.md').read_text()
    outputs = {}
    for seat in seats:
        services[seat] = {
            'build': './seat-box', 'networks': ['agents'], 'init': True, 'cpus': 2, 'mem_limit': '2048m',
            'depends_on': {'main': {'condition': 'service_healthy'}},
            'environment': {'MINDUSTRY_SEAT': seat, 'MINDUSTRY_SIM_URL': 'http://api:8080'},
            'volumes': [f'{seat}-token:/run/mindustry:ro'],
        }
        outputs[f'instructions/{seat}.md'] = template.replace('{seat}', seat)
        if seat not in cameras:
            continue
        services[f'{seat}-game'] = {
            'build': {'context': '..', 'dockerfile': 'environment/Dockerfile', 'target': 'runtime'},
            'networks': ['control'], 'platform': 'linux/amd64', 'command': ['node', '/opt/mindustry/environment/seat-client/client.mjs'],
            'volumes': ['camera-control:/run/mindustry-control:ro'],
            'init': True, 'stop_grace_period': '90s', 'cpus': 2, 'mem_limit': '2048m',
            'depends_on': {'main': {'condition': 'service_healthy'}},
            'environment': {
                'MINDUSTRY_SEAT': seat,
                'MINDUSTRY_SIM_URLS': json.dumps({'9000': 'http://main:9000', '9001': 'http://main:9001'}),
                'MINDUSTRY_SIM_HEADERS': '{}',
                'MINDUSTRY_RECORDINGS_DIR': f'/recordings/{seat}',
                'MINDUSTRY_SEAT_RUN_DIR': f'/tmp/mindustry-seat/{seat}',
            },
        }
        for source in [f'/recordings/{seat}'] + [f'/tmp/mindustry-seat/{seat}/{f}' for f in FILES]:
            lines += ['', '[[artifacts]]', f'source = "{source}"', f'service = "{seat}-game"']
    lines += [''] + [f'[agents.{seat}]' for seat in seats]
    text = (root/'task.toml').read_text()
    if text.count(MARK) != 1:
        raise ValueError('task.toml is missing its generated seat marker')

    outputs['environment/docker-compose.yaml'] = json.dumps({'services': services, 'networks': {'agents': {}, 'control': {'internal': True}}, 'volumes': {'camera-control': {}, **{f'{s}-token': {} for s in seats}}}, indent=2)+'\n'

    settings = config['settings']
    seconds = settings.get('time_limit_sec', 600)
    timeout = max(63000, settings.get('lobby_sec', 1800) + settings.get('games', 3) * (seconds + 60)
                  + settings.get('chat_after_sec', 300) + 600) if seconds is not None else 63000
    head = text.split(MARK)[0]
    for table in ['agent', '[verifier.collect]']:
        pattern = r'(?ms)(^\[' + re.escape(table) + r'\]\n(?:(?!^\[).)*?^timeout_sec = )[0-9]+'
        head, count = re.subn(pattern, lambda m: m[1] + str(timeout), head)
        if count != 1:
            raise ValueError(f'Expected one timeout for {table}')
    outputs['task.toml'] = head+'\n'.join(lines)+'\n'
    outputs['config.json'] = json.dumps(config, indent=2)+'\n'
    for old in (root/'instructions').glob('seat-*.md'):
        if old.name not in {f'{s}.md' for s in seats}:
            old.unlink()
    for name, content in outputs.items():
        path = root/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--games', type=int, help='consecutive games, 1 through 100 (default: config.json)')
    parser.add_argument('--seats', type=int, help='roster size, subject to the configured PvP teams')
    parser.add_argument('--task', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.task.resolve()
    config = json.loads((root/'config.json').read_text())
    if args.games is not None:
        config['settings']['games'] = args.games
    if args.seats is not None:
        config['seats'] = args.seats
    generate(root, config)
