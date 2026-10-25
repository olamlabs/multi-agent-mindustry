"""Run with Harbor Multiagent's Python: real Docker/engine, scripted agents, no model calls.

SMOKE_EVIDENCE selects the output directory. Exercises both agents finishing normally
on game_over and all agents returning while play is still active.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from harbor.agents.base import BaseAgent
from harbor.models.trial.config import TrialConfig
from harbor.trial.trial import Trial

class ProbeAgent(BaseAgent):
    def __init__(self, *args, early=False, **kwargs):
        super().__init__(*args, **kwargs)
        self.early = early

    @staticmethod
    def name():
        return 'series-lifecycle-probe'

    def version(self):
        return '1'

    async def setup(self, environment):
        pass

    async def run(self, instruction, environment, context):
        example = instruction.split('```python\n', 1)[1].split('```', 1)[0]
        client = example.split('players = call(', 1)[0]
        script = client + '\n' + '''import time
assert "HARBOR_SEAT_TOKEN" not in os.environ
while True:
    view = call("/update")
    Path("/logs/agent").mkdir(parents=True, exist_ok=True)
    Path("/logs/agent/probe.json").write_text(json.dumps(view))
    if view["status"]["phase"] == "running" if EARLY else view["game_over"]:
        break
    time.sleep(0.2)
'''.replace('EARLY', repr(self.early))
        import shlex
        reply = await environment.exec('python3 -c '+shlex.quote(script))
        if reply.return_code != 0:
            raise RuntimeError(f'probe exited {reply.return_code}: {reply.stderr}')
        context.cost_usd = 0

async def main():
    source = Path(__file__).resolve().parents[2]
    out = Path(os.environ.get('SMOKE_EVIDENCE', tempfile.mkdtemp(prefix='harbor-series-'))).resolve()
    out.mkdir(parents=True, exist_ok=True)
    for mode in ['normal', 'early']:
        task = out/mode/'task'
        shutil.copytree(source, task)
        config = json.loads((task/'config.json').read_text())
        config['seats'] = 2
        config['settings'].update(games=3,time_limit_sec=10,chat_after_sec=3,lobby_sec=120,
                                  video={'record':True,'seats':1}, replay={'record':True})
        (task/'config.json').write_text(json.dumps(config))
        subprocess.run([sys.executable,str(task/'scripts/configure.py')],check=True)
        trial_name=f'mindustry-series-{mode}-{os.getpid()}'
        trial = await Trial.create(TrialConfig(
            task={'path':task}, trials_dir=out/mode/'trials', trial_name=trial_name,
            environment={'override_cpus':float(os.environ.get('HARBOR_TEST_CPUS','8'))},
            participants=[{'seat':f'seat-{i}','import_path':'harbor_smoke:ProbeAgent',
                           'kwargs':{'early':mode=='early'}} for i in [1,2]],
        ))
        result = await trial.run()
        assert result.exception_info is None,result.exception_info
        assert len(result.seat_results)==2,result.seat_results
        assert all(seat.exception_info is None for seat in result.seat_results),result.seat_results
        path = out/mode/'trials'/trial_name
        sim = path/'artifacts/sim'
        terminal = json.loads((sim/'result.json').read_text())
        assert len(terminal['results']) == 3,terminal
        assert result.verifier_result.rewards['completed'] == 1,result.verifier_result
        assert result.verifier_result.rewards['games'] == 3,result.verifier_result
        assert {seat:result.verifier_result.rewards[seat] for seat in ['seat-1','seat-2']} == {'seat-1':.5,'seat-2':.5},result.verifier_result
        assert result.verifier_result.rewards['draws'] == 3,result.verifier_result
        video = next(row for row in map(json.loads,(sim/'log.jsonl').read_text().splitlines()) if row['type']=='video')
        assert video['complete'] and video['first_frame'],video
        assert list((path/'artifacts/recordings/seat-1').glob('*.mp4'))
        assert json.loads((sim/'replay/stats.json').read_text())['closed']
        receipt=json.loads((sim/'replay/manifest.json').read_text())
        assert receipt['closed'] and len(receipt['segments'])>0,receipt
        assert [game['game'] for game in terminal['results']]==[1,2,3],terminal
        for seat in ['seat-1','seat-2']:
            probe=json.loads((path/f'seats/{seat}/agent/probe.json').read_text())
            assert probe['game_over'] == (mode=='normal'),probe
        print(f'PASS {mode}: clean Harbor trial and seats, final simulation result and camera artifacts, reward',flush=True)
    print(out,flush=True)

if __name__ == '__main__':
    asyncio.run(main())
