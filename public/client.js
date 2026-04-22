/* Friendly Diner — client side */
(function () {
  const socket = io();

  // Public base URL used in the TV-screen QR code. Players who scan it will
  // land on the game with ?room=XXXX prefilled.
  const JOIN_BASE_URL = "https://repo96-production.up.railway.app/";

  // ---------- Friendly labels for ingredients & drink steps ----------
  const INGREDIENT_LABELS = {
    bottom_bun: { name: "Bottom Bun", icon: "🍞" },
    top_bun:    { name: "Top Bun",    icon: "🥖" },
    patty:      { name: "Patty",      icon: "🥩" },
    cheese:     { name: "Cheese",     icon: "🧀" },
    lettuce:    { name: "Lettuce",    icon: "🥬" },
    tomato:     { name: "Tomato",     icon: "🍅" },
    sausage:    { name: "Sausage",    icon: "🌭" },
    basket:     { name: "Basket",     icon: "🧺" },
    potato:     { name: "Potato",     icon: "🥔" },
    salt:       { name: "Salt",       icon: "🧂" },
  };

  const ROLE_LABELS = {
    taker: "📝 Take Orders",
    cook: "🍳 Cook Food",
    barista: "☕ Make Drinks",
  };

  // Tiny guard so SFX calls never break the UI if audio.js failed to load.
  const sfx = (name) => { try { window.Audio && window.Audio.sfx(name); } catch (_) {} };

  // ---------- State ----------
  let myId = null;
  let myName = "";
  let roomCode = null;
  let roomState = null;
  let myRole = "taker"; // local view preference

  // ---------- Element helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  function showScreen(id) {
    $$(".screen").forEach((s) => s.classList.remove("active"));
    $(`#${id}`).classList.add("active");
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  // ---------- Home screen ----------
  $("#btn-create").addEventListener("click", () => {
    const name = $("#name-input").value.trim();
    if (!name) return showHomeError("Please type your name first.");
    myName = name;
    socket.emit("createRoom", { name }, (res) => {
      if (!res || !res.ok) return showHomeError((res && res.error) || "Couldn't start a game.");
      roomCode = res.code;
      enterLobby();
    });
  });

  $("#btn-join").addEventListener("click", () => {
    const name = $("#name-input").value.trim();
    const code = $("#code-input").value.trim().toUpperCase();
    if (!name) return showHomeError("Please type your name first.");
    if (code.length !== 4) return showHomeError("Please type the 4-letter room code.");
    myName = name;
    socket.emit("joinRoom", { name, code }, (res) => {
      if (!res || !res.ok) return showHomeError((res && res.error) || "Couldn't join.");
      roomCode = res.code;
      enterLobby();
    });
  });

  function showHomeError(msg) { $("#home-error").textContent = msg; }

  // ---------- Lobby ----------
  function enterLobby() {
    $("#lobby-code").textContent = roomCode;
    showScreen("screen-lobby");
  }

  $$(".role-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const role = btn.dataset.role;
      myRole = role;
      socket.emit("pickRole", { role });
    });
  });

  $("#btn-start").addEventListener("click", () => {
    socket.emit("startGame");
  });

  // Open the TV view (host usually shows this on a big screen/projector)
  $("#btn-tv").addEventListener("click", () => {
    renderTvScreen();
    showScreen("screen-tv");
  });

  $("#btn-tv-back").addEventListener("click", () => {
    // If the game is running, go back to the play view; otherwise the lobby.
    if (roomState && roomState.started) {
      showScreen("screen-game");
      renderGame();
    } else {
      showScreen("screen-lobby");
    }
  });

  // ---------- Game screen ----------
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      myRole = btn.dataset.role;
      renderGame();
    });
  });

  $("#btn-end").addEventListener("click", () => {
    if (confirm("End the game now and show the summary?")) {
      socket.emit("endGame");
    }
  });

  $("#btn-back").addEventListener("click", () => {
    showScreen("screen-lobby");
  });

  // ---------- Sound/music toggle buttons ----------
  function refreshAudioButtons() {
    if (!window.Audio) return;
    const s = $("#btn-sound");
    const m = $("#btn-music");
    s.textContent = window.Audio.on ? "🔔 Sound on" : "🔕 Sound off";
    s.classList.toggle("off", !window.Audio.on);
    m.textContent = window.Audio.music ? "🎵 Music on" : "🎶 Music off";
    m.classList.toggle("off", !window.Audio.music);
  }
  $("#btn-sound").addEventListener("click", () => {
    if (!window.Audio) return;
    window.Audio.setMaster(!window.Audio.on);
    refreshAudioButtons();
  });
  $("#btn-music").addEventListener("click", () => {
    if (!window.Audio) return;
    window.Audio.setMusic(!window.Audio.music);
    refreshAudioButtons();
  });
  refreshAudioButtons();

  // ---------- Socket events ----------
  socket.on("connect", () => { myId = socket.id; });

  // Remember what state we saw last so we can fire SFX on transitions.
  let prevSnapshot = { customers: {}, orders: {}, completed: 0, started: false };

  socket.on("state", (state) => {
    roomState = state;
    renderLobby();

    // When the game starts, move lobby-viewers into the play screen. Don't
    // steal focus from anyone currently watching the TV or already playing.
    const onLobby = $("#screen-lobby").classList.contains("active");
    if (state.started && onLobby) {
      const myPlayer = state.players.find((p) => p.id === myId);
      if (myPlayer && myPlayer.role) myRole = myPlayer.role;
      showScreen("screen-game");
    }

    // Mood music starts when the game begins (first transition to started).
    if (state.started && !prevSnapshot.started) {
      if (window.Audio && window.Audio.music) window.Audio.startMusic();
    }
    if (!state.started && prevSnapshot.started) {
      if (window.Audio) window.Audio.stopMusic();
    }

    // SFX based on state diffs (new customer, order ready, score up)
    const custMap = {};
    for (const c of state.customers) custMap[c.id] = c;
    const orderMap = {};
    for (const o of state.orders) orderMap[o.id] = o;
    for (const c of state.customers) {
      if (!prevSnapshot.customers[c.id] && c.status === "waiting_take") {
        sfx("newCustomer");
      } else {
        const prev = prevSnapshot.customers[c.id];
        if (prev && prev.status !== "ready_deliver" && c.status === "ready_deliver") {
          sfx("ready");
        }
      }
    }
    if (state.completed > prevSnapshot.completed) {
      // Pulse the on-screen score counter
      flashScorePulse();
    }
    prevSnapshot = {
      started: state.started,
      completed: state.completed,
      customers: custMap,
      orders: orderMap,
    };

    if (state.started && $("#screen-game").classList.contains("active")) renderGame();
    if ($("#screen-tv").classList.contains("active")) renderTvScreen();

    // Drop any local taker drafts for customers that have moved past the
    // "waiting_take" state — keeps the menu panel clean on the next render.
    for (const id of Object.keys(takerSelections)) {
      const c = state.customers.find((x) => x.id === id);
      if (!c || c.status !== "waiting_take") delete takerSelections[id];
    }
  });

  function flashScorePulse() {
    ["#score", "#tv-live-score"].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.classList.remove("pulse");
      // force reflow so the animation can re-trigger
      void el.offsetWidth;
      el.classList.add("pulse");
    });
  }

  socket.on("gameOver", (data) => {
    $("#over-score").textContent = data.completed;
    const ul = $("#over-players");
    ul.innerHTML = "";
    data.players
      .slice()
      .sort((a, b) => (b.served || 0) - (a.served || 0))
      .forEach((p) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${escapeHtml(p.name)} — ${ROLE_LABELS[p.role] || ""}</span>
                        <span class="role-chip">served ${p.served || 0}</span>`;
        ul.appendChild(li);
      });
    showScreen("screen-over");
  });

  socket.on("hint", (h) => {
    sfx("wrong");
    if (h.kind === "wrong_ingredient") {
      const label = (INGREDIENT_LABELS[h.expected] && INGREDIENT_LABELS[h.expected].name) || h.expected;
      toast(`Not yet — next is: ${label}`);
    } else if (h.kind === "wrong_drink_step") {
      toast("Add the cup first, then pour the drink.");
    } else if (h.kind === "wrong_drink") {
      toast(`This guest wanted ${h.wantDrink}. Try another pour.`);
    } else if (h.kind === "wrong_order") {
      const parts = [];
      if (h.badFood)  parts.push(`wants ${h.wantFood}`);
      if (h.badDrink) parts.push(`wants ${h.wantDrink}`);
      toast(`${h.customerName} ${parts.join(" and ")}. Please check again.`);
    }
  });

  socket.on("disconnect", () => {
    toast("Lost connection. Trying to reconnect…");
  });

  // ---------- Render: Lobby ----------
  function renderLobby() {
    if (!roomState) return;
    $("#lobby-code").textContent = roomState.code;

    const ul = $("#lobby-players");
    ul.innerHTML = "";
    roomState.players.forEach((p) => {
      const li = document.createElement("li");
      const isHost = p.id === roomState.hostId;
      const isMe = p.id === myId;
      li.innerHTML = `
        <span>${escapeHtml(p.name)}${isMe ? " (you)" : ""}${isHost ? '<span class="host-tag">★ host</span>' : ""}</span>
        <span class="role-chip">${p.role ? ROLE_LABELS[p.role] : "Choosing…"}</span>
      `;
      ul.appendChild(li);
    });

    // Highlight my role button
    const myPlayer = roomState.players.find((p) => p.id === myId);
    $$(".role-btn").forEach((b) => {
      b.classList.toggle("selected", myPlayer && b.dataset.role === myPlayer.role);
    });

    // Host sees "Start Game"; others see waiting message
    const iAmHost = myId === roomState.hostId;
    $("#btn-start").hidden = !iAmHost || roomState.started;
    $("#waiting-msg").hidden = iAmHost || roomState.started;
    $("#btn-end").hidden = !iAmHost;
  }

  // ---------- Render: Game ----------
  function renderGame() {
    if (!roomState) return;
    $("#score").textContent = roomState.completed;

    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.role === myRole));

    $("#station-taker").hidden = myRole !== "taker";
    $("#station-cook").hidden = myRole !== "cook";
    $("#station-barista").hidden = myRole !== "barista";

    const iAmHost = myId === roomState.hostId;
    $("#btn-end").hidden = !iAmHost;

    if (myRole === "taker") renderTakerStation();
    else if (myRole === "cook") renderCookStation();
    else if (myRole === "barista") renderBaristaStation();
  }

  // Per-customer draft selections (local only — each taker has their own).
  // Shape: { [customerId]: { food: "burger", drink: "coffee" } }
  const takerSelections = {};

  // Briefly flash a card with a celebration class when a guest is delivered.
  // Stored here so re-renders don't steal the animation mid-flight.
  const deliveredFlash = new Set();

  function moodFor(customer, order, picks) {
    if (customer.status === "delivered") return "🎉";
    if (customer.status === "ready_deliver") return "😋";
    if (customer.status === "preparing") return "⌛";
    // Waiting to take. If the taker has picked the right items, the guest
    // smiles — gentle feedback before they even tap "Send to kitchen".
    const correct = picks && picks.food === order.food.id && picks.drink === order.drink.id;
    return correct ? "😊" : "🤔";
  }

  // Taker: writes down each guest's order by tapping food + drink menus.
  function renderTakerStation() {
    const list = $("#customers-list");
    const customers = roomState.customers;
    if (customers.length === 0) {
      list.innerHTML = `<p class="empty-note">No guests yet. Please wait a moment…</p>`;
      return;
    }

    const menu = roomState.menu;
    list.innerHTML = "";

    for (const c of customers) {
      const order = roomState.orders.find((o) => o.id === c.orderId);
      if (!order) continue;

      const picks = takerSelections[c.id] || {};
      const food = order.food;
      const drink = order.drink;

      const statusLabel = {
        waiting_take:  { text: "Ready to order",              cls: "waiting" },
        preparing:     { text: "Kitchen is working on it",    cls: "preparing" },
        ready_deliver: { text: "Food & drink ready!",         cls: "ready" },
        delivered:     { text: "Delivered — thank you!",      cls: "delivered" },
      }[c.status] || { text: c.status, cls: "" };

      const foodPill = `<span class="progress-pill ${order.foodDone ? "done" : ""}">${food.icon} ${escapeHtml(food.name)}${order.foodDone ? " ✓" : ""}</span>`;
      const drinkPill = `<span class="progress-pill ${order.drinkDone ? "done" : ""}">${drink.icon} ${escapeHtml(drink.name)}${order.drinkDone ? " ✓" : ""}</span>`;

      // Main action area — differs by status
      let body = "";
      if (c.status === "waiting_take") {
        // Each guest's menu order is shuffled by the server so the taker
        // has to actually look at icons, not tap from muscle memory.
        const foodKeys = c.foodOrder || Object.keys(menu.foods);
        const drinkKeys = c.drinkOrder || Object.keys(menu.drinks);
        const foodBtns = foodKeys.map((k) => menu.foods[k]).filter(Boolean).map((f) => `
          <button class="menu-btn ${picks.food === f.id ? "picked" : ""}" data-kind="food" data-id="${f.id}">
            <span class="ico" aria-hidden="true">${f.icon}</span>
            <span>${escapeHtml(f.name)}</span>
          </button>
        `).join("");
        const drinkBtns = drinkKeys.map((k) => menu.drinks[k]).filter(Boolean).map((d) => `
          <button class="menu-btn ${picks.drink === d.id ? "picked" : ""}" data-kind="drink" data-id="${d.id}">
            <span class="ico" aria-hidden="true">${d.icon}</span>
            <span>${escapeHtml(d.name)}</span>
          </button>
        `).join("");
        const canSend = !!(picks.food && picks.drink);
        body = `
          <div class="menu-section">
            <div class="menu-title">Choose the food</div>
            <div class="menu-grid">${foodBtns}</div>
          </div>
          <div class="menu-section">
            <div class="menu-title">Choose the drink</div>
            <div class="menu-grid">${drinkBtns}</div>
          </div>
          <button class="big-action primary send-btn" data-act="send" data-id="${c.id}" ${canSend ? "" : "disabled"}>
            ${canSend ? "Send to kitchen" : "Pick a food and a drink"}
          </button>
        `;
      } else if (c.status === "ready_deliver") {
        body = `<button class="big-action deliver" data-act="deliver" data-id="${c.id}">Deliver order 🎉</button>`;
      } else if (c.status === "preparing") {
        body = `<button class="big-action" disabled>⌛ Kitchen is working…</button>`;
      } else if (c.status === "delivered") {
        body = `<button class="big-action" disabled>Delivered — thank you!</button>`;
      }

      const card = document.createElement("div");
      card.className = "customer-card" + (deliveredFlash.has(c.id) ? " delivered-flash" : "");
      card.dataset.customerId = c.id;
      card.innerHTML = `
        <div class="who">
          <div class="face" aria-hidden="true">${c.face}</div>
          <div class="name">${escapeHtml(c.name)}</div>
          <div class="mood" aria-hidden="true">${moodFor(c, order, picks)}</div>
        </div>
        ${c.phrase ? `<div class="speech">“${escapeHtml(c.phrase)}”</div>` : ""}
        <div class="order">Would like: <b>${food.icon} ${escapeHtml(food.name)}</b> and <b>${drink.icon} ${escapeHtml(drink.name)}</b></div>
        <div class="progress-row">${foodPill} ${drinkPill}</div>
        <div class="status ${statusLabel.cls}">${statusLabel.text}</div>
        ${body}
      `;
      list.appendChild(card);
    }

    list.onclick = (ev) => {
      // Menu selection (food or drink)
      const menuBtn = ev.target.closest("button.menu-btn");
      if (menuBtn) {
        const card = menuBtn.closest(".customer-card");
        const cid = card.dataset.customerId;
        const kind = menuBtn.dataset.kind;
        const id = menuBtn.dataset.id;
        const cur = takerSelections[cid] || {};
        cur[kind] = cur[kind] === id ? null : id; // tap again to unselect
        takerSelections[cid] = cur;
        sfx("pick");
        renderTakerStation();
        return;
      }
      // Primary buttons
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === "send") {
        const picks = takerSelections[id] || {};
        if (!picks.food || !picks.drink) return;
        sfx("orderSent");
        socket.emit("submitOrder", { customerId: id, foodId: picks.food, drinkId: picks.drink });
      }
      if (btn.dataset.act === "deliver") {
        deliveredFlash.add(id);
        setTimeout(() => { deliveredFlash.delete(id); }, 1800);
        sfx("deliver");
        socket.emit("deliver", { customerId: id });
      }
    };
  }

  // Cook: list of food tickets that still need work
  function renderCookStation() {
    const list = $("#cook-list");
    const tickets = roomState.orders.filter((o) => !o.foodDone && o.status !== "delivered" && isCustomerActive(o));
    if (tickets.length === 0) {
      list.innerHTML = `<p class="empty-note">No food orders right now. Nice work!</p>`;
      return;
    }
    list.innerHTML = "";
    for (const order of tickets) {
      const customer = roomState.customers.find((c) => c.id === order.customerId);
      const waitingToBeTaken = customer && customer.status === "waiting_take";

      const recipeSteps = order.food.ingredients
        .map((ing, i) => {
          const label = INGREDIENT_LABELS[ing] || { name: ing, icon: "•" };
          const done = i < order.foodProgress.length;
          const next = i === order.foodProgress.length && !done;
          return `<li class="${done ? "done" : ""} ${next ? "next" : ""}">${label.icon} ${escapeHtml(label.name)}${done ? " ✓" : ""}</li>`;
        })
        .join("");

      // Distractor palette: every ingredient the kitchen has, shuffled by
      // the server per-ticket. The cook must pick the correct ones for the
      // recipe on the left, ignoring distractors like "sausage" on a burger.
      const paletteIds = order.ingredientOrder || Object.keys(roomState.menu.ingredients || INGREDIENT_LABELS);
      const palette = paletteIds
        .map((ing) => {
          const meta = (roomState.menu.ingredients && roomState.menu.ingredients[ing]) || INGREDIENT_LABELS[ing] || { name: ing, icon: "•" };
          return `<button class="ingredient-btn" data-ing="${ing}" ${waitingToBeTaken ? "disabled" : ""}>
                    <span class="ico" aria-hidden="true">${meta.icon}</span>
                    <span>${escapeHtml(meta.name)}</span>
                  </button>`;
        })
        .join("");

      const ready = order.foodDone;
      const guestTag = customer ? `for <b>${escapeHtml(customer.name)}</b>` : "";
      const takenHint = waitingToBeTaken ? `<p class="status waiting">Waiting for a server to take this order.</p>` : "";

      const card = document.createElement("div");
      card.className = "ticket-card";
      card.innerHTML = `
        <h4>${order.food.icon} ${escapeHtml(order.food.name)}</h4>
        <div class="for">${guestTag}</div>
        ${takenHint}
        <div class="recipe"><ol>${recipeSteps}</ol></div>
        <div class="ingredient-palette">${palette}</div>
        <div class="ticket-actions">
          <button class="undo" data-act="undo" data-id="${order.id}" ${order.foodProgress.length === 0 || waitingToBeTaken ? "disabled" : ""}>Undo last</button>
          <button class="serve" data-act="serve-food" data-id="${order.id}" disabled>${ready ? "Served ✓" : "Keep going…"}</button>
        </div>
      `;

      // Wire ingredient buttons
      card.querySelectorAll(".ingredient-btn").forEach((b) => {
        b.addEventListener("click", () => {
          if (waitingToBeTaken) return;
          sfx("ingredient");
          socket.emit("addIngredient", { orderId: order.id, ingredient: b.dataset.ing });
        });
      });
      card.querySelectorAll("button[data-act='undo']").forEach((b) => {
        b.addEventListener("click", () => {
          sfx("tap");
          socket.emit("undoIngredient", { orderId: order.id });
        });
      });

      list.appendChild(card);
    }
  }

  // Barista: two-step drinks (cup, then pour)
  function renderBaristaStation() {
    const list = $("#barista-list");
    const tickets = roomState.orders.filter((o) => !o.drinkDone && o.status !== "delivered" && isCustomerActive(o));
    if (tickets.length === 0) {
      list.innerHTML = `<p class="empty-note">No drink orders right now. Nice work!</p>`;
      return;
    }
    list.innerHTML = "";
    for (const order of tickets) {
      const customer = roomState.customers.find((c) => c.id === order.customerId);
      const waitingToBeTaken = customer && customer.status === "waiting_take";
      const cupDone = order.drinkProgress.cup;
      const drinkDone = order.drinkProgress.drink;

      const steps = `
        <ol>
          <li class="${cupDone ? "done" : ""} ${!cupDone ? "next" : ""}">🥤 Get a cup${cupDone ? " ✓" : ""}</li>
          <li class="${drinkDone ? "done" : ""} ${cupDone && !drinkDone ? "next" : ""}">${order.drink.icon} Pour ${escapeHtml(order.drink.name)}${drinkDone ? " ✓" : ""}</li>
        </ol>
      `;

      const takenHint = waitingToBeTaken ? `<p class="status waiting">Waiting for a server to take this order.</p>` : "";
      const guestTag = customer ? `for <b>${escapeHtml(customer.name)}</b>` : "";

      // Distractor pour: all 4 drinks as options. Server validates; wrong
      // pour gets a gentle hint instead of a silent no-op.
      const drinks = roomState.menu.drinks;
      const pourBtns = Object.values(drinks).map((d) => `
        <button class="drink-step-btn pour-btn" data-step="pour" data-drink="${d.id}"
          ${!cupDone || drinkDone || waitingToBeTaken ? "disabled" : ""}>
          <span class="ico" aria-hidden="true">${d.icon}</span>
          <span>Pour ${escapeHtml(d.name)}</span>
        </button>
      `).join("");

      const card = document.createElement("div");
      card.className = "ticket-card";
      card.innerHTML = `
        <h4>${order.drink.icon} ${escapeHtml(order.drink.name)}</h4>
        <div class="for">${guestTag}</div>
        ${takenHint}
        <div class="recipe">${steps}</div>
        <div class="drink-palette">
          <button class="drink-step-btn cup-btn" data-step="cup" ${cupDone || waitingToBeTaken ? "disabled" : ""}>
            <span class="ico" aria-hidden="true">🥤</span>
            <span>Get a cup</span>
          </button>
        </div>
        <div class="menu-title" style="margin-top:10px;">Then pour the right drink</div>
        <div class="drink-palette pour-grid">
          ${pourBtns}
        </div>
      `;

      card.querySelectorAll(".drink-step-btn").forEach((b) => {
        b.addEventListener("click", () => {
          const step = b.dataset.step;
          const payload = { orderId: order.id, step };
          if (step === "pour") payload.drinkId = b.dataset.drink;
          if (step === "cup") sfx("cup"); else sfx("pour");
          socket.emit("drinkStep", payload);
        });
      });

      list.appendChild(card);
    }
  }

  // ---------- Render: TV screen (the big shared display) ----------
  // The TV has two sub-views: a pre-game "how to join" screen with the QR
  // code, and an in-game live board so every phone-player can glance up
  // and see team progress.
  let tvLastRenderedCode = null;
  function renderTvScreen() {
    if (!roomState) return;
    const code = roomState.code;
    const inGame = !!roomState.started;

    $("#tv-pregame").hidden = inGame;
    $("#tv-ingame").hidden = !inGame;

    if (!inGame) {
      // Pre-game: QR + room code + player roster
      $("#tv-code").textContent = code;
      const joinUrl = `${JOIN_BASE_URL}?room=${encodeURIComponent(code)}`;
      $("#tv-url").textContent = joinUrl;

      // Only (re)load the QR if the code changed — avoids image flicker
      if (tvLastRenderedCode !== code) {
        $("#tv-qr").src = `/qr?text=${encodeURIComponent(joinUrl)}`;
        tvLastRenderedCode = code;
      }

      const ul = $("#tv-players");
      ul.innerHTML = "";
      roomState.players.forEach((p) => {
        const li = document.createElement("li");
        li.textContent = p.name + (p.role ? ` — ${ROLE_LABELS[p.role]}` : "");
        ul.appendChild(li);
      });
    } else {
      // In-game: big score, room code, and a live card for each customer
      $("#tv-live-score").textContent = roomState.completed;
      $("#tv-live-code").textContent = code;

      const guestsEl = $("#tv-live-guests");
      if (roomState.customers.length === 0) {
        guestsEl.innerHTML = `<p class="empty-note">Waiting for the first guest…</p>`;
      } else {
        guestsEl.innerHTML = "";
        for (const c of roomState.customers) {
          const order = roomState.orders.find((o) => o.id === c.orderId);
          if (!order) continue;
          const status = {
            waiting_take:  { text: "Waiting for a server",   cls: "waiting" },
            preparing:     { text: "Kitchen is working",     cls: "preparing" },
            ready_deliver: { text: "Ready to deliver!",      cls: "ready" },
            delivered:     { text: "Delivered — thank you!", cls: "delivered" },
          }[c.status] || { text: c.status, cls: "" };

          const card = document.createElement("div");
          card.className = "tv-guest-card";
          card.innerHTML = `
            <div class="tv-guest-head">
              <span class="tv-guest-face" aria-hidden="true">${c.face}</span>
              <span class="tv-guest-name">${escapeHtml(c.name)}</span>
            </div>
            <div class="tv-guest-order">${order.food.icon} ${escapeHtml(order.food.name)} &nbsp;+&nbsp; ${order.drink.icon} ${escapeHtml(order.drink.name)}</div>
            <div class="tv-guest-prog">
              <span class="tv-prog ${order.foodDone ? "done" : ""}">Food: ${order.foodProgress.length}/${order.food.ingredients.length}${order.foodDone ? " ✓" : ""}</span>
              <span class="tv-prog ${order.drinkDone ? "done" : ""}">Drink: ${drinkStepCount(order)}/2${order.drinkDone ? " ✓" : ""}</span>
            </div>
            <div class="tv-guest-status ${status.cls}">${status.text}</div>
          `;
          guestsEl.appendChild(card);
        }
      }

      const ul = $("#tv-live-players");
      ul.innerHTML = "";
      roomState.players
        .slice()
        .sort((a, b) => (b.served || 0) - (a.served || 0))
        .forEach((p) => {
          const li = document.createElement("li");
          const roleText = p.role ? ` — ${ROLE_LABELS[p.role]}` : "";
          const servedText = p.served ? ` · served ${p.served}` : "";
          li.textContent = p.name + roleText + servedText;
          ul.appendChild(li);
        });
    }
  }

  function drinkStepCount(order) {
    let n = 0;
    if (order.drinkProgress.cup) n++;
    if (order.drinkProgress.drink) n++;
    return n;
  }

  // If someone scanned the QR code, their URL includes ?room=ABCD. Prefill
  // the code field so they can just type their name and tap Join.
  (function prefillRoomFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const r = (params.get("room") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
      if (r.length === 4) {
        const input = $("#code-input");
        if (input) input.value = r;
      }
    } catch (_) { /* ignore */ }
  })();

  function isCustomerActive(order) {
    const c = roomState.customers.find((x) => x.id === order.customerId);
    return c && c.status !== "delivered";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
