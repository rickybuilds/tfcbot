"use strict";

const fs = require("fs");
const path = require("path");

const SUPPORTERS_PATH =
 path.resolve(process.cwd(), "supporters.json");

function getSupporters(){
 try{
   return JSON.parse(
     fs.readFileSync(SUPPORTERS_PATH,"utf8")
   );
 }catch{
   return [];
 }
}

function supporterBadge(id){
 return getSupporters().includes(String(id))
   ? " 💎"
   : "";
}

module.exports = {
 supporterBadge
};