"""Oracle API sanity check; survival has no winning solution or fixed pass score."""
import json
import os
from pathlib import Path
import time
import urllib.request

def call(path, body=None):
    token = Path('/run/mindustry/token').read_text().strip()
    request = urllib.request.Request(
        os.environ['MINDUSTRY_SIM_URL'].rstrip('/') + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request) as response:
        value = json.load(response)
    if value.get('error'):
        raise RuntimeError(value['error'])
    return value

def main():
    seat = os.environ['MINDUSTRY_SEAT']
    assert call('/')['you'] == seat
    call('/ready', {})
    while True:
        state = call('/update')
        assert not state['game_over'], 'Game ended before sanity checks'
        if state['status']['phase'] == 'running':
            break
        time.sleep(0.25)
    assert state['status']['core']['health'] > 0
    assert call('/query', {'of': 'players'})['rows']
    assert call('/query', {'of': 'ops'})['rows']
    assert call('/say', {'text': 'Oracle sanity checks passed: ' + seat})['message']['from'] == seat
    print(json.dumps({'seat': seat, 'status': 'passed', 'checks': ['identity', 'readiness', 'query', 'team_message']}))

if __name__ == '__main__':
    main()
