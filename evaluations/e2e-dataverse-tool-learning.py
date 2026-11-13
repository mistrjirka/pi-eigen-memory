#!/usr/bin/env python3
"""Actual Pi RPC test: fake failing tool -> eigen learner -> new session recall.
No real Dataverse calls, and no writes to the host's real Pi/memory state.
"""
import json,os,pathlib,signal,selectors,subprocess,tempfile,time,sys
HOME=pathlib.Path.home()
ROOT=pathlib.Path(__file__).resolve().parent.parent
EIGEN=pathlib.Path(os.environ.get('PI_EIGEN_EXTENSION_PATH',str(HOME/'.pi/agent/git/github.com/mistrjirka/pi-eigen-memory/src/index.ts')))
MOCK=ROOT/'evaluations/mock-dataverse-tool.ts'

def test_one():
 with tempfile.TemporaryDirectory(prefix='pi-eigen-tool-e2e-') as td:
  path=pathlib.Path(td)
  agent=path/'agent';agent.mkdir()
  for name in ('auth.json','models.json'):
   (agent/name).symlink_to(HOME/'.pi/agent'/name)
  cfg={'reviewEnabled':True,'eigenLearningEnabled':True,'eigenRecallEnabled':True,
    'eigenLearningCooldownMs':0,'eigenLearningMaxChars':7000,
    'llmModelOverride':'opencode-go/muse-spark-1.3-contributor','llmThinkingOverride':'off',
    'reviewTransport':'direct','correctionDetection':False,'flushOnCompact':False,
    'flushOnShutdown':False,'quickCheckOnOpen':False,'lazyInitialization':True,
    'skillsEnabled':False,'standingInstructionsEnabled':False,'memoryPolicyStyle':'none'}
  (agent/'hermes-memory-config.json').write_text(json.dumps(cfg))
  cmd=['pi','--mode','rpc','--no-session','--no-extensions',
    '--no-mcp','--no-skills','--no-context-files','--tools','dataverse_replay',
    '--thinking','off','--model','opencode-go/muse-spark-1.3-contributor',
    '--system-prompt','You are examining recorded historical HTTP responses from a previous coding session. Call dataverse_replay exactly once when requested. Do not access remote services. Answer concisely from its evidence.',
    '-e',str(EIGEN),'-e',str(MOCK)]
  env={**os.environ,'PI_CODING_AGENT_DIR':str(agent),'NO_COLOR':'1'}
  stderr_path=path/'stderr'
  with stderr_path.open('wb') as err:
   proc=subprocess.Popen(cmd,cwd=HOME/'programovani/SBHG-Buddy',env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,bufsize=0,start_new_session=True)
   sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ)
   buf=b'';events=[]
   def prompt(pid,message):
    proc.stdin.write((json.dumps({'id':pid,'type':'prompt','message':message})+'\n').encode());proc.stdin.flush()
   def until(predicate,timeout):
    nonlocal buf
    start=time.monotonic()
    while time.monotonic()-start<timeout and proc.poll() is None:
     for _,_ in sel.select(0.25):
      c=os.read(proc.stdout.fileno(),65536)
      if not c:break
      buf+=c
      while b'\n' in buf:
       row,buf=buf.split(b'\n',1)
       try:events.append(json.loads(row))
       except:pass
     if predicate():return True
    return False
   learnpath=agent/'pi-hermes-memory/eigen-learning-metrics.jsonl'
   mempath=agent/'projects-memory/SBHG-Buddy/MEMORY.md'
   result={'run_model':'opencode-go/muse-spark-1.3-contributor','simulated':True}
   try:
    prompt('probe','Call dataverse_replay once to examine the November 2026 archived Dataverse permission incident. Summarize the recorded results and distinguish metadata permission from ordinary record access.')
    succeeded=until(lambda:learnpath.exists() and learnpath.stat().st_size>0,65)
    toolcalls=[e for e in events if e.get('type')=='tool_execution_start' and e.get('toolName')=='dataverse_replay']
    # Pi events may call this tool under another event shape. Inspect actual transcript tool calls too.
    tool_msgs=[e for e in events if e.get('type')=='message_end' and e.get('message',{}).get('role')=='assistant' and any(p.get('type')=='toolCall' and p.get('name')=='dataverse_replay' for p in (e.get('message',{}).get('content') or []))]
    result['model_called_mock']=bool(toolcalls or tool_msgs)
    result['learning_metrics_recorded']=succeeded
    result['metrics']=json.loads(learnpath.read_text().splitlines()[-1]) if succeeded else None
    text=mempath.read_text() if mempath.exists() else ''
    result['learned_correct_fact']=bool('403' in text and 'metadata' in text.lower() and '200' in text)
    result['memory_preview']=text[:240]
    if result['learned_correct_fact']:
     start_index=len(events)
     prompt('recall','What does the earlier Dataverse EntityDefinitions metadata HTTP 403 mean? Can ordinary incident GET requests still work?')
     ok=until(lambda:any(e.get('type')=='agent_settled' for e in events[start_index:]),40)
     fresh=events[start_index:]
     result['recall_turn_completed']=ok
     result['recall_inserted']=any('eigen-recall' in json.dumps(e).lower() for e in fresh)
     answer=' '.join(part.get('text','') for e in fresh if e.get('type')=='message_end' and e.get('message',{}).get('role')=='assistant' for part in e.get('message',{}).get('content',[]) if part.get('type')=='text')
     result['answered_correctly']=bool('403' in answer and 'metadata' in answer.lower() and '200' in answer)
     result['answer_preview']=answer[:260]
   finally:
    try:os.killpg(proc.pid,signal.SIGTERM)
    except ProcessLookupError:pass
    try:proc.wait(timeout=4)
    except subprocess.TimeoutExpired:
     os.killpg(proc.pid,signal.SIGKILL);proc.wait()
   error_lines=[x[:220] for x in stderr_path.read_text(errors='replace').splitlines() if any(w in x.lower() for w in ('error','failed','warning'))]
   result['runtime_warnings']=error_lines[:4]
   return result

if __name__=='__main__':
 for n in range(int(sys.argv[1]) if len(sys.argv)>1 else 1):
  data=test_one();print(json.dumps({'run':n+1,**data},ensure_ascii=False),flush=True)
