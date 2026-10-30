// 共用元件：選手卡、迷你卡、隊徽標、金幣、畫面標題。
import type { KnownPlayer } from '../../manage/index.ts';
import { esc, lineageName, wan } from '../manage/format.ts';
import type { IconName } from './art.ts';
import { SLOT_NAMES, avatarSvg, crestSvg, icon, lineageColor, lineageGlyph, tierOf } from './art.ts';
import type { Ctx } from './model.ts';
import { crestOf, teamColor, teamName } from './model.ts';

export function coin(k: number, cls = ''): string {
  return `<span class="coin ${cls}">${icon('coins', 14)}<b>${wan(k)}</b><small>萬</small></span>`;
}

export function signedCoin(k: number): string {
  return `<span class="coin ${k >= 0 ? 'pos' : 'neg'}">${k >= 0 ? '+' : '−'}<b>${wan(Math.abs(k))}</b><small>萬</small></span>`;
}

export function crest(ctx: Ctx, teamId: string | null, size = 32): string {
  return crestSvg(crestOf(ctx, teamId), size);
}

export function teamTag(ctx: Ctx, teamId: string | null, size = 26): string {
  const me = teamId === ctx.v.me.teamId;
  return `<span class="tt ${me ? 'me' : ''}">${crest(ctx, teamId, size)}<span>${esc(teamName(ctx, teamId))}</span></span>`;
}

export function screenHead(title: string, ic: IconName, sub: string): string {
  return `<header class="sc-head"><button class="sc-back" data-act="go" data-to="hub">${icon('back', 18)}<span>基地</span></button>
    <div class="sc-title"><span class="sc-ic">${icon(ic, 26)}</span><div><h1>${title}</h1><p>${sub}</p></div></div></header>`;
}

export interface CardOpts {
  slot?: number;
  selected?: boolean;
  drag?: boolean;
  intel?: boolean;
  record?: { w: number; l: number };
  footer?: string;
  size?: 'md' | 'sm';
  act?: string;
}

export function playerCard(ctx: Ctx, p: KnownPlayer, o: CardOpts = {}): string {
  const t = tierOf(p.version);
  const team = teamColor(ctx, p.teamId);
  const intel = o.intel ? ctx.v.intel.find((i) => i.playerId === p.id) : undefined;
  const presets = ctx.v.presets.filter((x) => x.playerId === p.id && x.valid).length;
  const diff = intel ? intel.estPower - p.elo : 0;
  return `<div class="pc t${t.idx} pc-${o.size ?? 'md'} ${o.selected ? 'sel' : ''}" style="--tier:${t.color};--team:${team}" data-pid="${p.id}" data-act="${o.act ?? 'card'}" ${o.drag ? 'draggable="true"' : ''}>
    <div class="pc-frame">
      <div class="pc-head"><div class="pc-rt"><b>${p.elo}</b><span>評分</span></div>
        <div class="pc-lg" style="--lc:${lineageColor(p.lineageId)}" title="${lineageName(ctx.c, p.lineageId)}">${lineageGlyph(p.lineageId, 16)}<span>${lineageName(ctx.c, p.lineageId)}</span></div></div>
      <div class="pc-art">${avatarSvg(p.id + p.name, team, 132)}
        ${o.slot !== undefined && o.slot >= 0 ? `<span class="pc-slot">${SLOT_NAMES[o.slot]}</span>` : ''}
        ${p.upgrading ? '<span class="pc-flag">升版中</span>' : ''}
        ${intel ? `<span class="pc-intel" title="球探報告：真實強度估計 ±誤差">情報 <b>${intel.estPower}</b><i class="${diff >= 0 ? 'up' : 'dn'}">${diff >= 0 ? '+' : ''}${diff}</i></span>` : ''}</div>
      <div class="pc-name">${esc(p.name)}</div>
      <div class="pc-sub"><span class="pc-ver">v${p.version}・${t.name}</span>${o.record ? `<span>${o.record.w}勝${o.record.l}敗</span>` : `<span>${p.games} 場</span>`}</div>
      <div class="pc-foot"><span>週薪 <b>${wan(p.weeklySalary)}</b>萬</span>${presets ? `<span class="pc-pre" title="可用的戰術預設">${icon('flask', 12)}${presets}</span>` : ''}</div>
    </div>${o.footer ?? ''}</div>`;
}

/** 迷你卡：出賽位、對戰畫面用 */
export function miniCard(ctx: Ctx, p: KnownPlayer | undefined, extra = ''): string {
  if (!p) return `<div class="mc empty">${icon('users', 22)}<span>未指定</span></div>`;
  const t = tierOf(p.version);
  const team = teamColor(ctx, p.teamId);
  return `<div class="mc t${t.idx}" style="--tier:${t.color};--team:${team}">${avatarSvg(p.id + p.name, team, 54)}
    <div class="mc-txt"><b>${esc(p.name)}</b><span>${lineageGlyph(p.lineageId, 13)}${lineageName(ctx.c, p.lineageId)} v${p.version}</span></div><em>${p.elo}</em>${extra}</div>`;
}

export function slotLabel(i: number): string {
  return SLOT_NAMES[i] ?? `第 ${i + 1} 位`;
}
