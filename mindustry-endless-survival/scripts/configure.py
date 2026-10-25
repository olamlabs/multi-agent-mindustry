#!/usr/bin/env python3

"""Configure this standalone Harbor Multiagent task from local sources only."""

import argparse,json,subprocess,tomllib

from pathlib import Path
from prepare import prepare_instructions

HERE=Path(__file__).resolve().parents[1]

TASK_NAME='mindustry-endless-survival'

GAME_FILES=['status.json','ffmpeg.log','recording-validation.jsonl','failure.txt','renderers']

def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()

def validate_config(config):
    if set(config) != {'version', 'seats', 'wave_schedule_briefing', 'settings'}:
        raise ValueError('config.json requires version, seats, wave_schedule_briefing and settings')
    if not isinstance(config['version'], str) or not config['version'].strip():
        raise ValueError('version must be a nonempty string')
    if type(config['seats']) is not int or not 1 <= config['seats'] <= 20:
        raise ValueError('seats must be an integer from 1 to 20')
    if type(config['wave_schedule_briefing']) is not bool:
        raise ValueError('wave_schedule_briefing must be a boolean')
    settings = config['settings']
    if not isinstance(settings, dict):
        raise ValueError('settings must be an object')
    if any(key in settings for key in ('team_sizes', 'team_count', 'team_size', 'wave_schedule_briefing')):
        raise ValueError('Roster and briefing are configured at the top level')
    if settings.get('game_mode') != 'survival' or settings.get('map') != 'Fork' or settings.get('time_limit_sec') is not None:
        raise ValueError('Scenario must be endless survival on Fork')
    if settings.get('agent_ready_required') is not True:
        raise ValueError('Every agent must join the readiness barrier')
    if not isinstance(settings.get('endless_survival'), dict):
        raise ValueError('settings.endless_survival must explicitly define the wave profile')
    return settings

def validate_runtime(source, settings, seats=(1, 20)):
    if not (source / 'environment/sim/survival-grade.mjs').is_file():
        raise ValueError('Canonical deterministic survival grader is missing')
    if not (source / 'environment/plugin/src/harbor/ProgressiveWaves.java').is_file():
        raise ValueError('Progressive native wave source is missing; no map-wave fallback is allowed')
    program = '''import {readFileSync} from 'node:fs';
const {validateSettings, resolveTeams, resolveCameras} = await import(process.argv[1]);
const input = JSON.parse(readFileSync(0, 'utf8'));
const roster = Array.from({length:Number(process.argv[2])}, (_,i)=>`seat-${i+1}`);
const out = resolveCameras(resolveTeams(validateSettings(input), roster), roster);
if (out.time_limit_sec !== null || out.game_mode !== 'survival' || out.agent_ready_required !== true || !out.endless_survival) throw new Error('Unsupported endless survival contract');'''
    for size in sorted(set(seats)):
        result = subprocess.run(['node', '--input-type=module', '-e', program,
                                 (source / 'environment/sim/settings.mjs').resolve().as_uri(), str(size)],
                                input=json.dumps(settings), text=True, capture_output=True)
        if result.returncode:
            raise ValueError(f'Canonical runtime rejected the survival contract for {size} seats: ' + result.stderr.strip())

def seat_names(count):
    return [f'seat-{i}' for i in range(1, count + 1)]

def team_text(seats):
    n = len(seats)
    return 'one seat, seat-1, a team of one' if n == 1 else f'{n} seats, seat-1 to seat-{n}, one team of all of them'

def render_seats_task(path, version, seats, briefing, simulation):
    """task.toml in Harbor Multiagent's form: one [agents.<seat>] table per seat, every one graded (each seat's instruction is
    instructions/<seat>.md), the play clock, the verifier in main, the simulation's size and the game's
    files as artifacts: the simulation's from main, and each seat's native client's from its own game service."""
    tags = ['mindustry', 'benchmark', 'multi-agent', 'survival', 'endless'] + (['wave-schedule'] if briefing else [])
    description = (f'Endless Mindustry survival on Fork: {team_text(seats)} defend one core for as long as they can'
                   + (', told the wave schedule' if briefing else '') + '. The reward is native minutes survived.')
    lines = ['# Configured by scripts/configure.py from this task; edit its local sources.',
             '# The simulation ends at core loss; a play clock that runs out first leaves an unscored attempt.',
             'schema_version = "1.4"', f'version = {json.dumps(version)}', '',
             '[task]', f'name = "olamlabs/{path}"', f'description = {json.dumps(description)}', f'keywords = {json.dumps(tags)}', '',
             '[metadata]', 'author_name = "Olam Labs"', 'difficulty = "hard"', 'category = "games"', f'tags = {json.dumps(tags)}', '',
             '[agent]', 'timeout_sec = 63000', '',
             '# The verifier runs once in main and writes the shared survival reward.',
             '[verifier]', 'timeout_sec = 63000', '',
             '# main: the environment/Dockerfile simulation stage, native server, app and verifier.',
             '[environment]', 'build_timeout_sec = 3600', f'cpus = {simulation["cpus"]}', f'memory_mb = {simulation["memory_mb"]}']

    artifacts = ['artifacts = [', '  { source = "/logs/sim", destination = "logs/sim" },']
    for seat in seats:
        for source in [f'/recordings/{seat}', *[f'/tmp/mindustry-seat/{seat}/{name}' for name in GAME_FILES]]:
            artifacts.append(f'  {{ source = "{source}", service = "{seat}-game" }},')
    artifacts += [']', '']
    lines[5:5] = artifacts
    lines += ['', f"# The seats: {team_text(seats)}. Every seat is graded, so play ends once every seat's agent has ended."]
    lines += [f'[agents.{seat}]' for seat in seats]
    task = '\n'.join(lines) + '\n'
    parsed = tomllib.loads(task)
    if list(parsed['agents']) != seats or parsed['agent']['timeout_sec'] != 63000:
        raise ValueError('The seats-form task.toml does not name its roster')
    return task.encode()

def configure(root=HERE, config=None):
    root=Path(root).resolve()

    config = {**json.loads((root/'config.json').read_text()), **(config or {})}
    settings = validate_config(config)
    world={**settings,'wave_schedule_briefing':config['wave_schedule_briefing']}
    validate_runtime(root,world,(config['seats'],config['seats']))
    seats=seat_names(config['seats'])
    build=lambda target:{'context':'..','dockerfile':'environment/Dockerfile','target':target}
    services={'main':{'build':build('simulation'),'platform':'linux/amd64','networks':['control'],
        'command':['/bin/sh','-c','PATH=/usr/local/bin:/usr/bin:/bin exec node /app/task-runtime/seats.mjs --seat-clients'],
        'environment':{'HARBOR_SEATS':json.dumps(seats),'HARBOR_SIM_SETTINGS':json.dumps(world)},
        'volumes':['camera-control:/run/mindustry-control']+[f'{seat}-token:/run/seat-tokens/{seat}' for seat in seats],
        'healthcheck':{'test':['CMD','/bin/sh','-c',"PATH=/usr/local/bin:/usr/bin:/bin node -e \"fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\""],
                      'interval':'5s','timeout':'10s','retries':3,'start_period':'1h'}},
        'api':{'build':{'context':'..','dockerfile':'environment/gateway/Dockerfile'},'networks':['agents','control'],'depends_on':{'main':{'condition':'service_healthy'}}}}
    for seat in seats:
        services[seat]={'build':{'context':'..','dockerfile':'environment/seat-box/Dockerfile'},'networks':['agents'],'init':True,'cpus':2,'mem_limit':'2048m',
            'depends_on':{'main':{'condition':'service_healthy'}},
            'environment':{'HARBOR_SEAT':seat,'HARBOR_SIM_URL':'http://api:8080'},'volumes':[f'{seat}-token:/run/mindustry:ro']}
        services[seat+'-game']={'build':build('runtime'),'platform':'linux/amd64','networks':['control'],'init':True,
            'cpus':2,'mem_limit':'2048m','stop_grace_period':'90s','command':['node','/opt/mindustry/environment/seat-client/client.mjs'],
            'depends_on':{'main':{'condition':'service_healthy'}},'volumes':['camera-control:/run/mindustry-control:ro'],
            'environment':{'HARBOR_SEAT':seat,'HARBOR_SIM_URLS':json.dumps({'9000':'http://main:9000','9001':'http://main:9001'}),
                'HARBOR_SIM_HEADERS':'{}','MINDUSTRY_RECORDINGS_DIR':f'/recordings/{seat}','MINDUSTRY_SEAT_RUN_DIR':f'/tmp/mindustry-seat/{seat}'}}
    compose={'services':services,'networks':{'agents':{},'control':{}},
             'volumes':{'camera-control':{},**{seat+'-token':{} for seat in seats}}}
    task=render_seats_task(TASK_NAME,config['version'],seats,config['wave_schedule_briefing'],{'cpus':8,'memory_mb':8192}).decode()

    task=task.replace('# main:', '[[verifier.collect]]\nservice = "main"\ncommand = "PATH=/usr/local/bin:/usr/bin:/bin node /app/task-runtime/collect.mjs"\ntimeout_sec = 63000\n\n# main:')
    contract={'schema_version':'1.0.0', 'seat_range':[len(seats),len(seats)], 'settings':settings,
              'world_settings':{'wave_schedule_briefing':config['wave_schedule_briefing']}}

    (root/'instruction.md').read_text()
    outputs={'task.toml':task.encode(),'environment/docker-compose.yaml':json_bytes(compose),
        'environment/task-runtime/contract.json':json_bytes(contract),'config.json':json_bytes(config)}

    tomllib.loads(task)
    for name,data in outputs.items():
        path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    prepare_instructions(root)
    return outputs

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seats',type=int)
    parser.add_argument('--wave-schedule-briefing',action=argparse.BooleanOptionalAction,default=None)
    args=parser.parse_args()
    config=json.loads((HERE/'config.json').read_text())
    if args.seats is not None:config['seats']=args.seats
    if args.wave_schedule_briefing is not None:config['wave_schedule_briefing']=args.wave_schedule_briefing
    configure(config=config)
