export const MAX_LOBBY_SEC = 86400;
export const MAX_SEATS = 20;
export function seatsFromRoster(roster) {
  if (!roster || typeof roster !== 'object' || Array.isArray(roster)) throw new Error('Invalid roster');
  const names = Object.keys(roster);
  const seats = Array.from({length: names.length}, (_, i) => `seat-${i + 1}`);
  if (names.length < 1 || names.length > MAX_SEATS || names.some(name => !seats.includes(name))) throw new Error(`Expected canonical roster of one through ${MAX_SEATS} seats`);
  return seats;
}

export const DEFAULTS = { game_mode: 'survival', map: 'Fork', time_limit_sec: null, agent_ready_required: true, endless_survival: {first_wave_ticks:14400,wave_spacing_ticks:7200,spawn_seed:1,enemy_unit_health_multiplier:1,enemy_unit_damage_multiplier:1}, seed: 1, lobby_sec: 1800, save_interval_sec: 60, all_chat: false, video: { record: true, fps: 5, width: 960, height: 540, seats: 'all' } };
const SEAT_NAME = /^seat-([1-9]|1[0-9]|20)$/;
export function validateEndlessProfile(profile) {
  const fields=['first_wave_ticks','wave_spacing_ticks','spawn_seed','enemy_unit_health_multiplier','enemy_unit_damage_multiplier'];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).length!==fields.length || Object.keys(profile).some(key=>!fields.includes(key))) throw new Error('endless_survival requires exactly the five wave settings');
  for (const key of ['first_wave_ticks','wave_spacing_ticks']) if (!Number.isFinite(profile[key]) || profile[key]<60 || profile[key]>5184000) throw new Error(`endless_survival.${key} must be 60..5184000 native ticks`);
  if (!Number.isInteger(profile.spawn_seed) || profile.spawn_seed<0 || profile.spawn_seed>2147483647) throw new Error('endless_survival.spawn_seed must be 0..2147483647');
  for (const key of ['enemy_unit_health_multiplier','enemy_unit_damage_multiplier']) if (!Number.isFinite(profile[key]) || profile[key]<=0 || profile[key]>100) throw new Error(`endless_survival.${key} must be >0 and <=100`);
  return Object.fromEntries(fields.map(key=>[key,profile[key]]));
}

export const MAX_SURVIVAL_TEAM = 20;

export function validateSettings(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('settings must be an object');
  const allowed = new Set([...Object.keys(DEFAULTS), 'map', 'team_sizes', 'agent_ready_required', 'endless_survival', 'wave_schedule_briefing']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown setting: ${key}`);
  const settings = { ...DEFAULTS, ...value, video: { ...DEFAULTS.video, ...value.video } };
  {
    settings.endless_survival=validateEndlessProfile(settings.endless_survival);
    if (settings.game_mode!=='survival') throw new Error('endless_survival requires survival mode');
    if (Object.hasOwn(value,'time_limit_sec') && value.time_limit_sec!==null) throw new Error('endless_survival requires null time_limit_sec');
    settings.time_limit_sec=null;
    if (settings.agent_ready_required!==true) throw new Error('endless_survival requires agent_ready_required:true');

    if (settings.map!=='Fork' || (settings.team_sizes!==undefined && (!Array.isArray(settings.team_sizes) || settings.team_sizes.length!==1 || !Number.isInteger(settings.team_sizes[0]) || settings.team_sizes[0]<1 || settings.team_sizes[0]>MAX_SURVIVAL_TEAM))) throw new Error(`This endless survival task requires Fork and one team of 1 to ${MAX_SURVIVAL_TEAM} seats (team_sizes:[n], or the whole roster)`);
    if (Object.hasOwn(value,'wave_schedule_briefing') && typeof value.wave_schedule_briefing!=='boolean') throw new Error('wave_schedule_briefing must be true or false');
  }
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 2147483647) throw new Error('seed must be 0..2147483647');
  if (!Number.isInteger(settings.lobby_sec) || settings.lobby_sec < 1 || settings.lobby_sec > MAX_LOBBY_SEC) throw new Error('lobby_sec must be 1..86400');
  if (!Number.isInteger(settings.save_interval_sec) || settings.save_interval_sec < 0) throw new Error('save_interval_sec must be a whole number of seconds, 0 for no saves during a game');
  if (typeof settings.all_chat !== 'boolean') throw new Error('all_chat must be boolean');
  if (settings.map !== undefined && (typeof settings.map !== 'string' || !settings.map.trim() || settings.map.length > 100)) throw new Error('Invalid map');
  if (value.video !== undefined && (!value.video || typeof value.video !== 'object' || Array.isArray(value.video))) throw new Error('Invalid video');
  for (const key of Object.keys(settings.video)) if (!Object.hasOwn(DEFAULTS.video, key)) throw new Error(`Unknown video setting: ${key}`);
  if (typeof settings.video.record !== 'boolean') throw new Error('video.record must be boolean');
  for (const [key, min, max] of [['fps',1,15], ['width',640,1280], ['height',360,720]]) {
    if (!Number.isInteger(settings.video[key]) || settings.video[key] < min || settings.video[key] > max) throw new Error(`Invalid video.${key}`);
  }
  if (settings.video.width % 2 || settings.video.height % 2) throw new Error('Video dimensions must be even');
  const cameras = settings.video.seats;
  if (cameras !== 'all' && !(Number.isInteger(cameras) && cameras >= 0 && cameras <= MAX_SEATS) && !(Array.isArray(cameras) && cameras.length <= MAX_SEATS && cameras.every(seat => typeof seat === 'string' && SEAT_NAME.test(seat)) && new Set(cameras).size === cameras.length)) throw new Error(`video.seats must be "all", a number of cameras from 0 to ${MAX_SEATS}, or a list of distinct seats`);
  return settings;
}

export function resolveTeams(settings, seats) {
  if (seats.length < 1 || seats.length > MAX_SURVIVAL_TEAM) throw new Error(`Endless survival takes a roster of 1 to ${MAX_SURVIVAL_TEAM} seats`);
  if (settings.team_sizes !== undefined && (settings.team_sizes.length !== 1 || settings.team_sizes[0] !== seats.length)) throw new Error('Roster does not match team_sizes');
  return {...settings, team_sizes: [seats.length]};
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
    cameras = seats.slice(0, chosen);
  }
  return {...settings, video: {...settings.video, seats: [...cameras]}};
}
