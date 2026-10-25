import { gameFiles, readEnvironment } from './game-files.mjs';
import { ApiError, notify, serveApi, waitForChange } from './http.mjs';
import { validate } from './schema.mjs';
import { Backend } from './backend.mjs';
import { toolsFor } from './tools.mjs';

const TICK_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function serveMindustry({ engine, renderer, env = readEnvironment() }) {
  const files = gameFiles(env.logs);
  const waiters = new Set();
  files.append({ type: 'roster', seats: env.seats });
  const backend = new Backend({
    engine,
    renderer,
    evidence: env.logs,
    roster: Object.fromEntries(env.seats.map((seat) => [seat, {}])),
    settings: env.settings,
    log: (entry) => files.append(entry),

    onChange: () => {
      settle();
      notify(waiters);
    },
  });
  const tools = toolsFor(backend.settings);

  let savedFailure=null;
  function settle() {
    if(backend.failure&&backend.failure!==savedFailure){
      savedFailure=backend.failure;
      files.finish({failure:backend.failure});
      notify(waiters);
      return;
    }
    if (files.over) return;
    const status = backend.status();
    if (status === 'completed') files.finish({ started: true, terminal: backend.terminal });
    else if (status === 'not_started') files.finish({ started: false, reason: backend.abandoned });
    else if (backend.stoppedTerminal) files.finish({ started: backend.started, terminal: backend.stoppedTerminal });
    else return;
    notify(waiters);
  }

  const queues = new Map();
  const inOrder = (seat, work) => {
    const job = (queues.get(seat) ?? Promise.resolve()).then(work);
    queues.set(seat, job.catch(() => {}));
    return job;
  };

  const seen = new Map();
  const update = async (seat) => {
    const { status, wake_key: wakeKey } = await backend.observe(seat);
    seen.set(seat, JSON.stringify(wakeKey));
    return { game_over: files.over, status };
  };
  const routes = {
    'GET /': ({ seat }) => ({
      game: 'Mindustry',
      you: seat,
      endpoints: [
        { method: 'GET', path: '/update', description: 'Only your status, which every reply also carries.' },
        { method: 'POST', path: '/wait', description: 'Holds until something wakes you (see wake), the match starts or ends, then returns your status. Optional ?timeout_sec=N returns after N seconds if nothing changed.' },
        ...tools.map((tool) => ({ method: 'POST', path: `/${tool.name}`, description: tool.description, body: tool.inputSchema })),
      ],
    }),
    'GET /update': ({ seat }) => inOrder(seat, () => update(seat)),
    async 'POST /wait'({ seat, body, query, signal }) {
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length)
        throw new ApiError(400, 'POST /wait takes an empty JSON object; put its optional timeout in the URL: /wait?timeout_sec=N');
      for (const name of query.keys()) if (name !== 'timeout_sec')
        throw new ApiError(400, `Unknown /wait query parameter ${name}; the only parameter is timeout_sec`);
      if (query.getAll('timeout_sec').length > 1)
        throw new ApiError(400, 'timeout_sec must be supplied at most once');
      const rawLimit = query.get('timeout_sec');
      const limit = rawLimit === null ? null : Number(rawLimit);
      if (limit !== null && (!rawLimit.trim() || !Number.isFinite(limit) || limit < 0))
        throw new ApiError(400, 'timeout_sec must be a finite nonnegative number of seconds');
      const until = limit == null ? null : Date.now() + limit * 1000;
      if (until !== null && !Number.isFinite(until))
        throw new ApiError(400, 'timeout_sec is too large to represent as a deadline');
      const changed = async () => {
        if (files.over) return true;
        const { wake_key: wakeKey } = await inOrder(seat, () => backend.observe(seat));
        return JSON.stringify(wakeKey) !== seen.get(seat);
      };
      while (!(await changed()) && !signal.aborted && (until == null || Date.now() < until)) {

        const timer = until == null ? null : setTimeout(() => notify(waiters), Math.min(2 ** 31 - 1, Math.max(0, until - Date.now())));
        await waitForChange(waiters, signal);
        if (timer) clearTimeout(timer);
      }
      return inOrder(seat, () => update(seat));
    },
  };
  for (const tool of tools) {
    routes[`POST /${tool.name}`] = async ({ seat, body }) => {
      const problem = validate(tool.inputSchema, body);
      if (problem) throw new ApiError(400, problem);
      const reply = await inOrder(seat, () => backend.call(seat, tool.name, body)).finally(() => {
        settle();
        notify(waiters);
      });

      if (!reply.ok) throw new ApiError(reply.invalid ? 400 : 409, reply.error, reply.status ? { status: reply.status } : {});
      return reply.status ? { ...reply.result, status: reply.status } : reply.result;
    };
  }

  let ready = false;
  const server = await serveApi({
    port: env.port,
    tokens: env.tokens,
    routes,
    ready: () => ready && !backend.failure,
    over: () => files.over,

    statusOf: async (seat) => (await backend.observe(seat)).status,
  });
  console.log(`Mindustry listening on ${server.address().port}`);

  let stopping = false;
  async function shutDown(reason) {
    if (stopping) return;
    stopping = true;
    try {
      await backend.stop({ reason });
      settle();
    } catch (error) {
      console.error(`Stopping the match failed: ${error?.message ?? error}`);
    }
    try {
      await backend.close();
    } catch (error) {
      console.error(`Closing the match failed: ${error?.message ?? error}`);
    }
    server.close();
    process.exit(0);
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutDown(`the simulation was stopped (${signal})`));

  try {
    await backend.boot();
  } catch (error) {
    backend.fail(error);
    settle();
    await backend.close().catch(() => {});
    throw new Error(`The match failed to boot: ${error?.message ?? error}`, { cause: error });
  }
  ready = true;

  const lobbySec = backend.settings.lobby_sec;
  const lobby = backend.settings.agent_ready_required ? null : setTimeout(() => {
    const reason = `Not every camera seat's game client joined within ${lobbySec} s, so the match ended before play`;
    if (backend.abandon(reason)) settle();
  }, lobbySec * 1000);
  void backend.start().finally(() => clearTimeout(lobby));

  void (async () => {
    while (!stopping && !files.over) {
      if (await backend.tick()) notify(waiters);
      settle();
      await sleep(TICK_MS);
    }
  })();
  return server;
}
