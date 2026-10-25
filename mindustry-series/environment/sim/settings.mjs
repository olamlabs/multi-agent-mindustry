export const MAX_TIME_LIMIT_SEC = 86400;
export const MAX_SEATS = 200;
export const MAX_TEAM_SIZE = 100;
export function seatsFromRoster(roster) {
  if (!roster || typeof roster !== 'object' || Array.isArray(roster)) throw new Error('Invalid roster');
  const names = Object.keys(roster);
  const seats = Array.from({length: names.length}, (_, i) => `seat-${i + 1}`);
  if (names.length < 2 || names.length > MAX_SEATS || names.some(name => !seats.includes(name))) throw new Error(`Expected canonical roster of two through ${MAX_SEATS} seats`);
  return seats;
}

export const DEFAULTS = { game_mode: 'pvp', time_limit_sec: 600, seed: 1, games: 3, lobby_sec: 1800, chat_after_sec: 300, save_interval_sec: 60, all_chat: false, video: { record: true, fps: 5, width: 960, height: 540, seats: 'all' }, replay: { record: true, segment_sec: 600, keyframe_sec: 60 } };
const SEAT_NAME = /^seat-([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$/;
export function validateSettings(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('settings must be an object');
  const allowed = new Set([...Object.keys(DEFAULTS), 'map', 'team_count', 'team_size', 'team_sizes']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown setting: ${key}`);
  const settings = { ...DEFAULTS, ...value, video: { ...DEFAULTS.video, ...value.video }, replay: { ...DEFAULTS.replay, ...value.replay } };
  if (settings.game_mode !== 'pvp') throw new Error('Only PvP is supported');
  const coreOnly = settings.time_limit_sec === null;
  if (!coreOnly && (!Number.isInteger(settings.time_limit_sec) || settings.time_limit_sec < 10 || settings.time_limit_sec > MAX_TIME_LIMIT_SEC)) throw new Error('time_limit_sec must be 10..86400, or null for core-only PvP');
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 2147483647) throw new Error('seed must be 0..2147483647');
  if (!Number.isInteger(settings.games) || settings.games < 1 || settings.games > 100) throw new Error('games must be a whole number from 1 to 100');
  if (!Number.isInteger(settings.lobby_sec) || settings.lobby_sec < 1 || settings.lobby_sec > MAX_TIME_LIMIT_SEC) throw new Error('lobby_sec must be 1..86400');
  if (!Number.isInteger(settings.chat_after_sec) || settings.chat_after_sec < 0 || settings.chat_after_sec > MAX_TIME_LIMIT_SEC) throw new Error('chat_after_sec must be 0..86400');
  if (!Number.isInteger(settings.save_interval_sec) || settings.save_interval_sec < 0) throw new Error('save_interval_sec must be a whole number of seconds, 0 for no saves during a game');
  if (typeof settings.all_chat !== 'boolean') throw new Error('all_chat must be boolean');
  if (settings.team_sizes != null) {
    if (!Array.isArray(settings.team_sizes) || settings.team_sizes.length < 1 || settings.team_sizes.length > 6 || settings.team_sizes.some(n => !Number.isInteger(n) || n < 1 || n > MAX_TEAM_SIZE) || settings.team_sizes.reduce((a,b)=>a+b,0) > MAX_SEATS) throw new Error('Invalid team_sizes');
    if (settings.team_count != null || settings.team_size != null) throw new Error('Use team_sizes or team_count/team_size, not both');
  }
  if ((settings.team_count != null) !== (settings.team_size != null)) throw new Error('Set both team_count and team_size, or omit both');
  for (const [key, max] of [['team_count', 6], ['team_size', MAX_TEAM_SIZE]]) {
    if (settings[key] !== undefined && settings[key] !== null && (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > max)) throw new Error(`${key} must be 1..${max}`);
  }
  if (settings.map !== undefined && (typeof settings.map !== 'string' || !settings.map.trim() || settings.map.length > 100)) throw new Error('Invalid map');
  if (value.video !== undefined && (!value.video || typeof value.video !== 'object' || Array.isArray(value.video))) throw new Error('Invalid video');
  for (const key of Object.keys(settings.video)) if (!Object.hasOwn(DEFAULTS.video, key)) throw new Error(`Unknown video setting: ${key}`);
  if (typeof settings.video.record !== 'boolean') throw new Error('video.record must be boolean');
  for (const [key, min, max] of [['fps',1,15], ['width',640,1280], ['height',360,720]]) {
    if (!Number.isInteger(settings.video[key]) || settings.video[key] < min || settings.video[key] > max) throw new Error(`Invalid video.${key}`);
  }
  if (settings.video.width % 2 || settings.video.height % 2) throw new Error('Video dimensions must be even');
  if (value.replay !== undefined && (!value.replay || typeof value.replay !== 'object' || Array.isArray(value.replay))) throw new Error('Invalid replay');
  for (const key of Object.keys(settings.replay)) if (!Object.hasOwn(DEFAULTS.replay, key)) throw new Error(`Unknown replay setting: ${key}`);
  if (typeof settings.replay.record !== 'boolean') throw new Error('replay.record must be boolean');
  for (const key of ['segment_sec', 'keyframe_sec']) if (!Number.isInteger(settings.replay[key]) || settings.replay[key] < 1 || settings.replay[key] > MAX_TIME_LIMIT_SEC) throw new Error(`replay.${key} must be a whole number of seconds, 1..${MAX_TIME_LIMIT_SEC}`);
  const cameras = settings.video.seats;
  if (cameras !== 'all' && !(Number.isInteger(cameras) && cameras >= 0 && cameras <= MAX_SEATS) && !(Array.isArray(cameras) && cameras.length <= MAX_SEATS && cameras.every(seat => typeof seat === 'string' && SEAT_NAME.test(seat)) && new Set(cameras).size === cameras.length)) throw new Error(`video.seats must be "all", a number of cameras from 0 to ${MAX_SEATS}, or a list of distinct seats`);
  return settings;
}

export function resolveTeams(settings, seats) {
  if (settings.team_sizes != null) {
    if (settings.team_sizes.reduce((a,b)=>a+b,0) !== seats.length || settings.team_sizes.length < 2) throw new Error('Roster or mode does not match team_sizes');
    return {...settings};
  }
  const team_count = settings.team_count ?? 2;
  const team_size = settings.team_size ?? seats.length / team_count;
  if (team_count < 2) throw new Error('PvP requires 2..6 player teams');
  if (!Number.isInteger(team_size) || team_size < 1 || team_size > MAX_TEAM_SIZE || team_count * team_size !== seats.length) throw new Error(`Roster must match team_count × team_size, with 1..${MAX_TEAM_SIZE} seats per team`);
  return {...settings, team_count, team_size};
}

export function resolveCameras(settings, seats) {
  const chosen = settings.video.seats;
  let cameras;
  if (chosen === 'all') cameras = seats;
  else if (Array.isArray(chosen)) {
    const absent = chosen.find(seat => !seats.includes(seat));
    if (absent) throw new Error(`video.seats names ${absent}, which is not in the roster of ${seats.length}`);
    cameras = seats.filter(seat => chosen.includes(seat));
  } else {
    if (chosen > seats.length) throw new Error(`video.seats asks for ${chosen} cameras, more than the ${seats.length} seats`);
    const sizes = settings.team_sizes ?? Array(settings.team_count).fill(settings.team_size);
    let start = 0;
    const teams = sizes.map(size => seats.slice(start, start += size));
    const picked = new Set();
    for (let round = 0; picked.size < chosen; round++) for (const team of teams) if (round < team.length && picked.size < chosen) picked.add(team[round]);
    cameras = seats.filter(seat => picked.has(seat));
  }
  return {...settings, video: {...settings.video, seats: [...cameras]}};
}
