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

function statusLine(h){

  const udp=h.udp||{};

const bad =
  Number(udp.packet_receive_errors || 0) > 0 ||
  Number(udp.receive_buffer_errors || 0) > 0 ||
  Number(udp.send_buffer_errors || 0) > 0 ||
  Number(h.hlds?.cpu || 0) > 75;

  const icon=bad?"🔴":"🟢";

  return [
`${icon} ${h.server||"unknown"}`,
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
          value:statusLine(health),
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
