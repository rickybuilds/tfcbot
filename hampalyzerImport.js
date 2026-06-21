"use strict";

const https=require("https");
const sqlite3=require("sqlite3").verbose();
const { execFileSync } = require("child_process");

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

function textContent(html){
  return String(html||"")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/g," ")
    .replace(/&amp;/g,"&")
    .replace(/&#39;/g,"'")
    .replace(/&quot;/g,'"')
    .replace(/&ndash;/g,"-")
    .replace(/\s+/g," ")
    .trim();
}

function numberFromText(value){
  const m=String(value||"").match(/-?\d+/);
  return m?Number(m[0]):0;
}

function percentFromText(value){
  const m=String(value||"").match(/-?\d+(?:\.\d+)?/);
  return m?Number(m[0]):null;
}

function extractSection(html,startMarker,endMarker){
  const start=html.indexOf(`<!-- ${startMarker} -->`);
  const end=html.indexOf(`<!-- ${endMarker} -->`,start+1);
  if(start<0||end<0)return "";
  return html.slice(start,end);
}

function extractTopLevelDivsByClass(html,className){
  const out=[];
  const divRe=/<\/?div\b[^>]*>/gi;
  let depth=0;
  let start=-1;
  let m;

  while((m=divRe.exec(html))){
    const tag=m[0];
    const closing=/^<\//.test(tag);

    if(!closing){
      if(depth===0){
        const classes=(tag.match(/\bclass="([^"]*)"/i)||[])[1]||"";
        if(classes.split(/\s+/).includes(className))start=m.index;
      }
      depth++;
      continue;
    }

    depth=Math.max(0,depth-1);
    if(depth===0&&start>=0){
      out.push(html.slice(start,divRe.lastIndex));
      start=-1;
    }
  }

  return out;
}

function parseRoundStats(html){
  const rounds=[1,2].map(round_num=>({
    round_num,
    kills:0,
    team_kills:0,
    conced_kills:0,
    deaths_by_enemy:0,
    deaths_by_team:0,
    enemy_damage:0,
    team_damage:0,
    damage_taken_enemy:0,
    damage_taken_team:0,
    self_damage:0,
    conc_jumps:0
  }));

  const sections=[
    {
      start:"kills",
      end:"deaths",
      fields:{
        kills:"Enemy kills",
        team_kills:"Team kills",
        conced_kills:"Enemy kills while conced"
      }
    },
    {
      start:"deaths",
      end:"damage",
      fields:{
        deaths_by_enemy:"Deaths by enemy",
        deaths_by_team:"Deaths by teammates"
      }
    },
    {
      start:"damage",
      end:"weapons",
      fields:{
        enemy_damage:"Damage dealt to enemies",
        team_damage:"Damage dealt to teammates",
        damage_taken_enemy:"Damage taken from enemies",
        damage_taken_team:"Damage taken from teammates",
        self_damage:"Damage dealt to self"
      }
    },
    {
      start:"weapons",
      end:"buildables",
      fields:{conc_jumps:"Conc jumps"}
    }
  ];

  for(const section of sections){
    const block=extractSection(html,section.start,section.end);
    const columns=extractTopLevelDivsByClass(block,"flex-column").slice(0,2);

    columns.forEach((column,index)=>{
      const labels=parseH4(column);
      for(const [field,label] of Object.entries(section.fields)){
        rounds[index][field]=sumLabels(labels,label);
      }
    });
  }

  return rounds;
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

function parseClassTimeline(classes){
  const timelines={};

  for(const c of classes){
    const round=Number(c.round_num);
    timelines[round]=timelines[round]||[];
  }

  for(const round of Object.keys(timelines)){
    let cursor=0;
    for(const c of classes.filter(x=>Number(x.round_num)===Number(round))){
      timelines[round].push({
        class_name:c.class_name,
        start_seconds:cursor,
        end_seconds:cursor+c.seconds
      });
      cursor+=c.seconds;
    }
  }

  return timelines;
}

function classForEvent(timeline, seconds){
  if(!timeline||!timeline.length)return {class_name:null,confidence:"unknown_no_class_timeline"};

  const hit=timeline.find(c=>seconds>=c.start_seconds&&seconds<c.end_seconds);
  if(hit){
    return {
      class_name:hit.class_name,
      confidence:timeline.length===1?"exact_single_class_round":"exact_timeline_match"
    };
  }

  const last=timeline[timeline.length-1];
  if(last&&seconds>=last.end_seconds){
    return {
      class_name:last.class_name,
      confidence:"exact_after_pause_clamped"
    };
  }

  return {class_name:null,confidence:"unknown_timeline_gap"};
}

function parseKillEventTitle(title){
  const isFlagCarrier=/Killed flag carrier /i.test(title);
  const isConced=/ while conced at /i.test(title);
  const m=String(title||"").match(/^Killed (?:flag carrier )?(.+?)(?: while conced)? at (\d+:\d+)$/i);
  if(!m)return null;

  return {
    victim_name:m[1],
    event_time_text:m[2],
    event_time_seconds:timeToSec(m[2]),
    is_flag_carrier_kill:isFlagCarrier?1:0,
    is_conced:isConced?1:0
  };
}

function killEventKey(e){
  return `${e.weapon}|${e.victim_name}|${e.event_time_text}`;
}

function extractKillEventsFromSection(section){
  const events=[];
  const re=/class="weapon-icon\s+(weapon-\d+)[^"]*"\s+title="([^"]+)"/g;
  let m;

  while((m=re.exec(section))){
    const parsed=parseKillEventTitle(m[2]);
    if(!parsed)continue;
    events.push({weapon:m[1],...parsed});
  }

  return events;
}

function parseKillEvents(html,classes){
  const start=html.indexOf("<!-- kills -->");
  const end=html.indexOf("<!-- deaths -->",start);
  if(start<0||end<0)return [];

  const timelines=parseClassTimeline(classes);
  const block=html.slice(start,end);
  const columns=[...block.matchAll(/<div class="d-flex flex-column">([\s\S]*?)<\/div>\s*(?=<div class="d-flex flex-column">|$)/g)];
  const events=[];

  columns.forEach((col,index)=>{
    const roundNum=index+1;
    const sections=[...col[1].matchAll(/<div class="stats-faceted">([\s\S]*?)(?=<div class="stats-faceted">|$)/g)];

    let mainKills=[];
    let concedKills=[];

    for(const sec of sections){
      const section=sec[1];
      const title=textContent((section.match(/<h4>([\s\S]*?)<\/h4>/)||[])[1]||"");

      if(/^Enemy kills:\s*\d+/i.test(title)){
        mainKills=extractKillEventsFromSection(section);
      }else if(/^Enemy kills while conced:\s*\d+/i.test(title)){
        concedKills=extractKillEventsFromSection(section);
      }
    }

    const concedSet=new Set(concedKills.map(killEventKey));

    for(const e of mainKills){
      const classInfo=classForEvent(timelines[roundNum],e.event_time_seconds);
      events.push({
        round_num:roundNum,
        ...e,
        is_conced:concedSet.has(killEventKey(e))?1:0,
        attacker_class:classInfo.class_name,
        attacker_class_confidence:classInfo.confidence
      });
    }
  });

  return events;
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
    weapons:parseWeaponKills(html),
    kill_events:parseKillEvents(html,classes)
  };
}

function extractPlayerLinks(mainHtml,baseUrl){
  const links=[];
  const re=/<a class="nav-link" href="([^"]*\/p\d+\.html)">\s*([^<]+?)\s*<\/a>/g;
  let m;
  while((m=re.exec(mainHtml))){
    const href=m[1];
    const id=parsePlayerIdFromHref(href);
    if(!id)continue;
    const full=href.startsWith("http")?href:new URL(href,baseUrl).toString();
    const navName=textContent(m[2]||"");
    if(!links.some(x=>x.href===full))links.push({href:full,playerId:id,navName});
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


async function getDiscordIdForSteam(steamId){
  if(!steamId)return null;
  const row=await getDb(
    "SELECT discord_id FROM player_steam_ids WHERE steam_id=? ORDER BY is_primary DESC LIMIT 1",
    [steamId]
  );
  return row?row.discord_id:null;
}

function normalizePlayerName(name){
  return String(name||"").trim().toLowerCase();
}

function buildNameRoster(players){
  const byName={};

  for(const p of players){
    const names=[p.display_name,p.nav_name].filter(Boolean);

    for(const name of names){
      const key=normalizePlayerName(name);
      if(!key)continue;
      byName[key]=byName[key]||[];
      if(!byName[key].includes(p))byName[key].push(p);
    }
  }

  return byName;
}

function resolveVictimByName(victimName,nameRoster){
  const matches=nameRoster[normalizePlayerName(victimName)]||[];
  if(matches.length!==1)return null;
  return matches[0];
}

function parseTeamMembership(mainHtml){
  const teams={};

  for(const teamName of ["Team A","Team B"]){
    const safe=teamName.replace(" ","\\s+");
    const re=new RegExp(
      `<span>\\s*${safe}\\s*<\\/span>[\\s\\S]*?<ul[^>]*>([\\s\\S]*?)<\\/ul>`,
      "i"
    );
    const block=(mainHtml.match(re)||[])[1]||"";

    for(const link of block.matchAll(/href="[^"]*\/p(\d+)\.html"/g)){
      teams[link[1]]=teamName;
    }
  }

  return teams;
}

function tableCellText(rowHtml,className){
  const safe=className.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const re=new RegExp(
    `<td\\s+class="[^"]*\\b${safe}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/td>`,
    "i"
  );
  return textContent((rowHtml.match(re)||[])[1]||"");
}

function parseMapName(mainHtml){
  const m=mainHtml.match(
    /<i[^>]+title="Map played"[^>]*><\/i>\s*(?:&nbsp;)*\s*([^<\r\n]+)/
  );
  return m?textContent(m[1]):null;
}

function parseFallbackRoundDuration(mainHtml){
  const m=mainHtml.match(
    /<i[^>]+title="Length of match"[^>]*><\/i>[\s\S]*?(\d+):(\d+)m/
  );
  return m?Number(m[1])*60+Number(m[2]):0;
}

function parseFlagPace(mainHtml){
  const section = mainHtml.match(/<h3[^>]*>\s*Flag pace\s*<\/h3>[\s\S]*?<svg[\s\S]*?<\/svg>/i)?.[0] || "";

  const paths = [...section.matchAll(/<path[^>]+stroke="var\(--team-([ab])-color\)"[^>]+d="([^"]+)"/gi)]
    .map(m => ({
      team: m[1] === "a" ? "blue" : "red",
      d: m[2],
    }));

  function xToSeconds(x){
    return Math.round(((x - 25) / 800) * 900);
  }

  function yToScore(y){
    return Math.round(((510 - y) / 480) * 50);
  }

  function timeText(seconds){
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  const caps = [];

  for(const path of paths){
    const points = [...path.d.matchAll(/[ML]([0-9.]+),([0-9.]+)/g)]
      .map(m => ({ x:Number(m[1]), y:Number(m[2]) }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));

    for(let i=1;i<points.length;i++){
      const prev = points[i - 1];
      const cur = points[i];

      const prevScore = yToScore(prev.y);
      const curScore = yToScore(cur.y);

      if(Math.abs(cur.x - prev.x) < 0.01 && curScore > prevScore){
        const seconds = xToSeconds(cur.x);

        caps.push({
          team:path.team,
          cap_num:caps.filter(c => c.team === path.team).length + 1,
          time_seconds:seconds,
          time_text:timeText(seconds),
          score_after:curScore
        });
      }
    }
  }

  return caps.sort((a,b)=>a.time_seconds-b.time_seconds);
}

function parseMatchRoundData(mainHtml){
  const teamMembership=parseTeamMembership(mainHtml);
  const playerStats={};
  const rounds=[];
  const mvps=[];
  const summaryStart=mainHtml.indexOf('id="summary"');
  const summaryEnd=mainHtml.indexOf('id="comp"',summaryStart+1);
  if(summaryStart<0||summaryEnd<0){
    return {
      map_name:parseMapName(mainHtml),
      fallback_duration_seconds:parseFallbackRoundDuration(mainHtml),
      rounds,
      mvps,
      playerStats
    };
  }

  const summary=mainHtml.slice(summaryStart,summaryEnd);
  const roundRe=/<h3>\s*Round\s+(\d+)\s*<\/h3>([\s\S]*?)(?=<h3>\s*Round\s+\d+\s*<\/h3>|$)/gi;
  let roundMatch;

  while((roundMatch=roundRe.exec(summary))){
    const roundNum=Number(roundMatch[1]);
    const block=roundMatch[2];
    const score=(block.match(
      /<div class="score-bucket">[\s\S]*?<div class="team1">\s*(\d+)\s*<\/div>[\s\S]*?<div class="team2">\s*(\d+)\s*<\/div>/
    )||[]);
    const offenseScore=Number(score[1]||0);
    const defenseScore=Number(score[2]||0);
    const rows=[];
    const rowRe=/<tr class="(team[12])">([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while((rowMatch=rowRe.exec(block))){
      const visualTeam=rowMatch[1];
      const rowHtml=rowMatch[2];
      const playerId=(rowHtml.match(/href="[^"]*\/p(\d+)\.html"/)||[])[1];
      if(!playerId)continue;

      const displayName=textContent(
        (rowHtml.match(/<td\s+class="[^"]*\bplayer-name\b[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)||[])[1]||""
      );
      const touchText=tableCellText(rowHtml,"flag-touches");
      const row={
        round_num:roundNum,
        team_name:teamMembership[playerId]||visualTeam,
        role:tableCellText(rowHtml,"roles")||null,
        kills:numberFromText(tableCellText(rowHtml,"kills")),
        team_kills:numberFromText(tableCellText(rowHtml,"team-kills")),
        conced_kills:numberFromText(tableCellText(rowHtml,"conc-kills")),
        sentry_kills:numberFromText(tableCellText(rowHtml,"sentry-kills")),
        deaths_by_enemy:numberFromText(tableCellText(rowHtml,"deaths")),
        deaths_by_team:numberFromText(tableCellText(rowHtml,"team-deaths")),
        suicides:numberFromText(tableCellText(rowHtml,"suicides")),
        enemy_damage:numberFromText(tableCellText(rowHtml,"damage-enemy")),
        team_damage:numberFromText(tableCellText(rowHtml,"damage-team")),
        conc_jumps:numberFromText(tableCellText(rowHtml,"concs")),
        flag_captures:numberFromText(tableCellText(rowHtml,"flag-captures")),
        flag_touches:numberFromText(touchText),
        initial_touches:numberFromText((touchText.match(/\((\d+)\)/)||[])[1]),
        flag_time_seconds:timeToSec(tableCellText(rowHtml,"flag-time")),
        objectives:numberFromText(tableCellText(rowHtml,"objectives")),
        toss_percent:percentFromText(tableCellText(rowHtml,"flag-toss-percentage")),
        visual_team:visualTeam
      };

      rows.push(row);
      playerStats[playerId]=playerStats[playerId]||{};
      playerStats[playerId][roundNum]=row;

      if(/<span\s+class="[^"]*\bmvp\b[^"]*"[^>]*>\s*★?\s*<\/span>/i.test(rowHtml)){
        mvps.push({
          round_num:roundNum,
          player_id:playerId,
          mvp_display_name:displayName||null
        });
      }
    }

    const offenseRow=rows.find(row=>row.visual_team==="team1");
    const offenseTeam=offenseRow?offenseRow.team_name:null;
    const defenseTeam=offenseTeam==="Team A"
      ?"Team B"
      :offenseTeam==="Team B"
        ?"Team A"
        :null;

    rounds.push({
      round_num:roundNum,
      team1_score:offenseTeam==="Team B"?defenseScore:offenseScore,
      team2_score:offenseTeam==="Team B"?offenseScore:defenseScore,
      offense_team:offenseTeam,
      defense_team:offenseTeam?defenseTeam:null
    });
  }

  return {
    map_name:parseMapName(mainHtml),
    fallback_duration_seconds:parseFallbackRoundDuration(mainHtml),
    rounds,
    mvps,
    playerStats
  };
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

async function ensureSchema(){
  await runDb(`
    CREATE TABLE IF NOT EXISTS match_rounds (
      match_id TEXT NOT NULL,
      round_num INTEGER NOT NULL,
      map_name TEXT,
      duration_seconds INTEGER,
      team1_score INTEGER,
      team2_score INTEGER,
      offense_team TEXT,
      defense_team TEXT,
      PRIMARY KEY (match_id, round_num)
    )
  `);

  await runDb(`
    CREATE TABLE IF NOT EXISTS match_player_round_stats (
      match_id TEXT NOT NULL,
      player_key TEXT NOT NULL,
      steam_id TEXT,
      display_name TEXT,
      round_num INTEGER NOT NULL,
      team_name TEXT,
      role TEXT,
      kills INTEGER DEFAULT 0,
      team_kills INTEGER DEFAULT 0,
      conced_kills INTEGER DEFAULT 0,
      sentry_kills INTEGER DEFAULT 0,
      deaths_by_enemy INTEGER DEFAULT 0,
      deaths_by_team INTEGER DEFAULT 0,
      suicides INTEGER DEFAULT 0,
      enemy_damage INTEGER DEFAULT 0,
      team_damage INTEGER DEFAULT 0,
      damage_taken_enemy INTEGER DEFAULT 0,
      damage_taken_team INTEGER DEFAULT 0,
      self_damage INTEGER DEFAULT 0,
      conc_jumps INTEGER DEFAULT 0,
      flag_captures INTEGER DEFAULT 0,
      flag_touches INTEGER DEFAULT 0,
      initial_touches INTEGER DEFAULT 0,
      flag_time_seconds INTEGER DEFAULT 0,
      objectives INTEGER DEFAULT 0,
      toss_percent REAL,
      PRIMARY KEY (match_id, player_key, round_num)
    )
  `);

  await runDb(`
    CREATE TABLE IF NOT EXISTS match_round_mvps (
      match_id TEXT NOT NULL,
      round_num INTEGER NOT NULL,
      mvp_display_name TEXT,
      mvp_player_key TEXT,
      steam_id TEXT,
      PRIMARY KEY (match_id, round_num)
    )
  `);

  await runDb(`
    CREATE TABLE IF NOT EXISTS match_kill_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      source_url TEXT,
      round_num INTEGER NOT NULL,
      event_time_seconds INTEGER,
      event_time_text TEXT,
      attacker_key TEXT NOT NULL,
      attacker_steam_id TEXT,
      attacker_discord_id TEXT,
      attacker_name TEXT,
      attacker_team TEXT,
      attacker_role TEXT,
      attacker_class TEXT,
      attacker_class_confidence TEXT,
      weapon TEXT NOT NULL,
      victim_name TEXT,
      victim_key TEXT,
      victim_steam_id TEXT,
      victim_discord_id TEXT,
      victim_team TEXT,
      is_enemy_kill INTEGER DEFAULT 1,
      is_team_kill INTEGER DEFAULT 0,
      is_conced INTEGER DEFAULT 0,
      is_flag_carrier_kill INTEGER DEFAULT 0,
      source_confidence TEXT NOT NULL DEFAULT 'exact'
    )
  `);

  await runDb(`CREATE INDEX IF NOT EXISTS idx_mke_attacker ON match_kill_events(attacker_steam_id)`);
  await runDb(`CREATE INDEX IF NOT EXISTS idx_mke_victim ON match_kill_events(victim_steam_id)`);
  await runDb(`CREATE INDEX IF NOT EXISTS idx_mke_match_round ON match_kill_events(match_id, round_num)`);
  await runDb(`CREATE INDEX IF NOT EXISTS idx_mke_weapon ON match_kill_events(weapon)`);
  await runDb(`CREATE INDEX IF NOT EXISTS idx_mke_class_weapon ON match_kill_events(attacker_class, weapon)`);
  await runDb(`CREATE INDEX IF NOT EXISTS idx_mke_attacker_discord ON match_kill_events(attacker_discord_id)`);
  await runDb(`CREATE INDEX IF NOT EXISTS idx_mke_victim_discord ON match_kill_events(victim_discord_id)`);

  await runDb(`
  CREATE TABLE IF NOT EXISTS match_cap_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    source_url TEXT,
    team TEXT NOT NULL,
    cap_num INTEGER NOT NULL,
    time_seconds INTEGER NOT NULL,
    time_text TEXT NOT NULL,
    score_after INTEGER,
    imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(match_id, team, cap_num)
  )
`);
await runDb(`CREATE INDEX IF NOT EXISTS idx_match_cap_events_match ON match_cap_events(match_id)`);
await runDb(`CREATE INDEX IF NOT EXISTS idx_match_cap_events_time ON match_cap_events(match_id, time_seconds)`);
}

const matchId=process.argv[2];
const url=process.argv[3];
const FORCE=process.argv.includes("--force");

if(!matchId||!url){
  console.error("Usage: node hampalyzerImport.js MATCH_ID HAMPALYZER_URL [--force]");
  process.exit(1);
}

const db=new sqlite3.Database(DB_PATH);
db.configure("busyTimeout",30000);

(async()=>{
  await ensureSchema();

  const existing=await getDb(
    "SELECT match_id FROM match_stat_imports WHERE match_id=?",
    [matchId]
  );

if(existing&&!FORCE){
  console.log(`[hampalyzer] ${matchId} already imported`);
  db.close();
  return;
}

if(FORCE){
  await runDb("DELETE FROM match_kill_events WHERE match_id=?",[matchId]);
  await runDb("DELETE FROM match_round_mvps WHERE match_id=?",[matchId]);
  await runDb("DELETE FROM match_player_round_stats WHERE match_id=?",[matchId]);
  await runDb("DELETE FROM match_rounds WHERE match_id=?",[matchId]);
  await runDb("DELETE FROM match_cap_events WHERE match_id=?",[matchId]);
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
  const matchRoundData=parseMatchRoundData(mainHtml);
  const capEvents = parseFlagPace(mainHtml);
  const importedRoundNums=new Set(matchRoundData.rounds.map(round=>round.round_num));
  const teamMembership=parseTeamMembership(mainHtml);
  const roundSummaryByHampId=matchRoundData.playerStats||{};
  const roundInfoByNum={};
  for(const round of matchRoundData.rounds){
    roundInfoByNum[round.round_num]=round;
  }

  const roundDurations={};
  const playerIdentityByHampId={};
  const playersForRoster=[];

  for(let i=0;i<links.length;i++){
    const p=links[i];
    const accountId=Number(p.playerId);
    const fallbackSteam=`STEAM_0:${accountId%2}:${Math.floor(accountId/2)}`;
    const steam=steamIds[i]||fallbackSteam;
    playersForRoster.push({
      hamp_id:p.playerId,
      player_key:steam,
      steam_id:steam,
      discord_id:await getDiscordIdForSteam(steam),
      display_name:null,
      nav_name:p.navName||null,
      team_name:teamMembership[p.playerId]||null
    });
  }

  const rosterByHampId=Object.fromEntries(playersForRoster.map(p=>[p.hamp_id,p]));

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
    if(rosterByHampId[p.playerId]){
      rosterByHampId[p.playerId].display_name=stats.display_name;
    }
    const accountId=Number(p.playerId);
    const fallbackSteam=`STEAM_0:${accountId%2}:${Math.floor(accountId/2)}`;
    const steam=steamIds[i]||fallbackSteam;
    const playerKey=steam;
    playerIdentityByHampId[p.playerId]={
      player_key:playerKey,
      steam_id:steam,
      display_name:stats.display_name
    };
    const flags=flagStats[p.playerId]||{};
    const playerRoundStats=parseRoundStats(html);
    const classSecondsByRound={};

    for(const c of stats.classes){
      classSecondsByRound[c.round_num]=(classSecondsByRound[c.round_num]||0)+c.seconds;
    }
    for(const [roundNum,seconds] of Object.entries(classSecondsByRound)){
      roundDurations[roundNum]=Math.max(roundDurations[roundNum]||0,seconds);
    }

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

    const nameRoster=buildNameRoster(playersForRoster);
    const attackerDiscordId=rosterByHampId[p.playerId]?rosterByHampId[p.playerId].discord_id:null;

    for(const ev of stats.kill_events){
      if(importedRoundNums.size&&!importedRoundNums.has(ev.round_num))continue;

      const roundSummary=(roundSummaryByHampId[p.playerId]||{})[ev.round_num]||{};
      const roundInfo=roundInfoByNum[ev.round_num]||{};
      const attackerTeam=roundSummary.team_name||teamMembership[p.playerId]||null;
      const attackerRole=roundSummary.role||null;

      const victim=resolveVictimByName(ev.victim_name,nameRoster);
      const victimTeam=victim?victim.team_name:null;

      await runDb(
        `INSERT INTO match_kill_events
        (match_id,source_url,round_num,event_time_seconds,event_time_text,
         attacker_key,attacker_steam_id,attacker_discord_id,attacker_name,attacker_team,attacker_role,
         attacker_class,attacker_class_confidence,weapon,
         victim_name,victim_key,victim_steam_id,victim_discord_id,victim_team,
         is_enemy_kill,is_team_kill,is_conced,is_flag_carrier_kill,source_confidence)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          matchId,url,ev.round_num,ev.event_time_seconds,ev.event_time_text,
          playerKey,steam,attackerDiscordId,stats.display_name,attackerTeam,attackerRole,
          ev.attacker_class,ev.attacker_class_confidence,ev.weapon,
          ev.victim_name,
          victim?victim.player_key:null,
          victim?victim.steam_id:null,
          victim?victim.discord_id:null,
          victimTeam,
          1,
          0,
          ev.is_conced||0,
          ev.is_flag_carrier_kill||0,
          victim?"exact":"victim_name_unresolved"
        ]
      );
    }

    for(const detail of playerRoundStats){
      if(importedRoundNums.size&&!importedRoundNums.has(detail.round_num))continue;

      const summary=(matchRoundData.playerStats[p.playerId]||{})[detail.round_num]||{};
      const row={...detail,...summary};

      await runDb(
        `INSERT OR REPLACE INTO match_player_round_stats
        (match_id,player_key,steam_id,display_name,round_num,team_name,role,
         kills,team_kills,conced_kills,sentry_kills,deaths_by_enemy,deaths_by_team,suicides,
         enemy_damage,team_damage,damage_taken_enemy,damage_taken_team,self_damage,conc_jumps,
         flag_captures,flag_touches,initial_touches,flag_time_seconds,objectives,toss_percent)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          matchId,playerKey,steam,stats.display_name,detail.round_num,
          row.team_name||null,row.role||null,
          row.kills||0,row.team_kills||0,row.conced_kills||0,row.sentry_kills||0,
          row.deaths_by_enemy||0,row.deaths_by_team||0,row.suicides||0,
          row.enemy_damage||0,row.team_damage||0,
          row.damage_taken_enemy||0,row.damage_taken_team||0,row.self_damage||0,row.conc_jumps||0,
          row.flag_captures||0,row.flag_touches||0,row.initial_touches||0,
          row.flag_time_seconds||0,row.objectives||0,
          row.toss_percent==null?null:row.toss_percent
        ]
      );
    }

    console.log(`Imported ${stats.display_name} ${steam}`);
  }

  for(const round of matchRoundData.rounds){
    await runDb(
      `INSERT OR REPLACE INTO match_rounds
       (match_id,round_num,map_name,duration_seconds,team1_score,team2_score,offense_team,defense_team)
       VALUES(?,?,?,?,?,?,?,?)`,
      [
        matchId,round.round_num,matchRoundData.map_name,
        roundDurations[round.round_num]||matchRoundData.fallback_duration_seconds||0,
        round.team1_score,round.team2_score,round.offense_team,round.defense_team
      ]
    );
  }

  for(const mvp of matchRoundData.mvps){
    const identity=playerIdentityByHampId[mvp.player_id]||{};
    await runDb(
      `INSERT OR REPLACE INTO match_round_mvps
       (match_id,round_num,mvp_display_name,mvp_player_key,steam_id)
       VALUES(?,?,?,?,?)`,
      [
        matchId,
        mvp.round_num,
        identity.display_name||mvp.mvp_display_name||null,
        identity.player_key||null,
        identity.steam_id||null
      ]
    );
  }

  for(const cap of capEvents){
    await runDb(
      `INSERT OR REPLACE INTO match_cap_events
       (match_id, source_url, team, cap_num, time_seconds, time_text, score_after)
       VALUES(?,?,?,?,?,?,?)`,
      [
        matchId,
        url,
        cap.team,
        cap.cap_num,
        cap.time_seconds,
        cap.time_text,
        cap.score_after
      ]
    );
  }

  console.log(`[hampalyzer] Imported ${capEvents.length} cap timeline events for ${matchId}`);

  await runDb("COMMIT");
  
  const matchRow = await getDb(
	  "SELECT tfcstats_url FROM matches WHERE match_id=?",
	  [matchId]
	);

	if (matchRow?.tfcstats_url?.trim()) {
	  try {
		console.log(`[hampalyzer] Running TFCStats cap enrichment for ${matchId}`);

		execFileSync(
		  "node",
		  [
			"/root/tfcbot/importTfcstatsCaps.js",
			matchId,
			matchRow.tfcstats_url,
			"--force"
		  ],
		  { stdio: "inherit" }
		);

		console.log(`[hampalyzer] TFCStats cap enrichment complete`);
	  } catch (e) {
		if (e.status === 2) {
		  console.log(
			`[hampalyzer] TFCStats cap enrichment skipped for ${matchId}: timeline mismatch`
		  );
		} else {
		  console.error(
			`[hampalyzer] TFCStats cap enrichment failed for ${matchId}:`,
			e.message
		  );
		}
	  }
	}

	db.close();
	console.log(`Done. Imported ${links.length} players for ${matchId}`);
  
})().catch(async err=>{
  console.error(err);
  try{await runDb("ROLLBACK");}catch{}
  db.close();
  process.exit(1);
});
