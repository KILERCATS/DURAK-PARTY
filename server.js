const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ok:true}));
const rooms = new Map();
const suits = ['♠','♥','♦','♣'];
const rankNames = ['6','7','8','9','10','В','Д','К','Т'];
const newDeck = () => suits.flatMap(suit => rankNames.map((rank, value) => ({id: suit+rank, suit, rank, value})));
const shuffle = a => {for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;};
const fail = (socket, message) => socket.emit('errorMessage', message);
function start(room) {
  const deck = shuffle(newDeck());
  room.deck = deck; room.trump = deck[0].suit; room.trumpCard = {...deck[0]};
  room.hands = [[],[]]; for (let n=0;n<6;n++) for(let p=0;p<2;p++) room.hands[p].push(deck.pop());
  const vals = room.hands.map(hand=>Math.min(...hand.filter(c=>c.suit===room.trump).map(c=>c.value), 99));
  room.attacker = vals[0]===vals[1] ? crypto.randomInt(2) : (vals[0]<vals[1]?0:1);
  room.table=[]; room.maxAttack=6; room.started=true; room.finished=false; room.winner=null; room.message='Игра началась!';
}
function checkEnd(room) {
  if(room.deck.length) return false;
  const empty = room.hands.map(x=>x.length===0);
  if(empty[0]&&empty[1]) {room.finished=true;room.winner='Ничья';}
  else if(empty[0]||empty[1]) {room.finished=true;room.winner=empty[0]?room.players[0].name:room.players[1].name;}
  return room.finished;
}
function replenish(room) {
  for (const p of [room.attacker, 1-room.attacker]) while(room.deck.length && room.hands[p].length<6) room.hands[p].push(room.deck.pop());
}
function view(room, pos) {
  return {code:room.code, me:pos, players:room.players.map((p,i)=>({name:p.name, online:!!p.socketId, count:room.hands?.[i]?.length||0})),
    started:!!room.started, finished:!!room.finished, winner:room.winner, deckCount:room.deck?.length||0,
    trump:room.trump, trumpCard:room.trumpCard, hand:room.hands?.[pos]||[], table:room.table||[],
    attacker:room.attacker, defender:1-room.attacker, maxAttack:room.maxAttack, message:room.message};
}
function broadcast(room) {room.players.forEach((p,i)=>{if(p.socketId)io.to(p.socketId).emit('state',view(room,i));});}
function getSeat(socket, code) {
  const room = rooms.get(code);
  if(!room) {fail(socket,'Комната не найдена.');return null;}
  const pos=room.players.findIndex(p=>p.socketId===socket.id);
  if(pos<0) {fail(socket,'Вы не участник комнаты.');return null;}
  return {room,pos};
}
function generateCode() {let c;do{c=crypto.randomBytes(3).toString('hex').toUpperCase();}while(rooms.has(c));return c;}
io.on('connection',socket=>{
  socket.on('create', (data={})=>{
    const code=generateCode(), token=crypto.randomBytes(20).toString('hex');
    const room={code, players:[{name:cleanName(data.name),token,socketId:socket.id}],started:false,table:[],hands:[[],[]]};
    rooms.set(code,room);socket.join(code);socket.emit('joined',{code,token});broadcast(room);
  });
  socket.on('join',(data={})=>{
    const code=String(data.code||'').trim().toUpperCase();const room=rooms.get(code);
    if(!room)return fail(socket,'Комната не найдена или сервер был перезапущен.');
    let pos=room.players.findIndex(p=>p.token===data.token && data.token);
    if(pos===-1){if(room.players.length>=2)return fail(socket,'Комната уже заполнена.');
      const token=crypto.randomBytes(20).toString('hex');pos=room.players.length;
      room.players.push({name:cleanName(data.name),token,socketId:socket.id});socket.emit('joined',{code,token});
    }else {const old=room.players[pos].socketId; if(old&&old!==socket.id)io.sockets.sockets.get(old)?.leave(code);
      room.players[pos].socketId=socket.id;socket.emit('joined',{code,token:room.players[pos].token});}
    socket.join(code); if(room.players.length===2&&!room.started)start(room);broadcast(room);
  });
  socket.on('play',({code,id,defendId}={})=>{
    const seat=getSeat(socket,code);if(!seat)return;
    const {room,pos}=seat;if(!room.started||room.finished)return;
    const hand=room.hands[pos],idx=hand.findIndex(c=>c.id===id);
    if(idx<0)return fail(socket,'У вас нет этой карты.');
    const card=hand[idx];
    if(pos===room.attacker){
      const limit=Math.min(6,room.maxAttack);
      if(room.table.length>=limit)return fail(socket,'Больше подкидывать нельзя.');
      if(room.table.length>0&&!room.table.some(t=>t.attack.rank===card.rank || t.defense?.rank===card.rank))return fail(socket,'Подкидывать можно только уже встречавшееся достоинство.');
      hand.splice(idx,1);room.table.push({attack:card,defense:null});room.message='Ход защитника';
    } else {
      const item=room.table.find(t=>t.attack.id===defendId&&!t.defense);
      if(!item)return fail(socket,'Выберите непокрытую карту на столе.');
      if(!(card.suit===item.attack.suit&&card.value>item.attack.value || card.suit===room.trump&&item.attack.suit!==room.trump))return fail(socket,'Этой картой нельзя отбиться.');
      hand.splice(idx,1);item.defense=card;room.message='Можно подкинуть или завершить раунд';
    }
    broadcast(room);
  });
  socket.on('resolve',({code,action}={})=>{
    const seat=getSeat(socket,code);if(!seat)return;
    const {room,pos}=seat;if(!room.started||room.finished||!room.table.length)return;
    const allCovered=room.table.every(t=>t.defense);
    if(action==='take'){
      if(pos!==1-room.attacker)return fail(socket,'Взять карты может только защитник.');
      room.hands[pos].push(...room.table.flatMap(t=>[t.attack,t.defense].filter(Boolean)));
      room.table=[];replenish(room);room.message='Защитник взял карты. Атакующий ходит снова.';
    }else if(action==='beat'){
      if(pos!==room.attacker||!allCovered)return fail(socket,'Для отбоя все карты должны быть покрыты, а атакующий должен подтвердить.');
      room.table=[];replenish(room);room.attacker=1-room.attacker;room.message='Бито! Ход переходит другому игроку.';
    }else return;
    checkEnd(room);room.maxAttack=Math.min(6,room.hands[1-room.attacker].length);broadcast(room);
  });
  socket.on('restart',({code}={})=>{const seat=getSeat(socket,code);if(!seat)return; if(seat.room.players.length!==2)return;start(seat.room);broadcast(seat.room);});
  socket.on('disconnect',()=>{for(const room of rooms.values()){const p=room.players.find(p=>p.socketId===socket.id);if(p){p.socketId=null;broadcast(room);}}});
});
function cleanName(name) {return String(name||'Игрок').trim().slice(0,24)||'Игрок';}
httpServer.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('Durak Party ready'));
