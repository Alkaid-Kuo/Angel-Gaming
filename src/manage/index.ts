// M4 經營層入口。對戰只經由 BattleGateway 進來。
export * from './types.ts';
export * from './content.ts';
export * from './gateway.ts';
export { FakeGateway } from './gateway-fake.ts';
export { applyCommand } from './commands.ts';
export { newGame, advance, beginMatchDay, recordCall } from './game.ts';
export type { NewGameOptions, AdvanceOptions, AdvanceSummary, LiveTicket, LiveFinish } from './game.ts';
export { liveRequest } from './live.ts';
export { knownView } from './view.ts';
export type { KnownView, KnownPlayer, KnownFixture } from './view.ts';
export { standings } from './league.ts';
export type { StandingRow } from './league.ts';
export { serialize, deserialize } from './save.ts';
export { emptySeason, mvpIndex, ratingOf } from './stats.ts';
export { POLICIES, runSeason } from './autoplayer.ts';
export type { Policy } from './autoplayer.ts';
