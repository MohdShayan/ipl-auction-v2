import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuctionResultsCsv } from '../src/lib/auctionExport.js';

test('buildAuctionResultsCsv exports auction metadata, owners, and player name-price pairs', () => {
  const csv = buildAuctionResultsCsv({
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

  assert.match(csv, /Jasprit Bumrah/);
  assert.match(csv, /Mumbai Indians/);
  assert.match(csv, /Manager One/);
  assert.match(csv, /Unclaimed/);
  assert.match(csv, /Auction ID/);
  assert.match(csv, /Auction Type/);
  assert.match(csv, /Player 1 Name/);
  assert.match(csv, /Player 1 Price \(Cr\)/);
  assert.doesNotMatch(csv, /Player Role/);
  assert.doesNotMatch(csv, /Original Team/);
});
