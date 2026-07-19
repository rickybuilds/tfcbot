"use strict";

const fs = require("fs");
const path = require("path");

const SUPPORTERS_PATH =
 path.resolve(process.cwd(), "supporters.json");

function loadSupporters({ initialize = false } = {}){
 try{
   if(initialize && !fs.existsSync(SUPPORTERS_PATH)) fs.writeFileSync(SUPPORTERS_PATH, "[]\n");
   return JSON.parse(
     fs.readFileSync(SUPPORTERS_PATH,"utf8")
   );
 }catch{
   return [];
 }
}

function saveSupporters(ids){
 fs.writeFileSync(SUPPORTERS_PATH, JSON.stringify(ids.map(String), null, 2) + "\n");
}

function supporterBadge(id){
 return loadSupporters().includes(String(id))
   ? " 💎"
   : "";
}

module.exports = {
 loadSupporters,
 saveSupporters,
 supporterBadge
};
