#!/usr/bin/env python3
"""Host-side integration suite: two fresh Docker worlds, real seats, no paid models."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

from harbor.agents.base import BaseAgent
from harbor.models.trial.config import TrialConfig
from harbor.trial.trial import Trial

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent

class SmokeAgent(BaseAgent):
    @staticmethod
    def name():
        return 'endless-survival-integration'

    def version(self):
        return '1'

    async def setup(self, environment):
        pass

    async def run(self, instruction, environment, context):

        example = instruction.split('```python\n', 1)[1].split('```', 1)[0]
        client = example.split('players = call(', 1)[0]
        script = client + '\n' + (HERE/'seat_probe.py').read_text()
        reply = await environment.exec('python3 -c ' + shlex.quote(script))
        if reply.return_code:
            raise RuntimeError(reply.stderr or reply.stdout)
        context.cost_usd = 0

def check_verifier(task, logs, output, expected):
    """Repeat valid evidence, then remove native evidence and reject stale rewards."""
    evidence = output/'verifier-probe'
    for name in ['setup.json', 'result.json', 'agent-readiness.json', 'engine/survival.jsonl']:
        target = evidence/name;target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(logs/name, target)
    reward = output/'probe-reward.json'
    command = ['node', str(task/'environment/sim/verify.mjs'), str(evidence), str(reward)]
    env = {**os.environ, 'MINDUSTRY_SURVIVAL_SEATS': '2'}
    first = subprocess.run(command, env=env, capture_output=True, text=True, check=True)
    before = reward.read_bytes()
    assert json.loads(before)['reward'] == expected
    second = subprocess.run(command, env=env, capture_output=True, text=True, check=True)
    assert reward.read_bytes() == before, 'Saved-evidence scoring is not repeatable'
    (evidence/'engine/survival.jsonl').unlink()
    invalid = subprocess.run(command, env=env, capture_output=True, text=True)
    assert invalid.returncode != 0 and not reward.exists(), 'Invalid evidence retained a reward'
    (output/'verifier-probes.log').write_text(first.stdout + second.stdout + invalid.stdout + invalid.stderr)
    return ['repeatable_saved_evidence', 'missing_native_evidence_rejected', 'stale_reward_removed']

async def run_world(out, number, cpus):
    folder = out/f'world-{number}';folder.mkdir()
    task = folder/'task'
    shutil.copytree(SOURCE, task, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'runs', 'instructions'))
    subprocess.run([sys.executable, str(task/'scripts/configure.py'), '--seats', '2'], check=True)
    name = f'endless-integration-{os.getpid()}-{number}'
    trial = await Trial.create(TrialConfig(
        task={'path': task}, trials_dir=folder/'trials', trial_name=name,
        environment={'override_cpus': cpus, 'delete': True},
        participants=[{'seat': f'seat-{i}', 'import_path': 'integration:SmokeAgent',
                       'env': {'INTEGRATION_WORLD_ID': name}} for i in [1, 2]],
    ))
    print(f'Starting {name}: two real seat sandboxes and one native world', flush=True)
    result = await trial.run()
    assert result.exception_info is None, result.exception_info
    assert len(result.seat_results) == 2 and all(s.exception_info is None for s in result.seat_results), result.seat_results
    path = folder/'trials'/name
    rewards = result.verifier_result.rewards
    assert rewards['reward'] > 0 and rewards['seat-1'] == rewards['seat-2'] == rewards['reward'], rewards
    reward_file = json.loads((path/'verifier/reward.json').read_text())
    assert reward_file == rewards == {'reward': rewards['reward'], 'seat-1': rewards['reward'], 'seat-2': rewards['reward']}, rewards
    logs = path/'artifacts/logs/sim'
    native = json.loads((logs/'result.json').read_text())
    assert not native.get('failure') and native['terminal']['reason'] == 'core_destroyed', native
    outcome = json.loads((path/'verifier/survival-outcome.json').read_text())
    assert outcome['status'] == 'valid' and outcome['score_minutes'] == rewards['reward'], outcome
    artifacts = json.loads((path/'artifacts/manifest.json').read_text())
    assert any(a['source'] == '/logs/sim' and a['status'] == 'ok' for a in artifacts), artifacts
    probes = [json.loads((path/f'seats/seat-{i}/agent/integration.json').read_text()) for i in [1, 2]]
    assert all(p['world'] == name for p in probes)
    verification = check_verifier(task, logs, folder, rewards['reward'])
    summary = {'trial': name, 'reward_minutes': rewards['reward'], 'seat_probes': probes,
               'checks': ['fresh_world', 'core_loss', 'terminal_export', 'valid_shared_reward',
                          'survival_only_reward_file', *verification]}
    (folder/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    print(f'PASS {name}: native core loss, exported evidence, reward {rewards["reward"]}', flush=True)
    return summary

async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Fresh evidence directory; defaults to a temporary directory')
    parser.add_argument('--cpus', type=float, default=4, help='Diagnostic simulation allocation (task default is unchanged)')
    args = parser.parse_args()
    out = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix='mindustry-integration-'))
    if args.output:
        out.mkdir(parents=True, exist_ok=False)
    print(f'Evidence: {out}', flush=True)
    ledger = {'mode': 'pure_benchmark_integration', 'status': 'RUNNING', 'worlds': [],
              'limitations': ['No paid model calls', 'Not a winning strategy or difficulty calibration',
                              'Two seats per world; not a 20-seat capacity test', 'Local Docker only; other sandbox backends not tested']}
    try:
        for number in [1, 2]:
            ledger['worlds'].append(await run_world(out, number, args.cpus))
        tokens = [p['token_hash'] for world in ledger['worlds'] for p in world['seat_probes']]
        assert len(set(tokens)) == 4, 'Seat credentials reused across seats or world copies'
        ledger['status'] = 'PASS'
        ledger['isolation'] = 'Distinct seat credentials and clean seat filesystems across both fresh worlds'
    except BaseException as error:
        ledger['status'] = 'FAIL'
        ledger['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        (out/'summary.json').write_text(json.dumps(ledger, indent=2)+'\n')
    print('PASS complete integration suite; see summary.json for scope and limitations', flush=True)

if __name__ == '__main__':
    asyncio.run(main())
