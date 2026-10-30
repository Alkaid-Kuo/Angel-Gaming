// 兩模式來源與雜湊見combined-v1.114.json。
const AnnComponent=(()=>{
// 兩模式來源與雜湊見combined-v1.103.json。
const AnnComponent=(()=>{
const PRESET={"version":"v1.103-ann","field":[["shield",2],["spear",1],["archer",8]],"reserve":[],"spearWidth":15,"braceDistance":22000,"wallDistance":10000,"bank":true,"bankThreshold":60,"bankAbortLoss":20};
return class TacticalBot {
 constructor(){this.data=null;this.h=null;this.cost={};this.last={};this.memory={};this.index={};this.goals={};this.engagedAt={};this.cavalry={};this.previousDash={};this.enemyLoss=0;this.bankLead=false;this.initialFieldValue=0;this.bankPeak=0;this.bankAborted=false;}
 declare(){return{name:'Legion Research',version:PRESET.version,style:'七兵種協同與目標機動',knobs:[{key:'chase',name:'接戰距離',description:'佔點接敵範圍',min:10,max:20,default:16,integer:true},{key:'rush',name:'機動技能',description:'允許步兵切入與騎兵衝鋒',min:0,max:1,default:1,integer:true},{key:'kite',name:'弓兵退距',description:'弓兵面對近戰的退距',min:4,max:10,default:6,integer:true}]};}
 init(data,h){this.data=data;this.h=h;for(const u of data.units)this.cost[u.kind]=u.cost;}
 deploy(data,h){
  const capture=data.mode==='capture',field=capture&&PRESET.captureField?PRESET.captureField:PRESET.field,reserve=capture&&PRESET.captureReserve?PRESET.captureReserve:PRESET.reserve||[],W=data.map.width*1000,H=data.map.height*1000,side=data.playerId===0?1:-1,out=[],placed=[];
  this.initialFieldValue=field.reduce((sum,p)=>sum+p[1]*this.cost[p[0]],0);
  const radius=(kind,width)=>{const def=data.units.find(x=>x.kind===kind);if(kind==='lightCav'||kind==='heavyCav')return 4800;const rows=Math.max(2,Math.ceil(def.men/width));return Math.hypot(width*def.spacingX,rows*def.spacingY)/2;};
  const widthFor=k=>k==='spear'?(PRESET.spearWidth||15):k==='shield'?15:k==='archer'?6:k==='sword'?12:k==='light'?4:6;
  const all=[];for(const pair of field)for(let i=0;i<pair[1];i++)all.push(pair[0]);
  const laneCount=[0,0,0];
  for(let i=0;i<all.length;i++){
   const kind=all[i],width=widthFor(kind),rad=radius(kind,width),lane=i%3,rank=laneCount[lane]++;
   let want;
   if(capture)want={x:kind==='archer'?6000:17000,y:[27500,75000,122500][lane]+(rank%3-1)*6500};
   else{const same=all.filter(x=>x===kind).length,prior=all.slice(0,i).filter(x=>x===kind).length;const gap=Math.min(11000,Math.max(6500,(H-18000)/Math.max(1,same)));want={x:kind==='archer'?8000:17000,y:H/2+(prior-(same-1)/2)*gap};if(kind==='lightCav'||kind==='heavyCav')want.y=H/2+(prior%2===0?-1:1)*(20000+Math.floor(prior/2)*8500);}
   const candidates=[want];for(const x of [17500,11000,4500])for(let y=6500;y<=H-6500;y+=6500)candidates.push({x,y});
   candidates.sort((a,b)=>Math.abs(a.x-want.x)+Math.abs(a.y-want.y)-Math.abs(b.x-want.x)-Math.abs(b.y-want.y));
   const p=candidates.find(p=>p.x>=2500&&p.x<=18500&&p.y>=6000&&p.y<=H-6000&&placed.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>.55*(rad+q.rad)+300));
   if(!p)throw new Error('本研究編成無合法布陣位置');placed.push({...p,rad});
   out.push({type:kind,x:side===1?p.x:W-p.x,y:side===1?p.y:H-p.y,facing:side===1?0:180,formation:kind==='lightCav'||kind==='heavyCav'?'wedge':'line',width,stance:kind==='shield'?'carry':undefined});
  }
  if(capture)for(const pair of reserve)for(let i=0;i<pair[1];i++)out.push({type:pair[0],reserve:true,formation:pair[0]==='lightCav'||pair[0]==='heavyCav'?'wedge':'line'});
  return out;
 }
 dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
 angle(a,b){return this.h.angleTo(a.x,a.y,b.x,b.y);}
 diff(a,b){return Math.abs(((a-b+540)%360)-180);}
 clamp(p){return{x:Math.max(2500,Math.min(this.data.map.width*1000-2500,p.x)),y:Math.max(3500,Math.min(this.data.map.height*1000-3500,p.y))};}
 clear(a,b,cavalry){const n=Math.max(1,Math.ceil(this.dist(a,b)/900));for(let i=1;i<=n;i++){const t=this.h.terrainAt(a.x+(b.x-a.x)*i/n,a.y+(b.y-a.y)*i/n);if(t===5||t===7||t===8||(cavalry&&(t===2||t===4)))return false;}return true;}
 front(r,e){return this.diff(this.angle(e,r),e.facing)<70;}
 flank(r,e,margin){const a=e.facing*Math.PI/180,normal={x:-Math.sin(a),y:Math.cos(a)},points=[{x:e.x+normal.x*margin,y:e.y+normal.y*margin},{x:e.x-normal.x*margin,y:e.y-normal.y*margin}];points.sort((a,b)=>this.dist(r,a)-this.dist(r,b));return this.clamp(points[0]);}
 finish(obs,choices){choices.sort((a,b)=>b.priority-a.priority||a.r.id-b.r.id);const commands=[],used=new Set();for(const choice of choices){if(commands.length>=10)break;if(used.has(choice.r.id))continue;commands.push(choice.c);used.add(choice.r.id);this.last[choice.r.id]={...choice.c,tick:obs.tick};}
  return commands;}
 decide(obs){
  const own=obs.regiments.filter(r=>!r.reserve),enemies=obs.enemies,cap=this.data.mode==='capture',W=this.data.map.width*1000,H=this.data.map.height*1000,sign=obs.me===0?1:-1,choices=[];
  for(let i=0;i<own.length;i++)if(this.index[own[i].id]===undefined)this.index[own[i].id]=i;
  for(const e of enemies){const old=this.memory[e.id];if(old&&old.men>e.men)this.enemyLoss+=(old.men-e.men)*this.cost[e.kind]/e.men0;this.memory[e.id]={...e,tick:obs.tick,vx:old&&obs.tick>old.tick?(e.x-old.x)/(obs.tick-old.tick):0,vy:old&&obs.tick>old.tick?(e.y-old.y)/(obs.tick-old.tick):0};}
  for(const e of obs.events)if(e.type==='destroyed'&&this.memory[e.reg]){const old=this.memory[e.reg];this.enemyLoss+=old.men*this.cost[old.kind]/old.men0;delete this.memory[e.reg];}
  const bows=own.filter(r=>r.kind==='archer'),shields=own.filter(r=>r.kind==='shield'),spears=own.filter(r=>r.kind==='spear');
  const center={x:own.reduce((s,r)=>s+r.x,0)/Math.max(1,own.length),y:own.reduce((s,r)=>s+r.y,0)/Math.max(1,own.length)};
  let nearest=null;for(const e of enemies)if(!nearest||this.dist(center,e)<this.dist(center,nearest))nearest=e;
  let armyGoal=nearest||{x:sign===1?W*.47:W*.53,y:sign===1?H*.58:H*.42};
  if(!nearest&&obs.tick>500){const mem=Object.values(this.memory).filter(e=>obs.tick-e.tick<500).sort((a,b)=>this.dist(center,a)-this.dist(center,b));armyGoal=mem[0]||{x:sign===1?W-19000:19000,y:H/2};}
  const enqueue=(r,c,priority)=>{const old=this.last[r.id];if(c.type==='attack'&&cap){const e=enemies.find(x=>x.id===c.target);if(!e)return;c={type:'attackMove',x:e.x,y:e.y,intent:'座標集中接敵'};}
   if((c.type==='move'||c.type==='attackMove')&&r.order===c.type&&old&&old.type===c.type&&this.dist(c,old)<1600&&obs.tick-old.tick<35)return;
   if(c.type==='attack'&&r.order==='attack'&&r.target===c.target)return;if(c.type==='hold'&&r.order==='hold')return;
   if(c.x!==undefined){const p=this.clamp(c);c.x=p.x;c.y=p.y;}
   choices.push({r,c:{...c,id:r.id},priority:priority+Math.min(12,(obs.tick-(old?old.tick:0))/25)});
  };
  if(PRESET.bank&&!cap){
   const losses=this.initialFieldValue-own.reduce((sum,r)=>sum+this.cost[r.kind]*r.men/r.men0,0),lead=this.enemyLoss-losses;
   if(!this.bankAborted&&lead>=(PRESET.bankThreshold||60)&&obs.tick>(PRESET.bankMinTick||200)&&Object.values(this.memory).filter(e=>e.kind==='archer').length>=(PRESET.bankArchersRequired||1))this.bankLead=true;if(this.bankLead){this.bankPeak=Math.max(this.bankPeak,lead);if(lead<this.bankPeak-PRESET.bankAbortLoss){this.bankLead=false;this.bankAborted=true;}}if(lead<0)this.bankLead=false;
   if(this.bankLead){const home={x:sign===1?W*.22:W*.78,y:sign===1?H*.385:H*.615};for(let i=0;i<own.length;i++){const r=own[i];if(r.dashing)continue;let threat=null,dist=Infinity;for(const e of enemies){const d=this.dist(r,e);if(d<dist){dist=d;threat=e;}}const target={x:home.x+sign*(i%3-1)*2600,y:home.y+sign*(Math.floor(i/3)-1.5)*3500},hd=this.dist(r,target),angle=threat?this.angle(r,threat):(sign===1?0:180),diff=this.diff(angle,r.facing);
    if(r.kind==='spear'&&threat&&threat.kind!=='archer'&&dist<((threat.kind==='lightCav'||threat.kind==='heavyCav')?24000:8500)){if(r.status==='braced'||r.status==='bracing'){if(diff>85)enqueue(r,{type:'unbrace',intent:'後衛轉向'},100);continue;}if(r.status!=='unbracing')enqueue(r,{type:'brace',facing:angle,intent:'撤退槍林後衛'},100);continue;}
    if(r.kind==='shield'&&threat&&threat.kind!=='archer'&&dist<6500&&hd>6000){if(r.status==='walled'||r.status==='walling')continue;if(diff>10)enqueue(r,{type:'face',facing:angle,intent:'後衛盾兵對向'},100);else enqueue(r,{type:'shield',mode:'wall',intent:'後衛盾牆'},100);continue;}
    if(r.kind==='archer'&&threat&&threat.kind!=='archer'&&dist-threat.radius<6500){const d=Math.max(1,dist);enqueue(r,{type:'move',x:r.x+(r.x-threat.x)/d*5000,y:r.y+(r.y-threat.y)/d*5000,intent:'保存兵力脫離'},110);continue;}
    if(hd>2300){enqueue(r,{type:'move',x:target.x,y:target.y,facing:angle,intent:'領先撤回掩護'},70);continue;}
    const range=threat?16000+1000*Math.max(-3,Math.min(3,r.height-threat.height)):0;if(r.kind==='archer'&&threat&&dist-threat.radius*.5<range-1000){enqueue(r,{type:'attack',target:threat.id,intent:'掩護防守射擊'},80);continue;}enqueue(r,{type:'hold',intent:'保存已得戰果'},30);
   }return this.finish(obs,choices);}
  }
  if(cap){
   let spent=obs.fieldCost;const reserves=obs.regiments.filter(r=>r.reserve&&r.enterIn<0).sort((a,b)=>b.men/b.men0-a.men/a.men0),used=new Set();
   if(PRESET.adaptiveReserve){const enemy={},friendly={};for(const e of enemies)enemy[e.kind]=(enemy[e.kind]||0)+e.men/e.men0;for(const r of own)friendly[r.kind]=(friendly[r.kind]||0)+r.men/r.men0;const enemyCav=(enemy.lightCav||0)+(enemy.heavyCav||0),enemyFoot=(enemy.light||0)+(enemy.sword||0);const value=k=>k==='spear'&&enemyCav>=1.5?100-Math.min(3,friendly.spear||0)*30:k==='lightCav'&&((enemy.archer||0)>=2||(enemy.light||0)>=8)?85-Math.min(3,friendly.lightCav||0)*25:k==='sword'&&enemyFoot>=6?75-Math.min(5,friendly.sword||0)*12:k==='archer'&&((enemy.spear||0)>=3||(enemy.shield||0)>=3)?70-Math.min(4,friendly.archer||0)*15:k==='light'?50:20;reserves.sort((a,b)=>value(b.kind)-value(a.kind)||b.men/b.men0-a.men/a.men0);}
   for(const r of own){if(r.engaged)this.engagedAt[r.id]=obs.tick;const near=this.dist(r,this.data.map.spawns[obs.me])<this.data.capture.spawnRadius-500||this.data.map.supplies.some(p=>obs.flags.some(f=>f.id===p.flag&&f.owner===obs.me)&&this.dist(r,p)<this.data.capture.supplyRadius-500);
    if(PRESET.recycle!==false&&near&&!r.engaged&&!r.dashing&&obs.tick-(this.engagedAt[r.id]||-999)>35&&r.men/r.men0<.4){const fresh=reserves.find(x=>!used.has(x.id)&&x.kind===r.kind&&x.men/x.men0>.85&&spent-this.cost[r.kind]+this.cost[x.kind]<=obs.fieldCap);if(fresh){enqueue(r,{type:'swap',with:fresh.id,intent:'換下殘編'},125);used.add(fresh.id);}}
   }
   let summons=0;for(const r of reserves){if(summons>=2)break;if(used.has(r.id)||r.men/r.men0<.45||spent+this.cost[r.kind]>obs.fieldCap)continue;enqueue(r,{type:'summon',intent:'投入後備'},115);spent+=this.cost[r.kind];summons++;}
  }
  if(cap&&obs.tick%20===0||cap&&Object.keys(this.goals).length===0){
   for(const r of own){const old=obs.flags.find(f=>f.id===this.goals[r.id]);let best=old,bv=Infinity;
    for(const f of obs.flags){const distance=this.dist(r,f),load=own.filter(x=>x.id!==r.id&&this.goals[x.id]===f.id).reduce((s,x)=>s+this.cost[x.kind]*x.men/x.men0,0);const hostile=enemies.filter(e=>this.dist(e,f)<14000).reduce((s,e)=>s+this.cost[e.kind]*e.men/e.men0,0);let value=distance+(f.owner===obs.me&&!f.contested?14000:0)+load*80-f.points*6500+(old&&old.id!==f.id?3500:0);
     if((r.kind==='lightCav'||r.kind==='heavyCav')&&hostile>0)value-=4000;if(r.kind==='shield'||r.kind==='spear')value+=distance*.25;if(value<bv){bv=value;best=f;}}
    if(best)this.goals[r.id]=best.id;
   }
  }
  const targetFor=r=>{let target=null,bv=Infinity;for(const e of enemies){let v=this.dist(r,e);const front=this.front(r,e),brace=e.kind==='spear'&&(e.status==='braced'||e.status==='bracing')&&front,wall=e.kind==='shield'&&(e.status==='walled'||e.status==='walling')&&front;
    if(r.kind==='lightCav'||r.kind==='heavyCav'){v+=e.kind==='archer'?-14000:e.kind==='light'?-10000:0;if(brace)v+=35000;if(wall)v+=5000;}
    else if(r.kind==='sword'||r.kind==='light'){v+=e.kind==='archer'?-8000:e.kind==='shield'?5000:0;if(brace||wall)v+=14000;}
    if(cap){const f=obs.flags.find(f=>f.id===this.goals[r.id]);if(f&&this.dist(e,f)>18000)v+=18000;}
    if(v<bv){bv=v;target=e;}}
   return target;};
  for(const r of own){
   const old=this.last[r.id],index=this.index[r.id],flag=cap?obs.flags.find(f=>f.id===this.goals[r.id]):null;let goal=flag||armyGoal;
   const e=targetFor(r),distance=e?this.dist(r,e):Infinity,angle=e?this.angle(r,e):(sign===1?0:180);
   let danger=null,dd=Infinity;for(const x of enemies)if(x.kind!=='archer'){const d=this.dist(r,x)-x.radius;if(d<dd){dd=d;danger=x;}}
   if(r.engaged)this.engagedAt[r.id]=obs.tick;
   if(r.dashing){this.previousDash[r.id]=true;continue;}
   const cav=r.kind==='lightCav'||r.kind==='heavyCav';
   if(cav){
    if(this.previousDash[r.id]){this.cavalry[r.id]={until:obs.tick+(r.kind==='heavyCav'?110:90)};this.previousDash[r.id]=false;}
    const recovering=this.cavalry[r.id]&&obs.tick<this.cavalry[r.id].until;
    if((recovering||r.men/r.men0<.4)&&danger&&dd<13000){const d=Math.max(1,this.dist(r,danger));const p=this.clamp({x:r.x+(r.x-danger.x)/d*18000,y:r.y+(r.y-danger.y)/d*18000});enqueue(r,{type:'move',...p,intent:'騎兵脫離重整'},105);continue;}
    if(e){
     const braced=e.kind==='spear'&&(e.status==='braced'||e.status==='bracing')&&this.front(r,e);
     if(braced&&distance<33000){enqueue(r,{type:'move',...this.flank(r,e,19000),intent:'騎兵繞槍側擊'},90);continue;}
     const mem=this.memory[e.id],lead=mem?Math.min(30,distance/630):0;const predicted=this.clamp({x:e.x+(mem?mem.vx:0)*lead,y:e.y+(mem?mem.vy:0)*lead});
     if(this.data.knobs.rush&&r.skillCooldown===0&&r.terrain!==2&&r.terrain!==4&&r.formation!=='circle'&&distance>7500&&distance<(r.kind==='heavyCav'?28000:23000)&&!recovering&&this.clear(r,predicted,true)){enqueue(r,{type:'charge',x:predicted.x,y:predicted.y,intent:'騎兵側向衝鋒'},95);continue;}
     if(r.skillCooldown>0&&distance<7000&&e.kind==='spear'){enqueue(r,{type:'move',...this.flank(r,e,14000),intent:'騎兵拉開再衝'},80);continue;}
     if(r.terrain===2||r.terrain===4){let point=null,best=Infinity;for(const radius of [6500,11000,16000])for(let a=0;a<360;a+=45){const q=this.clamp({x:r.x+Math.cos(a*Math.PI/180)*radius,y:r.y+Math.sin(a*Math.PI/180)*radius}),t=this.h.terrainAt(q.x,q.y);if(t===2||t===4||t===5||t===7||t===8)continue;const value=Math.abs(this.dist(q,e)-18000)+this.dist(r,q)*.3;if(value<best){best=value;point=q;}}if(point){enqueue(r,{type:'move',...point,intent:'離開阻衝地形'},85);continue;}}
     if(distance<16000){enqueue(r,{type:'attack',target:e.id,intent:'騎兵追截'},60);continue;}
    }
   }
   if(r.kind==='shield'){
    const diff=e?this.diff(angle,r.facing):0;
    if(r.status==='walled'||r.status==='walling'){if(!e||distance>16000||diff>65)enqueue(r,{type:'shield',mode:'unwall',intent:'盾兵轉場'},100);continue;}
    if(e&&distance<(PRESET.wallDistance||10000)){if(diff>9)enqueue(r,{type:'face',facing:angle,intent:'盾面朝敵'},92);else enqueue(r,{type:'shield',mode:'wall',intent:'盾牆攔截'},93);continue;}
    if(e&&distance<22000&&r.stance!=='raise'){enqueue(r,{type:'shield',mode:'raise',intent:'舉盾掩護'},80);continue;}
    if((!e||distance>23000)&&r.stance!=='carry'){enqueue(r,{type:'shield',mode:'carry',intent:'持盾轉場'},70);continue;}
    let dest=goal;
    if(bows.length&&!cap){const group=bows.filter((x,i)=>i%Math.max(1,shields.length)===shields.indexOf(r)),g=group.length?{x:group.reduce((s,x)=>s+x.x,0)/group.length,y:group.reduce((s,x)=>s+x.y,0)/group.length}:center;const d=Math.max(1,this.dist(g,goal));dest={x:g.x+(goal.x-g.x)/d*5500,y:g.y+(goal.y-g.y)/d*5500};}
    enqueue(r,{type:'move',...dest,facing:angle,intent:'盾兵掩護推進'},45);continue;
   }
   if(r.kind==='archer'){
    if(danger&&dd<this.data.knobs.kite*1000){const d=Math.max(1,this.dist(r,danger));enqueue(r,{type:'move',x:r.x+(r.x-danger.x)/d*5500,y:r.y+(r.y-danger.y)/d*5500,intent:'射手脫離貼身'},110);continue;}
    if(r.status==='volleying')continue;
    let best=null,bv=Infinity;for(const x of enemies){const effective=this.dist(r,x)-x.radius*.5,range=16000+1000*Math.max(-3,Math.min(3,r.height-x.height));if(effective>range-1000)continue;const value=effective/1000+(x.kind==='shield'?24:x.kind==='archer'?-12:x.kind==='spear'?3:0)+x.men/x.men0*3;if(value<bv){bv=value;best=x;}}
    if(best){const density=enemies.filter(x=>this.dist(x,best)<4500).reduce((s,x)=>s+x.men,0),range=16000+1000*Math.max(-3,Math.min(3,r.height-best.height));if(r.skillCooldown===0&&density>=28&&this.dist(r,best)<range-1000){enqueue(r,{type:'volley',x:best.x,y:best.y,intent:'密集區齊射'},70);continue;}enqueue(r,{type:'attack',target:best.id,intent:'射手集火'},65);continue;}
    let anchor=null;for(const x of shields)if(!anchor||this.dist(r,x)<this.dist(r,anchor))anchor=x;
    if(anchor&&this.dist(r,anchor)<18000){const a=anchor.facing*Math.PI/180,offset=(index%2===0?-1:1)*2200;const p={x:anchor.x-Math.cos(a)*3200-Math.sin(a)*offset,y:anchor.y-Math.sin(a)*3200+Math.cos(a)*offset};if(this.dist(r,p)>2200)enqueue(r,{type:'attackMove',...p,intent:'射手保持掩護'},35);else enqueue(r,{type:'hold',intent:'射手待射'},20);continue;}
    if(e){const d=Math.max(1,distance),stand=12000;enqueue(r,{type:'attackMove',x:e.x+(r.x-e.x)/d*stand,y:e.y+(r.y-e.y)/d*stand,intent:'射手進入射程'},40);continue;}
   }
   if(r.kind==='spear'){
    let threat=e,dist=distance;for(const x of enemies)if((x.kind==='lightCav'||x.kind==='heavyCav')&&this.dist(r,x)<30000){if(!threat||!(threat.kind==='lightCav'||threat.kind==='heavyCav')||this.dist(r,x)<dist){threat=x;dist=this.dist(r,x);}}
    const cavalry=threat&&(threat.kind==='lightCav'||threat.kind==='heavyCav'),foot=threat&&(threat.kind==='sword'||threat.kind==='light'),diff=threat?this.diff(this.angle(r,threat),r.facing):0;
    const brace=cavalry?(threat.dashing?29000:24000):foot?(PRESET.braceDistance||22000):12000;
    if(r.status==='braced'||r.status==='bracing'){if(!threat||dist>brace+6000||threat.kind==='archer'||diff>75)enqueue(r,{type:'unbrace',intent:'槍兵重新定位'},100);continue;}if(r.status==='unbracing')continue;
    if(threat&&threat.kind!=='archer'&&dist<brace&&diff<85){enqueue(r,{type:'brace',facing:this.angle(r,threat),intent:'提前架槍迎擊'},100);continue;}
    if(threat){enqueue(r,{type:'attack',target:threat.id,intent:'槍兵接戰'},55);continue;}
   }
   if((r.kind==='sword'||r.kind==='light')&&e){
    const frontal=this.front(r,e)&&((e.kind==='spear'&&(e.status==='braced'||e.status==='bracing'))||(e.kind==='shield'&&(e.status==='walled'||e.status==='walling')));
    if(frontal&&distance<24000){enqueue(r,{type:'move',...this.flank(r,e,13000),intent:'步兵側包'},85);continue;}
    const withinFlag=flag&&this.dist(e,flag)<17000,shouldFight=!cap||withinFlag||e.kind==='archer'&&distance<13000;
    if(shouldFight&&distance<(cap?this.data.knobs.chase*1000:23000)){
     const skill=r.kind==='sword'?'assault':'infiltrate',limit=r.kind==='sword'?7500:9500;
     if(this.data.knobs.rush&&r.skillCooldown===0&&!r.engaged&&distance>3500&&distance<limit&&this.clear(r,e,false)){enqueue(r,{type:skill,x:e.x,y:e.y,intent:'步兵切入側翼'},80);continue;}
     enqueue(r,{type:'attack',target:e.id,intent:'步兵集中接敵'},55);continue;
    }
   }
   const toGoal=this.dist(r,goal);
   if(cap&&flag&&toGoal<2500){if(e&&this.dist(e,flag)<14000)enqueue(r,{type:'attack',target:e.id,intent:'清除圈內敵軍'},60);else enqueue(r,{type:'hold',intent:'守住旗圈'},25);continue;}
   if(!cav&&(r.kind==='light'||r.kind==='sword')&&this.data.knobs.rush&&r.skillCooldown===0&&toGoal>14000&&(!danger||dd>15000)){const p={x:r.x+(goal.x-r.x)/toGoal*(r.kind==='light'?9500:7500),y:r.y+(goal.y-r.y)/toGoal*(r.kind==='light'?9500:7500)};if(this.clear(r,p,false)){enqueue(r,{type:r.kind==='light'?'infiltrate':'assault',...p,intent:'步兵快速轉場'},50);continue;}}
   enqueue(r,{type:'attackMove',x:goal.x,y:goal.y,intent:'前往戰術目標'},30);
  }
  return this.finish(obs,choices);
 }
}

})();
const CapComponent=(()=>{
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

return class BaselineBot extends MobileCore {
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

})();
return class BaselineHybrid {constructor(){this.impl=null;}declare(){const d=new AnnComponent().declare();d.name="Legion Baseline";d.version="v1.103";d.style="雙模式分工與成熟兵種協同";return d;}init(data,h){this.impl=data.mode==="capture"?new CapComponent():new AnnComponent();this.impl.init(data,h);}deploy(data,h){return this.impl.deploy(data,h);}decide(obs){return this.impl.decide(obs);}}

})();
const CapComponent=(()=>{
const PRESET={"field":[["shield",2],["spear",1],["archer",8]],"reserve":[],"spearWidth":15,"braceDistance":22000,"wallDistance":10000,"bank":true,"bankThreshold":60,"adaptiveReserve":false,"version":"v1.100","captureField":[["sword",3],["light",14],["archer",2]],"captureReserve":[["sword",6],["light",28],["archer",4]],"macro":"stable"};
return class TacticalBot {
 constructor(){this.data=null;this.h=null;this.cost={};this.last={};this.memory={};this.index={};this.goals={};this.engagedAt={};this.cavalry={};this.previousDash={};this.enemyLoss=0;this.bankLead=false;this.initialFieldValue=0;}
 declare(){return{name:'Legion Research',version:PRESET.version,style:'七兵種協同與目標機動',knobs:[{key:'chase',name:'接戰距離',description:'佔點接敵範圍',min:10,max:20,default:16,integer:true},{key:'rush',name:'機動技能',description:'允許步兵切入與騎兵衝鋒',min:0,max:1,default:1,integer:true},{key:'kite',name:'弓兵退距',description:'弓兵面對近戰的退距',min:4,max:10,default:6,integer:true}]};}
 init(data,h){this.data=data;this.h=h;for(const u of data.units)this.cost[u.kind]=u.cost;}
 deploy(data,h){
  const capture=data.mode==='capture',field=capture&&PRESET.captureField?PRESET.captureField:PRESET.field,reserve=capture&&PRESET.captureReserve?PRESET.captureReserve:PRESET.reserve||[],W=data.map.width*1000,H=data.map.height*1000,side=data.playerId===0?1:-1,out=[],placed=[];
  this.initialFieldValue=field.reduce((sum,p)=>sum+p[1]*this.cost[p[0]],0);
  const radius=(kind,width)=>{const def=data.units.find(x=>x.kind===kind);if(kind==='lightCav'||kind==='heavyCav')return 4800;const rows=Math.max(2,Math.ceil(def.men/width));return Math.hypot(width*def.spacingX,rows*def.spacingY)/2;};
  const widthFor=k=>k==='spear'?(PRESET.spearWidth||15):k==='shield'?15:k==='archer'?6:k==='sword'?12:k==='light'?4:6;
  const all=[];for(const pair of field)for(let i=0;i<pair[1];i++)all.push(pair[0]);
  const laneCount=[0,0,0];
  for(let i=0;i<all.length;i++){
   const kind=all[i],width=widthFor(kind),rad=radius(kind,width),lane=i%3,rank=laneCount[lane]++;
   let want;
   if(capture)want={x:kind==='archer'?6000:17000,y:[27500,75000,122500][lane]+(rank%3-1)*6500};
   else{const same=all.filter(x=>x===kind).length,prior=all.slice(0,i).filter(x=>x===kind).length;const gap=Math.min(11000,Math.max(6500,(H-18000)/Math.max(1,same)));want={x:kind==='archer'?8000:17000,y:H/2+(prior-(same-1)/2)*gap};if(kind==='lightCav'||kind==='heavyCav')want.y=H/2+(prior%2===0?-1:1)*(20000+Math.floor(prior/2)*8500);}
   const candidates=[want];for(const x of [17500,11000,4500])for(let y=6500;y<=H-6500;y+=6500)candidates.push({x,y});
   candidates.sort((a,b)=>Math.abs(a.x-want.x)+Math.abs(a.y-want.y)-Math.abs(b.x-want.x)-Math.abs(b.y-want.y));
   const p=candidates.find(p=>p.x>=2500&&p.x<=18500&&p.y>=6000&&p.y<=H-6000&&placed.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>.55*(rad+q.rad)+300));
   if(!p)throw new Error('本研究編成無合法布陣位置');placed.push({...p,rad});
   out.push({type:kind,x:side===1?p.x:W-p.x,y:side===1?p.y:H-p.y,facing:side===1?0:180,formation:kind==='lightCav'||kind==='heavyCav'?'wedge':'line',width,stance:kind==='shield'?'carry':undefined});
  }
  if(capture)for(const pair of reserve)for(let i=0;i<pair[1];i++)out.push({type:pair[0],reserve:true,formation:pair[0]==='lightCav'||pair[0]==='heavyCav'?'wedge':'line'});
  return out;
 }
 dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
 angle(a,b){return this.h.angleTo(a.x,a.y,b.x,b.y);}
 diff(a,b){return Math.abs(((a-b+540)%360)-180);}
 clamp(p){return{x:Math.max(2500,Math.min(this.data.map.width*1000-2500,p.x)),y:Math.max(3500,Math.min(this.data.map.height*1000-3500,p.y))};}
 clear(a,b,cavalry){const n=Math.max(1,Math.ceil(this.dist(a,b)/900));for(let i=1;i<=n;i++){const t=this.h.terrainAt(a.x+(b.x-a.x)*i/n,a.y+(b.y-a.y)*i/n);if(t===5||t===7||t===8||(cavalry&&(t===2||t===4)))return false;}return true;}
 front(r,e){return this.diff(this.angle(e,r),e.facing)<70;}
 flank(r,e,margin){const a=e.facing*Math.PI/180,normal={x:-Math.sin(a),y:Math.cos(a)},points=[{x:e.x+normal.x*margin,y:e.y+normal.y*margin},{x:e.x-normal.x*margin,y:e.y-normal.y*margin}];points.sort((a,b)=>this.dist(r,a)-this.dist(r,b));return this.clamp(points[0]);}
 finish(obs,choices){choices.sort((a,b)=>b.priority-a.priority||a.r.id-b.r.id);const commands=[],used=new Set();for(const choice of choices){if(commands.length>=10)break;if(used.has(choice.r.id))continue;commands.push(choice.c);used.add(choice.r.id);this.last[choice.r.id]={...choice.c,tick:obs.tick};}
  return commands;}
 decide(obs){
  const own=obs.regiments.filter(r=>!r.reserve),enemies=obs.enemies,cap=this.data.mode==='capture',W=this.data.map.width*1000,H=this.data.map.height*1000,sign=obs.me===0?1:-1,choices=[];
  for(let i=0;i<own.length;i++)if(this.index[own[i].id]===undefined)this.index[own[i].id]=i;
  for(const e of enemies){const old=this.memory[e.id];if(old&&old.men>e.men)this.enemyLoss+=(old.men-e.men)*this.cost[e.kind]/e.men0;this.memory[e.id]={...e,tick:obs.tick,vx:old&&obs.tick>old.tick?(e.x-old.x)/(obs.tick-old.tick):0,vy:old&&obs.tick>old.tick?(e.y-old.y)/(obs.tick-old.tick):0};}
  for(const e of obs.events)if(e.type==='destroyed'&&this.memory[e.reg]){const old=this.memory[e.reg];this.enemyLoss+=old.men*this.cost[old.kind]/old.men0;delete this.memory[e.reg];}
  const bows=own.filter(r=>r.kind==='archer'),shields=own.filter(r=>r.kind==='shield'),spears=own.filter(r=>r.kind==='spear');
  const center={x:own.reduce((s,r)=>s+r.x,0)/Math.max(1,own.length),y:own.reduce((s,r)=>s+r.y,0)/Math.max(1,own.length)};
  let nearest=null;for(const e of enemies)if(!nearest||this.dist(center,e)<this.dist(center,nearest))nearest=e;
  let armyGoal=nearest||{x:sign===1?W*.47:W*.53,y:sign===1?H*.58:H*.42};
  if(!nearest&&obs.tick>500){const mem=Object.values(this.memory).filter(e=>obs.tick-e.tick<500).sort((a,b)=>this.dist(center,a)-this.dist(center,b));armyGoal=mem[0]||{x:sign===1?W-19000:19000,y:H/2};}
  const enqueue=(r,c,priority)=>{const old=this.last[r.id];if(c.type==='attack'&&cap){const e=enemies.find(x=>x.id===c.target);if(!e)return;c={type:'attackMove',x:e.x,y:e.y,intent:'座標集中接敵'};}
   if((c.type==='move'||c.type==='attackMove')&&r.order===c.type&&old&&old.type===c.type&&this.dist(c,old)<1600&&obs.tick-old.tick<35)return;
   if(c.type==='attack'&&r.order==='attack'&&r.target===c.target)return;if(c.type==='hold'&&r.order==='hold')return;
   if(c.x!==undefined){const p=this.clamp(c);c.x=p.x;c.y=p.y;}
   choices.push({r,c:{...c,id:r.id},priority:priority+Math.min(12,(obs.tick-(old?old.tick:0))/25)});
  };
  if(PRESET.bank&&!cap){
   const losses=this.initialFieldValue-own.reduce((sum,r)=>sum+this.cost[r.kind]*r.men/r.men0,0),lead=this.enemyLoss-losses;
   if(lead>=(PRESET.bankThreshold||60)&&obs.tick>(PRESET.bankMinTick||200)&&Object.values(this.memory).filter(e=>e.kind==='archer').length>=(PRESET.bankArchersRequired||1))this.bankLead=true;if(lead<0)this.bankLead=false;
   if(this.bankLead){const home={x:sign===1?W*.22:W*.78,y:sign===1?H*.385:H*.615};for(let i=0;i<own.length;i++){const r=own[i];if(r.dashing)continue;let threat=null,dist=Infinity;for(const e of enemies){const d=this.dist(r,e);if(d<dist){dist=d;threat=e;}}const target={x:home.x+sign*(i%3-1)*2600,y:home.y+sign*(Math.floor(i/3)-1.5)*3500},hd=this.dist(r,target),angle=threat?this.angle(r,threat):(sign===1?0:180),diff=this.diff(angle,r.facing);
    if(r.kind==='spear'&&threat&&threat.kind!=='archer'&&dist<((threat.kind==='lightCav'||threat.kind==='heavyCav')?24000:8500)){if(r.status==='braced'||r.status==='bracing'){if(diff>85)enqueue(r,{type:'unbrace',intent:'後衛轉向'},100);continue;}if(r.status!=='unbracing')enqueue(r,{type:'brace',facing:angle,intent:'撤退槍林後衛'},100);continue;}
    if(r.kind==='shield'&&threat&&threat.kind!=='archer'&&dist<6500&&hd>6000){if(r.status==='walled'||r.status==='walling')continue;if(diff>10)enqueue(r,{type:'face',facing:angle,intent:'後衛盾兵對向'},100);else enqueue(r,{type:'shield',mode:'wall',intent:'後衛盾牆'},100);continue;}
    if(r.kind==='archer'&&threat&&threat.kind!=='archer'&&dist-threat.radius<6500){const d=Math.max(1,dist);enqueue(r,{type:'move',x:r.x+(r.x-threat.x)/d*5000,y:r.y+(r.y-threat.y)/d*5000,intent:'保存兵力脫離'},110);continue;}
    if(hd>2300){enqueue(r,{type:'move',x:target.x,y:target.y,facing:angle,intent:'領先撤回掩護'},70);continue;}
    const range=threat?16000+1000*Math.max(-3,Math.min(3,r.height-threat.height)):0;if(r.kind==='archer'&&threat&&dist-threat.radius*.5<range-1000){enqueue(r,{type:'attack',target:threat.id,intent:'掩護防守射擊'},80);continue;}enqueue(r,{type:'hold',intent:'保存已得戰果'},30);
   }return this.finish(obs,choices);}
  }
  if(cap){
   let spent=obs.fieldCost;const reserves=obs.regiments.filter(r=>r.reserve&&r.enterIn<0).sort((a,b)=>b.men/b.men0-a.men/a.men0),used=new Set();
   if(PRESET.adaptiveReserve){const enemy={},friendly={};for(const e of enemies)enemy[e.kind]=(enemy[e.kind]||0)+e.men/e.men0;for(const r of own)friendly[r.kind]=(friendly[r.kind]||0)+r.men/r.men0;const enemyCav=(enemy.lightCav||0)+(enemy.heavyCav||0),enemyFoot=(enemy.light||0)+(enemy.sword||0);const value=k=>k==='spear'&&enemyCav>=1.5?100-Math.min(3,friendly.spear||0)*30:k==='lightCav'&&((enemy.archer||0)>=2||(enemy.light||0)>=8)?85-Math.min(3,friendly.lightCav||0)*25:k==='sword'&&enemyFoot>=6?75-Math.min(5,friendly.sword||0)*12:k==='archer'&&((enemy.spear||0)>=3||(enemy.shield||0)>=3)?70-Math.min(4,friendly.archer||0)*15:k==='light'?50:20;reserves.sort((a,b)=>value(b.kind)-value(a.kind)||b.men/b.men0-a.men/a.men0);}
   for(const r of own){if(r.engaged)this.engagedAt[r.id]=obs.tick;const near=this.dist(r,this.data.map.spawns[obs.me])<this.data.capture.spawnRadius-500||this.data.map.supplies.some(p=>obs.flags.some(f=>f.id===p.flag&&f.owner===obs.me)&&this.dist(r,p)<this.data.capture.supplyRadius-500);
    if(PRESET.recycle!==false&&near&&!r.engaged&&!r.dashing&&obs.tick-(this.engagedAt[r.id]||-999)>35&&r.men/r.men0<.4){const fresh=reserves.find(x=>!used.has(x.id)&&x.kind===r.kind&&x.men/x.men0>.85&&spent-this.cost[r.kind]+this.cost[x.kind]<=obs.fieldCap);if(fresh){enqueue(r,{type:'swap',with:fresh.id,intent:'換下殘編'},125);used.add(fresh.id);}}
   }
   let summons=0;for(const r of reserves){if(summons>=2)break;if(used.has(r.id)||r.men/r.men0<.45||spent+this.cost[r.kind]>obs.fieldCap)continue;enqueue(r,{type:'summon',intent:'投入後備'},115);spent+=this.cost[r.kind];summons++;}
  }
  if(cap){for(const r of own){if(this.goals[r.id]===undefined){const initial=obs.tick<10;let best=null,bv=Infinity;for(const f of obs.flags){const load=own.filter(x=>x.id!==r.id&&this.goals[x.id]===f.id).reduce((s,x)=>s+this.cost[x.kind]*x.men/x.men0,0);const v=initial?Math.abs(r.y-f.y):this.dist(r,f)+load*100-f.points*6000;if(v<bv){bv=v;best=f;}}if(best)this.goals[r.id]=best.id;}if(obs.tick%20!==0||r.engaged||r.dashing)continue;const current=obs.flags.find(f=>f.id===this.goals[r.id]);if(!current||current.owner!==obs.me||current.contested||this.dist(r,current)>12000)continue;const guards=own.filter(x=>this.goals[x.id]===current.id&&this.dist(x,current)<12000).reduce((s,x)=>s+this.cost[x.kind]*x.men/x.men0,0),threat=enemies.filter(x=>this.dist(x,current)<15000).reduce((s,x)=>s+this.cost[x.kind]*x.men/x.men0,0),minimum=(current.points===2?130:90)+threat*.5;if(guards-this.cost[r.kind]*r.men/r.men0<minimum)continue;let next=null,bv=Infinity;for(const f of obs.flags){if(f.id===current.id||f.owner===obs.me&&!f.contested)continue;const load=own.filter(x=>this.goals[x.id]===f.id).reduce((s,x)=>s+this.cost[x.kind]*x.men/x.men0,0),v=this.dist(r,f)+load*100-f.points*9000;if(v<bv){bv=v;next=f;}}if(next)this.goals[r.id]=next.id;}}
  const targetFor=r=>{let target=null,bv=Infinity;for(const e of enemies){let v=this.dist(r,e);const front=this.front(r,e),brace=e.kind==='spear'&&(e.status==='braced'||e.status==='bracing')&&front,wall=e.kind==='shield'&&(e.status==='walled'||e.status==='walling')&&front;
    if(r.kind==='lightCav'||r.kind==='heavyCav'){v+=e.kind==='archer'?-14000:e.kind==='light'?-10000:0;if(brace)v+=35000;if(wall)v+=5000;}
    else if(r.kind==='sword'||r.kind==='light'){v+=e.kind==='archer'?-8000:e.kind==='shield'?5000:0;if(brace||wall)v+=14000;}
    if(cap){const f=obs.flags.find(f=>f.id===this.goals[r.id]);if(f&&this.dist(e,f)>18000)v+=18000;}
    if(v<bv){bv=v;target=e;}}
   return target;};
  for(const r of own){
   const old=this.last[r.id],index=this.index[r.id],flag=cap?obs.flags.find(f=>f.id===this.goals[r.id]):null;let goal=flag||armyGoal;
   const e=targetFor(r),distance=e?this.dist(r,e):Infinity,angle=e?this.angle(r,e):(sign===1?0:180);
   let danger=null,dd=Infinity;for(const x of enemies)if(x.kind!=='archer'){const d=this.dist(r,x)-x.radius;if(d<dd){dd=d;danger=x;}}
   if(r.engaged)this.engagedAt[r.id]=obs.tick;
   if(r.dashing){this.previousDash[r.id]=true;continue;}
   const cav=r.kind==='lightCav'||r.kind==='heavyCav';
   if(cav){
    if(this.previousDash[r.id]){this.cavalry[r.id]={until:obs.tick+(r.kind==='heavyCav'?110:90)};this.previousDash[r.id]=false;}
    const recovering=this.cavalry[r.id]&&obs.tick<this.cavalry[r.id].until;
    if((recovering||r.men/r.men0<.4)&&danger&&dd<13000){const d=Math.max(1,this.dist(r,danger));const p=this.clamp({x:r.x+(r.x-danger.x)/d*18000,y:r.y+(r.y-danger.y)/d*18000});enqueue(r,{type:'move',...p,intent:'騎兵脫離重整'},105);continue;}
    if(e){
     const braced=e.kind==='spear'&&(e.status==='braced'||e.status==='bracing')&&this.front(r,e);
     if(braced&&distance<33000){enqueue(r,{type:'move',...this.flank(r,e,19000),intent:'騎兵繞槍側擊'},90);continue;}
     const mem=this.memory[e.id],lead=mem?Math.min(30,distance/630):0;const predicted=this.clamp({x:e.x+(mem?mem.vx:0)*lead,y:e.y+(mem?mem.vy:0)*lead});
     if(this.data.knobs.rush&&r.skillCooldown===0&&r.terrain!==2&&r.terrain!==4&&r.formation!=='circle'&&distance>7500&&distance<(r.kind==='heavyCav'?28000:23000)&&!recovering&&this.clear(r,predicted,true)){enqueue(r,{type:'charge',x:predicted.x,y:predicted.y,intent:'騎兵側向衝鋒'},95);continue;}
     if(r.skillCooldown>0&&distance<7000&&e.kind==='spear'){enqueue(r,{type:'move',...this.flank(r,e,14000),intent:'騎兵拉開再衝'},80);continue;}
     if(r.terrain===2||r.terrain===4){let point=null,best=Infinity;for(const radius of [6500,11000,16000])for(let a=0;a<360;a+=45){const q=this.clamp({x:r.x+Math.cos(a*Math.PI/180)*radius,y:r.y+Math.sin(a*Math.PI/180)*radius}),t=this.h.terrainAt(q.x,q.y);if(t===2||t===4||t===5||t===7||t===8)continue;const value=Math.abs(this.dist(q,e)-18000)+this.dist(r,q)*.3;if(value<best){best=value;point=q;}}if(point){enqueue(r,{type:'move',...point,intent:'離開阻衝地形'},85);continue;}}
     if(distance<16000){enqueue(r,{type:'attack',target:e.id,intent:'騎兵追截'},60);continue;}
    }
   }
   if(r.kind==='shield'){
    const diff=e?this.diff(angle,r.facing):0;
    if(r.status==='walled'||r.status==='walling'){if(!e||distance>16000||diff>65)enqueue(r,{type:'shield',mode:'unwall',intent:'盾兵轉場'},100);continue;}
    if(e&&distance<(PRESET.wallDistance||10000)){if(diff>9)enqueue(r,{type:'face',facing:angle,intent:'盾面朝敵'},92);else enqueue(r,{type:'shield',mode:'wall',intent:'盾牆攔截'},93);continue;}
    if(e&&distance<22000&&r.stance!=='raise'){enqueue(r,{type:'shield',mode:'raise',intent:'舉盾掩護'},80);continue;}
    if((!e||distance>23000)&&r.stance!=='carry'){enqueue(r,{type:'shield',mode:'carry',intent:'持盾轉場'},70);continue;}
    let dest=goal;
    if(bows.length&&!cap){const group=bows.filter((x,i)=>i%Math.max(1,shields.length)===shields.indexOf(r)),g=group.length?{x:group.reduce((s,x)=>s+x.x,0)/group.length,y:group.reduce((s,x)=>s+x.y,0)/group.length}:center;const d=Math.max(1,this.dist(g,goal));dest={x:g.x+(goal.x-g.x)/d*5500,y:g.y+(goal.y-g.y)/d*5500};}
    enqueue(r,{type:'move',...dest,facing:angle,intent:'盾兵掩護推進'},45);continue;
   }
   if(r.kind==='archer'){
    if(danger&&dd<this.data.knobs.kite*1000){const d=Math.max(1,this.dist(r,danger));enqueue(r,{type:'move',x:r.x+(r.x-danger.x)/d*5500,y:r.y+(r.y-danger.y)/d*5500,intent:'射手脫離貼身'},110);continue;}
    if(r.status==='volleying')continue;
    let best=null,bv=Infinity;for(const x of enemies){const effective=this.dist(r,x)-x.radius*.5,range=16000+1000*Math.max(-3,Math.min(3,r.height-x.height));if(effective>range-1000)continue;const value=effective/1000+(x.kind==='shield'?24:x.kind==='archer'?-12:x.kind==='spear'?3:0)+x.men/x.men0*3;if(value<bv){bv=value;best=x;}}
    if(best){const density=enemies.filter(x=>this.dist(x,best)<4500).reduce((s,x)=>s+x.men,0),range=16000+1000*Math.max(-3,Math.min(3,r.height-best.height));if(r.skillCooldown===0&&density>=28&&this.dist(r,best)<range-1000){enqueue(r,{type:'volley',x:best.x,y:best.y,intent:'密集區齊射'},70);continue;}enqueue(r,{type:'attack',target:best.id,intent:'射手集火'},65);continue;}
    let anchor=null;for(const x of shields)if(!anchor||this.dist(r,x)<this.dist(r,anchor))anchor=x;
    if(anchor&&this.dist(r,anchor)<18000){const a=anchor.facing*Math.PI/180,offset=(index%2===0?-1:1)*2200;const p={x:anchor.x-Math.cos(a)*3200-Math.sin(a)*offset,y:anchor.y-Math.sin(a)*3200+Math.cos(a)*offset};if(this.dist(r,p)>2200)enqueue(r,{type:'attackMove',...p,intent:'射手保持掩護'},35);else enqueue(r,{type:'hold',intent:'射手待射'},20);continue;}
    if(e){const d=Math.max(1,distance),stand=12000;enqueue(r,{type:'attackMove',x:e.x+(r.x-e.x)/d*stand,y:e.y+(r.y-e.y)/d*stand,intent:'射手進入射程'},40);continue;}
   }
   if(r.kind==='spear'){
    let threat=e,dist=distance;for(const x of enemies)if((x.kind==='lightCav'||x.kind==='heavyCav')&&this.dist(r,x)<30000){if(!threat||!(threat.kind==='lightCav'||threat.kind==='heavyCav')||this.dist(r,x)<dist){threat=x;dist=this.dist(r,x);}}
    const cavalry=threat&&(threat.kind==='lightCav'||threat.kind==='heavyCav'),foot=threat&&(threat.kind==='sword'||threat.kind==='light'),diff=threat?this.diff(this.angle(r,threat),r.facing):0;
    const brace=cavalry?(threat.dashing?29000:24000):foot?(PRESET.braceDistance||22000):12000;
    if(r.status==='braced'||r.status==='bracing'){if(!threat||dist>brace+6000||threat.kind==='archer'||diff>75)enqueue(r,{type:'unbrace',intent:'槍兵重新定位'},100);continue;}if(r.status==='unbracing')continue;
    if(threat&&threat.kind!=='archer'&&dist<brace&&diff<85){enqueue(r,{type:'brace',facing:this.angle(r,threat),intent:'提前架槍迎擊'},100);continue;}
    if(threat){enqueue(r,{type:'attack',target:threat.id,intent:'槍兵接戰'},55);continue;}
   }
   if((r.kind==='sword'||r.kind==='light')&&e){
    const frontal=this.front(r,e)&&((e.kind==='spear'&&(e.status==='braced'||e.status==='bracing'))||(e.kind==='shield'&&(e.status==='walled'||e.status==='walling')));
    if(frontal&&distance<24000){enqueue(r,{type:'move',...this.flank(r,e,13000),intent:'步兵側包'},85);continue;}
    const withinFlag=flag&&this.dist(e,flag)<17000,shouldFight=!cap||withinFlag||e.kind==='archer'&&distance<13000;
    if(shouldFight&&distance<(cap?this.data.knobs.chase*1000:23000)){
     const skill=r.kind==='sword'?'assault':'infiltrate',limit=r.kind==='sword'?7500:9500;
     if(this.data.knobs.rush&&r.skillCooldown===0&&!r.engaged&&distance>3500&&distance<limit&&this.clear(r,e,false)){enqueue(r,{type:skill,x:e.x,y:e.y,intent:'步兵切入側翼'},80);continue;}
     enqueue(r,{type:'attack',target:e.id,intent:'步兵集中接敵'},55);continue;
    }
   }
   const toGoal=this.dist(r,goal);
   if(cap&&flag&&toGoal<2500){if(e&&this.dist(e,flag)<14000)enqueue(r,{type:'attack',target:e.id,intent:'清除圈內敵軍'},60);else enqueue(r,{type:'hold',intent:'守住旗圈'},25);continue;}
   if(!cav&&(r.kind==='light'||r.kind==='sword')&&this.data.knobs.rush&&r.skillCooldown===0&&toGoal>14000&&(!danger||dd>15000)){const p={x:r.x+(goal.x-r.x)/toGoal*(r.kind==='light'?9500:7500),y:r.y+(goal.y-r.y)/toGoal*(r.kind==='light'?9500:7500)};if(this.clear(r,p,false)){enqueue(r,{type:r.kind==='light'?'infiltrate':'assault',...p,intent:'步兵快速轉場'},50);continue;}}
   enqueue(r,{type:'attackMove',x:goal.x,y:goal.y,intent:'前往戰術目標'},30);
  }
  return this.finish(obs,choices);
 }
}

})();
export default class BaselineHybrid {constructor(){this.impl=null;}declare(){const d=new AnnComponent().declare();d.name="Legion Baseline";d.version="v1.114";d.style="雙模式分工與成熟兵種協同";return d;}init(data,h){this.impl=data.mode==="capture"?new CapComponent():new AnnComponent();this.impl.init(data,h);}deploy(data,h){return this.impl.deploy(data,h);}decide(obs){return this.impl.decide(obs);}}
