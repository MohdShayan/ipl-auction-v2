import { IPL_PLAYERS } from '../data/players.js';
import { TEAMS } from '../data/teams.js';
const csvCell = (value) => {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

const row = (values) => values.map(csvCell).join(',');

export function buildAuctionResultsCsv({ auction, teams }) {
  const teamRows = Array.isArray(teams) ? teams : [];
  const participants = Array.isArray(auction?.players) ? auction.players : [];
  const teamById = new Map(teamRows.map((team) => [team.teamId, team]));
  const playerById = new Map(IPL_PLAYERS.map((player) => [player.id, player]));
  const participantByTeam = new Map(
    participants.filter((participant) => participant?.team).map((participant) => [
      participant.team,
      participant,
    ]),
  );
  const playerColumns = Array.from({ length: 11 }, (_, index) => [
    `Player ${index + 1} Name`,
    `Player ${index + 1} Price (Cr)`,
  ]).flat();
  const teamRowsForExport = TEAMS.map((team) => {
    const teamRow = teamById.get(team.id);
    const squad = (teamRow?.squad || []).slice(0, 11);
    const players = squad.flatMap((entry) => {
      const playerId = typeof entry === 'string' ? entry : entry?.id;
      const player = playerById.get(playerId);
      return [player?.name || playerId || '', typeof entry === 'string' ? '' : entry?.bid ?? ''];
    });
    return row([
      auction?.id || '',
      auction?.auctionType || 'mega',
      team.name,
      teamRow?.userName || participantByTeam.get(team.id)?.name || 'Unclaimed',
      ...players,
      ...Array(Math.max(0, playerColumns.length - players.length)).fill(''),
    ]);
  });

  return [
    row(['Crick Auction Results']),
    row(['Auction ID', auction?.id || '']),
    row(['Auction Type', auction?.auctionType || 'mega']),
    '',
    row(['Auction ID', 'Auction Type', 'Team Name', 'Team Owner', ...playerColumns]),
    ...teamRowsForExport,
  ].join('\r\n');
}

export function downloadAuctionResultsCsv({ auction, teams }) {
  const csv = buildAuctionResultsCsv({ auction, teams });
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const roomId = auction?.id || 'auction';
  link.href = url;
  link.download = `CrickAuction_Results_${new Date().toISOString().slice(0, 10)}_${roomId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
