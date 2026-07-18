"use strict";

const { EmbedBuilder } = require("discord.js");
const { isAdmin } = require("../lib/guards");
const servers = require("../servers.json");

const SERVERS = servers.map(s => ({
  name: s.name,
  url: `http://${s.ip.split(":")[0]}:7010/health`
}));

async function getHealth(server){
  const res = await fetch(server.url,{
    signal:AbortSignal.timeout(3000)
  });

  if(!res.ok){
    throw new Error(`HTTP ${res.status}`);
  }

  return await res.json();
}

const REGIONS = ["east", "central", "west"];

function getRegion(value){
  const normalized=String(value||"").toLowerCase();
  return REGIONS.find(region => normalized.includes(region));
}

function displayServerName(server,h){
  const expectedRegion=getRegion(server.name);
  const reportedName=h.server||"unknown";
  const reportedRegion=getRegion(reportedName);

  // A health agent can be cloned with a stale server name. Do not let one
  // region identify itself as another region in the combined status embed.
  if(expectedRegion && reportedRegion && expectedRegion!==reportedRegion){
    return expectedRegion.toUpperCase();
  }

  return reportedName;
}

function statusLine(server,h){

  const udp=h.udp||{};

const bad =
  Number(udp.packet_receive_errors || 0) > 0 ||
  Number(udp.receive_buffer_errors || 0) > 0 ||
  Number(udp.send_buffer_errors || 0) > 0 ||
  Number(h.hlds?.cpu || 0) > 75;

  const icon=bad?"🔴":"🟢";

  return [
`${icon} ${displayServerName(server,h)}`,
`Uptime: \`${h.uptime||"n/a"}\``,
`Load: \`${h.load||"n/a"}\``,
`Memory: \`${h.memory||"n/a"}\``,
`HLDS: \`${h.hlds?.running||0}\` running`,
`CPU: \`${h.hlds?.cpu||0}%\`  MEM: \`${h.hlds?.mem||0}%\``,
`UDP RX/TX: \`${udp.packets_received||0}/${udp.packets_sent||0}\``,
`UDP ERR: \`${udp.packet_receive_errors||0}\``,
`RXBUF: \`${udp.receive_buffer_errors||0}\``,
`TXBUF: \`${udp.send_buffer_errors||0}\``
  ].join("\n");

}

module.exports={

  name:"serverhealth",
  description:"Show server health",

  async execute(message,args,deps){

    if(!isAdmin(message,deps?.config)){
      return;
    }

    const fields=[];

    for(const server of SERVERS){

      try{

        const health=await getHealth(server);

        fields.push({
          name:server.name,
          value:statusLine(server,health),
          inline:true
        });

      }catch(err){

        fields.push({
          name:server.name,
          value:`🔴 Failed\n\`${err.message}\``,
          inline:true
        });

      }

    }

    const embed=new EmbedBuilder()
      .setTitle("🖥️ Server Health")
      .setColor(0x72d8ff)
      .setTimestamp()
      .addFields(fields);

    await message.channel.send({
      embeds:[embed]
    });

  }

};

module.exports._private={ displayServerName, statusLine };
