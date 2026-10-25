import json
import sys
import urllib.request
from pathlib import Path

def call(path, **body):
    req = urllib.request.Request('http://127.0.0.1:8091/' + path, json.dumps(body).encode(), {'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        result = json.load(r)
    assert result['ok'], result
    return result['result']

call('setup', game_mode='survival', map='Fork', seed=1, team_sizes=[2], endless_survival=dict(first_wave_ticks=5184000, wave_spacing_ticks=7200, spawn_seed=1, enemy_unit_health_multiplier=1, enemy_unit_damage_multiplier=1),
     time_limit_sec=None, seats=['seat-1','seat-2'])
result = call('evaluation_test')
assert result['ok'], result
evidence = Path(sys.argv[1])

frames = [json.loads(line) for line in (evidence/'evaluation.jsonl').open()]
assert frames and frames[-1]['final'], 'final evaluation frame'
last = frames[-1]
families = {row['family'] for row in last['buildings']}
assert families == {'extraction', 'transport'}, families
drill = next(r for r in last['buildings'] if r['type'] == 'mechanical-drill')
assert drill['output']['items']['copper'] == result['drill_copper']
assert drill['lost_output']['output_blocked']['items']['copper'] > 0
assert any(r['kind'] == 'duct' and r['transport']['nominal_capacity_items'] > 0 for r in last['buildings'])
assert any(r['kind'] == 'router' and r['transport']['nominal_capacity_items'] is None for r in last['buildings'])
mined = next(r for r in last['mining']['mined'] if r['unit_type'] == 'alpha')
assert mined['items']['lead'] == result['mined_lead'] and mined['controller'] == 'ai'
assert any(r['sink'] == 'turret' for r in last['deliveries'])
assert {c for r in last['stalled'] for c in r['lost_output']} >= {'input_limited', 'output_blocked', 'disabled'}
combat = last['combat']
hit = next(r for r in combat['damage'] if r['target_type'] == 'dagger' and r['source_type'] == 'dagger')
assert abs(hit['damage'] - result['attributed_damage']) < 1e-6 and hit['events'] >= 1
assert any(r['target_type'] == 'dagger' and r['damage'] > 0 for r in combat['unattributed_damage'])
assert any(r['target_type'] == 'dagger' and r['count'] == 1 for r in combat['kills'])
assert combat['firepower']['sharded']['peak_dps'] > 0
assert last['power']['sharded']['consumer_seconds']['full_power'] > 0
assert 'unit_cap' in last['coverage']['unmeasured']

stock = [json.loads(line) for line in (evidence/'stockpiles.jsonl').open()]
assert stock[-1]['final'] and stock[-1]['teams']['sharded']['storage_capacity'] > 0
assert 'lead' in stock[-1]['teams']['sharded']['items']

catalog = json.loads((evidence/'content.json').read_text())
assert catalog['units']['dagger']['tier'] == 1 and catalog['units']['mace']['tier'] == 2
assert catalog['blocks']['graphite-press']['category'] == 'crafting'

names = [r['name'] for r in call('query', seat='seat-1', of='collections')['rows']]
assert not any('evaluation' in n or 'stockpile' in n for n in names), names
rows = call('query', seat='seat-1', of='production', limit=1000)['rows']
assert not any(r['type'] in ('mechanical-drill', 'mechanical-pump', 'duct', 'router') for r in rows)
drills = call('query', seat='seat-1', of='buildings', filter=[['type','eq','mechanical-drill']], fields=['id','production'])['rows']
assert drills and all(b['production'].get('supported') is False for b in drills)
print(json.dumps(result))
