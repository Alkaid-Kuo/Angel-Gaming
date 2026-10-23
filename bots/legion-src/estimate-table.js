// 本檔由 scripts/legion-calibrate.ts 產生（引擎 0.3.2 實測），請不要手改；改了兵種數值就重新產生。
// 數值都是引擎單位的血量（一般單位 ×10）。

/**
 * 近戰：滿編的 a 團正面打 b 團時，b 每秒損失的血量（平地、預設陣形、不用技能）
 * @type {Readonly<Record<string, Readonly<Record<string, number>>>>}
 */
export const MELEE_DPS = {"spear":{"spear":600,"sword":320,"shield":868,"archer":970,"light":753,"lightCav":896,"heavyCav":336},"sword":{"spear":2264,"sword":1564,"shield":2043,"archer":2705,"light":2559,"lightCav":2517,"heavyCav":1016},"shield":{"spear":815,"sword":556,"shield":945,"archer":1243,"light":1144,"lightCav":951,"heavyCav":304},"archer":{"spear":733,"sword":608,"shield":314,"archer":774,"light":674,"lightCav":460,"heavyCav":668},"light":{"spear":729,"sword":618,"shield":676,"archer":1759,"light":862,"lightCav":372,"heavyCav":338},"lightCav":{"spear":734,"sword":850,"shield":1022,"archer":2087,"light":1818,"lightCav":612,"heavyCav":279},"heavyCav":{"spear":143,"sword":412,"shield":542,"archer":567,"light":602,"lightCav":360,"heavyCav":54}};

/**
 * 遠程：滿編的弓兵團射 12 格外站著不動的 b 團時，b 每秒損失的血量
 * @type {Readonly<Record<string, number>>}
 */
export const ARROW_DPS = {"spear":998,"sword":1043,"shield":578,"archer":931,"light":992,"lightCav":1138,"heavyCav":377};

/**
 * 衝鋒：滿編的騎兵團（楔形陣）從 16 格外衝沒架槍林、站著不動的 b 團，衝鋒結束時
 * [b 損失的血量（正面）, 騎兵損失（正面）, b 損失（背面）, 騎兵損失（背面）]
 * @type {Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>}
 */
export const CHARGE_HIT = {"lightCav":{"spear":[19077,1358,26760,-292],"sword":[13856,1592,24743,-58],"shield":[13465,382,26513,-1378],"archer":[15400,1859,15880,1451],"light":[11200,-536,11200,-536],"lightCav":[11431,-230,17563,-230],"heavyCav":[6310,1338,8660,1219]},"heavyCav":{"spear":[28680,-2092,30000,-2024],"sword":[27668,-2395,28800,-2318],"shield":[29059,-3363,30800,-3462],"archer":[13300,866,12600,1278],"light":[9800,704,9800,792],"lightCav":[15922,-1060,17600,-1225],"heavyCav":[10923,-1236,20885,-1236]}};
