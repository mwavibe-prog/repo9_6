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
};

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
    players: new Map(), // socketId -> player
    customers: [], // queued + seated customers
    orders: [], // orders currently in progress
    completed: 0,
    customerCounter: 0,
    orderCounter: 0,
    spawnTimer: null,
  };
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, role: p.role, served: p.served };
}

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    players: [...room.players.values()].map(publicPlayer),
    customers: room.customers.map((c) => ({
      id: c.id,
      name: c.name,
      face: c.face,
      phrase: c.phrase,
      orderId: c.orderId,
      status: c.status, // waiting_take | preparing | ready_deliver | left
    })),
    orders: room.orders.map((o) => ({
      id: o.id,
      customerId: o.customerId,
      food: o.food,
      foodProgress: o.foodProgress,
      foodDone: o.foodDone,
      foodClaimedBy: o.foodClaimedBy,
      drink: o.drink,
      drinkProgress: o.drinkProgress,
      drinkDone: o.drinkDone,
      drinkClaimedBy: o.drinkClaimedBy,
      status: o.status, // taken | preparing | ready | delivered
    })),
    completed: room.completed,
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

function spawnCustomer(room) {
  if (!room.started) return;
  // Gentle cap: no more than 5 waiting customers at once (keeps pace relaxed for elderly players)
  if (room.customers.filter((c) => c.status !== "delivered" && c.status !== "left").length >= 5) return;

  room.customerCounter += 1;
  room.orderCounter += 1;

  const food = pickRandom(MENU.foods);
  const drink = pickRandom(MENU.drinks);

  const customerId = "c" + room.customerCounter;
  const orderId = "o" + room.orderCounter;
  const name = CUSTOMER_NAMES[Math.floor(Math.random() * CUSTOMER_NAMES.length)];
  const face = CUSTOMER_FACES[Math.floor(Math.random() * CUSTOMER_FACES.length)];
  const phrase = CUSTOMER_PHRASES[Math.floor(Math.random() * CUSTOMER_PHRASES.length)];

  const customer = {
    id: customerId,
    name,
    face,
    phrase,
    orderId,
    status: "waiting_take",
  };

  const order = {
    id: orderId,
    customerId,
    food: { id: food.id, name: food.name, icon: food.icon, ingredients: food.ingredients },
    foodProgress: [], // list of ingredient ids added so far (in order required)
    foodDone: false,
    foodClaimedBy: null,
    drink: { id: drink.id, name: drink.name, icon: drink.icon },
    drinkProgress: { cup: false, drink: false }, // two-step drink
    drinkDone: false,
    drinkClaimedBy: null,
    status: "waiting_take",
  };

  room.customers.push(customer);
  room.orders.push(order);
  broadcast(room);
}

function startSpawning(room) {
  if (room.spawnTimer) return;
  // Spawn first customer quickly so the game feels alive
  spawnCustomer(room);
  room.spawnTimer = setInterval(() => spawnCustomer(room), 12000); // relaxed pace
}

function stopSpawning(room) {
  if (room.spawnTimer) {
    clearInterval(room.spawnTimer);
    room.spawnTimer = null;
  }
}

function findOrder(room, orderId) {
  return room.orders.find((o) => o.id === orderId);
}
function findCustomer(room, customerId) {
  return room.customers.find((c) => c.id === customerId);
}

function refreshStatuses(room) {
  for (const order of room.orders) {
    if (order.status === "delivered") continue;
    if (order.foodDone && order.drinkDone) {
      order.status = "ready";
      const c = findCustomer(room, order.customerId);
      if (c && c.status !== "delivered") c.status = "ready_deliver";
    } else if (order.status === "taken" || order.status === "preparing") {
      order.status = "preparing";
      const c = findCustomer(room, order.customerId);
      if (c && c.status !== "delivered") c.status = "preparing";
    }
  }
}

// ---------- Socket handlers ----------
io.on("connection", (socket) => {
  let currentRoomCode = null;

  socket.on("createRoom", ({ name }, cb) => {
    const safeName = String(name || "Friend").slice(0, 20).trim() || "Friend";
    const code = uniqueRoomCode();
    const room = newRoom(code, socket.id);
    room.players.set(socket.id, { id: socket.id, name: safeName, role: null, served: 0 });
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
    room.players.set(socket.id, { id: socket.id, name: safeName, role: null, served: 0 });
    socket.join(roomCode);
    currentRoomCode = roomCode;
    cb && cb({ ok: true, code: roomCode });
    broadcast(room);
  });

  socket.on("pickRole", ({ role }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (!["taker", "cook", "barista"].includes(role)) return;
    player.role = role;
    broadcast(room);
  });

  socket.on("startGame", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.started) return;
    // Make sure every player has a role; if not, assign the host's choice or default to taker
    for (const p of room.players.values()) {
      if (!p.role) p.role = "taker";
    }
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
    io.to(room.code).emit("gameOver", {
      completed: room.completed,
      players: [...room.players.values()].map(publicPlayer),
    });
    // Reset game state but keep players & roles for a possible next round
    room.customers = [];
    room.orders = [];
    room.completed = 0;
    for (const p of room.players.values()) p.served = 0;
    broadcast(room);
  });

  // Order Taker: write down the customer's order by picking from the menu.
  // The server checks the picks match the customer's request. If they
  // don't, it sends a gentle hint back and leaves the customer waiting.
  socket.on("submitOrder", ({ customerId, foodId, drinkId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const customer = findCustomer(room, customerId);
    if (!customer || customer.status !== "waiting_take") return;
    const order = findOrder(room, customer.orderId);
    if (!order) return;

    const foodOk = foodId === order.food.id;
    const drinkOk = drinkId === order.drink.id;
    if (!foodOk || !drinkOk) {
      io.to(socket.id).emit("hint", {
        kind: "wrong_order",
        customerName: customer.name,
        wantFood: order.food.name,
        wantDrink: order.drink.name,
        badFood: !foodOk,
        badDrink: !drinkOk,
      });
      return;
    }

    customer.status = "preparing";
    order.status = "preparing";
    const player = room.players.get(socket.id);
    if (player) player.took = (player.took || 0) + 1;
    refreshStatuses(room);
    broadcast(room);
  });

  // Cook claims a food ticket (optional, helps coordination but not required)
  socket.on("claimFood", ({ orderId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const order = findOrder(room, orderId);
    if (!order || order.foodDone) return;
    order.foodClaimedBy = socket.id;
    broadcast(room);
  });

  // Cook adds an ingredient. Must be the next ingredient in the recipe order.
  socket.on("addIngredient", ({ orderId, ingredient }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const order = findOrder(room, orderId);
    if (!order || order.foodDone) return;
    const next = order.food.ingredients[order.foodProgress.length];
    if (next !== ingredient) {
      // Gentle: just tell this one player "not yet", don't penalize
      io.to(socket.id).emit("hint", { kind: "wrong_ingredient", expected: next });
      return;
    }
    order.foodProgress.push(ingredient);
    if (order.foodProgress.length === order.food.ingredients.length) {
      order.foodDone = true;
    }
    refreshStatuses(room);
    broadcast(room);
  });

  // Cook can undo their last step (reduces frustration for elderly players)
  socket.on("undoIngredient", ({ orderId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const order = findOrder(room, orderId);
    if (!order || order.foodDone) return;
    order.foodProgress.pop();
    broadcast(room);
  });

  // Barista claims a drink ticket
  socket.on("claimDrink", ({ orderId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const order = findOrder(room, orderId);
    if (!order || order.drinkDone) return;
    order.drinkClaimedBy = socket.id;
    broadcast(room);
  });

  // Barista: add cup, then pour drink. Steps are ordered.
  socket.on("drinkStep", ({ orderId, step }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const order = findOrder(room, orderId);
    if (!order || order.drinkDone) return;
    if (step === "cup" && !order.drinkProgress.cup) {
      order.drinkProgress.cup = true;
    } else if (step === "pour" && order.drinkProgress.cup && !order.drinkProgress.drink) {
      order.drinkProgress.drink = true;
    } else {
      io.to(socket.id).emit("hint", { kind: "wrong_drink_step" });
      return;
    }
    if (order.drinkProgress.cup && order.drinkProgress.drink) {
      order.drinkDone = true;
    }
    refreshStatuses(room);
    broadcast(room);
  });

  // Order Taker delivers a ready order
  socket.on("deliver", ({ customerId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.started) return;
    const customer = findCustomer(room, customerId);
    if (!customer || customer.status !== "ready_deliver") return;
    const order = findOrder(room, customer.orderId);
    if (!order) return;
    customer.status = "delivered";
    order.status = "delivered";
    room.completed += 1;
    const player = room.players.get(socket.id);
    if (player) player.served = (player.served || 0) + 1;
    // Remove the customer & order after a short moment so players see the "delivered" state
    setTimeout(() => {
      const r = rooms.get(currentRoomCode);
      if (!r) return;
      r.customers = r.customers.filter((c) => c.id !== customer.id);
      r.orders = r.orders.filter((o) => o.id !== order.id);
      broadcast(r);
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
