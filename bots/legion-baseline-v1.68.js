// 本次測試支持的雙模式組合；來源與雜湊記於experiments/combined-v1.68.json。
const BANK={"lead":60};
const COORDINATE={"all":1};
const SWARM={"version":"v1.34","leash":1,"redistribute":1,"preferArcher":6000};
// 基準 BOT v1.0：輕步兵分路，僅依公開資料與視野決策。
class MobileCore {
  constructor() { this.data = null; this.h = null; this.goals = {}; this.last = {}; this.cost = {}; }
  declare() {
    return { name: 'Legion Baseline', version: 'v1.52', style: '輕步兵機動與三路佔點', knobs: [
      { key: 'chase', name: '接戰距離', description: '主動接敵距離（格）', min: 10, max: 20, default: 16, integer: true },
      { key: 'rush', name: '機動開關', description: '允許切入加速', min: 0, max: 1, default: 1, integer: true },
      { key: 'kite', name: '弓兵退距', description: '弓兵面對近戰威脅的退位距離（格）', min: 4, max: 10, default: 6, integer: true }
    ] };
  }
  init(data, helpers) { this.data = data; this.h = helpers; for (const u of data.units) this.cost[u.kind] = u.cost; }
  deploy(data, helpers) {
    const out = [], west = data.playerId === 0, W = data.map.width * 1000, H = data.map.height * 1000;
    for (let i = 0; i < 26; i++) {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 3500 + col * 6500;
      let y;
      if (data.mode === 'capture') { const lane = i % 3, n = Math.floor(i / 3); y = [27500,75000,122500][lane] + (n % 3 - 1) * 6500; }
      else y = H / 2 + (row - 4) * 6500;
      // 佔點三路各用三列；同一路以縱列與橫列避免重疊。
      let dx = x;
      if (data.mode === 'capture') dx = 3500 + Math.floor(Math.floor(i / 3) / 3) * 6500;
      out.push({ type:'light', x:west ? dx : W-dx, y:west ? y : H-y, facing:west ? 0:180, formation:'line', width:4 });
      this.goals[i] = data.mode === 'capture' ? (west ? i % 3 : 2-i%3) : 1;
    }
    if (data.mode === 'capture') for (let i=0; i<52; i++) out.push({type:'light',reserve:true,x:0,y:0,formation:'line'});
    this.initialGoalLayout=Array.from({length:26},(_,i)=>this.goals[i]);
    return out;
  }
  clearPath(a,b) {
    const d = Math.hypot(a.x-b.x,a.y-b.y), n = Math.max(1,Math.ceil(d/1000));
    for(let i=1;i<=n;i++){const t=this.h.terrainAt(a.x+(b.x-a.x)*i/n,a.y+(b.y-a.y)*i/n);if(t===5||t===7||t===8)return false;} return true;
  }
  decide(obs) {
    const cmds=[], field=obs.regiments.filter(r=>!r.reserve); let spent=obs.fieldCost;
    if(!this.goalsInitialized){for(let i=0;i<field.length;i++)this.goals[field[i].id]=this.initialGoalLayout[i];this.goalsInitialized=true;}
    const send=c=>{
      if(obs.flags.length&&c.target!==undefined){
        const e=obs.enemies.find(e=>e.id===c.target);
        if(e){
          if(c.type==='infiltrate'){c.x=e.x;c.y=e.y;}
          if(c.type==='attack'){
            const enemy=1-obs.me,spawn=this.data.map.spawns[enemy];
            const atSpawn=Math.hypot(e.x-spawn.x,e.y-spawn.y)<=this.data.capture.spawnRadius+100;
            const atSupply=this.data.map.supplies.some(p=>obs.flags.some(f=>f.id===p.flag&&f.owner===enemy)&&Math.hypot(e.x-p.x,e.y-p.y)<=this.data.capture.supplyRadius+100);
            if(COORDINATE.all||(!e.engaged&&!e.dashing&&(atSpawn||atSupply))){
              const old=this.last[c.id],own=obs.regiments.find(r=>r.id===c.id);
              if(own&&own.order==='attackMove'&&old&&old.coordinateTarget===e.id&&Math.hypot(old.x-e.x,old.y-e.y)<1500&&obs.tick-old.tick<20)return false;
              c={type:'attackMove',id:c.id,x:e.x,y:e.y,coordinateTarget:e.id,intent:'防撤回目標失效'};
            }
          }
        }
      }

      if(cmds.length<10){cmds.push(c);this.last[c.id]={...c,tick:obs.tick};return true;}return false; };
    for(const r of obs.regiments){if(!r.reserve||r.enterIn>=0||spent+this.cost[r.kind]>obs.fieldCap)continue; if(send({type:'summon',id:r.id,intent:'補充兵力'}))spent+=this.cost[r.kind];}
    const W=this.data.map.width*1000,H=this.data.map.height*1000;
    for(const r of field){
      if(SWARM.redistribute&&obs.flags.length&&obs.tick%20===0&&!r.engaged){const f=obs.flags.find(f=>f.id===this.goals[r.id]);if(f&&f.owner===obs.me&&!f.contested){const guards=field.filter(a=>this.goals[a.id]===f.id&&Math.hypot(a.x-f.x,a.y-f.y)<12000);if(guards.length>4){let dest=null,bv=Infinity;for(const p of obs.flags){if(p.owner===obs.me&&!p.contested)continue;const load=field.filter(a=>this.goals[a.id]===p.id).length;const v=Math.hypot(r.x-p.x,r.y-p.y)+load*3500-p.points*12000;if(v<bv){bv=v;dest=p;}}if(dest)this.goals[r.id]=dest.id;}}}
      if(cmds.length>=10)break;if(r.dashing)continue;
      let target=null,dist=Infinity;
      const flag=obs.flags.find(f=>f.id===this.goals[r.id]);
      let targetValue=Infinity;for(const e of obs.enemies){const actual=Math.hypot(r.x-e.x,r.y-e.y),fd=flag?Math.hypot(e.x-flag.x,e.y-flag.y):0;const cavalry=e.kind==='heavyCav'||e.kind==='lightCav';
        if(flag&&SWARM.leash===1&&cavalry&&fd>12000)continue;
        if(flag&&SWARM.leash===2&&fd>(e.kind==='archer'?22000:12000))continue;
        const value=actual-(e.kind==='archer'?SWARM.preferArcher:0);if(value<targetValue){targetValue=value;dist=actual;target=e;}}
      let goal;
      if(obs.flags.length){
        if(this.goals[r.id]===undefined){let best=Infinity;for(const f of obs.flags){const load=field.filter(a=>this.goals[a.id]===f.id).length;const v=Math.hypot(r.x-f.x,r.y-f.y)+load*6000-(f.owner!==obs.me?12000:0);if(v<best){best=v;this.goals[r.id]=f.id;}}}
        goal=obs.flags.find(f=>f.id===this.goals[r.id])||obs.flags[1];
      }else goal={x:W/2+(obs.me===0?20000:-20000),y:H/2};
      if(target&&dist<this.data.knobs.chase*1000){
        if(this.data.knobs.rush&&r.skillCooldown===0&&!r.engaged&&dist>4500&&dist<11000&&target.status!=='braced'&&this.clearPath(r,target)){send({type:'infiltrate',id:r.id,target:target.id,intent:'切入接戰'});continue;}
        if(r.order!=='attack'||r.target!==target.id)send({type:'attack',id:r.id,target:target.id,intent:'集中接戰'});
      }else{
        let dest=goal;
        if(!obs.flags.length&&obs.tick>1000){const phase=Math.floor((obs.tick-1000)/400)%3;dest={x:obs.me===0?W-25000:25000,y:[H/2,H*.2,H*.8][phase]};}
        const dd=Math.hypot(r.x-dest.x,r.y-dest.y),old=this.last[r.id];
        if(dd<1800){if(r.order!=='hold')send({type:'hold',id:r.id,intent:'守住目標'});continue;}
        if(this.data.knobs.rush&&r.skillCooldown===0&&dd>14000&&(!target||dist>22000)){
          const point={x:r.x+(dest.x-r.x)*10000/dd,y:r.y+(dest.y-r.y)*10000/dd};
          if(this.clearPath(r,point)){send({type:'infiltrate',id:r.id,x:point.x,y:point.y,intent:'快速轉移'});continue;}
        }
        if(r.order==='idle'||r.order==='hold'||r.order==='attack'||!old||Math.hypot(old.x-dest.x,old.y-dest.y)>2500)send({type:'attackMove',id:r.id,x:dest.x,y:dest.y,intent:'前往目標'});
      }
    }
    return cmds;
  }
}

const ARMY={"bows":8,"shields":2,"spears":1,"lights":0,"refresh":1800,"standoff":8000,"wait":450,"lead":50,"retreat":0,"wall":11000,"spread":11000,"kite":6000,"shieldPenalty":22,"volley":1,"volleyMen":20,"gap":2600,"brace":10000,"version":"v1.68","cavKite":6000,"spearCover":0};

export default class BaselineBot extends MobileCore {
  constructor(){super();this.annLast={};this.enemyMemory={};this.enemyLoss=0;this.members={};}
  declare(){const d=super.declare();d.version=ARMY.version;d.style='盾弓協同、高度判斷與三路機動';return d;}
  deploy(data,helpers){
    if(data.mode==='capture')return super.deploy(data,helpers);
    const s=data.playerId===0?1:-1,W=data.map.width*1000,H=data.map.height*1000,out=[];
    const placed=[];
    const place=(kind,x,y,form,width)=>{
      const radius=kind==='shield'?5310:kind==='spear'?4368:kind==='archer'?3000:3842;
      let point=null;
      const candidates=[{x,y}];for(let row=0;row<13;row++)for(const col of [17000,10500,4000])candidates.push({x:col,y:12000+row*6000});
      for(const p of candidates){if(p.x<2000||p.x>=19500||p.y<4000||p.y>H-4000)continue;if(placed.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>0.55*(radius+q.radius)+200)){point=p;break;}}
      if(!point)throw new Error('無合法布陣位置');placed.push({...point,radius});
      out.push({type:kind,x:s===1?point.x:W-point.x,y:s===1?point.y:H-point.y,facing:s===1?0:180,formation:form,width,stance:kind==='shield'?'raise':undefined});
    };
    for(let i=0;i<ARMY.shields;i++)place('shield',17000,H/2+(i-(ARMY.shields-1)/2)*14000,'line',15);
    for(let i=0;i<ARMY.spears;i++)place('spear',17000,H/2+(i-(ARMY.spears-1)/2)*10000+(ARMY.shields===2?0:7000),'line',15);
    for(let i=0;i<ARMY.bows;i++){
      const group=i%Math.max(1,ARMY.shields),rank=Math.floor(i/Math.max(1,ARMY.shields)),x=rank<2?11000:4000;
      const gy=(group-(ARMY.shields-1)/2)*14000;
      place('archer',x,H/2+gy+(rank%2===0?-1:1)*3500,'line',6);
    }
    for(let i=0;i<ARMY.lights;i++)place('light',8000,H/2+35000+i*7000,'line',4);
    return out;
  }
  decide(obs){if(this.data.mode==='capture')return super.decide(obs);return this.army(obs);}
  army(obs){
    const own=obs.regiments.filter(r=>!r.reserve),bows=own.filter(r=>r.kind==='archer'),shields=own.filter(r=>r.kind==='shield'),spears=own.filter(r=>r.kind==='spear'),cmds=[];
    const sign=obs.me===0?1:-1,W=this.data.map.width*1000,H=this.data.map.height*1000;
    const emit=(r,c)=>{
      if(cmds.length>=10)return;
      const last=this.annLast[r.id];
      if(c.type==='attack'&&r.order==='attack'&&r.target===c.target)return;
      if(c.type==='hold'&&r.order==='hold')return;
      if((c.type==='move'||c.type==='attackMove')&&r.order===c.type&&last&&last.type===c.type&&Math.hypot(last.x-c.x,last.y-c.y)<ARMY.refresh&&obs.tick-last.tick<80)return;
      c.id=r.id;cmds.push(c);this.annLast[r.id]={...c,tick:obs.tick};
    };
    const d=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y), angle=(a,b)=>this.h.angleTo(a.x,a.y,b.x,b.y);
    const range=(a,b)=>16000+1000*Math.max(-3,Math.min(3,a.height-b.height));
    for(const e of obs.enemies){const prev=this.enemyMemory[e.id];if(prev&&prev.men>e.men)this.enemyLoss+=(prev.men-e.men)*this.cost[e.kind]/e.men0;this.enemyMemory[e.id]={x:e.x,y:e.y,men:e.men,tick:obs.tick,kind:e.kind,men0:e.men0};}
    for(const e of obs.events)if(e.type==='destroyed'&&this.enemyMemory[e.reg]){const prev=this.enemyMemory[e.reg];this.enemyLoss+=prev.men*this.cost[prev.kind]/prev.men0;delete this.enemyMemory[e.reg];}
    const initial=ARMY.bows*44+ARMY.shields*50+ARMY.spears*38+ARMY.lights*19;
    const losses=initial-own.reduce((v,r)=>v+this.cost[r.kind]*r.men/r.men0,0);
    const observedLead=this.enemyLoss-losses;
    if(observedLead>=BANK.lead&&obs.tick>200&&Object.values(this.enemyMemory).some(e=>e.kind==='archer'))this.bankLead=true;
    if(observedLead<0)this.bankLead=false;
    if(this.bankLead){
      const home={x:sign===1?W*.22:W*.78,y:sign===1?H*.385:H*.615};
      for(let i=0;i<own.length;i++){
        const r=own[i];if(r.dashing)continue;
        let near=null,dist=Infinity;for(const e of obs.enemies){const dd=d(r,e);if(dd<dist){dist=dd;near=e;}}
        const target={x:home.x+sign*(i%3-1)*2600,y:home.y+sign*(Math.floor(i/3)-1.5)*3500};
        const hd=d(r,target),cav=near&&(near.kind==='heavyCav'||near.kind==='lightCav');
        if(r.kind==='spear'&&near&&near.kind!=='archer'&&dist<(cav?24000:8500)){
          const a=angle(r,near),diff=Math.abs(((a-r.facing+540)%360)-180);
          if(r.status==='braced'||r.status==='bracing'){if(diff>85)emit(r,{type:'unbrace',intent:'撤退後衛轉向'});continue;}
          if(r.status!=='unbracing')emit(r,{type:'brace',facing:a,intent:'保存戰果槍林後衛'});continue;
        }
        if(r.kind==='shield'&&near&&near.kind!=='archer'&&dist<6500&&hd>6000){
          const a=angle(r,near),diff=Math.abs(((a-r.facing+540)%360)-180);
          if(r.status==='walled'||r.status==='walling')continue;
          if(diff>10)emit(r,{type:'face',facing:a,intent:'撤退盾兵後衛對向'});else emit(r,{type:'shield',mode:'wall',intent:'撤退盾牆後衛'});continue;
        }
        if(r.kind==='archer'&&near&&near.kind!=='archer'&&dist-near.radius<6500){const dd=Math.max(1,dist);emit(r,{type:'move',x:Math.max(2500,Math.min(W-2500,r.x+(r.x-near.x)/dd*4500)),y:Math.max(3500,Math.min(H-3500,r.y+(r.y-near.y)/dd*4500)),intent:'保存戰果脫離貼身'});continue;}
        if(hd>2300){emit(r,{type:'move',x:target.x,y:target.y,facing:near?angle(r,near):(sign===1?0:180),intent:'領先撤回樹林'});continue;}
        if(r.kind==='archer'&&near&&dist-near.radius*.5<range(r,near)-1000){emit(r,{type:'attack',target:near.id,intent:'樹林防守射擊'});continue;}
        emit(r,{type:'hold',intent:'保存領先兵力'});
      }
      return cmds;
    }

    let nearest=null,nd=1e12;const center={x:own.reduce((v,r)=>v+r.x,0)/Math.max(1,own.length),y:own.reduce((v,r)=>v+r.y,0)/Math.max(1,own.length)};
    for(const e of obs.enemies){const dist=d(e,center);if(dist<nd){nd=dist;nearest=e;}}
    let goal={x:sign===1?W*.43:W*.57,y:sign===1?H*.59:H*.41};
    if(nearest){goal={x:nearest.x-sign*ARMY.standoff,y:nearest.y};}
    else if(obs.tick>ARMY.wait){let candidate=null,bd=1e12;for(const key in this.enemyMemory){const e=this.enemyMemory[key],dd=d(e,center);if(dd<bd){bd=dd;candidate=e;}}goal=candidate||{x:sign===1?W-24000:24000,y:H/2};}
    if(this.enemyLoss>losses+ARMY.lead&&obs.tick>600&&ARMY.retreat)goal={x:sign===1?W*.40:W*.60,y:sign===1?H*.60:H*.40};
    for(let i=0;i<shields.length;i++){
      const r=shields[i];let e=null,dist=1e12;for(const x of obs.enemies){const dd=d(r,x);if(dd<dist){e=x;dist=dd;}}
      const diff=e?Math.abs(((angle(r,e)-r.facing+540)%360)-180):0;
      if(r.status==='walled'||r.status==='walling'){
        if(!e||dist>ARMY.wall+4500||diff>70)emit(r,{type:'shield',mode:'unwall',intent:'盾牆轉移'});continue;
      }
      if(e&&dist<ARMY.wall){if(diff>8)emit(r,{type:'face',facing:angle(r,e),intent:'盾兵對準威脅'});else emit(r,{type:'shield',mode:'wall',intent:'架盾保護弓兵'});continue;}
      if(r.stance!=='raise'){emit(r,{type:'shield',mode:'raise',intent:'舉盾推進'});continue;}
      const offset=(i-(shields.length-1)/2)*ARMY.spread;
      let dest={x:goal.x,y:goal.y+offset};
      if(e&&e.kind!=='archer'&&dist<8000){emit(r,{type:'attack',target:e.id,intent:'盾兵攔截'});continue;}
      emit(r,{type:'move',x:dest.x,y:dest.y,facing:e?angle(r,e):(sign===1?0:180),intent:'盾兵掩護推進'});
    }
    for(let i=0;i<bows.length;i++){
      const r=bows[i];let threat=null,td=1e12,best=null,bv=1e12;
      for(const e of obs.enemies){const dd=d(r,e), eff=dd-e.radius*.5;
        if(e.kind!=='archer'&&dd-e.radius<td){td=dd-e.radius;threat=e;}
        if(eff<range(r,e)-700){const v=eff/1000+(e.kind==='shield'?ARMY.shieldPenalty:e.kind==='heavyCav'?8:e.kind==='spear'?4:e.kind==='archer'?-9:0)+e.men/e.men0*2;if(v<bv){bv=v;best=e;}}
      }
      const cav=threat&&(threat.kind==='heavyCav'||threat.kind==='lightCav');
      if(threat&&td<(cav?ARMY.cavKite:(this.data.knobs.kite*1000))){
        const dd=Math.max(1,d(r,threat)),px=r.x+(r.x-threat.x)/dd*4000,py=r.y+(r.y-threat.y)/dd*4000;
        let dest={x:px,y:py};
        if(cav&&ARMY.spearCover&&spears.length){let guard=spears[0];for(const p of spears)if(d(p,r)<d(guard,r))guard=p;const gd=Math.max(1,d(guard,threat));
          const protectedBy=(guard.status==='braced'||guard.status==='bracing')&&d(r,guard)<9000&&((r.x-guard.x)*(threat.x-guard.x)+(r.y-guard.y)*(threat.y-guard.y)<0)&&Math.abs(((angle(guard,threat)-guard.facing+540)%360)-180)<60;
          if(protectedBy){emit(r,{type:'attack',target:threat.id,intent:'槍林後壓制騎兵'});continue;}
          if(d(r,guard)<15000)dest={x:guard.x+(guard.x-threat.x)/gd*3500,y:guard.y+(guard.y-threat.y)/gd*3500};
        }
        emit(r,{type:'move',x:Math.max(2500,Math.min(W-2500,dest.x)),y:Math.max(3500,Math.min(H-3500,dest.y)),intent:'脫離近戰'});continue;
      }
      if(r.status==='volleying')continue;
      if(best){
        if(ARMY.volley&&r.skillCooldown===0&&best.men>=10&&d(r,best)<range(r,best)-700){
          let density=0;for(const e of obs.enemies)if(d(e,best)<4500)density+=e.men;
          if(density>=ARMY.volleyMen){emit(r,{type:'volley',x:best.x,y:best.y,intent:'密集區域齊射'});continue;}
        }
        emit(r,{type:'attack',target:best.id,intent:'弓兵優先壓制'});continue;
      }
      let anchor=null,ad=1e12;for(const s of shields){const dd=d(r,s);if(dd<ad){ad=dd;anchor=s;}}
      let dest;
      if(anchor){const facing=anchor.facing*Math.PI/180,rank=i%2===0?-1:1;dest={x:anchor.x-Math.cos(facing)*ARMY.gap-Math.sin(facing)*rank*2300,y:anchor.y-Math.sin(facing)*ARMY.gap+Math.cos(facing)*rank*2300};}
      else if(nearest){emit(r,{type:'attack',target:nearest.id,intent:'射手自主接敵'});continue;}
      else dest={x:goal.x-sign*4000,y:goal.y+(i-(bows.length-1)/2)*5000};
      if(d(r,dest)>1700)emit(r,{type:'attackMove',x:dest.x,y:dest.y,intent:'保持盾後掩護'});else if(r.order!=='hold')emit(r,{type:'hold',intent:'等待射擊機會'});
    }
    for(const r of spears){let e=null,dist=1e12;let cv=null,cd=Infinity;for(const x of obs.enemies){const dd=d(r,x);if(dd<dist){e=x;dist=dd;}if((x.kind==='heavyCav'||x.kind==='lightCav')&&dd<cd){cv=x;cd=dd;}}if(cv&&cd<30000){e=cv;dist=cd;}const cavalry=e&&(e.kind==='heavyCav'||e.kind==='lightCav');const footSwarm=obs.enemies.filter(x=>x.kind==='sword'||x.kind==='light').length>=6;const fastFoot=footSwarm&&e&&(e.kind==='sword'||e.kind==='light');
      const diff=e?Math.abs(((angle(r,e)-r.facing+540)%360)-180):0;
      if(r.status==='braced'||r.status==='bracing'){if(!e||dist>(cavalry?33000:fastFoot?28000:13000)||e.kind==='archer'||diff>75)emit(r,{type:'unbrace',intent:'槍陣轉向'});continue;}
      if(r.status==='unbracing')continue;
      if(e&&e.kind!=='archer'&&dist<(cavalry?(e.dashing?29000:24000):fastFoot?22000:ARMY.brace)&&diff<85){emit(r,{type:'brace',facing:angle(r,e),intent:'槍林攔截'});continue;}
      if(e){emit(r,{type:'attack',target:e.id,intent:'槍兵接戰'});continue;}
      emit(r,{type:'attackMove',x:goal.x+sign*2000,y:goal.y,intent:'槍兵前衛'});
    }
    for(const r of own.filter(r=>r.kind==='light')){
      let e=null,dist=1e12;for(const x of obs.enemies){const dd=d(r,x)+(x.kind==='archer'?-12000:0);if(dd<dist){e=x;dist=dd;}}
      if(r.dashing)continue;
      if(e&&r.skillCooldown===0&&d(r,e)>5000&&d(r,e)<11000&&e.status!=='braced'&&this.clearPath(r,e)){emit(r,{type:'infiltrate',target:e.id,intent:'側翼切入'});continue;}
      if(e)emit(r,{type:'attack',target:e.id,intent:'側翼接敵'});else emit(r,{type:'attackMove',x:goal.x,y:goal.y+12000,intent:'側翼偵查'});
    }
    return cmds;
  }
}
