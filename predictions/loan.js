'use strict';
function register(registry,service){registry.set('loan',async(message,args)=>{
 if(!message.guild||!service.config.predictionsOwnerId||String(message.author.id)!==service.config.predictionsOwnerId)return;
 const match=/^(?:<@!?(\d{15,22})>|(\d{15,22}))$/.exec(args[0]||''),amount=/^[1-9]\d*$/.test(args[1]||'')?Number(args[1]):NaN;
 const send=content=>message.channel.send({content,allowedMentions:{parse:[]}});
 if(!match||!Number.isSafeInteger(amount))return send('Usage: !loan <Discord ID|@player> <positive whole points>');
 try{const user=match[1]||match[2],r=service.store.issueLoan(user,amount,{operationKey:`loan:${message.id}`,actorId:String(message.author.id),now:service.clock()});return send(`🏦 Loaned **${r.amount.toLocaleString('en-US')} points** to <@${user}>. Interest: **${r.interestAdded.toLocaleString('en-US')} points**. Future winning profit automatically repays the loan.`);}
 catch(e){return send(/^Loan exceeds the limit/.test(e.message)?e.message:'Unable to issue loan. Check the amount and try again.');}
 });}
module.exports={register};
