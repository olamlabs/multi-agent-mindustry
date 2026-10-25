"""Endless survival checks against one fresh native server per case; `compare` checks across cases."""
import hashlib
import json
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

SEATS = [f'seat-{i}' for i in range(1, 21)]

def request(path, body):
    req = urllib.request.Request('http://127.0.0.1:8091/' + path, json.dumps(body).encode(), {'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as error:
        return json.load(error)

def call(path, **body):
    result = request(path, body)
    assert result['ok'], (path, result)
    return result['result']

def refused(path, needle, **body):
    result = request(path, body)
    assert not result['ok'] and needle in json.dumps(result), (path, body, result)

def profile(**changes):
    value = {'first_wave_ticks': 600, 'wave_spacing_ticks': 60, 'spawn_seed': 1,
             'enemy_unit_health_multiplier': 1, 'enemy_unit_damage_multiplier': 1}
    value.update(changes)
    return value

def setup(endless=None, **changes):
    body = dict(seats=SEATS, game_mode='survival', map='Fork', seed=1, team_sizes=[20], time_limit_sec=None)
    if endless is not None:
        body['endless_survival'] = endless
    body.update(changes)
    return body

def records(evidence):
    path = evidence / 'survival.jsonl'
    rows = [json.loads(line) for line in path.open()] if path.exists() else []
    assert [r['sequence'] for r in rows] == list(range(1, len(rows) + 1)), 'survival records are numbered in order'
    assert all(r['schema'] == 'mindustry-endless-survival-native/1' for r in rows)
    return rows

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def check_provenance(evidence, rows):
    provenance = rows[0]['data']['provenance']
    assert provenance['wave_schedule_sha256'] == sha256(evidence / 'wave-schedule.json')
    assert provenance['rules_sha256'] == sha256(evidence / 'rules.json')
    assert all(len(provenance[k]) == 64 for k in ('map_sha256', 'rules_sha256', 'wave_schedule_sha256', 'profile_sha256'))
    for r in rows:
        if 'provenance' in r['data']:
            assert r['data']['provenance'] == provenance, r['event']
    return provenance

def start(ready=SEATS):
    return call('start', ready_seats=ready)

def budget_reference(spec, wave):
    """Independent re-derivation of the wave allocation from wave-schedule.json alone."""
    kinds = spec['kinds']
    def smooth(x):
        x = min(1.0, max(0.0, x)); return x * x * (3 - 2 * x)
    def factor(armor):
        d = spec['reference_damage']; return d / max(d - armor, spec['min_armor_damage'] * d)
    budget = spec['first_budget']
    for _ in range(1, wave): budget *= spec['growth']
    unit = [k['health'] * factor(k['armor']) for k in kinds]
    weight = []
    for i, u in enumerate(unit):
        x = budget / u
        enter = 1.0 if i == 0 else smooth((x - spec['enter_from']) / spec['enter_span'])
        weight.append(enter * (1 - spec['fade_depth'] * smooth((x - spec['fade_from']) / spec['fade_span'])))
    n = len(kinds); counts = [0] * n; left = budget; ideal = [0.0] * n
    is_open = lambda i: weight[i] > 0 and counts[i] < kinds[i]['cap_per_wave']
    for _ in range(spec['rounds']):
        total = sum(weight[i] for i in range(n) if is_open(i))
        if total == 0: break
        start = left; added = 0
        for i in range(n):
            if is_open(i):
                ideal[i] = min(start * weight[i] / total / unit[i], kinds[i]['cap_per_wave'] - counts[i])
                k = int(ideal[i]); counts[i] += k; left -= k * unit[i]; added += k
        if not added: break
    for i in sorted([i for i in range(n) if is_open(i)], key=lambda i: (-(ideal[i] - int(ideal[i])), i)):
        if unit[i] <= left: counts[i] += 1; left -= unit[i]
    return budget, {kinds[i]['type']: counts[i] for i in range(n) if counts[i]}

def budget(evidence, out):
    call('setup', **setup(profile(first_wave_ticks=600, wave_spacing_ticks=60)))
    waves_wanted = 45
    result = call('survival_test', case='budget', waves=waves_wanted, start={'ready_seats': SEATS})
    views = [call('status', seat='seat-1'), call('query', seat='seat-1', of='match'),
             call('events', seat='seat-1', after=0, limit=100)]
    for hidden in ['progression', 'preview_waves', 'spawned_units', 'cumulative_spawned', 'wave_schedule_sha256']:
        assert hidden not in json.dumps(views), hidden
    call('stop')
    rows = records(evidence)
    check_provenance(evidence, rows)
    plan = json.loads((evidence / 'wave-schedule.json').read_text())
    spec = plan['progression']
    assert spec['id'] == 'strength-budget' and plan['spawn_groups'] == [] and len(plan['preview_waves']) == 100
    preview = {p['wave']: p for p in plan['preview_waves']}

    for n, p in preview.items():
        budget_n, counts = budget_reference(spec, n)
        assert abs(budget_n - p['budget']) <= 1e-9 * budget_n and counts == p['units'], (n, counts, p['units'])
        assert abs(p['strength'] - p['budget']) <= 1e-6 * p['budget'], (n, p['strength'], p['budget'])
        if n > 1: assert abs(p['budget'] / preview[n - 1]['budget'] - spec['growth']) < 1e-12
    waves = [r['data'] for r in rows if r['event'] == 'survival_wave']
    assert len(waves) >= waves_wanted
    for w in waves[:waves_wanted]:
        p = preview[w['wave']]

        assert w['spawned'] == p['units'] == w['planned_units'], (w['wave'], w['spawned'], p['units'])
        assert abs(w['realized_strength'] - w['budget']) <= 1e-4 * w['budget'], (w['wave'], w['realized_strength'], w['budget'])
        assert w['scheduled_simulation_tick'] == 600 + (w['wave'] - 1) * 60
    capped = [w['wave'] for w in waves[:waves_wanted] if w['planned_shield'] > 100]
    assert capped and capped[0] >= 30, 'large shields only once the caps bind'
    units = [sum(w['spawned'].values()) for w in waves[:waves_wanted]]
    assert max(abs(b - a) / a for a, b in zip(units[5:], units[6:])) < 0.4, 'unit counts change gradually'
    tiers = {}
    for w in waves[:waves_wanted]:
        for t in w['spawned']: tiers.setdefault(t, w['wave'])
    json.dump({'first_wave_by_type': tiers, 'ground_spawns': result['ground_spawns'],
               'units_per_wave': {w['wave']: sum(w['spawned'].values()) for w in waves[:waves_wanted]},
               'first_shield_wave': capped[0]}, (out / 'budget.json').open('w'), indent=1)

def strength(health, shield, armor, team_health):

    return (max(0, health) + max(0, shield)) * team_health * 30 / max(30 - armor, 3)

def clearance(evidence, out):
    call('setup', **setup(profile(first_wave_ticks=600, wave_spacing_ticks=600, enemy_unit_health_multiplier=2)))
    result = call('survival_test', case='clearance', start={'ready_seats': SEATS})
    rows = records(evidence)
    check_provenance(evidence, rows)
    waves = [r['data'] for r in rows if r['event'] == 'survival_wave']
    terminal = rows[-1]['data']
    assert [w['wave'] for w in waves] == [1, 2] and rows[-2]['event'] == 'last_friendly_core_destroyed'
    scheduled = {u for ids in result['spawned'].values() for u in ids}
    assert result['unscheduled'] not in scheduled
    trace = result['trace']
    c = terminal['clearance']

    strengths = [w['clearance']['wave_strength'] for w in waves[1:]] + [c['wave_strength']]
    assert waves[0]['clearance']['wave_strength'] is None

    for n, w in enumerate(waves, 1):
        entry = next(e for e in trace if e['waves_spawned'] == n)
        ids = set(result['spawned'][str(n)])
        recomputed = sum(strength(*e[1:]) for e in entry['enemies'] if e[0] in ids)
        assert abs(strengths[n - 1] - recomputed) <= 1e-9 * recomputed, (n, strengths, recomputed)

        assert abs(strengths[n - 1] - 2 * w['realized_strength']) <= 1e-6 * recomputed
    integral = observed = 0.0
    values = []
    for e in trace:
        alive = sum(strength(*u[1:]) for u in e['enemies'] if u[0] in scheduled)
        s = strengths[e['waves_spawned'] - 1]
        m = max(0.0, 1 - alive / s)
        values.append(m)
        integral += m * e['delta']
        observed += e['delta']

    assert values[0] < 1e-12 and 0 < values[5] < 1, values[:12]
    w2 = next(i for i, e in enumerate(trace) if e['waves_spawned'] == 2)
    assert values[w2] == 0 and values[-1] > 0, values[w2:]
    assert c['policy'] == 'realized_clearance/1' and c['first_wave_simulation_tick'] == waves[0]['simulation_tick']
    assert abs(c['observed_ticks'] - observed) <= 1e-9 * observed and abs(c['integral_ticks'] - integral) <= 1e-9 * observed, (c, integral, observed)
    assert abs(c['observed_ticks'] - (terminal['simulation_tick'] - c['first_wave_simulation_tick'])) <= 1e-6, c
    assert abs(c['mean'] - integral / observed) <= 1e-9

    before = sum(values[i] * trace[i]['delta'] for i in range(w2))
    assert waves[0]['clearance']['integral_ticks'] == 0 and waves[0]['clearance']['first_wave_simulation_tick'] is None
    assert abs(waves[1]['clearance']['integral_ticks'] - before) <= 1e-9 * observed
    json.dump({'terminal_clearance': c, 'values': values, 'waves': [w['clearance'] for w in waves]}, (out / 'clearance.json').open('w'))

def schedule(case, evidence, out):
    seed = 2 if case == 'schedule-c' else 1
    noisy = case == 'schedule-b'
    call('setup', **setup(profile(spawn_seed=seed)))
    result = call('survival_test', case='waves', waves=20, irregular=noisy, noise=noisy, drop_zone=noisy, noise_seed=7,
                  start={'ready_seats': SEATS})
    call('stop')
    rows = records(evidence)
    provenance = check_provenance(evidence, rows)
    waves = [r['data'] for r in rows if r['event'] == 'survival_wave']
    assert len(waves) >= 20, len(waves)
    plan = json.loads((evidence / 'wave-schedule.json').read_text())
    assert plan['profile']['spawn_seed'] == seed and not any(g['spawn'] != -1 for g in plan['spawn_groups'])
    preview = {p['wave']: p for p in plan['preview_waves']}
    for w in waves[:20]:
        n = w['wave']
        assert w['scheduled_simulation_tick'] == 600 + (n - 1) * 60 == preview[n]['scheduled_simulation_tick']

        late = w['simulation_tick'] - w['scheduled_simulation_tick']
        assert -1e-2 <= late < result['wave_deltas'][str(n)] + 1e-2, (n, late, result['wave_deltas'][str(n)])

        expected = Counter(preview[n]['units'])
        assert Counter(w['spawned']) == expected == Counter(u[0] for u in result['waves'][str(n)]), (n, w['spawned'], expected)
    assert waves[19]['enemies_alive_before'] > 0, 'later waves arrive while earlier enemies still live'
    if noisy:
        assert waves[0]['simulation_updates'] != 600 and len(set(result['wave_deltas'].values())) > 1, 'irregular steps'
        assert result['walls_placed'] > 0 and result['walls_standing'] == 0, 'the drop-zone shockwave destroyed structures mid-wave'
    terminal = rows[-1]['data']
    assert rows[-1]['event'] == 'survival_terminal' and terminal['reason'] == 'stopped' and terminal['survival_censored'] is True
    json.dump({'provenance': provenance, 'waves': {str(w['wave']): w for w in waves[:20]}, 'units': result['waves'],
               'wave_deltas': result['wave_deltas'], 'walls_placed': result['walls_placed'],
               'walls_standing': result['walls_standing'],
               'max_late': max(w['simulation_tick'] - w['scheduled_simulation_tick'] for w in waves[:20])},
              (out / f'{case}.json').open('w'))

def long_clock(case, evidence, out):
    first, step = (14400, 0.1) if case == 'long-small' else (28800, 1.01)
    call('setup', **setup(profile(first_wave_ticks=first, wave_spacing_ticks=7200)))
    result = call('survival_test', case='waves', waves=1, irregular=False, noise=False,
                  drop_zone=False, step=step, start={'ready_seats': SEATS})
    call('stop')
    rows = records(evidence)
    provenance = check_provenance(evidence, rows)
    waves = [r['data'] for r in rows if r['event'] == 'survival_wave']
    assert len(waves) == 1, waves
    wave = waves[0]
    actual_delta = result['wave_deltas']['1']
    assert abs(actual_delta - step) < 1e-6, (actual_delta, step)
    assert wave['scheduled_simulation_tick'] == first
    lateness = wave['simulation_tick'] - first
    assert -1e-6 <= lateness < actual_delta + 1e-6, (lateness, actual_delta)
    assert abs(wave['simulation_tick'] - wave['simulation_updates'] * actual_delta) < 1e-6
    assert rows[-1]['event'] == 'survival_terminal' and rows[-1]['data']['reason'] == 'stopped'
    json.dump({'provenance': provenance, 'wave': wave, 'requested_delta': step,
               'actual_delta': actual_delta, 'lateness_ticks': lateness, 'fixture': result},
              (out / f'{case}.json').open('w'))

def economy_death(evidence, out):

    refused('setup', 'requires game_mode survival', **setup(profile(), game_mode='attack', map='Fork'))
    refused('setup', 'time_limit_sec null', **setup(profile(), time_limit_sec=600))
    refused('setup', 'time_limit_sec null', **{k: v for k, v in setup(profile()).items() if k != 'time_limit_sec'})
    refused('setup', 'spawn_seed must be a number', **setup({k: v for k, v in profile().items() if k != 'spawn_seed'}))
    refused('setup', 'Unknown', **setup(profile(wave_growth=2)))
    for version in [1, 2, 3]:
        refused('setup', 'Unknown', **setup(profile(version=version)))
    refused('setup', 'spawn_seed must be an integer', **setup(profile(spawn_seed=1.5)))
    refused('setup', 'first_wave_ticks must be 60..5184000', **setup(profile(first_wave_ticks=10)))
    refused('setup', 'above 0', **setup(profile(enemy_unit_health_multiplier=0)))
    refused('setup', 'must be an object', **setup([1]))
    assert not call('state')['configured']
    call('setup', **setup(profile(first_wave_ticks=36000)))
    rows = records(evidence)
    assert [r['event'] for r in rows] == ['survival_setup']
    provenance = check_provenance(evidence, rows)
    refused('start', 'ready_seats', )
    refused('start', 'exactly the configured seats', ready_seats=SEATS[:19])
    refused('start', 'Duplicate ready seat', ready_seats=SEATS + ['seat-1'])
    started = start()
    again = start(list(reversed(SEATS)))
    rows = records(evidence)
    assert [r['event'] for r in rows] == ['survival_setup', 'survival_start']
    begin = rows[1]['data']
    assert started['survival_start'] == begin == again['survival_start'], 'the /start answer is the start record'
    assert begin['simulation_tick'] == 0 and begin['ticks_per_second'] == 60 and begin['ready_seats'] == SEATS
    assert set(begin['seat_teams']) == set(SEATS) and set(begin['seat_teams'].values()) == {begin['friendly_team']}
    friendly = begin['friendly_team']
    assert begin['core_health_by_team'][friendly]['count'] >= 1 and begin['core_health_by_team'][friendly]['health'] > 0

    result = call('survival_test', case='economy_death')
    assert result['drill_copper'] > 0 and result['belt_copper'] > 0 and result['core_deliveries'] > 0 and result['core_copper_gain'] > 0, result

    assert abs(result['lethal_core_damage'] - result['core_remaining_health']) < 1e-3, result
    rows = records(evidence)
    assert [r['event'] for r in rows][-2:] == ['last_friendly_core_destroyed', 'survival_terminal'], [r['event'] for r in rows]
    death, terminal = rows[-2]['data'], rows[-1]['data']
    state = call('state')
    assert state['completed'] and state['terminal'] == terminal and state['survival_censored'] is False
    assert terminal['reason'] == 'core_destroyed' and terminal['survival_censored'] is False
    assert death['simulation_tick'] == terminal['simulation_tick'] == result['ticks_after'] == result['ticks_before_lethal_update'] + 1
    assert death['simulation_updates'] == terminal['simulation_updates']
    assert abs(terminal['elapsed_simulation_seconds'] - terminal['simulation_tick'] / 60) < 1e-9
    assert death['winner'] == terminal['winning_team'] == rows[0]['data']['wave_team']
    for record in (death, terminal):
        cores = record['core_health_by_team'][friendly]
        assert cores['count'] == 0 and cores['health'] == 0 and cores['max_health'] == begin['core_health_by_team'][friendly]['max_health']
    assert terminal['provenance'] == provenance and terminal['end_condition'] == 'core_destroyed'
    assert terminal['clock']['policy'] == 'accumulated_native_time_delta' and terminal['record_failures'] == 0

    assert terminal['clearance'] == {'policy': 'realized_clearance/1', 'first_wave_simulation_tick': None, 'wave_strength': None, 'integral_ticks': 0, 'observed_ticks': 0, 'mean': None}
    events = [json.loads(line) for line in (evidence / 'events.jsonl').open()]
    assert [e['data'] for e in events if e['event'] == 'last_friendly_core_destroyed'] == [death]
    refused('start', 'terminal', ready_seats=SEATS)

    frames = [json.loads(line) for line in (evidence / 'evaluation.jsonl').open()]
    last = frames[-1]
    assert last['final'] and last['coverage']['health_observation'] == 'before_unit_building_bullet_phases_and_end_of_update'
    assert last['coverage']['damage_attribution'] == 'approximate_within_phase'
    drill = next(r for r in last['buildings'] if r['type'] == 'mechanical-drill')
    assert drill['output']['items']['copper'] >= result['drill_copper']
    assert any(r['sink'] == 'core' and r['items'].get('copper', 0) > 0 for r in last['deliveries'])
    belts = [json.loads(line) for line in (evidence / 'production.jsonl').open()][-1]['buildings']
    assert any(r['type'] == 'conveyor' and r['belt']['transferred_items'].get('copper', 0) > 0 for r in belts)
    stock = [json.loads(line) for line in (evidence / 'stockpiles.jsonl').open()]
    assert stock[-1]['final']
    json.dump({'provenance': provenance, 'death': death, 'terminal': terminal, 'result': result}, (out / 'economy-death.json').open('w'))

def stop(evidence, out):
    call('setup', **setup(profile(first_wave_ticks=36000)))
    call('survival_test', case='updates', updates=120, start={'ready_seats': SEATS})
    state = call('stop')
    rows = records(evidence)
    assert [r['event'] for r in rows] == ['survival_setup', 'survival_start', 'survival_terminal']
    terminal = rows[-1]['data']
    assert state['terminal'] == terminal and state['survival_censored'] is True
    assert terminal['reason'] == 'stopped' and terminal['survival_censored'] is True and terminal['winning_team'] is None
    assert terminal['simulation_tick'] == 120 and terminal['simulation_updates'] == 120
    assert terminal['core_health_by_team'][rows[1]['data']['friendly_team']]['count'] >= 1
    refused('start', 'terminal', ready_seats=SEATS)
    json.dump({'provenance': check_provenance(evidence, rows), 'terminal': terminal}, (out / 'stop.json').open('w'))

def modes(evidence, out):
    refused('setup', 'profile is required', **setup())
    for mode in ['pvp', 'attack', 'sandbox']:
        refused('setup', 'requires game_mode survival', **setup(profile(), game_mode=mode))
    refused('setup', 'time_limit_sec null', **setup(profile(), time_limit_sec=60))
    call('setup', **setup(profile(first_wave_ticks=36000)))
    call('start', ready_seats=SEATS)
    result = call('survival_test', case='combat')
    assert result['ok'], result
    terminal = call('stop')['terminal']
    assert terminal['reason'] == 'stopped' and terminal['survival_censored']
    (out / 'modes.json').write_text(json.dumps(result))

def compare(out):
    a, b, c = (json.loads((out / f'schedule-{k}.json').read_text()) for k in 'abc')

    assert a['provenance'] == b['provenance']
    assert a['units'] == b['units'], 'same seed, same offsets'

    assert c['provenance']['map_sha256'] == a['provenance']['map_sha256'] and c['provenance']['rules_sha256'] == a['provenance']['rules_sha256']
    assert c['provenance']['wave_schedule_sha256'] != a['provenance']['wave_schedule_sha256']
    for n in a['waves']:
        assert Counter(u[0] for u in a['units'][n]) == Counter(u[0] for u in c['units'][n])
    assert any(a['units'][n] != c['units'][n] for n in a['waves'])
    death = json.loads((out / 'economy-death.json').read_text())
    stop_ = json.loads((out / 'stop.json').read_text())
    assert death['provenance']['map_sha256'] == a['provenance']['map_sha256'] == stop_['provenance']['map_sha256']
    print(json.dumps({'max_late_ticks': {k: v['max_late'] for k, v in zip('abc', (a, b, c))},
                      'core_death': {'simulation_tick': death['terminal']['simulation_tick'], 'winner': death['terminal']['winning_team']},
                      'combat': json.loads((out / 'modes.json').read_text())}, indent=1))

if __name__ == '__main__':
    case = sys.argv[1]
    if case == 'compare':
        compare(Path(sys.argv[2]))
    else:
        evidence, out = Path(sys.argv[2]), Path(sys.argv[3])
        if case == 'budget':
            budget(evidence, out)
        elif case == 'clearance':
            clearance(evidence, out)
        elif case.startswith('schedule-'):
            schedule(case, evidence, out)
        elif case.startswith('long-'):
            long_clock(case, evidence, out)
        else:
            {'economy-death': economy_death, 'stop': stop, 'modes': modes}[case](evidence, out)
        print(case, 'ok')
