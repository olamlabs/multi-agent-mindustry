"""Executed inside each real seat, after the Python client from instruction.md."""
import hashlib
import time
from pathlib import Path

seat = os.environ['HARBOR_SEAT']
world = os.environ['INTEGRATION_WORLD_ID']
marker = Path('/tmp/mindustry-integration-world')
assert not marker.exists(), 'Seat filesystem leaked from another world'
marker.write_text(world)
assert call('/')['you'] == seat
call('/ready', {})
while True:
    view = call('/update')
    assert not view['game_over'], 'Game ended before readiness'
    if view['status']['phase'] == 'running':
        break
    time.sleep(0.25)
initial = view
assert initial['status']['core']['health'] > 0
unit = initial['status']['you']['unit_id']
me = call('/query', {'of': 'units', 'filter': [['id', 'eq', unit]]})['rows'][0]
call('/query', {'of': 'ops'})
call('/say', {'text': world + ':' + seat})
call('/act', {'ops': [{'op': 'input', 'move_to': {'x': me['x'] + 3, 'y': me['y']}}]})
while True:
    view = call('/update')
    assert not view['game_over'], 'Game ended before action confirmation'
    moved = call('/query', {'of': 'units', 'filter': [['id', 'eq', unit]]})['rows'][0]
    if abs(moved['x'] - me['x']) > 0.25 or abs(moved['y'] - me['y']) > 0.25:
        break
    time.sleep(0.25)
while True:
    events = call('/events', {'latest': 20, 'filter': [['kind', 'eq', 'say']]})['events']
    assert all(not e.get('text', '').startswith('endless-integration-') or e['text'].startswith(world + ':') for e in events), 'Messages leaked from another world'
    peers = [e for e in events if e.get('text', '').startswith(world + ':') and e.get('from') != seat]
    if peers:
        break
    assert not call('/update')['game_over'], 'No teammate message before terminal'
    time.sleep(0.25)

out = Path('/logs/agent');out.mkdir(parents=True, exist_ok=True)
(out/'integration.json').write_text(json.dumps({
    'seat': seat, 'world': world, 'initial': initial,
    'movement': {'before': me, 'after': moved}, 'peer_messages': peers,
    'token_hash': hashlib.sha256(Path('/run/mindustry/token').read_bytes()).hexdigest(),
    'checks': ['documented_python_client', 'identity', 'readiness', 'query', 'movement', 'team_chat', 'fresh_filesystem'],
}, indent=2))
