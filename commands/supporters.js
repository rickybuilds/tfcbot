"use strict";

const fs = require("fs");
const path = require("path");

const OWNER_ID = "255834576742645761";
const SUPPORTERS_PATH = path.resolve(process.cwd(), "supporters.json");

function loadSupporters(){
  try{
    if(!fs.existsSync(SUPPORTERS_PATH)) fs.writeFileSync(SUPPORTERS_PATH, "[]\n");
    return JSON.parse(fs.readFileSync(SUPPORTERS_PATH, "utf8"));
  }catch{
    return [];
  }
}

function saveSupporters(ids){
  fs.writeFileSync(SUPPORTERS_PATH, JSON.stringify(ids.map(String), null, 2) + "\n");
}

function getTargetId(message,args){
  const mentioned = message.mentions.users.first();
  if(mentioned) return mentioned.id;

  const raw = args[0];
  if(!raw) return null;

  const cleaned = raw.replace(/[<@!>]/g, "");
  return /^\d{15,25}$/.test(cleaned) ? cleaned : null;
}

module.exports = {
  name:"addsupport",
  description:"Manage supporters",

  async execute(message,args){
    if(message.author.id !== OWNER_ID) return;

    const sub = (args[0] || "").toLowerCase();
    const remove = sub === "remove" || sub === "delete" || sub === "del";
    const id = getTargetId(message, remove ? args.slice(1) : args);

    if(!id){
      return message.reply(remove ? "Usage: `!addsupport remove @user`" : "Usage: `!addsupport @user`");
    }

    const supporters = loadSupporters().map(String);

    if(remove){
      if(!supporters.includes(id)) return message.reply("That user is not currently a supporter.");
      saveSupporters(supporters.filter(x => x !== id));
      return message.reply(`Removed <@${id}> from Server Supporters.`);
    }

    if(supporters.includes(id)) return message.reply("Already a supporter 💎");

    supporters.push(id);
    saveSupporters(supporters);

    return message.reply(`Added <@${id}> as a Server Supporter 💎`);
  }
};