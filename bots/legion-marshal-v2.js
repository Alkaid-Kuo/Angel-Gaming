// 元帥 v160：由殲滅戰 v156 與佔點 v147 整合，只根據公開地圖、旗點與己方視野決策。
const VERSION = 'v160';
const FIELD_A = ["sword","sword","sword","sword","sword","sword","light","light","light","light","light","light","light","light","light","light","light"];
const FIELD_C = ["light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light"];
const RESERVE = ["light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light","light"];
const clamp = (x,a,b) => Math.max(a, Math.min(b,x));
const ds = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const diff = (a,b) => Math.abs(((a-b+540)%360)-180);
const mobile = r => !r.reserve && !r.dashing && r.status !== 'reforming';

export default class Marshal {
  constructor() {
    this.data = null;
    this.h = null;
    this.def = {};
    this.last = {};
    this.roles = {};
    this.seen = {};
    this.motion = {};
    this.melee = {};
    this.assigned = false;
    this.stage = 0;
  }
  declare() {
    return {name:'元帥',version:VERSION,style:'步兵繞側、衝鋒避讓、三路旗點與後備調度',knobs:[
      {key:'cohesion',name:'旗點展開',description:'旗圈目標的展開間距（格）',min:4,max:8,default:5,integer:true},
      {key:'flank',name:'迂迴距離',description:'繞開槍林與盾牆的額外距離（單位）',min:4000,max:7000,default:5000,integer:true},
      {key:'dodge',name:'閃避距離',description:'衝鋒來襲時的側向閃避距離（單位）',min:5000,max:8000,default:6500,integer:true}
    ]};
  }
  init(data,helpers) {
    this.data=data; this.h=helpers;
    this.sign=data.playerId===0?1:-1;
    this.W=data.map.width*1000; this.H=data.map.height*1000;
    for(const u of data.units) this.def[u.kind]=u;
    this.scoutPoints=[];
    const mw=data.map.width,mh=data.map.height,tiles=data.map.terrain,mark=new Uint8Array(mw*mh);
    for(let start=0;start<tiles.length;start++){
      if(tiles[start]!==2||mark[start])continue;
      const queue=[start];mark[start]=1;let head=0,sx=0,sy=0;
      while(head<queue.length){const t=queue[head++],x=t%mw,y=Math.floor(t/mw);sx+=x;sy+=y;const ns=[];if(x>0)ns.push(t-1);if(x+1<mw)ns.push(t+1);if(y>0)ns.push(t-mw);if(y+1<mh)ns.push(t+mw);for(const n of ns)if(!mark[n]&&tiles[n]===2){mark[n]=1;queue.push(n);}}
      if(queue.length<6)continue;
      const cx=sx/queue.length,cy=sy/queue.length;let best=queue[0],bd=Infinity;
      for(const t of queue){const d=(t%mw-cx)*(t%mw-cx)+(Math.floor(t/mw)-cy)*(Math.floor(t/mw)-cy);if(d<bd){bd=d;best=t;}}
      this.scoutPoints.push({x:(best%mw)*1000+500,y:Math.floor(best/mw)*1000+500});
    }
    this.scoutPoints.sort((a,b)=>this.local(b).x-this.local(a).x||this.local(a).y-this.local(b).y);
    this.scoutPoints.push(...data.map.spawns);
    for(const x of [30000,70000,110000,145000])for(const y of [20000,50000,80000])this.scoutPoints.push(this.world({x,y}));

  }
  deploy(data,helpers) {
    const kinds=data.mode==='capture'?FIELD_C:FIELD_A;
    const out=[]; let spent=0;
    const counts={};
    for(const k of kinds) counts[k]=(counts[k]||0)+1;
    const indices={};this.placed=[];let capFast=0;
    let deployIndex=0;
    for(const k of kinds) {
      const i=indices[k]||0; indices[k]=i+1;
      let x=16500, y=this.H/2;
      let formation=k==='archer'?'square':k==='spear'?'line':k==='heavyCav'?'wedge':'line';
      let width=k==='spear'?10:k==='archer'?6:k==='light'?4:6;
      if(data.mode==='capture') {
        if(k==='lightCav') y=i===0?27500:122500;
        else if(k==='light') y=i===0?34000:116000;
        else if(k==='archer') {x=8500;y=75000+(i-(counts[k]-1)/2)*6500;}
        else y=75000+(i-(counts[k]-1)/2)*6500;
      } else {
        if(k==='archer') {x=6500;y=50000+(i-(counts[k]-1)/2)*6500;}
        else if(k==='light') {x=16500;y=i===0?27000:73000;}
        else y=50000+(i-(counts[k]-1)/2)*6500;
      }
      if(k==='light') {x=i<13?16500:6500;y=this.H/2+((i%13)-6)*(this.H===100000?7000:10000);}
      if(data.mode==='annihilation') {const di=deployIndex++; const rows=Math.ceil(kinds.length/2);x=di<rows?16500:6500;y=35000+((di%rows)-(rows-1)/2)*6500;formation=k==='heavyCav'?'wedge':'line';width=k==='spear'?10:k==='sword'?8:k==='light'?8:6;}
      if(data.mode==='capture'){
        let wanted=75000;if(k==='light'||k==='lightCav'){const lane=capFast++%3;wanted=lane===0?27500:lane===2?122500:75000;}
        else wanted=75000+(i-(counts[k]-1)/2)*6500;
        let best=Infinity;
        for(const cx of [16500,6500])for(let cy=15000;cy<=135000;cy+=10000){
          if(this.placed.some(p=>Math.hypot(cx-p.x,cy-p.y)<6000))continue;
          const score=Math.abs(cy-wanted)+(cx===6500?3500:0);
          if(score<best){best=score;x=cx;y=cy;}
        }
        this.placed.push({x,y});
      }
      y=clamp(y,6000,this.H-6000);
      const p=this.world({x,y});
      const c=this.def[k].cost;
      if(spent+c>data.budget) continue;
      out.push({type:k,x:p.x,y:p.y,formation,width,facing:this.sign===1?0:180});spent+=c;
    }
    if(data.mode==='capture') for(const k of RESERVE) {
      if(spent+this.def[k].cost>data.budget) continue;
      out.push({type:k,reserve:true,formation:k==='archer'?'square':k==='spear'?'line':'line'});
      spent+=this.def[k].cost;
    }
    return out;
  }
  world(p) {return this.sign===1?{x:p.x,y:p.y}:{x:this.W-p.x,y:this.H-p.y};}
  local(p) {return this.world(p);}
  angle(a,b) {return this.h.angleTo(a.x,a.y,b.x,b.y);}
  offset(x,y,angle,distance) {const p=this.h.offset(x,y,angle,distance);return {x:p[0],y:p[1]};}
  pass(x,y) {const t=this.h.terrainAt(x,y);return t!==5&&t!==7&&t!==8;}
  safePoint(p) {
    p={x:clamp(p.x,1500,this.W-1500),y:clamp(p.y,1500,this.H-1500)};
    if(this.pass(p.x,p.y)) return p;
    for(let rad=1000;rad<=7000;rad+=1000) for(let i=0;i<8;i++) {
      const q=this.offset(p.x,p.y,i*45,rad);
      if(this.pass(q.x,q.y)) return q;
    }
    return p;
  }
  decide(obs) {
    if(this.data.mode==='annihilation') return this.meleeBattle(obs);
    const field=obs.regiments.filter(r=>!r.reserve);
    const enemies=obs.enemies;
    const commands=[];
    const push=(cmd,priority) => commands.push({cmd,p:priority});
    if(!this.assigned) {
      let flank=0,front=0,bow=0;
      for(const r of obs.regiments) {
        if(r.kind==='lightCav'||r.kind==='light') this.roles[r.id]={flank:this.data.mode==='capture'&&!r.reserve?(r.y<50000?0:r.y>100000?2:1):flank%3,index:flank++};
        else if(r.kind==='archer') this.roles[r.id]={flank:1,index:bow++};
        else this.roles[r.id]={flank:1,index:front++};
      }
      this.assigned=true;
      push({type:'plan',text:'三路快取旗點，補給輪換續防'},1000);
    }
    for(const r of field) if(r.engaged) this.melee[r.id]=obs.tick;
    for(const e of enemies) {
      const prev=this.seen[e.id];
      if(prev&&obs.tick>prev.tick) this.motion[e.id]={x:(e.x-prev.x)/(obs.tick-prev.tick),y:(e.y-prev.y)/(obs.tick-prev.tick)};
      this.seen[e.id]={x:e.x,y:e.y,kind:e.kind,tick:obs.tick,men:e.men};
    }
    for(const e of obs.events) if(e.type==='destroyed') delete this.seen[e.reg];
    const fronts=field.filter(r=>r.kind!=='archer'&&r.kind!=='light'&&r.kind!=='lightCav');
    const bows=field.filter(r=>r.kind==='archer');
    const center=this.world({x:this.data.mode==='capture'?116000:68000,y:this.data.mode==='capture'?75000:53000});
    let aim=center;
    if(this.data.mode==='annihilation') {
      let target=null,best=Infinity;
      const anchor=fronts.length?{x:fronts.reduce((s,r)=>s+r.x,0)/fronts.length,y:fronts.reduce((s,r)=>s+r.y,0)/fronts.length}:center;
      for(const e of enemies) {const d=ds(anchor,e);if(d<best){best=d;target=e;}}
      if(target) aim={x:target.x-this.sign*5500,y:target.y};
      else {
        const mem=Object.values(this.seen).filter(e=>obs.tick-e.tick<500).sort((a,b)=>b.tick-a.tick)[0];
        if(mem) aim={x:mem.x-this.sign*4500,y:mem.y};
        else if(obs.tick>70*10) aim=this.world({x:Math.min(148000,68000+(obs.tick-70*10)*65),y:50000});
      }
    }
    if(this.data.mode==='capture') {
      let available=obs.fieldCost;
      const reserves=obs.regiments.filter(r=>r.reserve&&r.enterIn<0);
      const used=new Set();
      for(const r of field) {
        if(r.dashing||r.engaged||obs.tick-(this.melee[r.id]||-1000)<35||r.men/r.men0>0.48) continue;
        let station=ds(r,this.data.map.spawns[obs.me])<=7900;
        for(const s of this.data.map.supplies) if(obs.flags.some(f=>f.id===s.flag&&f.owner===obs.me)&&ds(r,s)<=5900) station=true;
        if(!station) continue;
        const replacement=reserves.find(q=>!used.has(q.id)&&q.men/q.men0>0.85&&available-this.def[r.kind].cost+this.def[q.kind].cost<=obs.fieldCap);
        if(replacement) {this.roles[replacement.id]={...this.roles[r.id]};push({type:'swap',id:r.id,with:replacement.id,intent:'前線換兵'},100);used.add(replacement.id);used.add(r.id);available+=this.def[replacement.kind].cost-this.def[r.kind].cost;}
      }
      const healthy=reserves.some(q=>q.men/q.men0>=0.5);
      const keep=!healthy?reserves.slice().sort((a,b)=>a.men/a.men0-b.men/b.men0)[0]:null;
      for(const r of reserves) {
        if(used.has(r.id)||(r.men/r.men0<0.5&&(healthy||(keep&&keep.id===r.id)))) continue;
        const c=this.def[r.kind].cost;
        if(available+c>obs.fieldCap) continue;
        push({type:'summon',id:r.id,intent:'補充戰線'},92);available+=c;used.add(r.id);
      }
    }
    for(const r of field) {
      const role=this.roles[r.id]||{flank:1,index:0};
      const nearest=enemies.slice().sort((a,b)=>(ds(r,a)-a.radius*0.5)-(ds(r,b)-b.radius*0.5))[0];
      const nd=nearest?ds(r,nearest):Infinity;
      const isBow=r.kind==='archer';
      let goal=aim;
      if(this.data.mode==='capture') {
        let flag=obs.flags.find(f=>f.id===role.flank)||obs.flags[1];
        if(r.kind==='lightCav'||r.kind==='light') {
          const own=obs.flags.filter(f=>f.owner===obs.me);
          if(flag.owner===obs.me&&!flag.contested&&flag.capturer!==1-obs.me) {
            const choices=obs.flags.filter(f=>f.owner!==obs.me||f.contested).sort((a,b)=>ds(r,a)/(a.points||1)-ds(r,b)/(b.points||1));
            if(choices.length) flag=choices[0];
          }
        }
        const lateral=((role.index%3)-1)*this.data.knobs.cohesion*700;
        goal={x:flag.x-this.sign*(isBow?9500:role.flank===1?1500:0),y:flag.y+(isBow?lateral:lateral*0.65)};
        if(!isBow){const a=(role.index%8)*45+(obs.me===0?0:180);goal=this.offset(flag.x,flag.y,a,this.data.knobs.cohesion*900);}
      } else {
        const row=(role.index-(isBow?(bows.length-1)/2:(fronts.length-1)/2))*this.data.knobs.cohesion*1000;
        goal={x:aim.x-this.sign*(isBow?6500:0),y:aim.y+clamp(row,-14000,14000)};
        if(r.kind==='light') goal={x:aim.x+this.sign*2000,y:aim.y+(role.flank===0?-14000:14000)};
      }
      if(r.dashing) {
        if(nearest&&nd<15000&&diff(r.facing,this.angle(r,nearest))<55) push({type:'steer',id:r.id,facing:this.angle(r,nearest),intent:'修正衝刺'},55);
        continue;
      }
      if(!mobile(r)) continue;
      if(this.data.mode==='capture'){
        if(!this.recovering)this.recovering={};
        const stations=this.data.map.supplies.filter(s=>obs.flags.some(f=>f.id===s.flag&&f.owner===obs.me));
        const station=stations.slice().sort((a,b)=>ds(r,a)-ds(r,b))[0];
        if(station&&r.men/r.men0<0.45&&ds(r,station)<25000&&obs.regiments.some(q=>q.reserve&&q.enterIn<0&&q.men/q.men0>0.85))this.recovering[r.id]=station.id;
        if(!obs.regiments.some(q=>q.reserve&&q.enterIn<0&&q.men/q.men0>0.85))delete this.recovering[r.id];
        const s=stations.find(s=>s.id===this.recovering[r.id]);
        if(s){this.issue(r,{type:'move',id:r.id,x:s.x,y:s.y,intent:'退至補給站輪換'},obs.tick,push,88);continue;}
      }
      const charging=enemies.find(e=>e.kind==='heavyCav'&&e.dashing&&ds(r,e)<24000&&diff(e.facing,this.angle(e,r))<24);
      if(charging&&!r.dashing){const ad=((this.angle(charging,r)-charging.facing+540)%360)-180;const a=charging.facing+(ad>=0?90:-90);let q=this.offset(r.x,r.y,a,this.data.knobs.dodge);if(!this.pass(q.x,q.y))q=this.offset(r.x,r.y,a+180,this.data.knobs.dodge);this.issue(r,{type:'move',id:r.id,...this.safePoint(q),intent:'避開重騎衝鋒'},obs.tick,push,99);continue;}
      if(isBow) {
        const threats=enemies.filter(e=>e.kind!=='archer'&&ds(r,e)<8*1000+e.radius*0.45);
        if(threats.length) {
          const threat=threats.sort((a,b)=>ds(r,a)-ds(r,b))[0];
          let bestPoint=null,bestScore=-Infinity;
          for(let i=0;i<12;i++) {
            const p=this.offset(r.x,r.y,i*30,4500);
            if(!this.pass(p.x,p.y)||p.x<2500||p.x>this.W-2500||p.y<2500||p.y>this.H-2500) continue;
            let score=0;
            for(const e of threats) score+=Math.min(16000,ds(p,e))*(e.kind==='heavyCav'||e.kind==='lightCav'?1.4:1);
            score-=ds(p,goal)*0.18;
            if(this.h.terrainAt(p.x,p.y)===2) score+=1500;
            score+=this.h.heightAt(p.x,p.y)*350;
            if(score>bestScore){bestScore=score;bestPoint=p;}
          }
          if(bestPoint) {this.issue(r,{type:'move',id:r.id,x:bestPoint.x,y:bestPoint.y,intent:'避敵保弓'},obs.tick,push,95);continue;}
        }
        let target=null,ts=-Infinity;
        for(const e of enemies) {
          const d=ds(r,e),range=16000+1000*clamp(r.height-e.height,-3,3);
          if(d-e.radius/2>range-500) continue;
          let score=(e.kind==='archer'?5500:e.kind==='light'?3000:e.kind==='shield'?-5000:0)+(e.engaged?2000:0)-d*0.3+(1-e.men/e.men0)*2500;
          if(e.status==='braced') score-=3000;
          if(score>ts){ts=score;target=e;}
        }
        if(target) {
          if(r.order!=='attack'||r.target!==target.id) this.issue(r,{type:'attack',id:r.id,target:target.id,intent:'集火射擊'},obs.tick,push,65);
          continue;
        }
        this.issue(r,{type:'attackMove',id:r.id,...this.safePoint(goal),intent:'弓兵就位'},obs.tick,push,35);
        continue;
      }
      if(this.data.mode==='capture'&&r.kind==='light'&&r.skillCooldown===0&&!nearest&&ds(r,goal)>15000){
        const a=this.angle(r,goal);let clear=true;
        for(let t=1000;t<=10000;t+=1000){const p=this.offset(r.x,r.y,a,t);if(!this.pass(p.x,p.y))clear=false;}
        if(clear){push({type:'infiltrate',id:r.id,facing:a,intent:'急行搶旗'},80);continue;}
      }
      if(this.data.mode==='capture'&&role.flank!==undefined){
        const f=obs.flags.slice().sort((a,b)=>ds(a,goal)-ds(b,goal))[0];
        if(f&&f.owner!==obs.me&&ds(r,f)>6500&&(!nearest||ds(r,nearest)>7500)){
          this.issue(r,{type:'move',id:r.id,...this.safePoint(goal),intent:'優先入旗圈'},obs.tick,push,70);continue;
        }
      }
      if(r.kind==='spear') {
        const frontEnemy=enemies.filter(e=>e.kind!=='archer'&&ds(r,e)<11000).sort((a,b)=>ds(r,a)-ds(r,b))[0];
        if(r.status==='braced'||r.status==='bracing') {
          if(frontEnemy&&diff(r.facing,this.angle(r,frontEnemy))<65) continue;
          if(frontEnemy||!nearest||nd>18000||nearest.kind==='archer') this.issue(r,{type:'attackMove',id:r.id,...this.safePoint(goal),intent:'重整槍線'},obs.tick,push,60);
          continue;
        }
        if(r.status==='unbracing') continue;
        if(frontEnemy&&ds(r,frontEnemy)<(frontEnemy.dashing?11500:7800)&&diff(r.facing,this.angle(r,frontEnemy))<80) {
          push({type:'brace',id:r.id,facing:this.angle(r,frontEnemy),intent:'架槍拒敵'},90);continue;
        }
      }
      if(r.kind==='shield'&&nd<8000&&nearest&&nearest.kind!=='archer'&&!r.engaged) {push({type:'shield',id:r.id,mode:'wall',intent:'盾牆固守'},80);continue;}
      if(nearest) {
        let target=nearest;
        if(r.kind==='light'||r.kind==='lightCav'||r.kind==='heavyCav') {
          const vulnerable=enemies.filter(e=>(e.kind==='archer'||e.kind==='light')&&ds(r,e)<20000).sort((a,b)=>ds(r,a)-ds(r,b))[0];
          if(vulnerable) target=vulnerable;
        }
        const dist=ds(r,target);
        const angle=this.angle(r,target);
        const ranged=target.kind==='archer';
        if(this.data.mode==='capture'&&(target.status==='braced'||target.status==='walled')&&dist<15000&&diff(target.facing,this.angle(target,r))<80){
          const q1=this.offset(target.x,target.y,target.facing+105,target.radius+this.data.knobs.flank-800),q2=this.offset(target.x,target.y,target.facing-105,target.radius+this.data.knobs.flank-800);
          const q=ds(r,q1)<ds(r,q2)?q1:q2;this.issue(r,{type:'move',id:r.id,...this.safePoint(q),intent:'繞開架槍正面'},obs.tick,push,75);continue;
        }

        if(r.skillCooldown===0&&diff(r.facing,angle)<65) {
          let skill=null;
          if(r.kind==='light'&&dist>3000&&dist<12000) skill='infiltrate';
          if(r.kind==='sword'&&dist>2500&&dist<10500) skill='assault';
          if((r.kind==='lightCav'||r.kind==='heavyCav')&&r.terrain!==2&&r.terrain!==4&&dist>5500&&dist<23000&&target.status!=='braced') {
            let clear=true;
            for(let f=0.1;f<1;f+=0.1) {const t=this.h.terrainAt(r.x+(target.x-r.x)*f,r.y+(target.y-r.y)*f);if(t===2||t===4||t===5||t===7||t===8)clear=false;}
            if(clear) skill='charge';
          }
          if(skill){push({type:skill,id:r.id,target:target.id,intent:'突進破陣'},85);continue;}
        }
        const capException=this.data.mode==='capture'&&role.flank!==1&&ds(r,goal)<6500&&dist>9000;
        if(!capException&&(dist<15500||r.engaged||ranged&&dist<22000)) {
          if(r.order!=='attack'||r.target!==target.id) this.issue(r,{type:'attack',id:r.id,target:target.id,intent:'壓制敵軍'},obs.tick,push,50);
          continue;
        }
      }
      if(ds(r,goal)<1500) {
        if(r.order!=='hold'&&r.order!=='idle') this.issue(r,{type:'hold',id:r.id,intent:'守住位置'},obs.tick,push,25);
      } else this.issue(r,{type:'attackMove',id:r.id,...this.safePoint(goal),intent:'推進佈防'},obs.tick,push,30);
    }
    commands.sort((a,b)=>b.p-a.p);
    const out=[],ids=new Set();let n=0;
    for(const {cmd} of commands) {
      if(cmd.type==='plan'){out.push(cmd);continue;}
      if(n>=10||ids.has(cmd.id))continue;
      out.push(cmd);ids.add(cmd.id);n++;
      this.last[cmd.id]={cmd,tick:obs.tick};
    }
    return this.safeOrders(obs,out);
  }
  meleeBattle(obs) {
    const field=obs.regiments.filter(r=>!r.reserve);
    const enemies=obs.enemies;
    if(!this.battleRoles) {
      this.battleRoles={};this.dashTargets={};
      for(let i=0;i<field.length;i++) this.battleRoles[field[i].id]={index:i,wing:-1};
    }
    for(const e of enemies) {
      const old=this.seen[e.id];
      if(old&&obs.tick>old.tick) this.motion[e.id]={x:(e.x-old.x)/(obs.tick-old.tick),y:(e.y-old.y)/(obs.tick-old.tick)};
      this.seen[e.id]={...e,tick:obs.tick};
    }
    for(const e of obs.events) if(e.type==='destroyed')delete this.seen[e.reg];
    const actions=[];
    const push=(cmd,p)=>actions.push({cmd,p});
    const usedTargets={};
    for(const r of field) {
      const role=this.battleRoles[r.id];
      const lp=this.local(r);
      const last=this.last[r.id];
      const near=enemies.slice().sort((a,b)=>ds(r,a)-ds(r,b))[0];
      if(!this.lightReleased&&(obs.tick>700||field.some(q=>q.kind==='sword'&&q.engaged)))this.lightReleased=true;
      if(r.kind==='light'&&!this.lightReleased&&!r.engaged&&!r.dashing){
        const guard=field.filter(q=>q.kind==='sword').sort((a,b)=>ds(r,a)-ds(r,b))[0];
        if(guard&&lp.x-this.local(guard).x>4000&&ds(r,guard)>6000){
          const f=this.offset(guard.x,guard.y,guard.facing,2500),q=this.offset(f.x,f.y,guard.facing+90,(role.index%3-1)*3500);
          this.issue(r,{type:'move',id:r.id,...this.safePoint(q),intent:'與劍士同步進軍'},obs.tick,push,84);continue;
        }
      }
      const charging=enemies.find(e=>{if(!(e.kind==='heavyCav')||!e.dashing)return false;const q=this.offset(e.x,e.y,e.facing,1000),ux=q.x-e.x,uy=q.y-e.y,dx=r.x-e.x,dy=r.y-e.y;const f=(dx*ux+dy*uy)/1000,l=Math.abs(dx*uy-dy*ux)/1000;return f>-r.radius&&f<18000&&l<r.radius+e.radius*0.4+700;});
      if(charging&&!r.dashing){
        const a=charging.facing;
        const sideDiff=((this.angle(charging,r)-a+540)%360)-180;
        const side=sideDiff>=0?90:-90;
        let p=this.offset(r.x,r.y,a+side,this.data.knobs.dodge);
        if(!this.pass(p.x,p.y))p=this.offset(r.x,r.y,a-side,this.data.knobs.dodge);
        this.issue(r,{type:'move',id:r.id,...this.safePoint(p),intent:'閃避重騎衝鋒'},obs.tick,push,99);continue;
      }
      if(r.dashing) {
        const t=enemies.find(e=>e.id===this.dashTargets[r.id])||near;
        if(t&&diff(r.facing,this.angle(r,t))<50)push({type:'steer',id:r.id,facing:this.angle(r,t),intent:'追蹤突進'},80);
        continue;
      }
      let target=null,best=-Infinity;
      for(const e of enemies) {
        const d=ds(r,e);
        const isRanged=e.kind==='archer';
        let score=-d+(isRanged?14000:e.kind==='light'?3500:0)-(usedTargets[e.id]||0)*650;
        if(e.status==='braced'&&diff(e.facing,this.angle(e,r))<65)score-=10000;
        if(r.kind==='spear'&&(e.kind==='heavyCav'||e.kind==='lightCav'))score+=12000;
        if(d<7000)score+=7000;
        if(score>best){best=score;target=e;}
      }
      if(r.kind==='sword'){
        const close=enemies.filter(e=>e.kind!=='archer'&&ds(r,e)<r.radius+e.radius+2500).sort((a,b)=>ds(r,a)-ds(r,b))[0];
        if(close&&(r.engaged||ds(r,close)<7500))target=close;
      }
      if(target)usedTargets[target.id]=(usedTargets[target.id]||0)+1;
      if(r.status==='braced'||r.status==='bracing') {
        if(near&&near.kind!=='archer'&&ds(r,near)<12500&&diff(r.facing,this.angle(r,near))<70)continue;
        if(target)this.issue(r,{type:'move',id:r.id,x:target.x,y:target.y,intent:'收槍追擊'},obs.tick,push,65);
        continue;
      }
      if(r.status==='unbracing')continue;
      const cav=enemies.filter(e=>(e.kind==='heavyCav'||e.kind==='lightCav')&&ds(r,e)<14500).sort((a,b)=>ds(r,a)-ds(r,b))[0];
      if(r.kind==='spear'&&cav&&diff(r.facing,this.angle(r,cav))<85) {
        push({type:'brace',id:r.id,facing:this.angle(r,cav),intent:'拒止騎兵'},95);continue;
      }
      const targetDist=target?ds(r,target):Infinity;
      if(target&&(targetDist<17500||r.engaged||lp.x>88000)) {
        // 對架槍或盾牆走向側面，避免所有團擠在敵軍正前方。
        const front=(target.status==='braced'||target.status==='walled')&&diff(target.facing,this.angle(target,r))<85;
        if(front&&targetDist<16000) {
          const side=this.offset(target.x,target.y,target.facing+role.wing*100,this.data.knobs.flank+3000);
          if(ds(r,side)>3500) {
            this.issue(r,{type:'move',id:r.id,...this.safePoint(side),intent:'迂迴側翼'},obs.tick,push,62);continue;
          }
        }
        const blockers=enemies.filter(e=>e.id!==target.id&&(e.status==='braced'||e.status==='walled')&&ds(r,e)<targetDist&&diff(e.facing,this.angle(e,r))<80);
        let blocking=null;
        for(const e of blockers){const dx=target.x-r.x,dy=target.y-r.y,len=dx*dx+dy*dy;const t=((e.x-r.x)*dx+(e.y-r.y)*dy)/len;if(t<=0||t>=1)continue;const cross=Math.hypot(e.x-r.x-t*dx,e.y-r.y-t*dy);if(cross<e.radius+1800){blocking=e;break;}}
        if(blocking){const side=this.offset(blocking.x,blocking.y,blocking.facing+role.wing*105,blocking.radius+this.data.knobs.flank);this.issue(r,{type:'move',id:r.id,...this.safePoint(side),intent:'避開正面槍盾'},obs.tick,push,72);continue;}
        if((target.kind==='spear'||target.kind==='shield'||target.kind==='heavyCav'||target.status==='braced')&&targetDist<9500&&r.engaged){const q=this.offset(target.x,target.y,this.angle(target,r)+(role.index%2===0?75:-75),5000);this.issue(r,{type:'move',id:r.id,...this.safePoint(q),intent:'環繞側擊'},obs.tick,push,68);continue;}
        const ang=this.angle(r,target);
        if(r.skillCooldown===0&&diff(r.facing,ang)<90) {
          let skill=null;
          if(r.kind==='light'&&targetDist<11500&&targetDist>3200)skill='infiltrate';
          if(r.kind==='sword'&&targetDist<10500&&targetDist>2500)skill='assault';
          if((r.kind==='heavyCav'||r.kind==='lightCav')&&r.terrain!==2&&r.terrain!==4&&targetDist<23000&&targetDist>5500&&target.status!=='braced') {
            let clear=true;
            for(let t=0.1;t<1;t+=0.1){const q=this.h.terrainAt(r.x+(target.x-r.x)*t,r.y+(target.y-r.y)*t);if(q===2||q===4||q===5||q===7||q===8)clear=false;}
            if(clear)skill='charge';
          }
          if(skill){push({type:skill,id:r.id,target:target.id,intent:'突擊要害'},90);continue;}
        }
        if(r.order!=='attack'||r.target!==target.id)this.issue(r,{type:'attack',id:r.id,target:target.id,intent:'集中破陣'},obs.tick,push,55);
        continue;
      }
      const upper=role.wing===-1;
      let goal;
      if(!role.crossed && lp.x<(upper?90000:81000)) {
        const x=upper?92000:83000,y=upper?21500:78500;
        goal=this.world({x,y:y+(role.index%3-1)*600});
      } else {
        role.crossed=true;
        const memories=Object.values(this.seen).filter(e=>obs.tick-e.tick<700).sort((a,b)=>((a.kind==='archer'?-16000:0)+ds(r,a))-((b.kind==='archer'?-16000:0)+ds(r,b)));
        if(memories.length)goal=memories[0];
        else if(obs.tick>1000&&this.scoutPoints.length)goal=this.scoutPoints[(role.index+Math.floor((obs.tick-1000)/300)*3)%this.scoutPoints.length];
        else goal=this.world({x:125000,y:50000+(role.index%5-2)*7000});
      }
      this.issue(r,{type:'move',id:r.id,...this.safePoint(goal),intent:'兩翼渡河'},obs.tick,push,35);
    }
    actions.sort((a,b)=>b.p-a.p);
    const out=[],used=new Set();
    for(const {cmd} of actions){if(out.length>=10||used.has(cmd.id))continue;out.push(cmd);used.add(cmd.id);this.last[cmd.id]={cmd,tick:obs.tick};if(cmd.type==='assault'||cmd.type==='infiltrate'||cmd.type==='charge')this.dashTargets[cmd.id]=cmd.target;}
    if(obs.tick===0)out.unshift({type:'plan',text:'步兵同步繞側，避開衝鋒並搜索殘敵'});
    return out;
  }

  safeOrders(obs,orders){
    const enemies=new Map(obs.enemies.map(e=>[e.id,e]));
    for(const c of orders){
      const e=enemies.get(c.target);
      if(!e)continue;
      if(c.type==='infiltrate'||c.type==='assault'||c.type==='charge'){c.x=e.x;c.y=e.y;}
      if(c.type!=='attack'||e.engaged||e.dashing)continue;
      let risky=ds(e,this.data.map.spawns[1-obs.me])<=8100;
      for(const s of this.data.map.supplies)if(obs.flags.some(f=>f.id===s.flag&&f.owner===1-obs.me)&&ds(e,s)<=6100)risky=true;
      if(risky){c.type='attackMove';c.x=e.x;c.y=e.y;delete c.target;c.intent='壓制輪換位置';}
    }
    return orders;
  }

  issue(r,cmd,tick,push,priority) {
    const prev=this.last[r.id];
    if(prev&&prev.cmd.type===cmd.type&&tick-prev.tick<40) {
      if(cmd.type==='attack'&&cmd.target===prev.cmd.target&&r.order==='attack') return;
      if((cmd.type==='attackMove'||cmd.type==='move')&&r.order===cmd.type&&Math.hypot(cmd.x-prev.cmd.x,cmd.y-prev.cmd.y)<1700)return;
      if(cmd.type==='hold'&&(r.order==='hold'||r.order==='idle'))return;
    }
    push(cmd,priority+(prev?Math.min(10,(tick-prev.tick)/20):10));
  }
}


