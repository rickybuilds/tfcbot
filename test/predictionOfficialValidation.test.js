"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const official=()=>require('../predictions/official');
const snapshot=()=>({blueIds:['b1','b2','b3','b4'],redIds:['r1','r2','r3','r4'],mapName:'shutdown2',serverKey:'east'});
const row=()=>({blue_ids:JSON.stringify(['b3','b1','b4','b2']),red_ids:JSON.stringify(['r1','r2','r3','r4']),map_name:' SHUTDOWN2 ',server_name:'TFC East US Server'});

test('official terms accept reordered identities and canonical nonempty map and server aliases',()=>{
 const {sameMap,officialTermsMismatch}=official();assert.equal(sameMap(' SHUTDOWN2 ','shutdown2'),true);assert.equal(sameMap('',' '),false);
 assert.equal(officialTermsMismatch(row(),snapshot()),null);
 assert.equal(officialTermsMismatch({...row(),server_name:'east'},snapshot()),null);
});

test('official terms reject incomplete, duplicate and empty roster identities even if frozen data agrees',()=>{
 const {officialTermsMismatch}=official();
 for(const ids of [['b1','b2','b3'],['b1','b1','b3','b4'],['b1','b2','b3',''],['b1','b2','b3','r1']]){
  assert.equal(officialTermsMismatch({...row(),blue_ids:JSON.stringify(ids)},{...snapshot(),blueIds:ids}),'teams');
 }
 assert.equal(officialTermsMismatch({...row(),blue_ids:'not json'},snapshot()),'teams');
});

test('accepting changed maps never accepts absent maps or unknown, missing and conflicting servers',t=>{
 const servers=require('../config/rcon'),previous=servers.validation_other;servers.validation_other={host:'127.0.0.250',port:27015,name:'Validation Other Server'};t.after(()=>{if(previous===undefined)delete servers.validation_other;else servers.validation_other=previous;});
 const {officialTermsMismatch}=official();
 assert.equal(officialTermsMismatch({...row(),map_name:'different_map'},snapshot()),'map');
 assert.equal(officialTermsMismatch({...row(),map_name:'different_map'},snapshot(),{allowMapChange:true}),null);
 for(const map of ['',null,' '])assert.equal(officialTermsMismatch({...row(),map_name:map},snapshot(),{allowMapChange:true}),'map');
 for(const server of ['',null,'unrecognized server','Validation Other Server','127.0.0.250:27015'])assert.equal(officialTermsMismatch({...row(),server_name:server},snapshot(),{allowMapChange:true}),'server');
 assert.equal(officialTermsMismatch(row(),{...snapshot(),serverKey:''}),'server');
 assert.equal(officialTermsMismatch(row(),{...snapshot(),serverKey:'unrecognized server'}),'server');
});
