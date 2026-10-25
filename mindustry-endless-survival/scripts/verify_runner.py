#!/usr/bin/env python3
"""Prepare instruction files and preflight this standalone task with the installed Harbor Multiagent parser; never launch."""
import argparse,json,tomllib
from pathlib import Path
from prepare import prepare_instructions

def verify(task, config=None, **_):
    from harbor.models.task.task import Task
    from harbor.models.job.config import JobConfig
    from harbor.models.trial.config import AgentConfig
    task=Path(task).resolve()
    prepare_instructions(task)
    parsed=Task(task)
    raw=tomllib.loads((task/'task.toml').read_text())
    if raw['task']['name']!='olamlabs/mindustry-endless-survival':
        raise ValueError('Wrong standalone task name')
    seats=list(raw['agents'])
    if not 1<=len(seats)<=20 or seats!=[f'seat-{i+1}' for i in range(len(seats))]:
        raise ValueError('Expected canonical roster of 1..20 seats')
    if config is not None:
        for participant in config.get('participants',[]):
            unknown=set(participant)-set(AgentConfig.model_fields)-{'seat'}
            if unknown:raise ValueError(f'Unsupported participant fields: {sorted(unknown)}')
        job=JobConfig.model_validate(config)
        if [p.seat for p in job.participants]!=seats:
            raise ValueError('Configure the task to match the job roster first')
        if not job.tasks or job.tasks[0].path.resolve()!=task:
            raise ValueError('Job must name the exact standalone task directory')
        if job.retry.max_retries!=0:
            raise ValueError('Benchmark retries must remain disabled')
    return {'task':str(task),'seats':seats,'schema_version':raw['schema_version'],'parsed':parsed.name}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('task',type=Path,nargs='?',default=Path(__file__).resolve().parents[1])
    parser.add_argument('--job',type=Path)
    args=parser.parse_args()
    print(json.dumps(verify(args.task,json.loads(args.job.read_text()) if args.job else None),indent=2))
