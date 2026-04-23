const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 15;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// Generate a QR code SVG for any text (used on the TV screen to show the join link)
app.get("/qr", async (req, res) => {
  const text = String(req.query.text || "").slice(0, 500);
  if (!text) return res.status(400).send("missing text");
  try {
    const svg = await QRCode.toString(text, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      color: { dark: "#0d2f6f", light: "#ffffff" },
    });
    res.set("Content-Type", "image/svg+xml");
    res.set("Cache-Control", "public, max-age=300");
    res.send(svg);
  } catch (err) {
    res.status(500).send("qr error");
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---------- Menu ----------
// Foods need a list of ingredients. Drinks are made by picking cup + drink.
const MENU = {
  foods: {
    burger: {
      id: "burger",
      name: "Burger",
      icon: "🍔",
      ingredients: ["bottom_bun", "patty", "lettuce", "tomato", "top_bun"],
    },
    cheeseburger: {
      id: "cheeseburger",
      name: "Cheeseburger",
      icon: "🧀🍔",
      ingredients: ["bottom_bun", "patty", "cheese", "lettuce", "top_bun"],
    },
    hotdog: {
      id: "hotdog",
      name: "Hot Dog",
      icon: "🌭",
      ingredients: ["bottom_bun", "sausage", "top_bun"],
    },
    fries: {
      id: "fries",
      name: "Fries",
      icon: "🍟",
      ingredients: ["basket", "potato", "salt"],
    },
  },
  drinks: {
    coffee: { id: "coffee", name: "Coffee", icon: "☕", needsCup: true },
    tea: { id: "tea", name: "Tea", icon: "🍵", needsCup: true },
    juice: { id: "juice", name: "Juice", icon: "🧃", needsCup: true },
    water: { id: "water", name: "Water", icon: "💧", needsCup: true },
  },
  // All ingredients that the cook's palette might display, including ones
  // that don't belong in any particular recipe — those act as distractors.
  ingredients: {
    bottom_bun: { id: "bottom_bun", name: "Bottom Bun", icon: "🍞" },
    top_bun:    { id: "top_bun",    name: "Top Bun",    icon: "🥖" },
    patty:      { id: "patty",      name: "Patty",      icon: "🥩" },
    cheese:     { id: "cheese",     name: "Cheese",     icon: "🧀" },
    lettuce:    { id: "lettuce",    name: "Lettuce",    icon: "🥬" },
    tomato:     { id: "tomato",     name: "Tomato",     icon: "🍅" },
    sausage:    { id: "sausage",    name: "Sausage",    icon: "🌭" },
    basket:     { id: "basket",     name: "Basket",     icon: "🧺" },
    potato:     { id: "potato",     name: "Potato",     icon: "🥔" },
    salt:       { id: "salt",       name: "Salt",       icon: "🧂" },
  },
};

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const CUSTOMER_NAMES = [
  "Margaret", "Harold", "Beatrice", "Raymond", "Dorothy", "Walter",
  "Eleanor", "Arthur", "Gloria", "Vincent", "Mabel", "Stanley",
  "Iris", "Clifford", "Pearl", "Bernard",
];

const CUSTOMER_FACES = ["👵", "👴", "🧓", "👩‍🦳", "👨‍🦳"];

const CUSTOMER_PHRASES = [
  "I'm ready for something delicious!",
  "Morning! I'm a little peckish today.",
  "Oh, everything looks wonderful here.",
  "Just what the doctor ordered!",
  "I've been looking forward to this.",
  "My usual, please!",
  "Do you have anything warm today?",
  "Just a little something, please.",
  "I'll have the special today.",
  "This place is my favourite!",
  "Something sweet would be lovely.",
  "So happy to be out and about.",
  "Whatever's freshest, please.",
  "My, it smells wonderful in here.",
  "A little treat before I head home.",
];

// ---------- Rooms ----------
const rooms = new Map();

function makeRoomCode() {
  // 4 letter uppercase code, avoid easily confused chars
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 4; i++) out += letters[Math.floor(Math.random() * letters.length)];
  return out;
}

function uniqueRoomCode() {
  let code;
  do { code = makeRoomCode(); } while (rooms.has(code));
  return code;
}

function newRoom(code, hostSocketId) {
  return {
    code,
    hostId: hostSocketId,
    started: false,
    players: new Map(), // socketId -> Player
    customerCounter: 0, // room-wide monotonic counter for unique customer ids
    orderCounter: 0,
  };
}

function newPlayer(id, name) {
  return {
    id,
    name,
    served: 0,       // guests delivered
    score: 0,        // total points earned (with tips)
    streak: 0,       // consecutive deliveries without a "left"
    bestStreak: 0,
    left: 0,         // guests who walked off
    wave: 1,         // personal wave
    waveProgress: 0, // deliveries toward next wave up
    customer: null,  // current guest (null before start / between guests)
    order: null,
  };
}

// Patience budget (ms) for the current wave. Generous at wave 1, never
// tighter than a minute — elderly players still have plenty of time even
// at the hardest wave.
function patienceForWave(wave) {
  return Math.max(60000, 100000 - (wave - 1) * 10000);
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    served: p.served,
    score: p.score,
    streak: p.streak,
    bestStreak: p.bestStreak,
    left: p.left,
    wave: p.wave,
    customer: p.customer ? {
      id: p.customer.id,
      name: p.customer.name,
      face: p.customer.face,
      phrase: p.customer.phrase,
      vip: p.customer.vip,
      status: p.customer.status,
      foodOrder: p.customer.foodOrder,
      drinkOrder: p.customer.drinkOrder,
      patienceLeft: Math.max(0, p.customer.expiresAt - Date.now()),
      patienceMax: p.customer.patienceMax,
    } : null,
    order: p.order ? {
      id: p.order.id,
      food: p.order.food,
      foodProgress: p.order.foodProgress,
      foodDone: p.order.foodDone,
      ingredientOrder: p.order.ingredientOrder,
      drink: p.order.drink,
      drinkProgress: p.order.drinkProgress,
      drinkDone: p.order.drinkDone,
      status: p.order.status,
    } : null,
  };
}

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    players: [...room.players.values()].map(publicPlayer),
    menu: MENU,
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", publicState(room));
}

function pickRandom(obj) {
  const keys = Object.keys(obj);
  return obj[keys[Math.floor(Math.random() * keys.length)]];
}

// Spawn a new guest for THIS player only (concurrent competitive play:
// each player has their own queue and races against the others).
function spawnForPlayer(room, player) {
  if (!room.started) return;
  if (player.customer &&
      player.customer.status !== "delivered" &&
      player.customer.status !== "left") return;

  room.customerCounter += 1;
  room.orderCounter += 1;

  const food = pickRandom(MENU.foods);
  const drink = pickRandom(MENU.drinks);

  const customerId = "c" + room.customerCounter;
  const orderId = "o" + room.orderCounter;
  const name = CUSTOMER_NAMES[Math.floor(Math.random() * CUSTOMER_NAMES.length)];
  const face = CUSTOMER_FACES[Math.floor(Math.random() * CUSTOMER_FACES.length)];
  const phrase = CUSTOMER_PHRASES[Math.floor(Math.random() * CUSTOMER_PHRASES.length)];

  const foodOrder = shuffled(Object.keys(MENU.foods));
  const drinkOrder = shuffled(Object.keys(MENU.drinks));
  const ingredientOrder = shuffled(Object.keys(MENU.ingredients));
  const vip = Math.random() < 0.20;
  const patienceMax = patienceForWave(player.wave);
  const arrivedAt = Date.now();

  player.customer = {
    id: customerId,
    name, face, phrase, vip,
    status: "waiting_take",
    foodOrder, drinkOrder,
    arrivedAt, patienceMax,
    expiresAt: arrivedAt + patienceMax,
  };
  player.order = {
    id: orderId,
    food: { id: food.id, name: food.name, icon: food.icon, ingredients: food.ingredients },
    foodProgress: [],
    foodDone: false,
    ingredientOrder,
    drink: { id: drink.id, name: drink.name, icon: drink.icon },
    drinkProgress: { cup: false, drink: false },
    drinkDone: false,
    status: "waiting_take",
  };
  broadcast(room);
}

function startSpawning(room) {
  // Give every player their first guest at game start.
  for (const p of room.players.values()) {
    spawnForPlayer(room, p);
  }
}

function stopSpawning(_room) { /* no-op */ }

function refreshStatusForPlayer(player) {
  if (!player.customer || !player.order) return;
  const o = player.order, c = player.customer;
  if (o.status === "delivered" || o.status === "left") return;
  if (o.foodDone && o.drinkDone) {
    o.status = "ready";
    if (c.status !== "delivered" && c.status !== "left") c.status = "ready_deliver";
  } else {
    o.status = "preparing";
    if (c.status !== "delivered" && c.status !== "left") c.status = "preparing";
  }
}

// Walk the guest off this one player's queue — streak resets for them
// only; other players are unaffected. Next guest arrives after a beat.
function handleLeaveForPlayer(room, player) {
  if (!player.customer) return;
  player.customer.status = "left";
  if (player.order) player.order.status = "left";
  player.streak = 0;
  player.left += 1;
  io.to(player.id).emit("guestLeft", { name: player.customer.name });
  broadcast(room);
  const custId = player.customer.id;
  setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r) return;
    const p = r.players.get(player.id);
    if (!p || !p.customer || p.customer.id !== custId) return;
    p.customer = null;
    p.order = null;
    if (r.started) spawnForPlayer(r, p);
    else broadcast(r);
  }, 2500);
}

// Patience tick — runs for every player in every started room.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.started) continue;
    for (const p of room.players.values()) {
      const c = p.customer;
      if (!c) continue;
      if (c.status === "delivered" || c.status === "left") continue;
      if (c.status === "ready_deliver") continue;
      if (now >= c.expiresAt) handleLeaveForPlayer(room, p);
    }
  }
}, 500);

// ---------- Socket handlers ----------
io.on("connection", (socket) => {
  let currentRoomCode = null;

  socket.on("createRoom", ({ name }, cb) => {
    const safeName = String(name || "Friend").slice(0, 20).trim() || "Friend";
    const code = uniqueRoomCode();
    const room = newRoom(code, socket.id);
    room.players.set(socket.id, newPlayer(socket.id, safeName));
    rooms.set(code, room);
    socket.join(code);
    currentRoomCode = code;
    cb && cb({ ok: true, code });
    broadcast(room);
  });

  socket.on("joinRoom", ({ name, code }, cb) => {
    const safeName = String(name || "Friend").slice(0, 20).trim() || "Friend";
    const roomCode = String(code || "").toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room) return cb && cb({ ok: false, error: "We couldn't find that room. Please check the code." });
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      return cb && cb({ ok: false, error: "This room is full (15 players)." });
    }
    const p = newPlayer(socket.id, safeName);
    room.players.set(socket.id, p);
    socket.join(roomCode);
    currentRoomCode = roomCode;
    // If the game is already in progress, let latecomers start playing too.
    if (room.started) spawnForPlayer(room, p);
    cb && cb({ ok: true, code: roomCode });
    broadcast(room);
  });

  socket.on("startGame", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.started) return;
    room.started = true;
    startSpawning(room);
    broadcast(room);
  });

  socket.on("endGame", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    stopSpawning(room);
    room.started = false;
    const standings = [...room.players.values()].map(publicPlayer)
      .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.served || 0) - (a.served || 0));
    io.to(room.code).emit("gameOver", { standings });
    // Reset each player's stats but keep them in the lobby for the next round
    for (const p of room.players.values()) {
      p.served = 0;
      p.score = 0;
      p.streak = 0;
      p.bestStreak = 0;
      p.left = 0;
      p.wave = 1;
      p.waveProgress = 0;
      p.customer = null;
      p.order = null;
    }
    broadcast(room);
  });

  // Each action operates on THIS player's own customer/order — competitive
  // mode means everyone has their own race going.

  socket.on("submitOrder", ({ foodId, drinkId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const player = room.players.get(socket.id);
    if (!player || !player.customer || !player.order) return;
    if (player.customer.status !== "waiting_take") return;

    const foodOk = foodId === player.order.food.id;
    const drinkOk = drinkId === player.order.drink.id;
    if (!foodOk || !drinkOk) {
      io.to(socket.id).emit("hint", {
        kind: "wrong_order",
        customerName: player.customer.name,
        wantFood: player.order.food.name,
        wantDrink: player.order.drink.name,
        badFood: !foodOk,
        badDrink: !drinkOk,
      });
      return;
    }

    player.customer.status = "preparing";
    player.order.status = "preparing";
    refreshStatusForPlayer(player);
    broadcast(room);
  });

  socket.on("addIngredient", ({ ingredient }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const player = room.players.get(socket.id);
    if (!player || !player.order || player.order.foodDone) return;
    const next = player.order.food.ingredients[player.order.foodProgress.length];
    if (next !== ingredient) {
      io.to(socket.id).emit("hint", { kind: "wrong_ingredient", expected: next });
      return;
    }
    player.order.foodProgress.push(ingredient);
    if (player.order.foodProgress.length === player.order.food.ingredients.length) {
      player.order.foodDone = true;
    }
    refreshStatusForPlayer(player);
    broadcast(room);
  });

  socket.on("undoIngredient", () => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const player = room.players.get(socket.id);
    if (!player || !player.order || player.order.foodDone) return;
    player.order.foodProgress.pop();
    broadcast(room);
  });

  socket.on("drinkStep", ({ step, drinkId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const player = room.players.get(socket.id);
    if (!player || !player.order || player.order.drinkDone) return;
    const order = player.order;

    if (step === "cup" && !order.drinkProgress.cup) {
      order.drinkProgress.cup = true;
    } else if (step === "pour" && order.drinkProgress.cup && !order.drinkProgress.drink) {
      if (drinkId !== order.drink.id) {
        io.to(socket.id).emit("hint", {
          kind: "wrong_drink",
          wantDrink: order.drink.name,
        });
        return;
      }
      order.drinkProgress.drink = true;
    } else {
      io.to(socket.id).emit("hint", { kind: "wrong_drink_step" });
      return;
    }
    if (order.drinkProgress.cup && order.drinkProgress.drink) {
      order.drinkDone = true;
    }
    refreshStatusForPlayer(player);
    broadcast(room);
  });

  // Deliver this player's ready order. Tip + streak + wave are all
  // per-player so players compete for the top of the leaderboard.
  socket.on("deliver", () => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const player = room.players.get(socket.id);
    if (!player || !player.customer || player.customer.status !== "ready_deliver") return;

    const customer = player.customer;
    const order = player.order;

    // Speed tip: deliver with ≥50% patience left = 3 pts, ≥20% = 2 pts,
    // anything above zero = 1 pt. VIP guests (crown) tip double.
    const msLeft = Math.max(0, customer.expiresAt - Date.now());
    const ratio = customer.patienceMax ? msLeft / customer.patienceMax : 0;
    let tip = 1;
    if (ratio >= 0.5) tip = 3;
    else if (ratio >= 0.2) tip = 2;
    if (customer.vip) tip *= 2;

    customer.status = "delivered";
    if (order) order.status = "delivered";
    player.served += 1;
    player.score += tip;
    player.streak += 1;
    if (player.streak > player.bestStreak) player.bestStreak = player.streak;
    player.waveProgress += 1;

    // Per-player pops so only the player who scored sees "+3 tip!"
    io.to(socket.id).emit("tipEarned", {
      tip, vip: !!customer.vip, streak: player.streak, name: customer.name,
    });
    if ([3, 5, 10, 15, 20].includes(player.streak)) {
      io.to(socket.id).emit("streakMilestone", { streak: player.streak });
    }
    if (player.waveProgress >= 5) {
      player.wave += 1;
      player.waveProgress = 0;
      io.to(socket.id).emit("waveUp", { wave: player.wave });
    }

    const custId = customer.id;
    setTimeout(() => {
      const r = rooms.get(currentRoomCode);
      if (!r) return;
      const p = r.players.get(socket.id);
      if (!p || !p.customer || p.customer.id !== custId) return;
      p.customer = null;
      p.order = null;
      if (r.started) spawnForPlayer(r, p);
      else broadcast(r);
    }, 2000);
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) {
      stopSpawning(room);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.id) {
      // Hand the host crown to whoever is next
      room.hostId = [...room.players.keys()][0];
    }
    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log(`Friendly Diner running at http://localhost:${PORT}`);
});
