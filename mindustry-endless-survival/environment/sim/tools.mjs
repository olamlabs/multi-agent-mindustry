export const OPS = ['input', 'plan_add', 'plan_remove', 'plan_prioritize', 'plan_clear', 'rebuild_remove',
  'configure', 'rotate', 'withdraw', 'deposit', 'discard', 'control', 'command', 'stance', 'rally',
  'payload_pickup', 'payload_drop', 'ping'];

const object = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const filter = {
  type: 'array',
  description: 'All predicates must hold. Each is [path, op, value]; op is eq, ne, in, not_in, lt, le, gt, ge or contains; path may be dotted ("building.team").',
  items: {type: 'array', minItems: 3, maxItems: 3},
};
const fields = {type: 'array', items: {type: 'string'}, description: 'Fields to return; default all.'};
const limit = {type: 'integer', minimum: 1, description: 'Rows per reply; default 128, no maximum.'};

export function toolsFor(settings) {
  const audiences = settings?.all_chat ? ['team', 'self', 'all'] : ['team', 'self'];
  return [
    ...(settings?.agent_ready_required ? [{
      name: 'ready',
      description: 'Register that your agent has started and can access the game tools. Call with {} once you have read the brief. This returns immediately; the game stays paused until every agent registers and the cameras are ready. Then use POST /wait or GET /update until status.phase is running. Repeating this call is safe. This is a startup barrier, not a reserved planning period.',
      inputSchema: object(),
    }] : []),
    {
      name: 'query',
      description: 'Read current game records: match, players, teams, units, buildings, own-team production counters (including retired building lifetimes), tiles, bullets, and static blocks, unit_types, items, liquids and ops. {of:"collections"} lists every collection with its fields. Rows are live; pass `next` as `after` to continue a scan.',
      inputSchema: object({
        of: {type: 'string', description: 'Collection name.'},
        filter, fields, limit,
        area: object({x: {type: 'integer'}, y: {type: 'integer'}, w: {type: 'integer', minimum: 1}, h: {type: 'integer', minimum: 1}}, ['x', 'y', 'w', 'h']),
        after: {type: 'integer', description: 'The previous reply\'s `next`.'},
      }, ['of']),
    },
    {
      name: 'events',
      description: 'Read your log: native game events (construction, destruction, units created and lost, configuration, waves, game over), messages you can see, and your team\'s accepted inputs. Returns at once. Give exactly one of: `cursor`, a name you choose that remembers its filter and position, so each read returns only entries it has not returned before; `latest`, the newest N matching entries; or `after`, a raw position. `more:true` means further entries are waiting.',
      inputSchema: object({
        cursor: {type: 'string', minLength: 1, description: 'Your name for this reader; its first read sets its filter.'},
        latest: {type: 'integer', minimum: 1},
        after: {type: 'integer', minimum: 0},
        filter, fields, limit,
      }),
    },
    {
      name: 'act',
      description: 'Apply player inputs in order. Inspect every results[].ok: a refused op reports its error immediately, not pending work, while other ops in the batch can succeed. Acceptance is not completion: input controls are held; plan_add queues asynchronous construction/deconstruction. query {of:"ops"} lists every op and its fields.',
      inputSchema: object({
        ops: {
          type: 'array', minItems: 1,
          items: {type: 'object', properties: {op: {type: 'string', enum: OPS}}, required: ['op'], additionalProperties: true},
        },
      }, ['ops']),
    },
    {
      name: 'say',
      description: `Post a message. audience: ${audiences.map(a => `"${a}"`).join(', ')}; default "team". "self" reaches only you. \`to\` names the seats it is for without hiding it from the audience. \`data\` carries any JSON object.`,
      inputSchema: object({
        text: {type: 'string', minLength: 1},
        data: {type: 'object', description: 'Any JSON object.'},
        audience: {type: 'string', enum: audiences},
        to: {type: 'array', items: {type: 'string'}},
        reply_to: {type: 'string', description: 'id of a message you can see.'},
      }),
    },
    {
      name: 'wake',
      description: 'Your wake filters: a log entry that matches any one of them wakes you in POST /wait, and the match starting or ending always does. {} returns the list; {filters:[...]} replaces the whole list, for entries logged from then on. The list starts as messages from other seats and your own self messages: [[["kind","eq","say"],["from","ne",<your seat>]],[["kind","eq","say"],["audience","eq","self"]]].',
      inputSchema: object({filters: {type: 'array', items: filter, description: 'The whole new list; [] leaves only the match starting or ending.'}}),
    },
  ];
}

export const TOOL_NAMES = ['query', 'events', 'act', 'say', 'wake', 'ready'];
