"use strict";

const https=require("https");
const sqlite3=require("sqlite3").verbose();

const DB_PATH="/root/tfcbot/elo.db";

function get(url){
  return new Promise((resolve,reject)=>{
    https.get(url,res=>{
      let data="";
      res.on("data",c=>data+=c);
      res.on("end",()=>resolve(data));
    }).on("error",reject);
  });
}

function timeToSec(t){
  const m=String(t||"").match(/(\d+):(\d+)/);
  return m?Number(m[1])*60+Number(m[2]):0;
}

function sumLabels(lines,label){
  const safe=label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const re=new RegExp("^"+safe+":\\s*(\\d+)","i");
  return lines.reduce((s,l)=>{
    const m=l.match(re);
    return s+(m?Number(m[1]):0);
  },0);
}

function parsePlayerIdFromHref(href){
  const m=href.match(/p(\d+)\.html/);
  return m?m[1]:null;
}

function parseH4(html){
  return [...html.matchAll(/<h4>(.*?)<\/h4>/g)].map(m=>m[1].trim());
}

function parseName(html){
  const m=html.match(/<p class="h2 player-name">([^<]+)<\/p>/);
  return m?m[1].trim():"unknown";
}

function parseClasses(html){
  const out=[];
  const start=html.indexOf("<!-- player classes -->");
  const end=html.indexOf("<!-- kills -->");
  if(start<0||end<0)return out;

  const block=html.slice(start,end);
  const roundBlocks=[...block.matchAll(/<div class="d-flex flex-row classes">([\s\S]*?)(?=<div class="d-flex flex-row classes">|$)/g)];

  roundBlocks.forEach((rb,i)=>{
    const round=i+1;
    const classRe=/alt="([^"]+)"\s*\/>\s*<div>(\d{2}):(\d{2})<\/div>/g;
    let m;
    while((m=classRe.exec(rb[1]))){
      out.push({round_num:round,class_name:m[1],seconds:Number(m[2])*60+Number(m[3])});
    }
  });

  return out;
}

function mainClass(classes){
  if(!classes.length)return null;
  const totals={};
  for(const c of classes)totals[c.class_name]=(totals[c.class_name]||0)+c.seconds;
  return Object.entries(totals).sort((a,b)=>b[1]-a[1])[0][0];
}

function parseWeaponKills(html){
  const weapons={};
  const start=html.indexOf("<!-- kills -->");
  const end=html.indexOf("<!-- deaths -->");
  if(start<0||end<0)return weapons;

  const block=html.slice(start,end);
  const sections=[...block.matchAll(/<div class="stats-faceted">([\s\S]*?)(?=<div class="stats-faceted">|<\/div>\s*<\/div>\s*<div class="d-flex flex-column">|$)/g)];

  for(const s of sections){
    const section=s[1];
    const title=(section.match(/<h4>(.*?)<\/h4>/)||[])[1]||"";
    if(!/^Enemy kills:\s*\d+/i.test(title))continue;

    const re=/class="weapon-icon (weapon-\d+)[^"]*"\s+title="Killed /g;
    let m;
    while((m=re.exec(section))){
      weapons[m[1]]=(weapons[m[1]]||0)+1;
    }
  }

  return weapons;
}

function parsePlayerStats(html){
  const h4=parseH4(html);
  const deathsByEnemy=sumLabels(h4,"Deaths by enemy");
  const deathsByTeam=sumLabels(h4,"Deaths by teammates");
  const dmgTakenEnemy=sumLabels(h4,"Damage taken from enemies");
  const dmgTakenTeam=sumLabels(h4,"Damage taken from teammates");
  const classes=parseClasses(html);

  return {
    display_name:parseName(html),
    kills:sumLabels(h4,"Enemy kills"),
    team_kills:sumLabels(h4,"Team kills"),
    deaths:deathsByEnemy+deathsByTeam,
    deaths_by_enemy:deathsByEnemy,
    deaths_by_team:deathsByTeam,
    enemy_damage:sumLabels(h4,"Damage dealt to enemies"),
    team_damage:sumLabels(h4,"Damage dealt to teammates"),
    damage_taken:dmgTakenEnemy+dmgTakenTeam,
    self_damage:sumLabels(h4,"Damage dealt to self"),
    conc_jumps:sumLabels(h4,"Conc jumps"),
    classes,
    main_class:mainClass(classes),
    weapons:parseWeaponKills(html)
  };
}

function extractPlayerLinks(mainHtml,baseUrl){
  const links=[];
  const re=/<a class="nav-link" href="([^"]*\/p\d+\.html)">/g;
  let m;
  while((m=re.exec(mainHtml))){
    const href=m[1];
    const id=parsePlayerIdFromHref(href);
    if(!id)continue;
    const full=href.startsWith("http")?href:new URL(href,baseUrl).toString();
    if(!links.some(x=>x.href===full))links.push({href:full,playerId:id});
  }
  return links;
}

function parseSteamIdsFromMain(mainHtml){
  const ids=[];
  const re=/tracker\.thecatacombs\.us\/index\.php\?steamid=([0-5]:[01]:\d+)/g;
  let m;
  while((m=re.exec(mainHtml))){
    ids.push(`STEAM_${m[1]}`);
  }
  return ids;
}

function parseFlagStats(mainHtml){
  const map={};
  const rowRe=/<tr[\s\S]*?<\/tr>/g;
  let row;
  while((row=rowRe.exec(mainHtml))){
    const r=row[0];
    const link=r.match(/href="[^"]*\/p(\d+)\.html"/);
    if(!link)continue;

    const playerId=link[1];
    const caps=(r.match(/<td class="flag-captures[^"]*">\s*([^<]+)</)||[])[1];
    const touches=(r.match(/<td class="flag-touches[^"]*">\s*([^<]+)</)||[])[1];
    const flagTime=(r.match(/<td class="flag-time[^"]*">\s*([^<]+)</)||[])[1];

    const capMain=String(caps||"").match(/(\d+)/);
    const touchMain=String(touches||"").match(/(\d+)/);
    const touchInitial=String(touches||"").match(/\((\d+)\)/);

    map[playerId]=map[playerId]||{flag_captures:0,flag_touches:0,initial_touches:0,flag_time_seconds:0};
    map[playerId].flag_captures+=capMain?Number(capMain[1]):0;
    map[playerId].flag_touches+=touchMain?Number(touchMain[1]):0;
    map[playerId].initial_touches+=touchInitial?Number(touchInitial[1]):0;
    map[playerId].flag_time_seconds+=timeToSec(flagTime);
  }
  return map;
}

function runDb(sql,params=[]){
  return new Promise((resolve,reject)=>{
    db.run(sql,params,function(err){err?reject(err):resolve(this);});
  });
}

function getDb(sql,params=[]){
  return new Promise((resolve,reject)=>{
    db.get(sql,params,(err,row)=>err?reject(err):resolve(row));
  });
}

const matchId=process.argv[2];
const url=process.argv[3];
const FORCE=process.argv.includes("--force");

if(!matchId||!url){
  console.error("Usage: node hampalyzerImport.js MATCH_ID HAMPALYZER_URL [--force]");
  process.exit(1);
}

const db=new sqlite3.Database(DB_PATH);

(async()=>{
  const existing=await getDb(
    "SELECT match_id FROM match_stat_imports WHERE match_id=?",
    [matchId]
  );

if(existing&&!FORCE){
  console.log(`[hampalyzer] ${matchId} already imported`);
  db.close();
  return;
}

if(existing&&FORCE){
  console.log(`[hampalyzer] ${matchId} force reimport`);

  await runDb("DELETE FROM match_player_weapons WHERE match_id=?",[matchId]);
  await runDb("DELETE FROM match_player_classes WHERE match_id=?",[matchId]);
  await runDb("DELETE FROM match_player_stats WHERE match_id=?",[matchId]);
  await runDb("DELETE FROM match_stat_imports WHERE match_id=?",[matchId]);
}

  const mainHtml=await get(url);
  const links=extractPlayerLinks(mainHtml,url);
  const steamIds=parseSteamIdsFromMain(mainHtml);
  const flagStats=parseFlagStats(mainHtml);

  await runDb("BEGIN");

  await runDb(
    `INSERT OR REPLACE INTO match_stat_imports(match_id,source,source_url,status,notes)
     VALUES(?,?,?,?,?)`,
    [matchId,"hampalyzer",url,"ok",`players=${links.length}`]
  );

  for(let i=0;i<links.length;i++){
    const p=links[i];
    const html=await get(p.href);
    const stats=parsePlayerStats(html);
    const accountId=Number(p.playerId);
    const fallbackSteam=`STEAM_0:${accountId%2}:${Math.floor(accountId/2)}`;
    const steam=steamIds[i]||fallbackSteam;
    const playerKey=steam;
    const flags=flagStats[p.playerId]||{};

    await runDb(
      `INSERT OR REPLACE INTO match_player_stats
      (match_id,player_key,steam_id,display_name,kills,deaths,enemy_damage,team_damage,damage_taken,flag_captures,main_class,team_kills,deaths_by_enemy,deaths_by_team,self_damage,conc_jumps,flag_touches,initial_touches,flag_time_seconds)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        matchId,playerKey,steam,stats.display_name,
        stats.kills,stats.deaths,stats.enemy_damage,stats.team_damage,stats.damage_taken,
        flags.flag_captures||0,stats.main_class,
        stats.team_kills,stats.deaths_by_enemy,stats.deaths_by_team,stats.self_damage,stats.conc_jumps,
        flags.flag_touches||0,flags.initial_touches||0,flags.flag_time_seconds||0
      ]
    );

    for(const c of stats.classes){
      await runDb(
        `INSERT OR REPLACE INTO match_player_classes(match_id,player_key,class_name,round_num,seconds)
         VALUES(?,?,?,?,?)`,
        [matchId,playerKey,c.class_name,c.round_num,c.seconds]
      );
    }

    for(const [weapon,kills] of Object.entries(stats.weapons)){
      await runDb(
        `INSERT OR REPLACE INTO match_player_weapons(match_id,player_key,weapon,kills)
         VALUES(?,?,?,?)`,
        [matchId,playerKey,weapon,kills]
      );
    }

    console.log(`Imported ${stats.display_name} ${steam}`);
  }

  await runDb("COMMIT");
  db.close();
  console.log(`Done. Imported ${links.length} players for ${matchId}`);
})().catch(async err=>{
  console.error(err);
  try{await runDb("ROLLBACK");}catch{}
  db.close();
  process.exit(1);
});