const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const MAX_PLAYERS = 6;
const START_GOLD = 10;
const ROUND_MS = 180000;

const makeCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
};
const publicRoom = room => ({
  code: room.code, phase: room.phase, round: room.round,
  deadline: room.deadline, hostName: room.hostName,
  players: [...room.players.values()].map(p => ({
    id: p.id, name: p.name, gold: p.gold, alive: p.alive,
    ready: !!p.choice, usedDouble: p.usedDouble,
    defendedLastRound: p.defendedLastRound,
    submitted: !!p.choice
  })),
  history: room.history.slice(-12),
  lastResult: room.lastResult,
  winner: room.winner
});
function broadcast(room) { io.to(room.code).emit("room:update", publicRoom(room)); }
function clearTimer(room) { if (room.timer) clearTimeout(room.timer); room.timer = null; }
function startRound(room) {
  clearTimer(room);
  room.phase = "choosing";
  room.deadline = Date.now() + ROUND_MS;
  for (const p of room.players.values()) p.choice = null;
  broadcast(room);
  room.timer = setTimeout(() => resolveRound(room), ROUND_MS);
}
function finishGame(room) {
  room.phase = "finished";
  room.deadline = null;
  const alive = [...room.players.values()].filter(p => p.alive);
  const pool = alive.length ? alive : [...room.players.values()];
  const max = Math.max(...pool.map(p => p.gold));
  room.winner = pool.filter(p => p.gold === max).map(p => p.name);
  broadcast(room);
}
function resolveRound(room) {
  if (room.phase !== "choosing") return;
  clearTimer(room);
  const alive = [...room.players.values()].filter(p => p.alive);
  const deltas = new Map(alive.map(p => [p.id, 0]));
  const choices = new Map();
  for (const p of alive) {
    // Timeout = no action. It has no defensive/reflection effect.
    choices.set(p.id, p.choice || { action: "none", targetId: null, double: false });
  }

  // Resolve attacks and reflections simultaneously from the submitted choices.
  for (const p of alive) {
    const c = choices.get(p.id);
    if (c.action === "attack") {
      const target = room.players.get(c.targetId);
      if (!target || !target.alive || target.id === p.id) continue;
      const tc = choices.get(target.id);
      if (tc.action === "defend" || tc.action === "reflect") continue;
      deltas.set(p.id, deltas.get(p.id) + (c.double ? 2 : 1));
      deltas.set(target.id, deltas.get(target.id) - 1);
    }
  }
  for (const p of alive) {
    const c = choices.get(p.id);
    if (c.action !== "reflect") continue;
    const attackers = alive.filter(a => {
      const ac = choices.get(a.id);
      return ac.action === "attack" && ac.targetId === p.id;
    });
    if (attackers.length === 0) {
      deltas.set(p.id, deltas.get(p.id) - 2);
    } else {
      for (const attacker of attackers) {
        deltas.set(p.id, deltas.get(p.id) + (c.double ? 2 : 1));
        deltas.set(attacker.id, deltas.get(attacker.id) - 1);
      }
    }
  }

  const report = [];
  for (const p of alive) {
    const c = choices.get(p.id);
    const delta = deltas.get(p.id);
    p.gold = Math.max(0, p.gold + delta);
    if (c.action === "defend") p.defendedLastRound = true;
    else p.defendedLastRound = false;
    if (c.double) p.usedDouble = true;
    report.push({
      name: p.name, action: c.action, targetName: c.action === "attack" ? (room.players.get(c.targetId)?.name || "알 수 없음") : null,
      delta, gold: p.gold, eliminated: p.gold === 0
    });
    if (p.gold === 0) p.alive = false;
  }
  room.lastResult = { round: room.round, report };
  room.history.push({ round: room.round, report });
  room.deadline = null;

  if (room.round >= 10 || [...room.players.values()].every(p => !p.alive)) {
    finishGame(room);
  } else {
    room.phase = "result";
    broadcast(room);
  }
}
io.on("connection", socket => {
  socket.on("room:create", ({ name }, cb) => {
    name = String(name || "").trim().slice(0, 14);
    if (!name) return cb?.({ error: "닉네임을 입력해 주세요." });
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    const room = {
      code, hostId: socket.id, hostName: name, players: new Map(),
      phase: "lobby", round: 0, deadline: null, timer: null,
      history: [], lastResult: null, winner: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "host";
    cb?.({ code, role: "host" });
    broadcast(room);
  });
  socket.on("room:join", ({ code, name }, cb) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 14);
    const room = rooms.get(code);
    if (!room) return cb?.({ error: "방을 찾을 수 없습니다." });
    if (!name) return cb?.({ error: "닉네임을 입력해 주세요." });
    if (room.phase !== "lobby") return cb?.({ error: "이미 게임이 시작된 방입니다." });
    if (room.players.size >= MAX_PLAYERS) return cb?.({ error: "플레이어는 최대 6명까지 참가할 수 있습니다." });
    if ([...room.players.values()].some(p => p.name === name)) return cb?.({ error: "이미 사용 중인 닉네임입니다." });
    room.players.set(socket.id, {
      id: socket.id, name, gold: START_GOLD, alive: true,
      usedDouble: false, defendedLastRound: false, choice: null
    });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "player";
    cb?.({ code, role: "player" });
    broadcast(room);
  });
  socket.on("game:start", cb => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "host" || room.hostId !== socket.id) return cb?.({ error: "방장만 시작할 수 있습니다." });
    if (room.phase !== "lobby" || room.players.size < 2) return cb?.({ error: "게임을 시작하려면 플레이어가 2명 이상 필요합니다." });
    room.round = 1;
    startRound(room);
    cb?.({ ok: true });
  });
  socket.on("choice:submit", (choice, cb) => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.id);
    if (!room || !p || room.phase !== "choosing" || !p.alive) return cb?.({ error: "지금은 선택할 수 없습니다." });
    if (p.choice) return cb?.({ error: "이미 선택을 완료했습니다." });
    const action = ["attack", "defend", "reflect"].includes(choice?.action) ? choice.action : null;
    if (!action) return cb?.({ error: "행동을 선택해 주세요." });
    if (action === "defend" && p.defendedLastRound) return cb?.({ error: "방어는 연속으로 사용할 수 없습니다." });
    let targetId = null;
    if (action === "attack") {
      targetId = String(choice.targetId || "");
      const target = room.players.get(targetId);
      if (!target || !target.alive || target.id === p.id) return cb?.({ error: "공격 대상을 다시 선택해 주세요." });
    }
    const useDouble = !!choice.double;
    if (useDouble && p.usedDouble) return cb?.({ error: "더블은 게임에서 한 번만 사용할 수 있습니다." });
    p.choice = { action, targetId, double: useDouble };
    broadcast(room);
    cb?.({ ok: true });
    const living = [...room.players.values()].filter(x => x.alive);
    if (living.every(x => !!x.choice)) resolveRound(room);
  });
  socket.on("round:next", cb => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== "host" || room.hostId !== socket.id) return cb?.({ error: "방장만 진행할 수 있습니다." });
    if (room.phase !== "result") return cb?.({ error: "결과 확인 단계가 아닙니다." });
    room.round += 1;
    startRound(room);
    cb?.({ ok: true });
  });
  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    if (socket.data.role === "player") {
      const p = room.players.get(socket.id);
      if (p && room.phase === "lobby") room.players.delete(socket.id);
      // During a game, a disconnected player remains in the match; their turn times out as no action.
    } else if (socket.data.role === "host" && room.hostId === socket.id) {
      room.hostDisconnected = true;
    }
    broadcast(room);
    if (room.players.size === 0 && room.phase === "lobby") rooms.delete(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Yak-tal game running on http://localhost:${PORT}`));
