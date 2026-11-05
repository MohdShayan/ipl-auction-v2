import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalRoom,
  readLocalRoom,
  writeLocalRoom,
  joinLocalRoomDb,
  updateLocalPlayerTeam,
  fillLocalEmptyTeamsWithBots,
  removeLocalBotTeam,
  startLocalAuction,
  skipLocalUpcomingSet,
  startLocalUnsoldSet,
  placeLocalBid,
  endLocalPlayerAuction,
  manageLocalAuctionQueue,
  pauseLocalAuction,
  resumeLocalAuction,
  endLocalAuction,
} from '../src/lib/localAuctionEngine.js';
import { IPL_PLAYERS } from '../src/data/players.js';

test('createLocalRoom creates a room with valid initial data', () => {
  const roomId = 'HOTSPOT-TEST1';
  const result = createLocalRoom(
    roomId,
    'user_123',
    { name: 'Host Manager', team: 'MI' },
    'sprint5',
    false,
  );

  assert.equal(result.server, 'local');
  const room = readLocalRoom(roomId);
  assert.ok(room);
  assert.equal(room.id, roomId);
  assert.equal(room.hostId, 'user_123');
  assert.equal(room.squadLimit, 5);
  assert.equal(room.overseasLimit, 2);
  assert.equal(room.settings.budget, 60.0);
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0].team, 'MI');
  assert.ok(room.teams[`${roomId}_user_123`]);
  assert.equal(room.teams[`${roomId}_user_123`].budgetRemaining, 60.0);
});

test('joinLocalRoomDb adds new manager to local room', () => {
  const roomId = 'HOTSPOT-TEST2';
  createLocalRoom(roomId, 'user_host', { name: 'Host', team: 'CSK' }, 'mega');

  joinLocalRoomDb(roomId, 'user_guest', { name: 'Guest', team: 'RCB' });

  const room = readLocalRoom(roomId);
  assert.equal(room.players.length, 2);
  const guest = room.players.find((p) => p.id === 'user_guest');
  assert.ok(guest);
  assert.equal(guest.team, 'RCB');
  assert.ok(room.teams[`${roomId}_user_guest`]);
  assert.equal(room.teams[`${roomId}_user_guest`].budgetRemaining, 120.0);
});

test('fillLocalEmptyTeamsWithBots fills remaining teams up to 10 teams', () => {
  const roomId = 'HOTSPOT-TEST3';
  createLocalRoom(roomId, 'user_host', { name: 'Host', team: 'MI' }, 'mega');

  fillLocalEmptyTeamsWithBots(roomId);

  const room = readLocalRoom(roomId);
  assert.equal(room.players.length, 10);
  assert.equal(Object.keys(room.teams).length, 10);
  assert.ok(room.players.some((p) => p.isBot && p.team === 'CSK'));
});

test('removeLocalBotTeam removes a bot player and team', () => {
  const roomId = 'HOTSPOT-TEST4';
  createLocalRoom(roomId, 'user_host', { name: 'Host', team: 'MI' }, 'mega');
  fillLocalEmptyTeamsWithBots(roomId);

  removeLocalBotTeam(roomId, 'bot_CSK');

  const room = readLocalRoom(roomId);
  assert.equal(room.players.length, 9);
  assert.equal(room.players.some((p) => p.id === 'bot_CSK'), false);
  assert.equal(room.teams[`${roomId}_bot_CSK`], undefined);
});

test('startLocalAuction transitions room to active and sets live bidding', () => {
  const roomId = 'HOTSPOT-TEST5';
  createLocalRoom(roomId, 'user_host', { name: 'Host', team: 'MI' }, 'mega');

  startLocalAuction(roomId);

  const room = readLocalRoom(roomId);
  assert.equal(room.status, 'active');
  assert.equal(room.live.status, 'bidding');
  assert.ok(room.live.playerId);
  assert.equal(room.live.currentBid, 0);
  assert.ok(room.live.timerEndsAt > Date.now());
  assert.equal(room.live.playerOrderIndex, 0);
});

test('host can persist local queue changes and non-hosts cannot', () => {
  const roomId = 'HOTSPOT-QUEUE1';
  createLocalRoom(roomId, 'user_host', { name: 'Host', team: 'MI' });
  startLocalAuction(roomId);

  const started = readLocalRoom(roomId);
  const firstPending = started.pendingQueue[1];
  const secondPending = started.pendingQueue[2];

  assert.throws(
    () => manageLocalAuctionQueue(roomId, 'guest', 'remove', firstPending),
    /active auction host/,
  );
  manageLocalAuctionQueue(roomId, 'user_host', 'remove', firstPending);
  let room = readLocalRoom(roomId);
  assert.equal(room.pendingQueue.includes(firstPending), false);

  manageLocalAuctionQueue(roomId, 'user_host', 'add_front', firstPending);
  room = readLocalRoom(roomId);
  assert.equal(room.pendingQueue[0], firstPending);

  manageLocalAuctionQueue(roomId, 'user_host', 'move', secondPending, room.pendingQueue.length - 1);
  room = readLocalRoom(roomId);
  assert.equal(room.pendingQueue.at(-1), secondPending);
});

test('host can move an upcoming local set to the end of the player queue', () => {
  const roomId = 'HOTSPOT-SKIP1';
  createLocalRoom(roomId, 'user_host', { name: 'Host', team: 'MI' });
  startLocalAuction(roomId);

  const before = readLocalRoom(roomId);
  const currentIndex = before.live.playerOrderIndex;
  const upcoming = before.playerOrder.slice(currentIndex + 1);
  const setName = IPL_PLAYERS[upcoming[0]].set;
  const expectedMoved = upcoming.filter((index) => IPL_PLAYERS[index].set === setName);

  assert.equal(skipLocalUpcomingSet(roomId, 'guest', setName), false);
  assert.equal(skipLocalUpcomingSet(roomId, 'user_host', setName), true);

  const after = readLocalRoom(roomId);
  assert.equal(after.playerOrder[after.live.playerOrderIndex], before.playerOrder[currentIndex]);
  assert.deepEqual(after.playerOrder.slice(-expectedMoved.length), expectedMoved);
  assert.equal(after.messages.at(-1).text, `${setName} moved to the end of the auction queue.`);
});

test('host can revisit local Unsold Set players multiple times', () => {
  const roomId = 'HOTSPOT-UNSOLD1';
  createLocalRoom(roomId, 'user_host', { name: 'Host', team: 'MI' });
  const room = readLocalRoom(roomId);
  room.status = 'active';
  room.playerOrder = [0, 1, 2, 3];
  room.live = {
    playerId: IPL_PLAYERS[0].id,
    playerOrderIndex: 0,
    status: 'bidding',
    timerEndsAt: Date.now() + 10000,
  };
  room.unsoldPlayerIds = [IPL_PLAYERS[4].id, IPL_PLAYERS[5].id];
  room.unsoldRoundStarted = true;
  writeLocalRoom(roomId, room);

  assert.equal(startLocalUnsoldSet(roomId, 'guest'), false);
  assert.equal(startLocalUnsoldSet(roomId, 'user_host'), true);

  const after = readLocalRoom(roomId);
  assert.deepEqual(after.playerOrder, [0, 4, 5, 1, 2, 3]);
  assert.deepEqual(after.unsoldReturnPlayerIds, [IPL_PLAYERS[4].id, IPL_PLAYERS[5].id]);
  assert.deepEqual(after.unsoldPlayerIds, []);
  assert.equal(startLocalUnsoldSet(roomId, 'user_host'), false);

  after.live = {
    playerId: IPL_PLAYERS[4].id,
    playerOrderIndex: 1,
    status: 'unsold',
  };
  after.unsoldPlayerIds = [IPL_PLAYERS[4].id];
  writeLocalRoom(roomId, after);

  assert.equal(startLocalUnsoldSet(roomId, 'user_host'), true);
  const secondReturn = readLocalRoom(roomId);
  assert.deepEqual(secondReturn.playerOrder, [0, 4, 4, 5, 1, 2, 3]);
  assert.deepEqual(secondReturn.unsoldPlayerIds, []);

  secondReturn.live = {
    playerId: IPL_PLAYERS[4].id,
    playerOrderIndex: 2,
    status: 'unsold',
  };
  secondReturn.unsoldPlayerIds = [IPL_PLAYERS[4].id];
  writeLocalRoom(roomId, secondReturn);

  assert.equal(startLocalUnsoldSet(roomId, 'user_host'), true);
  assert.deepEqual(readLocalRoom(roomId).playerOrder, [0, 4, 4, 4, 5, 1, 2, 3]);
});

test('placeLocalBid updates currentBid, highBidder, and extends timer', () => {
  const roomId = 'HOTSPOT-TEST6';
  createLocalRoom(roomId, 'user_host', { name: 'Host', team: 'MI' }, 'mega');
  startLocalAuction(roomId);

  const room = placeLocalBid(
    roomId,
    'user_host',
    'MI',
    'Host',
    'Mumbai Indians',
  );

  assert.equal(room.live.highBidderId, 'user_host');
  assert.ok(room.live.currentBid > 0);
  assert.equal(room.live.highBidderName, 'Host');
  assert.equal(room.live.highBidderTeamId, 'MI');
});

test('pauseLocalAuction, resumeLocalAuction, and endLocalAuction manage room lifecycle', () => {
  const roomId = 'HOTSPOT-TEST7';
  createLocalRoom(roomId, 'user_host', { name: 'Host', team: 'MI' }, 'mega');
  startLocalAuction(roomId);

  pauseLocalAuction(roomId);
  let room = readLocalRoom(roomId);
  assert.equal(room.live.status, 'paused');

  resumeLocalAuction(roomId);
  room = readLocalRoom(roomId);
  assert.equal(room.live.status, 'bidding');

  endLocalAuction(roomId);
  room = readLocalRoom(roomId);
  assert.equal(room.status, 'completed');
  assert.equal(room.live.status, 'completed');
});
