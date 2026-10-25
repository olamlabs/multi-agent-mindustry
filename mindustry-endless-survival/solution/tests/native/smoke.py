"""Contract smoke against the real v160.5 engine; no mocked game responses."""
import argparse
import json
import math
import re
from pathlib import Path
import time
import urllib.request
parser = argparse.ArgumentParser()
parser.add_argument('--seats', type=int, required=True)
parser.add_argument('--evidence', required=True)
args = parser.parse_args()
seen_ops = set()
seen_codes = set()

def request(path, **body):
    req = urllib.request.Request('http://127.0.0.1:8091/' + path, json.dumps(body).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)

def call(path, seat='seat-1', **body):
    if seat is not None:
        body['seat'] = seat
    reply = request(path, **body)
    assert reply['ok'], (path, body, reply)
    return reply['result']

def reject(path, invalid=True, **body):
    """A refused call: `invalid` (malformed, 400 at the app) or refused as the game stands (409). Neither names a Java
    class."""
    reply = request(path, **body)
    assert not reply['ok'] and isinstance(reply['error'], str) and (reply['invalid'] is invalid), reply
    assert 'Exception' not in reply['error'], reply
    return reply['error']

def op(name, code=None, **body):
    seen_ops.add(name)
    result = call('act', ops=[{'op': name, **body}])['results'][0]
    assert result['index'] == 0, result
    if code:
        assert not result['ok'] and result['error']['code'] == code, (name, result)
        seen_codes.add(code)
    else:
        assert result['ok'] and result['error'] is None, (name, body, result)
    return result['effect']

def query(of, **body):
    return call('query', of=of, **body)['rows']

def eventually(fn, timeout=12):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        value = fn()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError('Timed out: ' + str(fn))

def measured_query(of, **body):
    measured = call('fixture_query', of=of, **body)
    rows = measured['result']['rows']
    assert measured['rows_built'] == len(rows), measured
    return rows

def point(x, y):
    return {'x': x, 'y': y}

def refusal(name, code, **body):
    seen_ops.add(name)
    result = call('act', ops=[{'op': name, **body}])['results'][0]
    assert not result['ok'] and result['error']['code'] == code, (name, body, result)
    seen_codes.add(code)
    return result['error']

def transfer_refusal(name, code, **body):
    result = call('act', ops=[{'op': name, **body}])['results'][0]
    assert not result['ok'] and result['error']['code'] == code, result
    facts = result['error']['facts']
    assert 'stack' in facts and facts['range_tiles'] > 0, facts
    if facts['building_exists']:
        assert facts['distance_tiles'] >= 0 and isinstance(facts['allow_deposit'], bool), facts
    if name == 'deposit':
        assert facts['cooldown_remaining_ms'] >= 0, facts
    return result['error']

def transfer_error(name, code, **body):
    return transfer_refusal(name, code, **body)['facts']
assert call('health', seat=None)['version'] == '160.5'
for method, body in [('GET', None), ('POST', b''), ('POST', b'{broken')]:
    req = urllib.request.Request('http://127.0.0.1:8091/health', body, method=method)
    with urllib.request.urlopen(req, timeout=30) as response:
        assert not json.load(response)['ok']
seats = ['seat-' + str(i + 1) for i in range(args.seats)]
settings = dict(seats=seats, game_mode='survival', map='Fork', time_limit_sec=None, team_sizes=[len(seats)], endless_survival=dict(first_wave_ticks=5184000, wave_spacing_ticks=7200, spawn_seed=1, enemy_unit_health_multiplier=1, enemy_unit_damage_multiplier=1), all_chat=True, video={'record': False}, save_interval_sec=1)
assert 'Explicit seats roster is required' in reject('setup', **{key:value for key,value in settings.items() if key!='seats'})
state = call('setup', seat=None, **settings)
assert state['configured'] and (not state['started']) and (not state['completed']), state
assert set(state['seat_teams']) == set(seats)
assert len(set(state['seat_teams'].values())) == 1
for forbidden in ['units', 'players', 'buildings', 'chat']:
    assert forbidden not in state
status = call('status')
assert list(status) == ['t', 'team', 'you', 'core', 'chat', 'wake_head'] or list(status) == ['t', 'team', 'you', 'core', 'chat', 'wave', 'wake_head'], status
assert status['team'] == state['seat_teams']['seat-1'] and status['chat'] is None, status
assert status['core'] and status['core']['health'] > 0 and isinstance(status['core']['items'], dict), status
seen = request('query', seat='seat-2', of='match', fields=['map'])
assert seen['ok'] and seen['status']['team'] == state['seat_teams']['seat-2'], seen
refused = request('query', seat='seat-2', of='tanks')
assert not refused['ok'] and refused['status']['team'] == state['seat_teams']['seat-2'], refused
assert 'status' not in request('state')
for collection, name in [('collections', 'collections'), ('blocks', 'conveyor'), ('unit_types', 'dagger'), ('items', 'copper'), ('liquids', 'water'), ('ops', 'configure')]:
    assert query(collection, filter=[['name', 'eq', name]], fields=['name']) == [{'name': name}]
assert query('tiles', area={'x': 0, 'y': 0, 'w': 1, 'h': 1}, fields=['id', 'x', 'y']) == [{'id': 0, 'x': 0, 'y': 0}]
assert query('match', fields=['game_mode', 'map', 'width', 'height']) == [{key: state[key] for key in ['game_mode', 'map', 'width', 'height']}]
for name, summary in {'conveyor': 'Transports items forward.', 'router': 'Distributes input items to all 4 output directions equally.', 'distributor': 'Distributes input items to all 8 output directions equally.', 'junction': 'Acts as a bridge for two crossing conveyor belts.', 'unloader': 'Unloads items from nearby blocks in any direction.\nOutput can be filtered to unload only specific items.'}.items():
    assert query('blocks', filter=[['name', 'eq', name]], fields=['description']) == [{'description': summary}]
assert all((row['description'] for row in query('blocks', limit=1000)))
for collection, described, missing in [('unit_types', 'gamma', 'dummy'), ('items', 'copper', 'fissile-matter'), ('liquids', 'water', 'gallium')]:
    assert query(collection, filter=[['name', 'eq', described]], fields=['description'])[0]['description']
    assert query(collection, filter=[['name', 'eq', missing]], fields=['description']) == [{'description': None}]
    assert 'description' in query('collections', filter=[['name', 'eq', collection]])[0]['fields']
assert call('events', cursor='setup.chat', filter=[['kind', 'eq', 'say']]) == {'cursor': 'setup.chat', 'events': [], 'more': False}
operations = {row['name']: row for row in query('ops')}
config_schema = operations['configure']['fields']['value']
assert set(config_schema['scalar_types']) == {'null', 'boolean', 'string', 'int'}
variants = config_schema['variants']
assert set(variants) == {'item', 'liquid', 'block', 'unit', 'command', 'stance', 'int', 'float', 'point', 'points', 'ints', 'bytes', 'logic'}
assert variants['point']['frame']['enum'] == ['relative']
absolute_frame = variants['points']['frame']['enum'][0]
assert absolute_frame == 'absolute' and variants['logic']['frame']['enum'] == [absolute_frame]
assert {'x', 'y', 'name'} == set(variants['logic']['links']['items'])
assert operations['plan_add']['fields']['plan']['variants']['construction']['rotation']['default'] == 0
assert operations['discard']['fields']['angle']['default'] == 0
for path, body in [('act', {'ops': [{'op': 'input', 'shoot': True}]}), ('say', {'text': 'too early'}), ('wake', {})]:
    assert reject(path, seat='seat-1', invalid=False, **body) == 'The game has not started'
call('start', seat=None, ready_seats=seats)
eventually(lambda: (call('status')['you'] or {}).get('unit_id'))
collections = query('collections', limit=2 ** 60)
assert {r['name'] for r in collections} == {'collections', 'match', 'players', 'teams', 'units', 'buildings', 'production', 'tiles', 'bullets', 'blocks', 'unit_types', 'items', 'liquids', 'ops'}
for collection in collections:
    name, key = (collection['name'], collection['key'])
    full = query(name, limit=2 ** 60)
    keys = [r[key] for r in full]
    assert all((isinstance(k, int) for k in keys)), (name, keys[:10])
    assert keys == sorted(set(keys)), (name, keys[:10])
    assert query(name, filter=[['missing.field', 'eq', None]], limit=2 ** 60) == []
    assert query(name, area={'x': -2, 'y': -2, 'w': 1, 'h': 1}, limit=2 ** 60) == []
    if full:
        wanted = full[0][key]
        rows = query(name, filter=[[key, 'eq', wanted]], fields=[key], limit=2 ** 60)
        assert rows == [{key: wanted}], (name, rows)
        page = call('query', of=name, fields=[key], limit=1)
        assert page['rows'] == [{key: wanted}]
        if len(full) > 1:
            assert page['next'] == wanted
            second = call('query', of=name, fields=[key], limit=1, after=page['next'])
            assert second['rows'][0][key] > wanted
        else:
            assert page['next'] is None
assert query('items', filter=[['name', 'in', ['copper', 'lead']]], fields=['name']) == [{'name': 'copper'}, {'name': 'lead'}]
assert query('items', filter=[['name', 'in', ['copper', 'lead']], ['name', 'ne', 'lead']], fields=['name']) == [{'name': 'copper'}]
assert query('items', filter=[['name', 'in', ['copper', 'lead']], ['name', 'not_in', ['lead']]], fields=['name']) == [{'name': 'copper'}]
for operator, value in [('ne', None), ('not_in', [])]:
    assert query('items', filter=[['missing.field', operator, value]]) == []
reject('query', seat='seat-1', of='items', filter=[['name', 'not_in', 'lead']])
assert query('items', filter=[['name', 'contains', 'copp']], fields=['name']) == [{'name': 'copper'}]
assert query('items', filter=[['id', 'lt', 1e+100]], limit=2 ** 60) == query('items', limit=2 ** 60)
assert query('items', filter=[['id', 'eq', -0.0]], fields=['id']) == [{'id': 0}]
assert query('items', filter=[['id', 'eq', 0], ['id', 'gt', -0.0]]) == []
assert query('tiles', area={'x': 0, 'y': 0, 'w': 1e+100, 'h': 1e+100}, limit=1, fields=['id']) == [{'id': 0}]
world = query('match')[0]
width, height = (world['width'], world['height'])
for area in [{'x': 2.25, 'y': 3.5, 'w': 3, 'h': 2}, {'x': -1.5, 'y': -2, 'w': 3, 'h': 4}, {'x': width - 0.5, 'y': height - 0.5, 'w': 1e+100, 'h': 1e+100}, {'x': 4, 'y': 4, 'w': 0, 'h': 3}, {'x': 1e+100, 'y': 0, 'w': 1e+100, 'h': 1}]:
    expected = [{'id': y * width + x} for y in range(height) for x in range(width) if area['x'] <= x < area['x'] + area['w'] and area['y'] <= y < area['y'] + area['h']]
    assert measured_query('tiles', area=area, fields=['id'], limit=2 ** 60) == expected
    if expected:
        after = expected[0]['id']
        assert measured_query('tiles', area=area, fields=['id'], after=after, limit=2 ** 60) == expected[1:]
        page = call('query', of='tiles', area=area, fields=['id'], limit=1)
        assert page['rows'] == expected[:1]
        assert page['next'] == (after if len(expected) > 1 else None)
assert measured_query('tiles', after=2 ** 60) == []
for operator in ['lt', 'le', 'gt', 'ge']:
    query('units', filter=[['health', operator, 10]])
reject('query', seat='seat-1', of='units', filter=[['id', 'bad', 1]])
nin = reject('query', seat='seat-1', of='units', filter=[['id', 'ge', 0], ['id', 'nin', [1]]])
assert nin == 'filter[1]: op "nin" is not one of eq, ne, in, not_in, lt, le, gt, ge, contains', nin
assert reject('query', seat='seat-1', of='tanks').startswith('of: "tanks" is not one of collections, match, players')
sand = reject('query', seat='seat-1', of='tiles', filter=[['floor', 'in', ['sand', 'darksand']]])
assert sand.startswith('filter[0]: no floor is named "sand"; the floor names containing it are ') and 'sand-floor' in sand and ('darksand' in sand), sand
for of, path, value in [('units', 'type', 'gama'), ('buildings', 'type', 'conveyer'), ('tiles', 'ore', 'copper'), ('items', 'name', 'coper'), ('units', 'team', 'Sharded'), ('liquids', 'name', 'oil2'), ('unit_types', 'name', 'flare2')]:
    assert f'"{value}"' in reject('query', seat='seat-1', of=of, filter=[[path, 'ne', value]]), (of, path)
for of, path, value in [('tiles', 'floor', 'darksand'), ('tiles', 'ore', 'ore-copper'), ('tiles', 'block', 'air'), ('units', 'team', 'derelict'), ('units', 'type', 'gamma'), ('buildings', 'type', 'conveyor'), ('items', 'name', 'copper'), ('tiles', 'ore', None)]:
    query(of, filter=[[path, 'eq', value]], limit=1)
assert query('units', filter=[['type', 'contains', 'gam']], limit=1) is not None
reject('query', seat='seat-1', of='units', limit=0)
reject('query', seat='seat-1', of='units', unexpected=True)
reject('query', seat='seat-1', of='units', limit=None)
reject('events', seat='seat-1', after=0, limit=None)
reject('query', seat='seat-1', of='items', after='copper')
reject('query', seat='seat-1', of='items', after=None)
assert query('items', after=2 ** 60) == []
assert call('events', after=2 ** 60) == {'events': [], 'next': 2 ** 60, 'more': False}
reject('status', seat='missing')
reject('act', seat='seat-1', ops=[])
reject('act', seat='seat-1', ops=[{'op': 'input', 'move': point(1, 0), 'move_to': point(1, 2)}])
reject('act', seat='seat-1', ops=[{'op': 'tap', 'tile': [0, 0]}])
for malformed, path, allowed in [({'op': 'input', 'bogus': 1}, 'bogus', 'shoot'), ({'op': 'unknown'}, 'op', 'plan_add'), ({'op': 'withdraw', 'building': 1, 'item': 'copper'}, 'amount', 'int'), ({'op': 'withdraw', 'building': 'wrong', 'item': 'copper', 'amount': 1}, 'building', 'int'), ({'op': 'control', 'target': {'kind': 'tile', 'id': 1}}, 'target.kind', 'building'), ({'op': 'plan_add', 'plan': {'x': 1, 'y': 1, 'block': 'conveyor', 'rotation': 4}}, 'plan.rotation', '0..3'), ({'op': 'configure', 'building': 1, 'value': {'type': 'wat'}}, 'value.type', 'points'), ({'op': 'plan_add', 'plan': {'x': 1, 'y': 1, 'block': 'ground-factory', 'config': {'name': 'flare'}}}, 'plan.config.type: required; one of item, liquid, block, unit', 'logic'), ({'op': 'configure', 'building': 1}, 'value: required; expected a configuration', '{type, ...}'), ({'op': 'configure', 'building': 1, 'value': {'type': 'logic', 'frame': 'absolute', 'code': 'end', 'links': [{'x': 1, 'y': 'bad', 'name': 'node1'}]}}, 'value.links[0].y', 'int'), ({'op': 'discard', 'angle': None}, 'angle', 'number'), ({'op': 'plan_add', 'plan': {'x': 1, 'y': 1, 'block': 'conveyor', 'rotation': None}}, 'plan.rotation', '0..3'), ({'op': 'plan_add', 'plan': {'x': 1, 'y': 1, 'block': 'power-node', 'config': {'type': 'points', 'frame': 'relative', 'values': []}}}, 'plan.config.frame', 'absolute'), ({'op': 'configure', 'building': 1, 'value': {'type': 'point', 'frame': 'absolute', 'x': 1, 'y': 2}}, 'value.frame', 'relative'), ({'op': 'configure', 'building': 1, 'value': {'type': 'bytes', 'base64': '?!'}}, 'value.base64', 'base64')]:
    before = call('events', after=0, limit=2 ** 60)['next']
    error = reject('act', seat='seat-1', ops=[{'op': 'input', 'shoot': True}, malformed])
    assert f'ops[1].{path}' in error and allowed in error, error
    assert not call('events', after=before, filter=[['kind', 'eq', 'act']])['events']
    me = call('status')['you']['unit_id']
    assert query('units', filter=[['id', 'eq', me]])[0]['shooting'] == 0
for route in ['map', 'render-state', 'catalog', 'action']:
    reject(route)
for operation, field in [({'op': 'input'}, 'move'), ({'op': 'input'}, 'move_to'), ({'op': 'input'}, 'aim'), ({'op': 'input'}, 'mine'), ({'op': 'command', 'units': [1]}, 'target'), ({'op': 'rally', 'buildings': [1]}, 'target'), ({'op': 'payload_drop'}, 'at'), ({'op': 'ping'}, 'at'), ({'op': 'rebuild_remove'}, 'tiles')]:
    for malformed in [[1, 2], {'x': 1}, {'x': 1, 'y': '2'}, {'x': 1, 'y': 2, 'z': 3}, {'x': 1e+100, 'y': 2}]:
        value = [malformed] if field == 'tiles' else malformed
        error = reject('act', seat='seat-1', ops=[{**operation, field: value}])
        assert f'ops[0].{field}' in error, (operation, field, error)
for field in ['mine', 'tiles']:
    value = point(1.5, 2)
    operation = {'op': 'input', field: value} if field == 'mine' else {'op': 'rebuild_remove', field: [value]}
    assert f'ops[0].{field}' in reject('act', seat='seat-1', ops=[operation])
other = 'seat-2'
enemy = seats[-1]
base = call('status')
message = call('say', text='team hello', to=[other], data={'n': 1})['message']
assert message['from'] == 'seat-1' and message['audience'] == 'team'
assert 'seq' not in message and message['id']
heard = call('status', seat=other)['chat']
assert heard['from'] == 'seat-1' and heard['to'] == [other] and (heard['text'] == 'team hello') and (heard['data'] == {'n': 1}), heard
assert call('status')['chat'] == base['chat']
assert call('status')['wake_head'] == base['wake_head']
assert call('status', seat=other)['wake_head'] > 0
note = call('say', audience='self', text='note')['message']
assert 'seq' not in note
note_seq = call('events', latest=1, filter=[['id', 'eq', note['id']]])['events'][0]['seq']
assert call('status')['chat']['seq'] == note_seq and call('status')['chat']['text'] == 'note'
assert call('status')['wake_head'] == note_seq
call('say', seat=other, reply_to=message['id'], text='reply')
reject('say', seat='seat-1', reply_to='missing', text='bad')
reject('say', seat='seat-1', audience='self', to=[other], text='bad')
reject('say', seat='seat-1')
broadcast = call('say', audience='all', text='public')['message']
assert any((e.get('id') == broadcast['id'] for e in call('events', seat=enemy, after=0)['events']))

def seq_of(said):
    return call('events', latest=1, filter=[['id', 'eq', said['id']]])['events'][0]['seq']

def default_wake(seat):
    return [[['kind', 'eq', 'say'], ['from', 'ne', seat]], [['kind', 'eq', 'say'], ['audience', 'eq', 'self']]]
assert call('wake') == {'filters': default_wake('seat-1')}
assert call('wake', seat=other) == {'filters': default_wake(other)}
old_head = call('status')['wake_head']
assert call('wake', filters=[]) == {'filters': []}
call('say', audience='self', text='nothing wakes')
call('say', seat=other, text='nothing wakes')
assert call('status')['wake_head'] == old_head
self_only = [[['audience', 'eq', 'self']]]
assert call('wake', filters=self_only) == {'filters': self_only}
assert call('wake') == {'filters': self_only}
assert call('status')['wake_head'] == old_head
call('say', seat=other, text='not waking')
assert call('status')['wake_head'] == old_head
woke = call('say', audience='self', text='wakes')['message']
assert call('status')['wake_head'] == seq_of(woke)
either = [[['kind', 'eq', 'never']], [['kind', 'eq', 'say'], ['from', 'eq', other]]]
assert call('wake', filters=either) == {'filters': either}
woke = call('say', seat=other, text='wakes by its second filter')['message']
assert call('status')['wake_head'] == seq_of(woke)
kept = [[['data', 'eq', {'n': 1}], ['reply_to', 'eq', None]], [['t', 'gt', 1.5], ['to', 'contains', other]], [['kind', 'in', ['say', 'act']]]]
assert call('wake', filters=kept) == {'filters': kept}
for bad in [{'after': 0, 'filter': []}, {'filters': None}, {'filters': [None]}, {'filters': [[['kind', 'eq']]]}, {'filters': [kept[0], [['kind', 'like', 'say']]]}, {'filters': [[['kind', 'in', 'say']]]}]:
    reject('wake', seat='seat-1', **bad)
assert call('wake') == {'filters': kept}
team = call('status')['team']
call('wake', filters=default_wake('seat-1') + [[['kind', 'eq', 'unit_create'], ['unit.team', 'eq', team]]])
made = call('fixture_unit_create', seat=None)['unit']
created = call('events', latest=1, filter=[['kind', 'eq', 'unit_create'], ['unit.id', 'eq', made]])['events'][0]
assert created['unit']['team'] == team and call('status')['wake_head'] == created['seq'], created
call('wake', filters=default_wake('seat-1'))
for seat in seats:
    events = call('events', seat=seat, after=0, limit=2 ** 60)['events']
    assert [e['seq'] for e in events] == list(range(1, len(events) + 1))
page = call('events', after=0, filter=[['kind', 'eq', 'say']], fields=['seq', 'kind'], limit=1)
assert len(page['events']) == 1 and page['next'] == page['events'][0]['seq'] and page['more']
empty = call('events', after=0, filter=[['kind', 'eq', 'never']], limit=1)
assert empty['events'] == [] and (not empty['more']) and (empty['next'] > 0)
chat_filter = [['kind', 'eq', 'say']]
baseline = call('events', latest=2 ** 60, filter=chat_filter)['events']
first = call('events', cursor='model.chat', filter=chat_filter, fields=['id'], limit=1)
assert first == {'cursor': 'model.chat', 'events': [{'id': baseline[0]['id']}], 'more': True}
for bad in [{'filter': [['kind', 'eq', 'act']]}, {'fields': ['.']}, {'limit': 0}, {'after': 0}, {'latest': 1}, {'filter': [['kind', 'not_in', 'say']]}]:
    reject('events', seat='seat-1', invalid=bad != {'filter': [['kind', 'eq', 'act']]}, cursor='model.chat', **bad)
program = call('events', cursor='miner.chat', filter=chat_filter, fields=['id'], limit=1)
assert program['events'] == first['events']
assert call('events', after=0, filter=chat_filter, fields=['id'], limit=1)['events'] == first['events']
assert call('events', latest=2, filter=chat_filter)['events'] == baseline[-2:]
assert call('events', latest=2 ** 60, filter=chat_filter) == {'events': baseline}
assert call('events', latest=1, filter=[['kind', 'eq', 'never']]) == {'events': []}
for bad in [{}, {'cursor': ''}, {'cursor': None}, {'latest': 0}, {'latest': 1.5}, {'latest': None}, {'latest': 1, 'limit': 1}, {'latest': 1, 'after': 0}]:
    reject('events', seat='seat-1', **bad)
second = call('events', cursor='model.chat', fields=['id'], limit=1)
assert second['events'] == [{'id': baseline[1]['id']}]
remaining = call('events', cursor='model.chat', filter=chat_filter, limit=2 ** 60)
assert remaining['events'] == baseline[2:] and (not remaining['more'])
assert call('events', cursor='model.chat')['events'] == []
assert call('events', cursor='setup.chat')['events'] == baseline
assert call('events', cursor='all.events', limit=1)['events'] == call('events', after=0, limit=1)['events']
assert call('events', cursor='all.events', filter=[], limit=1)['events'] == call('events', after=1, limit=1)['events']
reject('events', seat='seat-1', cursor='new.reader', filter=chat_filter, fields=['.'])
assert call('events', cursor='new.reader', filter=chat_filter, limit=1)['events'] == baseline[:1]
other_baseline = call('events', seat=other, latest=2 ** 60, filter=chat_filter)['events']
assert call('events', seat=other, cursor='model.chat', filter=chat_filter)['events'] == other_baseline
unread = [call('say', seat=other, text=f'unread {i}')['message']['id'] for i in range(3)]
op('input', shoot=False)
assert 'head' not in call('status')
received = []
while True:
    page = call('events', cursor='model.chat', limit=1)
    assert set(page) == {'cursor', 'events', 'more'}
    received.extend((e['id'] for e in page['events']))
    if not page['more']:
        break
assert received == unread, received
negative = [['kind', 'eq', 'say'], ['from', 'ne', 'seat-1'], ['audience', 'not_in', ['self']]]
assert [e['id'] for e in call('events', latest=3, filter=negative)['events']] == unread
assert call('wake', filters=[negative]) == {'filters': [negative]}
woke = call('say', seat=other, text='negative')['message']
assert call('status')['wake_head'] == seq_of(woke)
call('wake', filters=default_wake('seat-1'))
for operator, value in [('ne', None), ('not_in', [])]:
    assert call('events', latest=1, filter=[['missing', operator, value]]) == {'events': []}
assert call('events', cursor='miner.chat', limit=1)['events'] == baseline[1:2]
assert call('events', seat=enemy, latest=1, filter=[['audience', 'eq', 'self']]) == {'events': []}
numeric_filter = [['data', 'eq', {'n': 1}]]
assert call('events', cursor='numeric.filter', filter=numeric_filter)['events'][0]['id'] == message['id']
assert call('events', cursor='numeric.filter', filter=[['data', 'eq', {'n': 1.0}]])['events'] == []
catalog = query('blocks', fields=['id', 'name'], limit=2 ** 60)
assert [b['id'] for b in catalog] == call('fixture_blocks', seat=None)['visible_ids']
assert not {'air', 'spawn', *(f'build{i}' for i in range(1, 17))} & {b['name'] for b in catalog}
assert 'conveyor' in {b['name'] for b in catalog}
fixture = call('fixture', seat=None)
unit_id = call('status')['you']['unit_id']
unit = query('units', filter=[['id', 'eq', unit_id]])[0]
assert {'velocity_x', 'health', 'stack', 'plans', 'command', 'stance', 'target'} <= unit.keys()
for collection in collections:
    assert 'color' not in collection['fields'], collection
assert 'color' not in unit
assert query('units', filter=[['id', 'eq', unit_id]], fields=['color']) == [{}]
assert not {'camera_x', 'bullet_lifetime', 'power_net_in'} & unit.keys()
assert unit['health'] > 0 and unit['shooting'] == 0
assert unit['controlled'] == 'player', unit
assert {u['controlled'] for u in query('units', limit=2 ** 60)} <= {'player', 'processor', 'command', 'ai'}
assert all((v is not None for k, v in unit.items() if k not in {'command', 'target'})), unit
assert query('units', filter=[['id', 'eq', unit_id], ['bullet_lifetime', 'eq', None]]) == []
assert query('units', filter=[['id', 'eq', unit_id]], fields=['bullet_lifetime']) == [{}]
assert query('tiles', area={'x': unit['x'], 'y': unit['y'], 'w': 1, 'h': 1})[0]['block'] == 'air'
assert isinstance(call('status')['t'], (int, float))
assert isinstance(call('query', of='match')['tick'], int)
for path in ['.', 'health.']:
    reject('query', seat='seat-1', of='units', fields=[path])
own = fixture['own_config']
foreign = fixture['foreign_config']
assert 'config' in query('buildings', filter=[['id', 'eq', own]])[0]
assert 'config' not in query('buildings', filter=[['id', 'eq', foreign]])[0]
assert query('buildings', filter=[['id', 'eq', foreign], ['config', 'eq', None]]) == []
assert query('buildings', filter=[['id', 'eq', fixture['public_config']]])[0]['config'] == {'type': 'item', 'name': 'lead'}
for collection, ids in [('units', [fixture['command_unit'], fixture['carrier']]), ('buildings', [own, foreign, fixture['storage']])]:
    expected = [{'id': id} for id in sorted(ids)]
    assert measured_query(collection, filter=[['id', 'in', ids + ids + ['wrong', None, 1.5, 1e+100]]], fields=['id'], limit=2 ** 60) == expected
    assert measured_query(collection, filter=[['id', 'eq', float(ids[0])]], fields=['id']) == [{'id': ids[0]}]
    assert measured_query(collection, filter=[['id', 'in', ids], ['id', 'eq', ids[0]]], fields=['id']) == [{'id': ids[0]}]
    assert measured_query(collection, filter=[['id', 'eq', ids[0]], ['id', 'eq', ids[1]]]) == []
    assert measured_query(collection, filter=[['id', 'in', []]]) == []
    assert measured_query(collection, filter=[['id', 'eq', 'wrong']]) == []
    assert measured_query(collection, area={'x': -2, 'y': -2, 'w': 1, 'h': 1}) == []
building = query('buildings', filter=[['id', 'eq', fixture['storage']]])[0]
assert all((v is not None for k, v in building.items() if k != 'config')), building
assert measured_query('buildings', filter=[['id', 'eq', building['id']]], area={'x': building['x'], 'y': building['y'], 'w': 0.1, 'h': 0.1}, fields=['id']) == [{'id': building['id']}]
assert measured_query('buildings', filter=[['id', 'eq', building['id']]], area={'x': building['x'] - 1, 'y': building['y'], 'w': 1, 'h': 1}) == []
start = [unit['x'], unit['y']]
assert op('input', move=point(1, 0))['move'] == point(1, 0)
eventually(lambda: query('units', filter=[['id', 'eq', unit_id]])[0]['x'] > start[0] + 0.5)
assert op('input', move=point(0, 0))['move'] == point(0, 0)
assert op('input', move_to=point(*start))['move_to'] == point(*start)
eventually(lambda: math.dist(start, [query('units', filter=[['id', 'eq', unit_id]])[0][k] for k in ['x', 'y']]) < 0.3)
assert op('input', move_to=None, aim=point(start[0] + 10, start[1]), shoot=True, boost=False, building=False, mine=None)['aim'] == point(start[0] + 10, start[1])
bullets = eventually(lambda: query('bullets'))
assert {'velocity_x', 'velocity_y', 'bullet_lifetime', 'bullet_time'} <= bullets[0].keys()
assert 'color' not in bullets[0]
assert all((v is not None for v in bullets[0].values())), bullets[0]
assert measured_query('bullets', area={'x': -2, 'y': -2, 'w': 1, 'h': 1}) == []
assert measured_query('bullets', filter=[['id', 'eq', -1]]) == []
assert measured_query('bullets', filter=[['id', 'in', []]]) == []
op('input', shoot=False)
assert op('input', mine=fixture['mine_tile'])['mine'] == fixture['mine_tile']
assert op('input', mine=None)['mine'] is None
for huge in [point(1e38, 0), point(0, -1e38)]:
    for operation in [
        {'op': 'input', 'aim': huge}, {'op': 'input', 'move_to': huge},
        {'op': 'command', 'units': [-1], 'target': huge}, {'op': 'rally', 'buildings': [-1], 'target': huge},
        {'op': 'payload_drop', 'at': huge}, {'op': 'ping', 'at': huge},
    ]:
        before = call('events', after=0, limit=2 ** 60)['next']
        rejection = reject('act', seat='seat-1', ops=[{'op': 'input', 'shoot': True}, operation, {'op': 'input', 'shoot': False}])
        assert 'ops[1].' in rejection and 'native position range' in rejection, rejection
        assert call('events', after=before, filter=[['kind', 'eq', 'act']])['events'] == []
        assert op('input', building=False)['shoot'] is False, 'validation must run before any operation mutates held controls'
for operation, code in [({'op': 'input', 'aim': point(1e37, 0)}, 'out_of_range'), ({'op': 'input', 'move': point(1e38, 0)}, 'invalid_args')]:
    results = call('act', ops=[operation, {'op': 'input', 'shoot': False}])['results']
    assert not results[0]['ok'] and results[0]['error']['code'] == code and results[1]['ok'], results
for initial_move in [{'move': point(0.25, 0.5)}, {'move_to': point(*start)}]:
    baseline = {'op': 'input', **initial_move, 'aim': point(start[0] + 6, start[1]), 'shoot': True, 'boost': True, 'building': False, 'mine': fixture['mine_tile']}
    for invalid, code in [({'move': point(2, 0)}, 'invalid_args'), ({'move_to': point(state['width'], 0)}, 'out_of_range'), ({'move': point(0, 0), 'aim': point(state['width'], 0)}, 'out_of_range'), ({'move': point(0, 0), 'aim': point(start[0], start[1] + 6), 'shoot': False, 'boost': False, 'building': True, 'mine': fixture['far_mine_tile']}, 'out_of_range'), ({'move_to': None, 'shoot': False, 'mine': fixture['bare_tile']}, 'not_accepted'), ({'move': point(0, 0), 'mine': point(state['width'], 0)}, 'out_of_range')]:
        before = call('events', after=0, limit=2 ** 60)['next']
        operations = [baseline, {'op': 'input', **invalid}, {'op': 'input', 'building': False}, {'op': 'input', 'move_to': None, 'shoot': False, 'boost': False, 'mine': None}]
        results = call('act', ops=operations)['results']
        assert results[0]['ok'] and results[2]['ok'] and results[3]['ok'], results
        assert not results[1]['ok'] and results[1]['error']['code'] == code and (results[1]['effect'] is None), results
        assert results[2]['effect'] == results[0]['effect'], results
        logged = call('events', after=before, filter=[['kind', 'eq', 'act']])['events']
        assert len(logged) == 3, logged
far = call('act', ops=[{'op': 'input', 'mine': fixture['far_mine_tile']}])['results'][0]
assert not far['ok'] and far['error']['code'] == 'out_of_range', far
assert far['error']['facts']['distance_tiles'] > far['error']['facts']['unit']['mine_range_tiles'], far
away, reach = map(float, re.fullmatch('Mining tile is ([\\d.]+) tiles away; this unit mines within ([\\d.]+)', far['error']['message']).groups())
assert abs(away - far['error']['facts']['distance_tiles']) < 0.01 and abs(reach - far['error']['facts']['unit']['mine_range_tiles']) < 0.01, far
own_core = query('buildings', filter=[['type', 'contains', 'core'], ['team', 'eq', call('status')['team']]], fields=['id', 'type', 'team', 'x', 'y'], limit=1)[0]
built = call('act', ops=[{'op': 'input', 'mine': point(own_core['x'], own_core['y'])}])['results'][0]
assert not built['ok'] and built['error']['code'] == 'not_accepted', built
assert built['error']['facts']['block'].startswith('core') and built['error']['facts']['mine_result'] is None, built
assert {'floor', 'overlay', 'floor_drop', 'wall_drop', 'unit', 'distance_tiles'} <= built['error']['facts'].keys(), built
covered = call('act', ops=[{'op': 'input', 'mine': point(3, 3)}])['results'][0]
assert not covered['ok'] and covered['error']['code'] == 'not_accepted' and (covered['error']['facts']['block'] == 'container'), covered
assert covered['error']['facts']['distance_tiles'] > covered['error']['facts']['unit']['mine_range_tiles'], covered
miner = built['error']['facts']['unit']['type']
core_at = f"({int(own_core['x'])},{int(own_core['y'])})"
assert built['error']['message'] == f"Tile {core_at} is covered by the {own_core['team']} {own_core['type']} (building {own_core['id']}) at {core_at}; {miner} mines only floor tiles with no block on them", built
assert covered['error']['message'] == f"Tile (3,3) is covered by the {own_core['team']} container (building {fixture['far_storage']}) at (3,3); {miner} mines only floor tiles with no block on them", covered
bare = refusal('input', 'not_accepted', mine=fixture['bare_tile'])
assert bare['message'] == f"Tile ({fixture['bare_tile']['x']},{fixture['bare_tile']['y']}) drops nothing to mine (floor stone, no ore)", bare
hard = refusal('input', 'not_accepted', mine=fixture['hard_mine_tile'])
assert hard['message'] == f"titanium at ({fixture['hard_mine_tile']['x']},{fixture['hard_mine_tile']['y']}) has hardness 3; {miner} mines up to hardness {hard['facts']['unit']['mine_tier']}", hard
construction = call('fixture_construction', seat=None)
assert construction['disabled']['state'] == 'blocked', construction
assert construction['disabled']['blocked_reasons'] == ['building_disabled'], construction
assert construction['queued']['state'] == 'queued', construction
assert construction['started']['state'] == 'building', construction
assert 0 < construction['started']['progress'] < 1, construction
assert construction['away']['state'] == 'blocked' and 'out_of_range' in construction['away']['blocked_reasons'], construction
assert construction['away']['progress'] == construction['started']['progress'], construction
assert construction['helped']['progress'] > construction['away']['progress'], construction
assert construction['helped']['progress_source'] == 'world', construction
assert construction['helped'] == construction['reread'], construction
assert construction['resumed']['state'] == 'building' and construction['resumed']['progress'] > construction['helped']['progress'], construction
assert construction['missing']['state'] == 'blocked' and 'missing_resources' in construction['missing']['blocked_reasons'], construction
assert construction['starved']['progress'] == construction['missing']['progress'], construction
assert construction['paid']['state'] == 'building' and (not construction['paid']['blocked_reasons']), construction
assert construction['deconstructed']['progress'] < construction['deconstruction']['progress'], construction
assert construction['completed']['target_complete'] and construction['completed']['progress'] == 0, construction
assert construction['completed']['state'] == 'queued' and (not construction['completed']['blocked_reasons']), construction
assert construction['vanished']['state'] == 'blocked' and 'invalid_target' in construction['vanished']['blocked_reasons'], construction
assert construction['vanished']['progress'] is None and construction['vanished']['progress_source'] == 'unavailable', construction
x, y = fixture['plan_tile']
plan = {'x': x, 'y': y, 'block': 'conveyor'}
queued = op('plan_add', plan=plan)
assert queued == {'queued': 1, 'plan': {'x': x, 'y': y, 'breaking': False, 'block': 'conveyor', 'rotation': 0}}, queued
queued_row = next((p for p in query('units', filter=[['id', 'eq', unit_id]])[0]['plans'] if p['x'] == x and p['y'] == y))
assert queued_row['rotation'] == 0 and {'progress', 'stuck'} <= queued_row.keys(), queued_row
second_plan = {'x': x + 1, 'y': y, 'block': 'conveyor', 'rotation': 0}
op('plan_add', plan=second_plan)
first = op('plan_prioritize', key={'x': x + 1, 'y': y, 'breaking': False})['first']
assert (first['x'], first['y']) == (x + 1, y)
assert op('plan_remove', key={'x': x + 1, 'y': y, 'breaking': False})['plans'] == 1
assert op('plan_clear')['plans'] == 0
configured_plan = op('plan_add', plan={'x': x + 1, 'y': y, 'block': 'sorter', 'config': {'type': 'item', 'name': 'lead'}})['plan']
assert configured_plan['config'] == {'type': 'item', 'name': 'lead'}
assert not {'progress', 'stuck'} & configured_plan.keys()
op('plan_clear')
assert op('plan_add', plan={'x': x + 1, 'y': y, 'block': 'sorter', 'config': None})['plan'] == {'x': x + 1, 'y': y, 'breaking': False, 'block': 'sorter', 'rotation': 0}
op('plan_clear')
here = query('units', filter=[['id', 'eq', fixture['command_unit']]], fields=['x', 'y', 'type'])[0]
wall = point(round(here['x']), round(here['y']))
standing = refusal('plan_add', 'invalid_placement', plan={**wall, 'block': 'copper-wall'})
assert standing['message'].startswith(f"Ground units stand in the copper-wall footprint at ({wall['x']},{wall['y']}): "), standing
assert f"{here['type']} {fixture['command_unit']} ({team})" in standing['message'], standing
assert not standing['facts']['no_unit_overlap'] and standing['facts']['valid_ignoring_units'], standing
bare_drill = refusal('plan_add', 'invalid_placement', plan={'x': x - 8, 'y': y + 8, 'block': 'mechanical-drill'})
assert bare_drill['message'] == f'No tile under mechanical-drill at ({x - 8},{y + 8}) has an item it can mine at tier 2: the tiles drop nothing', bare_drill
assert not bare_drill['facts']['block_can_place_on'], bare_drill
op('plan_add', plan=plan)
op('input', building=True)
eventually(lambda: query('buildings', filter=[['x', 'eq', x], ['y', 'eq', y], ['type', 'eq', 'conveyor']]))
for kind in ['block_build_begin', 'block_build_end']:
    assert call('events', after=0, filter=[['kind', 'eq', kind]])['events'], kind
built = query('buildings', filter=[['x', 'eq', x], ['y', 'eq', y]])[0]
op('rotate', building=built['id'], clockwise=True)
call('fixture_kill', seat=None, building=built['id'])
team = call('status')['team']
assert any((p['x'] == x and p['y'] == y for p in query('teams', filter=[['name', 'eq', team]])[0]['plans']))
assert op('rebuild_remove', tiles=[point(x, y)])['removed'] == 1
assert not any((p['x'] == x and p['y'] == y for p in query('teams', filter=[['name', 'eq', team]])[0]['plans']))
assert call('events', after=0, filter=[['kind', 'eq', 'block_destroy'], ['building.id', 'eq', built['id']]])['events']
op('configure', building=own, value={'type': 'logic', 'frame': 'absolute', 'code': 'end', 'links': []})
node = query('buildings', filter=[['id', 'eq', fixture['power_node']]])[0]
destination = point(node['x'] + 3, node['y'])
links = {'type': 'points', 'frame': absolute_frame, 'values': [destination]}
op('configure', building=node['id'], value={'type': 'points', 'frame': 'absolute', 'values': []})
assert op('configure', building=node['id'], value=links)['config'] == links
node = query('buildings', filter=[['id', 'eq', node['id']]])[0]
assert node['config'] == links and node['power_links'] == [destination]
assert node['power_links_frame'] == 'absolute' and 'color' not in node
linked = query('buildings', filter=[['x', 'eq', destination['x']], ['y', 'eq', destination['y']]])[0]
assert point(node['x'], node['y']) in linked['power_links']
event = call('events', latest=1, filter=[['kind', 'eq', 'config'], ['building.id', 'eq', node['id']]])['events'][0]
assert event['value'] == links, event
for value, path in [({'type': 'points', 'frame': 'relative', 'values': [point(3, 0)]}, 'frame'), ({'type': 'points', 'values': [destination]}, 'frame'), ({'type': 'points', 'frame': 'absolute', 'values': [[3, 0]]}, 'values[0]')]:
    error = reject('act', seat='seat-1', ops=[{'op': 'configure', 'building': node['id'], 'value': value}])
    assert f'ops[0].value.{path}' in error, error
for targets in [[point(3, 0)], [point(node['x'], node['y'])], [destination, point(3, 0)], [destination, destination]]:
    op('configure', 'invalid_args', building=node['id'], value={'type': 'points', 'frame': 'absolute', 'values': targets})
    assert query('buildings', filter=[['id', 'eq', node['id']]])[0]['config'] == links
for id in [fixture['foreign_power'], fixture['far_power']]:
    target = query('buildings', filter=[['id', 'eq', id]])[0]
    op('configure', 'invalid_args', building=node['id'], value={'type': 'points', 'frame': 'absolute', 'values': [destination, point(target['x'], target['y'])]})
    assert query('buildings', filter=[['id', 'eq', node['id']]])[0]['config'] == links
op('configure', 'invalid_args', building=node['id'], value=0)
storage = fixture['storage']
assert query('buildings', filter=[['id', 'eq', storage]])[0]['controlled'] == 'none'
call('fixture_transfer', seat=None)
empty_stack = transfer_error('deposit', 'insufficient_items', building=storage)
assert empty_stack['stack']['amount'] == 0
unknown = transfer_error('withdraw', 'unknown_entity', building=-1, item='copper', amount=5)
assert not unknown['building_exists']
foreign_facts = transfer_error('withdraw', 'not_allied', building=foreign, item='copper', amount=5)
assert foreign_facts['building_exists']
far_error = transfer_refusal('withdraw', 'out_of_range', building=fixture['far_storage'], item='copper', amount=5)
far_facts = far_error['facts']
assert far_facts['distance_tiles'] > far_facts['range_tiles']
away, reach = map(float, re.fullmatch('Building is ([\\d.]+) tiles away; items transfer within ([\\d.]+)', far_error['message']).groups())
assert abs(away - far_facts['distance_tiles']) < 0.01 and abs(reach - far_facts['range_tiles']) < 0.01, far_error
no_inventory = transfer_error('withdraw', 'unsupported', building=own, item='copper', amount=5)
assert not no_inventory['has_inventory']
no_item = transfer_error('withdraw', 'insufficient_items', building=storage, item='thorium', amount=5)
assert no_item['building_items'] == 0 and no_item['item'] == 'thorium'
invalid = transfer_error('withdraw', 'invalid_args', building=storage, item='copper', amount=0)
assert invalid['requested_amount'] == 0
op('withdraw', building=storage, item='copper', amount=5)
rejected_error = transfer_refusal('deposit', 'not_accepted', building=fixture['factory'])
rejected = rejected_error['facts']
assert rejected['stack'] == {'item': 'copper', 'amount': 5}
assert rejected['building_accepts_amount'] == 0 and (not rejected['building_accepts_item'])
assert rejected_error['message'] == 'ground-factory does not take copper for its dagger plan', rejected_error
op('configure', building=fixture['factory'], value=-1)
no_plan = transfer_refusal('deposit', 'not_accepted', building=fixture['factory'])
assert no_plan['message'] == 'ground-factory has no unit plan configured, and takes no items without one', no_plan
op('configure', building=fixture['factory'], value=0)
mixed_error = transfer_refusal('withdraw', 'not_accepted', building=storage, item='lead', amount=5)
mixed = mixed_error['facts']
assert mixed['stack'] == {'item': 'copper', 'amount': 5} and mixed['unit_accepts_amount'] == 0
assert mixed_error['message'] == 'Unit carries 5 copper and holds one item type at a time', mixed_error
filled = call('fixture_items', seat=None, building=storage, item='copper')
full_storage = transfer_refusal('deposit', 'not_accepted', building=storage)
assert full_storage['message'] == f"container is full of copper: it holds {filled['amount']} of {filled['amount']}", full_storage
call('fixture_items', seat=None, building=storage, item='copper', amount=filled['before'])
op('withdraw', building=storage, item='copper', amount=1000)
full_stack = transfer_refusal('withdraw', 'not_accepted', building=storage, item='copper', amount=1)
held = full_stack['facts']['stack']['amount']
assert full_stack['facts']['unit_accepts_amount'] == 0 and full_stack['message'] == f'Unit stack is full: {held} of {held} copper', full_stack
op('discard', angle=90)
burst = call('act', ops=[{'op': 'configure', 'building': fixture['factory'], 'value': 0}] * 70)['results']
assert all((r['ok'] for r in burst)), next((r for r in burst if not r['ok']))
time.sleep(0.5)
assert not next((row for row in query('players') if row['seat'] == 'seat-1'))['dead']
batch = call('act', ops=[operation for _ in range(3) for operation in [{'op': 'withdraw', 'building': storage, 'item': 'copper', 'amount': 5}, {'op': 'deposit', 'building': storage}]])['results']
assert all((r['ok'] for r in batch[:-1])), batch
limited = batch[-1]['error']
assert limited['code'] == 'not_accepted', batch[-1]
facts = limited['facts']
assert facts['stack'] == {'item': 'copper', 'amount': 5}
assert facts['building_accepts_item'] and facts['building_accepts_amount'] == 5
assert facts['unit_accepts_amount'] > 0 and facts['distance_tiles'] <= facts['range_tiles']
assert facts['cooldown_remaining_ms'] > 0, facts
waited, window = map(int, re.fullmatch('Item transfer is on cooldown: (\\d+) ms remaining; at most 2 deposits per (\\d+) ms', limited['message']).groups())
assert waited == facts['cooldown_remaining_ms'] and 0 < waited <= window, limited
players = query('players')
own_player = next((row for row in players if row['seat'] == 'seat-1'))
remaining_ms = own_player['deposit_cooldown_remaining_ms']
assert 0 < remaining_ms <= facts['cooldown_remaining_ms'], own_player
assert all(('deposit_cooldown_remaining_ms' not in row for row in players if row['seat'] != 'seat-1'))
assert call('query', seat=other, of='players', filter=[['seat', 'eq', 'seat-1']], fields=['deposit_cooldown_remaining_ms'])['rows'] == [{}]
assert query('players', filter=[['seat', 'eq', other], ['deposit_cooldown_remaining_ms', 'ne', None]]) == []
time.sleep(facts['cooldown_remaining_ms'] / 1000 + 0.05)
assert query('players', filter=[['seat', 'eq', 'seat-1']])[0]['deposit_cooldown_remaining_ms'] == 0
assert op('deposit', building=storage)['transferred'] == 5
assert op('withdraw', building=storage, item='copper', amount=5)['stack']['amount'] == 5
assert op('deposit', building=storage)['stack']['amount'] == 0
op('withdraw', building=storage, item='copper', amount=5)
assert op('discard')['stack']['amount'] == 0
command_test_unit = call('fixture_command_unit', seat=None)['unit']
other_command = next((c for c in query('unit_types', filter=[['name', 'eq', 'mega']])[0]['commands'] if c != 'move'))
op('command', units=[command_test_unit], command='move')
for target, code in [(point(state['width'], 0), 'out_of_range'), ({'kind': 'unit', 'id': -1}, 'unknown_entity'), ({'kind': 'building', 'id': -1}, 'unknown_entity')]:
    before = call('events', after=0, limit=2 ** 60)['next']
    refusal('command', code, units=[command_test_unit], command=other_command, target=target)
    observed = query('units', filter=[['id', 'eq', command_test_unit]], fields=['command', 'target'])[0]
    assert observed['command'] == 'move', observed
    assert not call('events', after=before, filter=[['kind', 'eq', 'act']])['events']
call('fixture_command_unit', seat=None, remove=command_test_unit)
ai = fixture['command_unit']
command = op('command', units=[ai], command='move', target=point(start[0] + 15, start[1]), queue=False)['units'][0]
assert command['id'] == ai and command['command'] == 'move' and (command['target'] == point(start[0] + 15, start[1])), command
stance = op('stance', units=[ai], stance='holdfire', enabled=True)['units'][0]
assert stance['command'] == 'move' and 'holdfire' in stance['stance'] and (stance['target'] == command['target']), stance
assert 'holdfire' in query('units', filter=[['id', 'eq', ai]])[0]['stance']
assert op('rally', buildings=[fixture['factory']], target=point(start[0] + 15, start[1]))['buildings'][0]['target'] == command['target']
assert op('command', units=[ai], target={'kind': 'building', 'id': foreign})['units'][0]['target']['id'] == foreign
assert refusal('command', 'unsupported', units=[unit_id], command='move')['message'] == f"{unit['type']} {unit_id} is controlled by player seat-1"
bound = call('fixture_logic', seat=None, processor=own)['unit']
processor = query('buildings', filter=[['id', 'eq', own]], fields=['type', 'x', 'y'])[0]
assert refusal('command', 'unsupported', units=[bound], command='move')['message'] == f"dagger {bound} is controlled by a logic processor: the {team} {processor['type']} (building {own}) at ({int(processor['x'])},{int(processor['y'])})"
op('control', target={'kind': 'unit', 'id': fixture['carrier']})
op('payload_pickup', target={'kind': 'unit', 'id': fixture['payload_unit']})
op('payload_drop', at=fixture['payload_at'])
assert op('payload_pickup', target={'kind': 'building', 'id': fixture['payload_building']})['payload_count'] == 1
assert op('payload_drop', at=fixture['payload_build_at'])['payload_count'] == 0
op('control', target=None)
eventually(lambda: (call('status')['you'] or {}).get('unit_id'))
ping_fields = ['ping_x', 'ping_y', 'ping_text']
ping_unit = call('status')['you']['unit_id']
assert query('units', filter=[['id', 'eq', ping_unit]], fields=ping_fields) == [{}]
assert op('ping', at=point(*start), text='private attack location')['at'] == point(*start)
for viewer in ['seat-1', other]:
    ping = call('query', seat=viewer, of='units', filter=[['id', 'eq', ping_unit]], fields=ping_fields)['rows'][0]
    assert math.isclose(ping['ping_x'], start[0], abs_tol=1e-05) and math.isclose(ping['ping_y'], start[1], abs_tol=1e-05), ping
    assert ping['ping_text'] == 'private attack location', ping
eventually(lambda: query('units', filter=[['id', 'eq', ping_unit]], fields=ping_fields) == [{}], timeout=24)
steering = call('fixture_steering', seat=None)
op('control', target={'kind': 'unit', 'id': steering['unit']})
flare = query('units', filter=[['id', 'eq', steering['unit']]])[0]
heading = math.radians(flare['rotation'])
forward = [math.cos(heading), math.sin(heading)]
side = [-forward[1], forward[0]]
destination = [flare['x'] + side[0] * 10, flare['y'] + side[1] * 10]
op('input', move_to=point(*destination))
turned = eventually(lambda: (row if 30 < (row['rotation'] - flare['rotation']) % 360 < 150 else None) if (row := query('units', filter=[['id', 'eq', steering['unit']]])[0]) else None)
displacement = [turned['x'] - flare['x'], turned['y'] - flare['y']]
assert sum((d * f for d, f in zip(displacement, forward))) > 0.05, (flare, turned)
assert sum((d * s for d, s in zip(displacement, side))) > 0, (flare, turned)
op('input', move_to=None)
stopped = query('units', filter=[['id', 'eq', steering['unit']]])[0]
time.sleep(0.2)
released = query('units', filter=[['id', 'eq', steering['unit']]])[0]
assert math.dist([stopped['x'], stopped['y']], [released['x'], released['y']]) < 0.01
op('control', target=None)
eventually(lambda: (call('status')['you'] or {}).get('unit_id'))
turret = call('fixture_turret', seat=None)
loaded = query('buildings', filter=[['id', 'eq', turret['building']]], fields=['ammo', 'ammo_capacity'])[0]
op('withdraw', building=storage, item='copper', amount=5)
no_room = transfer_refusal('deposit', 'not_accepted', building=turret['building'])
assert no_room['message'] == f"duo has no room for copper ammo: it holds {loaded['ammo']:g} of {loaded['ammo_capacity']:g} ammo, and one copper adds 2", no_room
op('discard')
op('withdraw', building=storage, item='lead', amount=5)
assert transfer_refusal('deposit', 'not_accepted', building=turret['building'])['message'] == 'duo does not take lead: it is not one of its ammo types'
op('discard')
assert op('control', target={'kind': 'building', 'id': turret['building']})['unit_id'] == turret['unit']
assert call('status')['you']['unit_id'] == turret['unit']
occupied = call('act', seat=other, ops=[{'op': 'control', 'target': {'kind': 'building', 'id': turret['building']}}])['results'][0]
assert not occupied['ok'] and occupied['error']['code'] == 'not_accepted', occupied
before_fire = query('buildings', filter=[['id', 'eq', turret['building']]])[0]['ammo']
op('input', aim=turret['aim'], shoot=True)
eventually(lambda: query('buildings', filter=[['id', 'eq', turret['building']]])[0]['ammo'] < before_fire)
eventually(lambda: query('bullets', filter=[['type', 'eq', turret['bullet_type']], ['team', 'eq', team]]))
assert query('buildings', filter=[['id', 'eq', turret['building']]])[0]['shooting'] == 1
op('input', shoot=False)
op('control', target=None)
eventually(lambda: (call('status')['you'] or {}).get('unit_id'))
entry = call('fixture_entry', seat=None)
op('control', target={'kind': 'unit', 'id': entry['unit']})
op('control', target={'kind': 'building', 'id': entry['building']})
assert query('units', filter=[['id', 'eq', entry['unit']]]) == []
assert query('buildings', filter=[['id', 'eq', entry['building']]])[0]['payload_count'] == 1
eventually(lambda: (call('status')['you'] or {}).get('unit_id'))
op('withdraw', 'unknown_entity', building=-1, item='copper', amount=1)
op('withdraw', 'not_allied', building=foreign, item='copper', amount=1)
op('withdraw', 'out_of_range', building=fixture['far_storage'], item='copper', amount=1)
op('withdraw', 'insufficient_items', building=storage, item='thorium', amount=1)
op('rotate', 'unsupported', building=storage, clockwise=True)
on_core = refusal('plan_add', 'invalid_placement', plan={'x': fixture['core_tile'][0], 'y': fixture['core_tile'][1], 'block': 'conveyor', 'rotation': 0})
core_tile = f"({fixture['core_tile'][0]},{fixture['core_tile'][1]})"
assert on_core['message'] == f"conveyor at {core_tile} is blocked by the {own_core['team']} {own_core['type']} (building {own_core['id']}) at {core_tile}", on_core
op('input', 'invalid_args', move=point(2, 0))
bounds = f"0 <= x < {state['width']} and 0 <= y < {state['height']}"
assert refusal('input', 'out_of_range', aim=point(state['width'] + 5, 1))['message'] == f"aim ({state['width'] + 5},1) is outside the world, which spans {bounds}"
assert refusal('input', 'out_of_range', mine=point(state['width'], 0))['message'] == f"mine ({state['width']},0) is outside the world, which spans {bounds}"
op('plan_remove', 'not_accepted', key={'x': 0, 'y': 0, 'breaking': False})
killed = call('status')['you']['unit_id']
call('fixture_death', seat=None)
assert query('units', filter=[['id', 'eq', killed]]) == [], 'a dead unit is not listed'
assert all((u['health'] > 0 for u in query('units', limit=2 ** 60)))
op('input', 'respawning', move=point(0, 0))
dead = query('players', filter=[['seat', 'eq', 'seat-1']])[0]
assert dead['dead'] and dead['unit_id'] is None, dead
transfer_error('deposit', 'respawning', building=storage)
eventually(lambda: (call('status')['you'] or {}).get('unit_id'))
rows = call('act', ops=[{'op': 'withdraw', 'building': -1, 'item': 'copper', 'amount': 1}, {'op': 'input', 'shoot': False}])['results']
assert not rows[0]['ok'] and rows[1]['ok']
effect = op('input', shoot=False)
assert effect['move'] == point(0, 0) and effect['move_to'] is None and (effect['mine'] is None) and (not effect['boost'])
for seat in seats:
    events = call('events', seat=seat, after=0, limit=2 ** 60)['events']
    assert [e['seq'] for e in events] == list(range(1, len(events) + 1))
    assert all((isinstance(e['tick'], int) for e in events))
assert seen_ops == {r['name'] for r in query('ops', limit=2 ** 60)}, seen_ops
assert seen_codes == {'invalid_args', 'respawning', 'out_of_range', 'invalid_placement', 'not_allied', 'unknown_entity', 'not_accepted', 'insufficient_items', 'unsupported'}
terminal = call('stop', seat=None)
assert terminal['reason'] == 'stopped' and terminal['terminal']['core_health_by_team']
assert terminal['terminal']['seat_teams'] == state['seat_teams']
assert call('stop', seat=None)['terminal'] == terminal['terminal']
time.sleep(0.3)
assert call('state', seat=None)['terminal'] == terminal['terminal']
assert reject('act', seat='seat-1', invalid=False, ops=[{'op': 'input', 'shoot': True}]) == 'This game has ended, so no input applies'
last = call('say', text='after the end')['message']
assert call('status', seat=other)['chat']['text'] == 'after the end', last
assert call('events', latest=1, filter=[['kind', 'eq', 'say']])['events'][0]['id'] == last['id']
evidence = Path(args.evidence)
assert json.loads((evidence / 'state.json').read_text())['completed']
assert (evidence / 'final.msav').stat().st_size > 0
assert all((save.stat().st_size > 0 for save in (evidence / 'saves').glob('*.msav'))) and any((evidence / 'saves').glob('*.msav'))
for line in (evidence / 'snapshots.jsonl').read_text().splitlines():
    assert not {'units', 'buildings', 'players', 'chat'} & json.loads(line).keys()
print(json.dumps({'mode': 'survival', 'seats': args.seats, 'ops': sorted(seen_ops), 'codes': sorted(seen_codes), 'terminal': terminal['reason']}), flush=True)
