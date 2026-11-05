import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuctionResultsJson } from '../src/lib/auctionExport.js';

test('buildAuctionResultsJson exports auction metadata, owners, and player name-price pairs', () => {
  const result = buildAuctionResultsJson({
    auction: {
      id: 'ROOM1',
      auctionType: 'mega',
      settings: { budget: 120 },
      players: [{ id: 'manager-1', name: 'Manager One', team: 'MI' }],
      unsoldPlayerIds: ['p_missing'],
    },
    teams: [{
      teamId: 'MI',
      userId: 'manager-1',
      userName: 'Manager One',
      budgetRemaining: 117,
      spent: 3,
      squad: [{ id: 'p_621', bid: 3 }],
    }],
  });

  assert.equal(result.auctionId, 'ROOM1');
  assert.equal(result.auctionType, 'mega');
  assert.deepEqual(result.teams[0], {
    teamName: 'Mumbai Indians',
    ownerName: 'Manager One',
    players: [{ name: 'Jasprit Bumrah', price: 3 }],
  });
  assert.equal(result.teams[1].ownerName, 'Unclaimed');
});
