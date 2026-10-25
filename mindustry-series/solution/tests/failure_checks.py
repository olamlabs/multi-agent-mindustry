import asyncio,json,os,shutil,subprocess,sys,shlex,time,struct,gzip,re
from pathlib import Path
from harbor.agents.base import BaseAgent
from harbor.models.trial.config import TrialConfig
from harbor.trial.trial import Trial
SOURCE=Path(__file__).resolve().parents[2]
ROOT=Path(os.environ['SMOKE_EVIDENCE']).resolve()
ROOT.mkdir(parents=True,exist_ok=True)
class ProbeAgent(BaseAgent):
    def __init__(self,*a,delay=0,**kw):super().__init__(*a,**kw);self.delay=delay
    @staticmethod
    def name():return 'series-check-scripted'
    def version(self):return '1'
    async def setup(self,environment):await asyncio.sleep(self.delay)
    async def run(self,instruction,environment,context):
        script="""const fs=require('fs');const headers={authorization:'Bearer '+fs.readFileSync('/run/mindustry/token','utf8').trim()};(async()=>{let first=null;for(;;){const r=await fetch(process.env.HARBOR_SIM_URL+'/update',{headers});const view=await r.json();if(!r.ok)throw Error(JSON.stringify(view));if(!first)first={at:new Date().toISOString(),view};if(view.game_over){fs.mkdirSync('/logs/agent',{recursive:true});fs.writeFileSync('/logs/agent/probe.json',JSON.stringify({first,last:{at:new Date().toISOString(),view}}));break;}await new Promise(r=>setTimeout(r,200));}})().catch(e=>{console.error(e);process.exit(1)});"""
        r=await environment.exec('node -e '+shlex.quote(script))
        if r.return_code:raise RuntimeError(str(r.stderr))
        context.cost_usd=0
async def inject_fault(name, mode, run_task):
    assert mode == 'native_kill', 'Only actual process termination is tested.'
    container=name+'__env-main-1'
    observed=None
    async def execute(*args):
        proc=await asyncio.create_subprocess_exec('docker','exec',container,*args,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        stdout,_=await proc.communicate()
        return proc.returncode,stdout.decode()
    deadline=time.monotonic()+240
    while not run_task.done() and time.monotonic()<deadline:
        code,text=await execute('cat','/logs/sim/engine/state.json')
        if code==0 and json.loads(text).get('started'):
            break
        await asyncio.sleep(1)
    else:
        raise RuntimeError('No running native game for fault injection')
    pid_script="import os,signal; p=[p for p in os.listdir('/proc') if p.isdigit() and open('/proc/'+p+'/cmdline','rb').read().startswith(b'java\\0')]; assert len(p)==1; os.kill(int(p[0]),signal.SIGKILL)"
    code,text=await execute('python3','-c',pid_script,mode)
    assert code==0,text
    for _ in range(15):
        code,text=await execute('cat','/logs/sim/failure.json')
        if code==0:
            observed=json.loads(text);break
        if run_task.done():break
        await asyncio.sleep(1)
    assert observed is not None and 'SIGKILL' in json.dumps(observed), observed
    (ROOT/(mode+'-failure.json')).write_text(json.dumps(observed,indent=2)+'\n')

async def main():
    out=ROOT/'extra-harbor';out.mkdir(exist_ok=True)
    summaries=[]
    modes=os.environ.get('SMOKE_MODES','replay,slow_setup,lobby_missing').split(',')
    allowed={'replay','slow_setup','lobby_missing','native_kill','replay_disk_full','endurance','default_roster'}
    assert set(modes)<=allowed, f'Unsupported modes: {set(modes)-allowed}'
    for mode in modes:
        task=out/mode/'task';task.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(SOURCE,task)
        c=json.loads((task/'config.json').read_text());c['seats']=4 if mode=='default_roster' else 2
        c['settings'].update(games=100 if mode=='endurance' else 3 if mode=='default_roster' else 2 if mode=='replay' else 1,time_limit_sec=60 if mode.startswith('native_') else 10,chat_after_sec=0,lobby_sec=5 if mode=='lobby_missing' else 120,video={'record':mode in ['replay','endurance','lobby_missing','default_roster'],'seats':'all' if mode=='default_roster' else 1 if mode in ['replay','endurance','lobby_missing'] else []},replay={'record':mode in ['replay','endurance','replay_disk_full','default_roster'],'segment_sec':600,'keyframe_sec':60})
        (task/'config.json').write_text(json.dumps(c));subprocess.run([sys.executable,str(task/'scripts/configure.py')],check=True)
        if mode=='lobby_missing':
            p=task/'environment/docker-compose.yaml';compose=json.loads(p.read_text());compose['services']['seat-1-game']['command']=['sleep','infinity'];p.write_text(json.dumps(compose,indent=2))
        if mode=='replay_disk_full':
            p=task/'environment/docker-compose.yaml';compose=json.loads(p.read_text());compose['services']['main']['tmpfs']=['/logs/sim/replay:size=4096'];p.write_text(json.dumps(compose,indent=2))
        name=f'series-check-{mode.replace("_","-")}-{os.getpid()}'
        trial=await Trial.create(TrialConfig(task={'path':task},environment={'override_cpus':float(os.environ.get('HARBOR_TEST_CPUS','8'))},trials_dir=out/mode/'trials',trial_name=name,participants=[{'seat':f'seat-{i}','import_path':'failure_checks:ProbeAgent','kwargs':{'delay':30 if mode=='slow_setup' else 0}} for i in range(1,c['seats']+1)]))
        running=asyncio.create_task(trial.run())
        if mode.startswith('native_'):await inject_fault(name,mode,running)
        result=await running;p=out/mode/'trials'/name;sim=p/'artifacts/sim'
        summary={'mode':mode,'trial':str(p),'exception':str(result.exception_info) if result.exception_info else None,'seat_exceptions':[str(s.exception_info) if s.exception_info else None for s in result.seat_results],'rewards':result.verifier_result.rewards if result.verifier_result else None,'native_result':json.loads((sim/'result.json').read_text()) if (sim/'result.json').exists() else None}
        summary['agent_observations']={}
        for seat in [f'seat-{i}' for i in range(1,c['seats']+1)]:
            f=p/f'seats/{seat}/agent/probe.json'
            if f.exists():summary['agent_observations'][seat]=json.loads(f.read_text())
        if mode in ['replay','endurance','default_roster']:
            d=sim/'replay';summary['replay_stats']=json.loads((d/'stats.json').read_text()) if (d/'stats.json').exists() else None
            summary['segments']=[]
            for f in sorted(d.glob('*.mreplay')):
                b=f.read_bytes();n=struct.unpack('>i',b[8:12])[0] if b[:8]==b'MREPLAY1' else None

                row={'file':str(f),'bytes':len(b)}
                try:raw=gzip.decompress(b[12+n:]);row['gzip_complete']=True;row['decompressed_bytes']=len(raw)
                except Exception as e:row.update(gzip_complete=False,error=f'{type(e).__name__}: {e}')
                summary['segments'].append(row)
        if mode in ['lobby_missing','native_kill','replay_disk_full']:
            assert result.exception_info is not None or result.verifier_result is None or not result.verifier_result.rewards,summary
            assert not summary['rewards'],summary

            causes='\n'.join(f.read_text(errors='replace') for f in [sim/'failure.json',sim/'result.json',sim/'mindustry-server.log',sim/'replay/stats.json'] if f.exists())
            if mode=='lobby_missing':
                native=summary['native_result']
                assert native == {'started':False,'reason':f"Not every agent and required camera became ready within {c['settings']['lobby_sec']} s; infrastructure preparation failed before play"},summary
                expected_seats={f'seat-{i}' for i in range(1,c['seats']+1)}
                if all(seat.agent_execution is None for seat in result.seat_results):
                    assert result.exception_info is not None and not summary['agent_observations'],summary
                else:
                    assert set(summary['agent_observations'])==expected_seats,summary
                    assert all(v['last']['view']['game_over'] and v['last']['view']['status']['phase']=='not_started' for v in summary['agent_observations'].values()),summary
            else:
                pattern={'native_kill':r'SIGKILL','replay_disk_full':r'No space left on device|ENOSPC'}[mode]
                assert re.search(pattern,causes,re.I), {'mode':mode,'missing_expected_failure':pattern,'summary':summary}
            assert not (p/'verifier/reward.json').exists(),summary
        else:
            assert result.exception_info is None and not any(summary['seat_exceptions']),summary
            assert summary['rewards']['completed']==1,summary
            expected_seats={f'seat-{i}' for i in range(1,c['seats']+1)}
            assert set(summary['agent_observations'])==expected_seats,summary
            assert len(result.seat_results)==c['seats'],summary
            assert len(summary['native_result']['results'])==c['settings']['games'],summary
            assert all(v['last']['view']['game_over'] is True for v in summary['agent_observations'].values()),summary
            if mode=='slow_setup':
                assert all(not v['first']['view']['game_over'] and v['first']['view']['status']['t']<2 for v in summary['agent_observations'].values()),summary
            if mode in ['replay','endurance','default_roster']:
                assert summary['segments'] and len(summary['segments'])==summary['replay_stats']['segments'],summary
                assert summary['replay_stats']['complete'] and summary['replay_stats']['closed'] and all(s['gzip_complete'] for s in summary['segments']),summary
                assert (sim/'replay/manifest.json').exists()
        summaries.append(summary);(ROOT/'extra-harbor-results.json').write_text(json.dumps(summaries,indent=2)+'\n');print(json.dumps({'mode':mode,'exception':summary['exception'],'rewards':summary['rewards'],'replay_closed':summary.get('replay_stats',{}).get('closed') if summary.get('replay_stats') else None,'segments':summary.get('segments')}),flush=True)
if __name__=='__main__':asyncio.run(main())
