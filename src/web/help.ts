// 遊戲說明：規則、建築與兵種（數值直接取自設定檔）、操作。首頁與遊戲內的說明面板共用。
import { BASE_UPGRADES, BUILDING_STATS, BUILDING_TYPES, DAMAGE_MULTIPLIER, RESEARCH, RESEARCH_TYPES, RULES, TICKS_PER_SECOND, TILE_SIZE, UNIT_STATS, UNIT_TYPES, type UnitType } from '../config/index.ts';
import { BUILD_KEYS, BUILDING_NAME, BUILDING_TIP, RESEARCH_NAME, RESEARCH_TIP, TRAIN_KEYS, UNIT_NAME, UNIT_TIP } from './labels.ts';

export interface HelpSection {
  readonly id: string;
  readonly title: string;
  readonly html: string;
}

const sec = (ticks: number): string => `${Math.round((ticks / TICKS_PER_SECOND) * 10) / 10} 秒`;
const tiles = (units: number): string => `${Math.round((units / TILE_SIZE) * 10) / 10} 格`;
const TARGET_NAME: Record<string, string> = { ...UNIT_NAME, building: '建築' };

/** 某攻擊方的特殊倍率說明，例如「對騎兵 ×2」 */
function multiplierText(attacker: UnitType | 'tower'): string {
  const row = DAMAGE_MULTIPLIER[attacker];
  const parts: string[] = [];
  for (const [target, m] of Object.entries(row)) {
    if (m === null) continue;
    if (m !== 100) parts.push(`對${TARGET_NAME[target]} ×${m / 100}`);
  }
  const cannot = Object.entries(row).filter(([, m]) => m === null).map(([t]) => TARGET_NAME[t]);
  // 只能攻擊建築的兵種（攻城車）已寫在兵種介紹裡，不重複
  if (cannot.length > 0 && cannot.length < Object.keys(row).length - 1) parts.push(`不能攻擊${cannot.join('、')}`);
  return parts.join('；');
}

function keyOf(map: Partial<Record<string, string>>, value: string): string {
  return (Object.entries(map).find(([, v]) => v === value)?.[0] ?? '').toUpperCase();
}

function rulesHtml(): string {
  const e = RULES.economy;
  return `
<p><b>目標：</b>摧毀對手所有的主堡。時限 ${Math.round(RULES.match.timeLimitTicks / TICKS_PER_SECOND / 60)} 分鐘，到時還沒分出勝負，比「資產分數」：存活單位的成本＋已完工建築的成本（手上沒花掉的礦不算）。</p>
<p><b>開局：</b>1 座主堡、${e.startWorkers} 名工人、${e.startMinerals} 礦。工人一開始是閒置的，要先派去採礦。</p>
<p><b>採礦：</b>工人每趟採 ${e.mineAmount} 礦（富礦 ${e.richMineAmount} 礦，金色），送回主堡或採集站才入帳。每個礦點同時只能 1 人開採，其他人排隊。主礦只有 4 個礦點、共 ${4 * e.nodeReserve} 礦，會採完；之後要到分礦蓋採集站。</p>
<p><b>人口：</b>每個單位佔人口（騎兵 2、攻城車 3）。主堡 +${BUILDING_STATS.base.supplyProvided}、補給站 +${BUILDING_STATS.supply.supplyProvided}，上限 ${RULES.supply.hardCap}。人口滿了就不能再生產。</p>
<p><b>相剋：</b>長槍兵剋騎兵、騎兵剋弓兵、弓兵靠射程磨長槍兵；攻城車拆建築最快但怕防禦塔。</p>
<p><b>迷霧：</b>只看得到自己單位與建築視野內的東西；看過的敵方建築會留下記憶（半透明）。要在分礦蓋建築，要先有自己的單位到過那裡。</p>
<p><b>瞭望塔：</b>地圖中央的圓點。派單位站在 ${RULES.watchtower.captureRadiusTiles} 格內一段時間就能佔領，得到周圍 ${RULES.watchtower.sightTiles} 格的視野。</p>
<p><b>姿態：</b>積極（預設，主動攻擊視野內的敵人，最多追 ${RULES.stance.aggressiveChaseTiles} 格）、防守（只打射程內的敵人，不離開 ${RULES.stance.defensiveLeashTiles} 格）、堅守（原地不動，只打射程內的敵人）、撤退（不自動攻擊，只執行你指定的攻擊）。</p>`;
}

function unitsHtml(): string {
  const rows = UNIT_TYPES.map((t) => {
    const u = UNIT_STATS[t];
    return `<tr><td>${UNIT_NAME[t]}</td><td>${BUILDING_NAME[u.producer]}（${keyOf(TRAIN_KEYS[u.producer], t)}）</td><td>${u.cost}</td><td>${u.supply}</td><td>${u.hp}</td><td>${u.attack}</td><td>${tiles(u.range)}</td><td>${Math.round((u.speed * TICKS_PER_SECOND) / 100) / 10} 格/秒</td><td>${sec(u.trainTicks)}</td><td>${[UNIT_TIP[t], multiplierText(t)].filter((x) => x !== '').join('；')}</td></tr>`;
  }).join('');
  return `<table class="data"><tr><th>兵種</th><th>生產（鍵）</th><th>礦</th><th>人口</th><th>血量</th><th>攻擊</th><th>射程</th><th>速度</th><th>時間</th><th>特色</th></tr>${rows}</table>
<p class="muted">射程是兩個單位邊緣之間的距離。傷害 ＝ 攻擊 × 倍率 − 護甲（最少 1）。</p>`;
}

function buildingsHtml(): string {
  const rows = BUILDING_TYPES.map((t) => {
    const b = BUILDING_STATS[t];
    const req = b.requiresTech > 1 ? `主堡 Lv${b.requiresTech}` : '—';
    const extra = b.weapon !== null ? `；攻擊 ${b.weapon.attack}、射程 ${tiles(b.weapon.range)}${multiplierText('tower') !== '' ? `、${multiplierText('tower')}` : ''}` : '';
    return `<tr><td>${BUILDING_NAME[t]}</td><td>B ${keyOf(BUILD_KEYS, t)}</td><td>${b.cost}</td><td>${b.size}×${b.size}</td><td>${b.hp}</td><td>${sec(b.buildTicks)}</td><td>${req}</td><td>${BUILDING_TIP[t]}${extra}</td></tr>`;
  }).join('');
  const up = BASE_UPGRADES.map((u, i) => `Lv${i + 2}：${u.cost} 礦、${sec(u.ticks)}`).join('；');
  const research = RESEARCH_TYPES.map((r) => `${RESEARCH_NAME[r]}（${RESEARCH_TIP[r]}）：${RESEARCH[r].levels.map((l, i) => `Lv${i + 1} ${l.cost} 礦`).join('、')}`).join('<br>');
  return `<table class="data"><tr><th>建築</th><th>鍵</th><th>礦</th><th>大小</th><th>血量</th><th>建造</th><th>需要</th><th>用途</th></tr>${rows}</table>
<p><b>主堡升級（選主堡按 U）：</b>${up}。升級中主堡暫停生產。</p>
<p><b>鍛造所研究：</b><br>${research}</p>
<p class="muted">建造：選工人後按 B 再按建築鍵，左鍵放下（綠色可蓋、紅色不行）。礦是在工人抵達、開工時才扣。取消建造中的建築退還 ${RULES.construction.cancelRefundPercent}%。</p>`;
}

function controlsHtml(): string {
  const rows: [string, string][] = [
    ['左鍵', '選取單位或建築（拖曳框選；Shift 加選；雙擊選取畫面內同類型單位）'],
    ['右鍵', '移動；點敵人＝攻擊；工人點礦點＝採礦；工人點己方未完工建築＝接續建造；選建築時＝設定集結點'],
    ['右下角指令格', '每個按鈕左上角是快捷鍵；滑鼠移上去看說明；灰色代表目前不能用（會寫原因）'],
    ['A ＋ 左鍵', '攻擊移動：途中遇到敵人會自動開打'],
    ['M ＋ 左鍵', '移動（同右鍵）'],
    ['H', '駐守：原地停下'],
    ['G', '工人：回去採最近的礦'],
    ['F1～F4', '姿態：積極、防守、堅守、撤退'],
    ['B ＋ 建築鍵', '工人蓋建築（Shift 可連續放置）'],
    ['Q／W／E', '選建築時生產或研究'],
    ['U', '選主堡時升級'],
    ['X', '取消升級／研究、最後一個生產項目，或取消建造中的建築'],
    ['Ctrl ＋ 0～9／0～9', '設定編隊／選取編隊'],
    ['.（句點）', '輪流選取閒置工人；頂列的「閒置工人」也可以點'],
    ['Esc', '取消目前的模式；再按一次取消選取'],
    ['空白鍵／＋／−', '暫停；調整速度'],
    ['WASD／方向鍵／畫面邊緣／中鍵拖曳／滾輪', '平移與縮放（A、W 等鍵在有對應動作時優先執行動作）'],
    ['?', '開關這個說明'],
  ];
  return `<table class="data keys">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
}

export function helpSections(): HelpSection[] {
  return [
    { id: 'rules', title: '規則', html: rulesHtml() },
    { id: 'units', title: '兵種', html: unitsHtml() },
    { id: 'buildings', title: '建築與科技', html: buildingsHtml() },
    { id: 'controls', title: '操作', html: controlsHtml() },
  ];
}

/** 遊戲內的說明面板（分頁） */
export class HelpOverlay {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs: HTMLButtonElement[] = [];
  private readonly sections = helpSections();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'help-overlay hidden';
    const box = document.createElement('div');
    box.className = 'help-box';
    const head = document.createElement('div');
    head.className = 'help-head';
    for (const s of this.sections) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.title;
      b.addEventListener('click', () => this.show(s.id));
      this.tabs.push(b);
      head.append(b);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '關閉（Esc）';
    close.addEventListener('click', () => this.close());
    head.append(close);
    this.body = document.createElement('div');
    this.body.className = 'help-body';
    box.append(head, this.body);
    this.root.append(box);
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    parent.append(this.root);
    this.render('rules');
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  show(id: string): void {
    this.render(id);
    this.root.classList.remove('hidden');
  }

  private render(id: string): void {
    const s = this.sections.find((x) => x.id === id) ?? this.sections[0];
    this.body.innerHTML = s.html;
    this.tabs.forEach((b, i) => b.classList.toggle('active', this.sections[i].id === s.id));
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.root.classList.remove('hidden');
  }

  close(): void {
    this.root.classList.add('hidden');
  }
}
