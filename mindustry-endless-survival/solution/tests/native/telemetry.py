import json
import sys
import urllib.request
from pathlib import Path

def call(path, **body):
    req = urllib.request.Request('http://127.0.0.1:8091/' + path, json.dumps(body).encode(), {'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        result = json.load(r)
    assert result['ok'], result
    return result['result']

call('setup', game_mode='survival', map='Fork', seed=1, team_sizes=[2], endless_survival=dict(first_wave_ticks=5184000, wave_spacing_ticks=7200, spawn_seed=1, enemy_unit_health_multiplier=1, enemy_unit_damage_multiplier=1),
     time_limit_sec=None, seats=['seat-1','seat-2'])
result = call('telemetry_test')
rows = call('query', seat='seat-1', of='production', limit=1000)['rows']
assert len(rows) == result['lifetime_count']
assert call('query', seat='seat-2', of='production', limit=1000)['rows'] == rows
first = call('query', seat='seat-1', of='production', limit=1)
second = call('query', seat='seat-1', of='production', limit=1, after=first['next'])
assert second['rows'][0]['id'] > first['rows'][0]['id']
assert call('query', seat='seat-2', of='production', filter=[['team','eq','crux']])['rows'] == []
buildings = call('query', seat='seat-1', of='buildings', filter=[['team','eq','sharded']], fields=['id','production'])['rows']
assert any(b['production'].get('supported') for b in buildings)
teammate = call('query', seat='seat-2', of='buildings', filter=[['team','eq','sharded']], fields=['id','production'])['rows']
assert teammate == buildings
collections = call('query', seat='seat-1', of='collections')['rows']
assert 'production' in [r['name'] for r in collections]
assert 'output_utilization' in next(r for r in collections if r['name']=='production')['fields']
lines = [json.loads(line) for line in (Path(sys.argv[1])/'production.jsonl').open()]
assert len(lines) >= 2 and not lines[0]['final'] and lines[-1]['final']
assert {r['id'] for line in lines for r in line['buildings']} == {r['id'] for r in rows}
assert lines[-1]['coverage']['supported_blocks']
print(json.dumps(result))
