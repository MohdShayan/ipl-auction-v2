import { supabase } from './supabase';
import {
  AUCTION_SERVERS,
  DEFAULT_AUCTION_SERVER,
  PRIMARY_SERVER,
  getServerMeta,
  normalizeServer,
} from './auctionServers';

const TABLE = 'auction_states';
const MAX_TRANSACTION_ATTEMPTS = 12;
const presenceRooms = new Map();
const connectionListeners = new Set();
let connectionChannel = null;
let connected = false;
let serverTimeOffset = 0;

function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
  }
  return supabase;
}

function parsePath(path) {
  return String(path || '').split('/').filter(Boolean);
}

function getRoomPath(reference) {
  const parts = parsePath(reference.path);
  if (parts[0] !== 'auctions' || !parts[1]) return null;
  return { roomId: parts[1], keys: parts.slice(2) };
}

function readPath(value, keys) {
  return keys.reduce((current, key) => (
    current && typeof current === 'object' ? current[key] : undefined
  ), value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function writePath(state, keys, value) {
  if (keys.length === 0) return clone(value);
  let current = state;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== 'object') current[key] = {};
    current = current[key];
  }
  if (value === null || value === undefined) delete current[keys[keys.length - 1]];
  else current[keys[keys.length - 1]] = clone(value);
  return state;
}

class Snapshot {
  constructor(value, key = null) {
    this.value = value === undefined ? null : value;
    this.key = key;
  }

  val() {
    return this.value;
  }

  exists() {
    return this.value !== null;
  }

  forEach(callback) {
    if (!this.value || typeof this.value !== 'object') return false;
    for (const key of Object.keys(this.value).sort()) {
      if (callback(new Snapshot(this.value[key], key)) === true) return true;
    }
    return false;
  }
}

export async function readRoom(roomId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from(TABLE)
    .select('state, version')
    .eq('id', roomId)
    .maybeSingle();
  if (error) throw error;
  return data || { state: {}, version: 0 };
}

function getReferenceValue(reference, roomState) {
  const roomPath = getRoomPath(reference);
  if (!roomPath) return null;
  let value = readPath(roomState, roomPath.keys);
  if (reference.limit !== null && value && typeof value === 'object') {
    const keys = Object.keys(value).sort().slice(-reference.limit);
    value = Object.fromEntries(keys.map((key) => [key, value[key]]));
  }
  return value === undefined ? null : value;
}

export async function get(reference) {
  const roomPath = getRoomPath(reference);
  if (!roomPath) return new Snapshot(null);
  const row = await readRoom(roomPath.roomId);
  return new Snapshot(getReferenceValue(reference, row.state), roomPath.keys.at(-1) || roomPath.roomId);
}

async function compareAndSet(roomId, expectedVersion, state) {
  const { data, error } = await requireSupabase().rpc('compare_and_set_auction_state', {
    p_id: roomId,
    p_expected_version: expectedVersion,
    p_state: state,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result) throw new Error('Supabase returned no result for an auction state update.');
  return result;
}

async function mutate(reference, updateState) {
  const roomPath = getRoomPath(reference);
  if (!roomPath) throw new Error(`Unsupported Supabase auction path: ${reference.path}`);
  const { roomId, keys } = roomPath;

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const row = await readRoom(roomId);
    const state = clone(row.state) || {};
    const nextState = updateState(state, readPath(state, keys));
    if (nextState === undefined) return { committed: false, state };
    const result = await compareAndSet(roomId, row.version, nextState);
    if (result.committed) return { committed: true, state: result.state };
  }
  throw new Error('Auction state changed too frequently. Please retry the operation.');
}

export async function set(reference, value) {
  const roomPath = getRoomPath(reference);
  if (!roomPath) throw new Error(`Unsupported Supabase auction path: ${reference.path}`);
  if (roomPath.keys[0] === 'presence') {
    if (value == null) {
      const room = presenceRooms.get(roomPath.roomId);
      if (roomPath.keys[1]) room?.channel.untrack({ userId: roomPath.keys[1] });
      return;
    }
    return setPresence(reference, value);
  }
  if (roomPath.keys.length === 0 && value == null) {
    const { error } = await requireSupabase().from(TABLE).delete().eq('id', roomPath.roomId);
    if (error) throw error;
    return;
  }
  await mutate(reference, (state) => writePath(state, roomPath.keys, value));
}

export async function update(reference, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new TypeError('Auction updates must be an object.');
  }
  const roomPath = getRoomPath(reference);
  if (!roomPath) throw new Error(`Unsupported Supabase auction path: ${reference.path}`);
  if (roomPath.keys[0] === 'presence') {
    const current = await get(reference);
    return set(reference, { ...(current.val() || {}), ...values });
  }
  await mutate(reference, (state, currentValue) => {
    const nextValue = clone(currentValue) || {};
    for (const [key, value] of Object.entries(values)) {
      writePath(nextValue, parsePath(key), value);
    }
    return writePath(state, roomPath.keys, nextValue);
  });
}

export async function remove(reference) {
  return set(reference, null);
}

export async function runTransaction(reference, updateFunction) {
  const roomPath = getRoomPath(reference);
  if (!roomPath) throw new Error(`Unsupported Supabase auction path: ${reference.path}`);
  const { roomId, keys } = roomPath;

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const row = await readRoom(roomId);
    const state = clone(row.state) || {};
    const currentValue = readPath(state, keys);
    const proposedValue = updateFunction(clone(currentValue));
    if (proposedValue === undefined) {
      return { committed: false, snapshot: new Snapshot(currentValue, keys.at(-1) || roomId) };
    }
    const nextState = writePath(state, keys, proposedValue);
    const result = await compareAndSet(roomId, row.version, nextState);
    if (result.committed) {
      return {
        committed: true,
        snapshot: new Snapshot(readPath(result.state, keys), keys.at(-1) || roomId),
      };
    }
  }
  throw new Error('Auction state changed too frequently. Please retry the operation.');
}

function randomKey() {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const entropy = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12) ||
    Math.random().toString(36).slice(2, 14);
  return `${timestamp}${entropy}`;
}

export async function push(reference, value) {
  const childReference = {
    ...reference,
    path: `${reference.path.replace(/\/+$/, '')}/${randomKey()}`,
  };
  await set(childReference, value);
}

export const serverTimestamp = () => Date.now();

export function ref(_database, path) {
  return { path: String(path || ''), limit: null };
}

export function query(reference, limit) {
  return { ...reference, limit: limit?.count ?? null };
}

export const limitToLast = (count) => ({ count });

function notifyConnection(value) {
  connected = value;
  for (const listener of connectionListeners) listener(value);
  if (value) refreshServerTimeOffset();
}

function ensureConnectionChannel() {
  if (connectionChannel || !supabase) return;
  connectionChannel = supabase.channel('auction-connection-watch');
  connectionChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') notifyConnection(true);
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      notifyConnection(false);
    }
  });
}

async function refreshServerTimeOffset() {
  if (!supabase) return;
  const { data, error } = await supabase.rpc('get_server_time_ms');
  if (error) {
    console.warn('[supabase] Could not sync server time; using the local clock.', error);
    return;
  }
  serverTimeOffset = Number(data) - Date.now();
}

function presenceValue(roomId) {
  const room = presenceRooms.get(roomId);
  const current = room?.channel?.presenceState?.() || {};
  return Object.fromEntries(Object.entries(current).map(([userId, entries]) => {
    const latest = Array.isArray(entries) ? entries[entries.length - 1] : entries;
    return [userId, { ...latest, online: true }];
  }));
}

function publishPresence(roomId) {
  const room = presenceRooms.get(roomId);
  if (!room) return;
  const value = presenceValue(roomId);
  for (const listener of room.listeners) listener(new Snapshot(value, 'presence'));
}

function ensurePresenceRoom(roomId, userId = null) {
  let room = presenceRooms.get(roomId);
  if (room || !supabase) return room;
  const channel = supabase.channel(`auction-presence:${roomId}`, {
    config: { presence: { key: userId || undefined } },
  });
  room = { channel, listeners: new Set(), pending: new Map(), subscribed: false };
  presenceRooms.set(roomId, room);
  channel.on('presence', { event: 'sync' }, () => publishPresence(roomId));
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      room.subscribed = true;
      for (const [userId, value] of room.pending) {
        channel.track({ userId, ...value }).catch((error) => {
          console.error(`[supabase] Failed to publish presence for ${userId}`, error);
        });
      }
      room.pending.clear();
      publishPresence(roomId);
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      room.subscribed = false;
      console.error(`[supabase] Presence channel unavailable for room ${roomId}: ${status}`);
    }
  });
  return room;
}

async function setPresence(reference, value) {
  const roomPath = getRoomPath(reference);
  if (!roomPath || !roomPath.keys[0] || !roomPath.keys[1]) {
    throw new Error(`Unsupported Supabase presence path: ${reference.path}`);
  }
  const userId = roomPath.keys[1];
  const room = ensurePresenceRoom(roomPath.roomId, userId);
  if (!room) throw new Error('Supabase is not configured.');
  if (!userId) throw new Error(`Unsupported Supabase presence path: ${reference.path}`);
  if (room.subscribed) {
    const status = await room.channel.track({ userId, ...value });
    if (status !== 'ok') throw new Error(`Failed to publish presence: ${status}`);
  } else {
    room.pending.set(userId, value);
  }
}

function subscribeToPresence(reference, listener, onError) {
  const roomPath = getRoomPath(reference);
  if (!roomPath) return () => {};
  const room = ensurePresenceRoom(roomPath.roomId, roomPath.keys[1]);
  if (!room) {
    onError?.(new Error('Supabase is not configured.'));
    return () => {};
  }
  const callback = (snapshot) => {
    const value = readPath(snapshot.val(), roomPath.keys.slice(1)) || {};
    listener(new Snapshot(value, roomPath.keys.at(-1) || roomPath.roomId));
  };
  room.listeners.add(callback);
  if (room.subscribed) callback(new Snapshot(presenceValue(roomPath.roomId), 'presence'));
  return () => {
    room.listeners.delete(callback);
    if (room.listeners.size === 0 && room.pending.size === 0) {
      room.channel.untrack().catch((error) => {
        console.warn('[supabase] Could not stop room presence tracking.', error);
      });
      requireSupabase().removeChannel(room.channel).catch((error) => {
        console.warn('[supabase] Could not close room presence channel.', error);
      });
      presenceRooms.delete(roomPath.roomId);
    }
  };
}

export function onDisconnect() {
  // Supabase Realtime Presence automatically removes the user when its socket
  // disconnects, so no client-side disconnect write is required.
  return { set: async () => {} };
}

export function onValue(reference, listener, onError) {
  if (reference.path === '.info/connected') {
    const callback = (value) => listener(new Snapshot(value));
    connectionListeners.add(callback);
    ensureConnectionChannel();
    callback(connected);
    return () => connectionListeners.delete(callback);
  }
  if (reference.path === '.info/serverTimeOffset') {
    listener(new Snapshot(serverTimeOffset));
    return () => {};
  }

  const roomPath = getRoomPath(reference);
  if (roomPath?.keys[0] === 'presence') {
    return subscribeToPresence(reference, listener, onError);
  }
  if (!roomPath || !supabase) {
    onError?.(new Error('Supabase is not configured or the auction path is invalid.'));
    return () => {};
  }

  let cancelled = false;
  let eventRevision = 0;
  let initialSnapshotStarted = false;
  let latestVersion = -1;
  const channel = supabase
    .channel(`auction-state:${roomPath.roomId}:${randomKey()}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: TABLE,
      filter: `id=eq.${roomPath.roomId}`,
    }, (payload) => {
      if (cancelled) return;
      const version = Number(payload.new?.version);
      if (Number.isFinite(version) && version < latestVersion) return;
      if (Number.isFinite(version)) latestVersion = version;
      eventRevision += 1;
      const state = payload.eventType === 'DELETE' ? {} : payload.new?.state || {};
      listener(new Snapshot(getReferenceValue(reference, state), roomPath.keys.at(-1) || roomPath.roomId));
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED' && !initialSnapshotStarted) {
        initialSnapshotStarted = true;
        const revisionBeforeRead = eventRevision;
        readRoom(roomPath.roomId).then((row) => {
          if (!cancelled && eventRevision === revisionBeforeRead) {
            if (row.version < latestVersion) return;
            latestVersion = row.version;
            listener(new Snapshot(
              getReferenceValue(reference, row.state),
              roomPath.keys.at(-1) || roomPath.roomId,
            ));
          }
        }).catch((error) => {
          if (!cancelled) onError?.(error);
        });
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        onError?.(new Error(`Supabase Realtime subscription failed: ${status}`));
      }
    });

  return () => {
    cancelled = true;
    requireSupabase().removeChannel(channel);
  };
}

export function isServerAvailable(server) {
  const normalized = normalizeServer(server, null);
  return Boolean(supabase && normalized && normalized !== 'local');
}

export function getAvailableServers() {
  return isServerAvailable(DEFAULT_AUCTION_SERVER)
    ? [AUCTION_SERVERS.find((server) => server.id === PRIMARY_SERVER)]
    : [];
}

export function getRtdb() {
  return supabase;
}

export const rtdb = supabase;

export function getActiveServer() {
  return DEFAULT_AUCTION_SERVER;
}

export function setActiveServer(server) {
  return isServerAvailable(server) ? supabase : null;
}

export function goOnlineServer(server = DEFAULT_AUCTION_SERVER) {
  if (!isServerAvailable(server)) throw new Error('Supabase is not configured.');
  ensureConnectionChannel();
  return supabase;
}

export function goOfflineServer() {
  // Supabase Realtime channels are closed by their subscription cleanup handlers.
}

export function waitForServerConnection(_databaseOrServer, timeoutMs = 6000) {
  if (!supabase) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer;
    const finish = (value) => {
      clearTimeout(timer);
      connectionListeners.delete(listener);
      resolve(value);
    };
    const listener = (value) => {
      if (value) finish(true);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    connectionListeners.add(listener);
    ensureConnectionChannel();
    if (connected) finish(true);
  });
}

export const getServerTime = () => Date.now() + serverTimeOffset;
export const getServerTimeOffset = () => serverTimeOffset;
export const waitForServerTime = async () => serverTimeOffset;

export function getServerMetaForDatabase(server) {
  return getServerMeta(server);
}

export default supabase;
