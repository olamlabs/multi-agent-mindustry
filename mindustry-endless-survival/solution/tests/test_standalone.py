"""Exercise a copy with no sibling runtime or repository checkout."""
import importlib.util,json,shutil,subprocess,tempfile,tomllib,unittest,sys,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"scripts"))
import configure
from prepare import prepare_instructions

class StandaloneTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name).resolve()/'mindustry-endless-survival'
        shutil.copytree(ROOT,self.root,ignore=shutil.ignore_patterns('__pycache__','*.pyc','instructions'))
    def tearDown(self):self.temp.cleanup()
    def files(self):
        return {str(p.relative_to(self.root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
    def test_isolated_configuration_all_supported_sizes_and_briefing(self):
        self.assertEqual(list(self.root.parent.iterdir()),[self.root])
        runtime_before=(self.root/'environment/plugin/src/agentbridge/AgentBridge.java').read_bytes()
        for n in range(1,21):
            subprocess.run([sys.executable,str(self.root/'scripts/configure.py'),'--seats',str(n),'--wave-schedule-briefing'],check=True,cwd=self.root.parent,capture_output=True)
            task=tomllib.loads((self.root/'task.toml').read_text())
            self.assertEqual(task['task']['name'],'olamlabs/mindustry-endless-survival')
            self.assertEqual(list(task['agents']),[f'seat-{i+1}' for i in range(n)])
            self.assertEqual(len(list((self.root/'instructions').glob('seat-*.md'))),n)
            compose=json.loads((self.root/'environment/docker-compose.yaml').read_text())
            self.assertEqual(json.loads(compose['services']['main']['environment']['MINDUSTRY_SIM_SETTINGS'])['wave_schedule_briefing'],True)
            self.assertEqual(compose['services']['main']['build'],{'context':'.','target':'simulation'})
            self.assertTrue(task['verifier']['collect'])
            self.assertEqual([name for name in compose['services'] if name.endswith('-game')],[])
            self.assertEqual(json.loads(compose['services']['main']['environment']['MINDUSTRY_SIM_SETTINGS'])['video']['seats'],[])

            self.assertEqual([artifact['source'] for artifact in task['artifacts']],['/logs/sim'])
            self.assertEqual(task['artifacts'][0]['destination'],'logs/sim')
            for i in range(n):
                link=self.root/f'instructions/seat-{i+1}.md'
                self.assertFalse(link.is_symlink())
                instruction=link.read_text()
                self.assertNotIn('{{TEAM_ROSTER}}',instruction)
                self.assertIn('| 25 | 52:00 | 70,923 |',instruction)
                self.assertIn("only agent seat" if n == 1 else f'Your team has {n} agent seats',instruction)
                self.assertNotIn('/brief',instruction)
                self.assertIn('$MINDUSTRY_SEAT',instruction)
                self.assertIn('/run/mindustry/token',instruction)
                self.assertNotIn('MINDUSTRY_SEAT_TOKEN',instruction)
        self.assertEqual(runtime_before,(self.root/'environment/plugin/src/agentbridge/AgentBridge.java').read_bytes())
    def test_preparation_materializes_and_refreshes_shared_instructions(self):
        self.assertFalse((self.root/'instructions').exists())
        prepare_instructions(self.root)
        self.assertEqual(len(list((self.root/'instructions').glob('seat-*.md'))),2)
        shared=self.root/'instruction.md'
        shared.write_text(shared.read_text()+'\nShared edit.\n')
        prepare_instructions(self.root)
        before=self.files();prepare_instructions(self.root);self.assertEqual(before,self.files())
        for path in (self.root/'instructions').glob('seat-*.md'):
            self.assertTrue(path.read_text().endswith('Shared edit.\n'))
            self.assertNotIn('| 25 | 52:00 |',path.read_text())

    def test_invalid_config_does_not_mutate_files(self):
        for n in [0,21,1.5,True]:
            before=self.files()
            with self.assertRaises(ValueError):configure.configure(self.root,{'seats':n,'wave_schedule_briefing':False})
            self.assertEqual(before,self.files())
    def test_invalid_settings_and_obsolete_metadata_do_not_mutate_files(self):
        original=json.loads((self.root/'config.json').read_text())
        for changes in [{'release': {}}, {'settings': {**original['settings'], 'team_size': 2}},
                        {'settings': {**original['settings'], 'map': 'Maze'}},
                        {'settings': {**original['settings'], 'agent_ready_required': False}},
                        {'settings': {**original['settings'], 'endless_survival': {'version': 99}}}]:
            before=self.files()
            with self.assertRaises(ValueError):configure.configure(self.root,changes)
            self.assertEqual(before,self.files())
    def test_briefing_uses_configured_wave_timing_and_multipliers(self):
        settings=json.loads((self.root/'config.json').read_text())['settings']
        settings['endless_survival'].update(first_wave_ticks=60,wave_spacing_ticks=120,enemy_unit_health_multiplier=2,enemy_unit_damage_multiplier=3,spawn_seed=42)
        configure.configure(self.root,{'settings':settings,'wave_schedule_briefing':True})
        text=(self.root/'instructions/seat-1.md').read_text()
        self.assertIn('first wave spawns 1 second (60 ticks)',text)
        self.assertIn('every 2 seconds (120 ticks)',text)
        self.assertIn('| 5 | 0:09 | 1,329 | 13 |',text)
        self.assertNotIn('4 minutes (14,400 ticks)',text)
        self.assertIn('base composition strength',text)
        self.assertIn('health multiplier: 2; damage multiplier: 3',text)
        before=self.files();prepare_instructions(self.root);self.assertEqual(before,self.files())
    def test_invalid_camera_and_briefing_profile_do_not_mutate(self):
        original=json.loads((self.root/'config.json').read_text())['settings']
        cases=[{'settings':{**original,'video':{**original['video'],'seats':['seat-20']}}},
               {'settings':{**original,'video':{**original['video'],'seats':3}}},
               {'settings':{**original,'endless_survival':{**original['endless_survival'],'version':1}},'wave_schedule_briefing':True},
               {'settings':{k:v for k,v in original.items() if k!='endless_survival'},'wave_schedule_briefing':True}]
        for case in cases:
            with self.subTest(case=case):
                before=self.files()
                with self.assertRaises(ValueError):configure.configure(self.root,case)
                self.assertEqual(before,self.files())
    def test_stable_configuration_and_no_sibling_build_context(self):
        configure.configure(self.root)
        before=self.files();configure.configure(self.root);self.assertEqual(before,self.files())
        compose=json.loads((self.root/'environment/docker-compose.yaml').read_text())
        for service in compose['services'].values():
            build=service.get('build')
            if build:
                context=build if isinstance(build,str) else build['context']
                self.assertTrue((self.root/'environment'/context).resolve().is_relative_to(self.root/'environment'))
            self.assertNotIn('image',service)
        self.assertFalse(compose['networks']['control'].get('internal',False))
        self.assertEqual(compose['services']['main']['networks'],['control'])
        self.assertEqual(compose['services']['seat-1']['networks'],['agents'])
        self.assertNotIn('wstunnel',(self.root/'environment/Dockerfile').read_text())
    def test_configuration_needs_no_model_or_harness_policy(self):
        configure.configure(self.root,{'seats':2,'wave_schedule_briefing':False})
        contract=json.loads((self.root/'environment/task-runtime/contract.json').read_text())
        self.assertNotIn('harness_protocols',contract)
        settings=json.loads((self.root/'config.json').read_text())['settings']
        self.assertEqual(contract['settings'],{**settings,'video':{**settings['video'],'seats':[]}})
        job=json.loads((self.root/'job.json').read_text())
        self.assertEqual([p['seat'] for p in job['participants']],['seat-1','seat-2'])
        self.assertEqual(job['retry']['max_retries'],0)
        self.assertEqual(job['n_attempts'],1)
    def test_live_cameras_get_a_game_service_only_for_recorded_seats(self):
        settings=json.loads((self.root/'config.json').read_text())['settings']
        for chosen,expected in [('all',['seat-1','seat-2','seat-3']),(['seat-2'],['seat-2']),(0,[])]:
            with self.subTest(chosen=chosen):
                configure.configure(self.root,{'seats':3,'settings':{**settings,'video':{**settings['video'],'record':True,'seats':chosen}}})
                compose=json.loads((self.root/'environment/docker-compose.yaml').read_text())
                task=tomllib.loads((self.root/'task.toml').read_text())
                self.assertEqual([name for name in compose['services'] if name.endswith('-game')],[f'{seat}-game' for seat in expected])
                self.assertEqual(sorted({artifact['service'] for artifact in task['artifacts'] if 'service' in artifact}),[f'{seat}-game' for seat in expected])
                self.assertEqual(json.loads(compose['services']['main']['environment']['MINDUSTRY_SIM_SETTINGS'])['video']['seats'],chosen)
                for seat in expected:
                    camera=compose['services'][f'{seat}-game']
                    self.assertEqual(camera['environment']['MINDUSTRY_CONTROL_URL'],'http://main:9001')
                    self.assertEqual(camera['networks'],compose['services']['main']['networks'])
                    self.assertNotIn('volumes',camera)
    def test_runtime_rejects_changed_benchmark_conditions(self):
        configure.configure(self.root,{'seats':2,'wave_schedule_briefing':False})
        script="""import assert from 'node:assert/strict';
const {assertBenchmarkSettings}=await import(process.argv[1]);
const seats=['seat-1','seat-2'];
assert.equal(assertBenchmarkSettings({wave_schedule_briefing:true},seats).wave_schedule_briefing,true);
for(const change of [{map:'Maze'},{time_limit_sec:60},{seed:2},{agent_ready_required:false}]) {
  assert.throws(()=>assertBenchmarkSettings(change,seats));
}
assert.throws(()=>assertBenchmarkSettings({},['seat-1']));
"""
        subprocess.run(['node','--input-type=module','-e',script,(self.root/'environment/task-runtime/contract.mjs').as_uri()],check=True,capture_output=True)
    def test_grading_and_wave_contract_are_preserved(self):
        m=json.loads((self.root/'config.json').read_text())
        self.assertEqual(m['settings']['map'],'Fork')
        self.assertEqual(m['settings']['seed'],1)
        self.assertTrue(m['settings']['agent_ready_required'])
        self.assertFalse(m['wave_schedule_briefing'])
        self.assertEqual(m['settings']['endless_survival'],{
            'first_wave_ticks':14400,'wave_spacing_ticks':7200,
            'spawn_seed':1,'enemy_unit_health_multiplier':1,'enemy_unit_damage_multiplier':1})
        self.assertEqual(m['settings']['time_limit_sec'],None)
        self.assertEqual(set(m),{'version','seats','wave_schedule_briefing','settings'})
        self.assertFalse((self.root/'manifest.json').exists())
        verifier=(self.root/'tests/test.sh').read_text()
        self.assertIn('/app/sim/verify.mjs',verifier)
        self.assertNotIn('/tests/grader/',verifier)

if __name__=='__main__':unittest.main()
