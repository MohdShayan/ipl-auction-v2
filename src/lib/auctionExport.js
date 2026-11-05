import { IPL_PLAYERS } from '../data/players.js';
import { TEAMS } from '../data/teams.js';

export function buildAuctionResultsJson({ auction, teams }) {
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
  const teamRowsForExport = TEAMS.map((team) => {
    const teamRow = teamById.get(team.id);
    const squad = (teamRow?.squad || []).slice(0, 11);
    const players = squad.map((entry) => {
      const playerId = typeof entry === 'string' ? entry : entry?.id;
      const player = playerById.get(playerId);
      return {
        name: player?.name || playerId || '',
        price: typeof entry === 'string' ? null : entry?.bid ?? null,
      };
    });
    return {
      teamName: team.name,
      ownerName: teamRow?.userName || participantByTeam.get(team.id)?.name || 'Unclaimed',
      players,
    };
  });

  return {
    auctionId: auction?.id || '',
    auctionType: auction?.auctionType || 'mega',
    teams: teamRowsForExport,
  };
}

export function downloadAuctionResultsJson({ auction, teams }) {
  const json = JSON.stringify(buildAuctionResultsJson({ auction, teams }), null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const roomId = auction?.id || 'auction';
  link.href = url;
  link.download = `CrickAuction_Results_${new Date().toISOString().slice(0, 10)}_${roomId}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
