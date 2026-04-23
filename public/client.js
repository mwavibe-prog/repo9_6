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

  // Smoothly tick patience bars between server broadcasts — every state
  // update stores a snapshot of patienceLeft and we interpolate from it.
  let patienceReceivedAt = 0;
  function patienceLeftNow(c) {
    if (!c || typeof c.patienceLeft !== "number") return 0;
    return Math.max(0, c.patienceLeft - (Date.now() - patienceReceivedAt));
  }
  function patiencePercentNow(c) {
    if (!c || !c.patienceMax) return 0;
    return Math.max(0, Math.min(100, (patienceLeftNow(c) / c.patienceMax) * 100));
  }

  // Look up my own player entry in the room. Each player runs their own
  // race in competitive mode — my customer/order lives here.
  function getMe() {
    if (!roomState || !myId) return null;
    return roomState.players.find((p) => p.id === myId) || null;
  }

  // ---------- State ----------
  let myId = null;
  let myName = "";
  let roomCode = null;
  let roomState = null;

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
  let prevSnapshot = { myCustomer: null, myScore: 0, started: false };

  socket.on("state", (state) => {
    roomState = state;
    patienceReceivedAt = Date.now();
    renderLobby();

    // When the game starts, move lobby-viewers into the play screen. Don't
    // steal focus from anyone currently watching the TV or already playing.
    const onLobby = $("#screen-lobby").classList.contains("active");
    if (state.started && onLobby) {
      showScreen("screen-game");
    }

    // Mood music starts when the game begins (first transition to started).
    if (state.started && !prevSnapshot.started) {
      if (window.Audio && window.Audio.music) window.Audio.startMusic();
    }
    if (!state.started && prevSnapshot.started) {
      if (window.Audio) window.Audio.stopMusic();
    }

    // SFX based on MY player's state diffs (new guest, order ready, score up)
    const me = state.players.find((p) => p.id === myId);
    const prevMyCust = prevSnapshot.myCustomer;
    if (me && me.customer) {
      if (!prevMyCust || prevMyCust.id !== me.customer.id) {
        if (me.customer.status === "waiting_take") sfx("newCustomer");
      } else if (prevMyCust.status !== "ready_deliver" && me.customer.status === "ready_deliver") {
        sfx("ready");
      }
    }
    if (me && prevSnapshot.myScore != null && me.score > prevSnapshot.myScore) {
      flashScorePulse();
    }
    prevSnapshot = {
      started: state.started,
      myCustomer: me && me.customer ? { id: me.customer.id, status: me.customer.status } : null,
      myScore: me ? me.score : 0,
    };

    if (state.started && $("#screen-game").classList.contains("active")) renderGame();
    if ($("#screen-tv").classList.contains("active")) renderTvScreen();

    // Drop my local taker draft if my customer moved past waiting_take.
    const myCustId = me && me.customer ? me.customer.id : null;
    const myCustStatus = me && me.customer ? me.customer.status : null;
    for (const id of Object.keys(takerSelections)) {
      if (id !== myCustId || myCustStatus !== "waiting_take") delete takerSelections[id];
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
    const standings = (data.standings || []).slice();
    const me = standings.find((p) => p.id === myId);
    const myRank = me ? standings.indexOf(me) + 1 : 0;
    $("#over-rank").textContent    = myRank ? `#${myRank}` : "—";
    $("#over-score").textContent   = me ? me.score || 0 : 0;
    $("#over-served").textContent  = me ? me.served || 0 : 0;
    $("#over-streak").textContent  = me ? me.bestStreak || 0 : 0;
    $("#over-left").textContent    = me ? me.left || 0 : 0;

    const ul = $("#over-players");
    ul.innerHTML = "";
    standings.forEach((p, i) => {
      const medal = ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
      const isMe = p.id === myId;
      const li = document.createElement("li");
      li.className = isMe ? "me" : "";
      li.innerHTML = `
        <span><b>${medal}</b> ${escapeHtml(p.name)}${isMe ? " (you)" : ""}</span>
        <span class="role-chip"><b>${p.score || 0}</b> pts · ${p.served || 0} served · best 🔥${p.bestStreak || 0}</span>
      `;
      ul.appendChild(li);
    });
    showScreen("screen-over");
  });

  // Speed-tip popup after a delivery. Rendered as a toast with a big emoji
  // so players can see the reward even if they looked away for a second.
  socket.on("tipEarned", (d) => {
    sfx("deliver");
    const bonus = d.tip > 1 ? ` (tip +${d.tip})` : "";
    const crown = d.vip ? " 👑 VIP" : "";
    toast(`🎉 ${escapeHtml(d.name)} served${crown}${bonus}`);
  });

  socket.on("streakMilestone", (d) => {
    sfx("deliver");
    cheer(`🔥 Streak of ${d.streak}!`);
  });

  socket.on("waveUp", (d) => {
    sfx("newCustomer");
    cheer(`🌊 Wave ${d.wave}! The diner is getting busy…`);
  });

  socket.on("guestLeft", (d) => {
    sfx("wrong");
    toast(`😞 ${escapeHtml(d.name)} got tired of waiting and left.`);
  });

  // Full-width celebration banner used for streak / wave events
  function cheer(msg) {
    const el = $("#cheer-banner");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    clearTimeout(cheer._t);
    cheer._t = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => { el.hidden = true; }, 400);
    }, 2200);
  }

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
      `;
      ul.appendChild(li);
    });

    // Host sees "Start Game"; others see waiting message
    const iAmHost = myId === roomState.hostId;
    $("#btn-start").hidden = !iAmHost || roomState.started;
    $("#waiting-msg").hidden = iAmHost || roomState.started;
    $("#btn-end").hidden = !iAmHost;
  }

  // Phase derived from MY own customer — each player is running their own
  // race, so phones are not in lockstep.
  function currentPhase() {
    const me = getMe();
    if (!me || !me.customer) return "wait";
    const c = me.customer;
    if (c.status === "delivered") return "delivered";
    if (c.status === "left")      return "wait";
    if (c.status === "waiting_take") return "take";
    const o = me.order;
    if (!o) return "wait";
    if (!o.foodDone)  return "cook";
    if (!o.drinkDone) return "drink";
    return "deliver";
  }

  const PHASE_META = {
    take:      { ico: "📝", text: "Take the order" },
    cook:      { ico: "🍳", text: "Cook the food" },
    drink:     { ico: "☕", text: "Make the drink" },
    deliver:   { ico: "🎉", text: "Deliver the order" },
    delivered: { ico: "✨", text: "Delivered!" },
    wait:      { ico: "⏳", text: "Waiting for the next guest…" },
  };

  // ---------- Render: Game ----------
  function renderGame() {
    if (!roomState) return;
    const me = getMe();
    const myScore   = me ? me.score   : 0;
    const myStreak  = me ? me.streak  : 0;
    const myWave    = me ? me.wave    : 1;
    const myServed  = me ? me.served  : 0;
    $("#score").textContent        = myScore;
    $("#stat-streak").textContent  = myStreak;
    $("#stat-wave").textContent    = myWave;
    $("#stat-served").textContent  = myServed;

    const phase = currentPhase();
    const meta = PHASE_META[phase];
    $("#phase-banner .phase-ico").textContent = meta.ico;
    $("#phase-banner .phase-text").textContent = meta.text;
    $("#phase-banner").setAttribute("data-phase", phase);

    // Serving context uses MY customer
    const ctx = $("#serving-context");
    const c = me ? me.customer : null;
    const order = me ? me.order : null;
    if (c && order && c.status !== "delivered" && c.status !== "left") {
      ctx.hidden = false;
      ctx.querySelector(".serving-face").textContent = (c.vip ? "👑" : "") + c.face;
      ctx.querySelector(".serving-text").innerHTML =
        `Now serving <b>${escapeHtml(c.name)}${c.vip ? ' <span class="vip-tag">VIP</span>' : ""}</b> — ${order.food.icon} ${escapeHtml(order.food.name)} + ${order.drink.icon} ${escapeHtml(order.drink.name)}`;
      ctx.querySelector(".serving-patience").innerHTML = patienceBarHtml(c);
    } else {
      ctx.hidden = true;
    }

    $("#station-taker").hidden   = phase !== "take";
    $("#station-cook").hidden    = phase !== "cook";
    $("#station-barista").hidden = phase !== "drink";
    $("#station-deliver").hidden = !(phase === "deliver" || phase === "delivered");

    const iAmHost = myId === roomState.hostId;
    $("#btn-end").hidden = !iAmHost;

    if (phase === "take")         renderTakerStation();
    else if (phase === "cook")    renderCookStation();
    else if (phase === "drink")   renderBaristaStation();
    else if (phase === "deliver" || phase === "delivered") renderDeliverPanel();

    renderLeaderboardMini();
  }

  // Compact live leaderboard under the header on every player's phone.
  function renderLeaderboardMini() {
    const el = $("#leaderboard-mini");
    if (!el) return;
    const ranked = (roomState.players || []).slice().sort(
      (a, b) => (b.score || 0) - (a.score || 0) || (b.served || 0) - (a.served || 0)
    );
    el.innerHTML = ranked.map((p, i) => {
      const medal = ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
      const isMe = p.id === myId;
      return `<li class="${isMe ? "me" : ""}">
        <span class="rank">${medal}</span>
        <span class="who">${escapeHtml(p.name)}${isMe ? " (you)" : ""}</span>
        <span class="pts"><b>${p.score || 0}</b> pts · ${p.served || 0} served</span>
      </li>`;
    }).join("");
  }

  function renderDeliverPanel() {
    const panel = $("#deliver-panel");
    const me = getMe();
    const c = me && me.customer;
    if (!c) {
      panel.innerHTML = `<p class="empty-note">Waiting…</p>`;
      return;
    }
    const order = me.order;
    if (!order) return;
    const delivered = c.status === "delivered";
    panel.innerHTML = `
      <div class="customer-card ${delivered ? "delivered-flash" : ""}${c.vip ? " vip" : ""}">
        <div class="who">
          <div class="face" aria-hidden="true">${c.vip ? "<span class='crown' aria-hidden='true'>👑</span>" : ""}${c.face}</div>
          <div class="name">${escapeHtml(c.name)}${c.vip ? ' <span class="vip-tag">VIP</span>' : ""}</div>
          <div class="mood" aria-hidden="true">${delivered ? "🎉" : "😋"}</div>
        </div>
        <div class="order">${order.food.icon} <b>${escapeHtml(order.food.name)}</b> &amp; ${order.drink.icon} <b>${escapeHtml(order.drink.name)}</b></div>
        ${delivered ? "" : patienceBarHtml(c)}
        ${delivered
          ? `<div class="big-action deliver" style="text-align:center;">Delivered — thank you! 🎉</div>`
          : `<button class="big-action deliver" data-act="deliver">Deliver order 🎉</button>`
        }
      </div>
    `;
    panel.onclick = (ev) => {
      const btn = ev.target.closest("button[data-act='deliver']");
      if (!btn) return;
      sfx("deliver");
      socket.emit("deliver");
    };
  }

  // Per-customer draft selections (local only — each taker has their own).
  // Shape: { [customerId]: { food: "burger", drink: "coffee" } }
  const takerSelections = {};

  // Briefly flash a card with a celebration class when a guest is delivered.
  // Stored here so re-renders don't steal the animation mid-flight.
  const deliveredFlash = new Set();

  function patienceBarHtml(c) {
    if (!c || typeof c.patienceMax !== "number") return "";
    const pct = patiencePercentNow(c);
    const state = pct > 50 ? "ok" : (pct > 20 ? "warn" : "danger");
    return `<div class="patience" data-cust="${c.id}">
              <div class="patience-label">Patience</div>
              <div class="patience-track">
                <div class="patience-fill ${state}" style="width:${pct.toFixed(1)}%"></div>
              </div>
            </div>`;
  }

  // Animate patience bars on screen. Competitive mode means each player
  // has their own customer, and the TV shows every player's customer at
  // once — iterate them all.
  setInterval(() => {
    if (document.hidden) return;
    if (!roomState || !roomState.players) return;
    const customers = [];
    for (const p of roomState.players) if (p.customer) customers.push(p.customer);
    for (const c of customers) {
      const pct = patiencePercentNow(c);
      const state = pct > 50 ? "ok" : (pct > 20 ? "warn" : "danger");
      document.querySelectorAll('.patience[data-cust="' + c.id + '"] .patience-fill').forEach((el) => {
        el.style.width = pct.toFixed(1) + "%";
        el.classList.remove("ok", "warn", "danger");
        el.classList.add(state);
      });
    }
  }, 120);

  function moodFor(customer, order, picks) {
    if (customer.status === "delivered") return "🎉";
    if (customer.status === "ready_deliver") return "😋";
    if (customer.status === "preparing") return "⌛";
    // Waiting to take. If the taker has picked the right items, the guest
    // smiles — gentle feedback before they even tap "Send to kitchen".
    const correct = picks && picks.food === order.food.id && picks.drink === order.drink.id;
    return correct ? "😊" : "🤔";
  }

  // Taker: my own guest only. Tap food + drink from the shuffled menus,
  // then Send to Kitchen.
  function renderTakerStation() {
    const list = $("#customers-list");
    const me = getMe();
    const c = me && me.customer;
    const order = me && me.order;
    if (!c || !order) {
      list.innerHTML = `<p class="empty-note">Waiting for the next guest…</p>`;
      return;
    }

    const menu = roomState.menu;
    list.innerHTML = "";

    const picks = takerSelections[c.id] || {};
    const food = order.food;
    const drink = order.drink;

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

    const foodPill  = `<span class="progress-pill">${food.icon} ${escapeHtml(food.name)}</span>`;
    const drinkPill = `<span class="progress-pill">${drink.icon} ${escapeHtml(drink.name)}</span>`;

    const card = document.createElement("div");
    card.className = "customer-card" + (c.vip ? " vip" : "");
    card.dataset.customerId = c.id;
    card.innerHTML = `
      <div class="who">
        <div class="face" aria-hidden="true">${c.vip ? "<span class='crown' aria-hidden='true'>👑</span>" : ""}${c.face}</div>
        <div class="name">${escapeHtml(c.name)}${c.vip ? ' <span class="vip-tag">VIP</span>' : ""}</div>
        <div class="mood" aria-hidden="true">${moodFor(c, order, picks)}</div>
      </div>
      ${c.phrase ? `<div class="speech">“${escapeHtml(c.phrase)}”</div>` : ""}
      <div class="order">Would like: <b>${food.icon} ${escapeHtml(food.name)}</b> and <b>${drink.icon} ${escapeHtml(drink.name)}</b></div>
      <div class="progress-row">${foodPill} ${drinkPill}</div>
      ${patienceBarHtml(c)}
      <div class="menu-section">
        <div class="menu-title">Choose the food</div>
        <div class="menu-grid">${foodBtns}</div>
      </div>
      <div class="menu-section">
        <div class="menu-title">Choose the drink</div>
        <div class="menu-grid">${drinkBtns}</div>
      </div>
      <button class="big-action primary send-btn" data-act="send" ${canSend ? "" : "disabled"}>
        ${canSend ? "Send to kitchen" : "Pick a food and a drink"}
      </button>
    `;
    list.appendChild(card);

    list.onclick = (ev) => {
      const menuBtn = ev.target.closest("button.menu-btn");
      if (menuBtn) {
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
      const btn = ev.target.closest("button[data-act='send']");
      if (!btn) return;
      const p = takerSelections[c.id] || {};
      if (!p.food || !p.drink) return;
      sfx("orderSent");
      socket.emit("submitOrder", { foodId: p.food, drinkId: p.drink });
    };
  }

  // Cook: my own ticket — circular ingredient ring.
  function renderCookStation() {
    const list = $("#cook-list");
    const me = getMe();
    const order = me && me.order;
    const customer = me && me.customer;

    if (!order || !customer || order.foodDone) {
      list.innerHTML = `<p class="empty-note">Waiting for the next order…</p>`;
      return;
    }

    const menuIngredients = (roomState.menu && roomState.menu.ingredients) || INGREDIENT_LABELS;
    const paletteIds = order.ingredientOrder || Object.keys(menuIngredients);
    const n = paletteIds.length;

    // Recipe list shown inside the central plate
    const recipeSteps = order.food.ingredients
      .map((ing, i) => {
        const meta = menuIngredients[ing] || INGREDIENT_LABELS[ing] || { name: ing, icon: "•" };
        const done = i < order.foodProgress.length;
        const next = i === order.foodProgress.length && !done;
        return `<li class="${done ? "done" : ""} ${next ? "next" : ""}">${meta.icon} ${escapeHtml(meta.name)}${done ? " ✓" : ""}</li>`;
      })
      .join("");

    // One button per ingredient, positioned on a circle around the plate
    const ringBtns = paletteIds.map((ing, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2; // start at top, clockwise
      const rx = 50 + Math.cos(angle) * 40; // percent of container width
      const ry = 50 + Math.sin(angle) * 40;
      const meta = menuIngredients[ing] || INGREDIENT_LABELS[ing] || { name: ing, icon: "•" };
      const recipeNeeds = order.food.ingredients.includes(ing);
      return `
        <button class="ring-btn ${recipeNeeds ? "" : "ring-distractor"}"
                data-ing="${ing}"
                style="left:${rx}%; top:${ry}%;">
          <span class="ring-ico" aria-hidden="true">${meta.icon}</span>
          <span class="ring-name">${escapeHtml(meta.name)}</span>
        </button>`;
    }).join("");

    const guestTag = customer ? `for <b>${escapeHtml(customer.name)}</b>` : "";
    const canUndo = order.foodProgress.length > 0;
    const doneCount = order.foodProgress.length;
    const totalCount = order.food.ingredients.length;

    list.innerHTML = `
      <div class="cook-recipe-card">
        <div class="cook-recipe-head">
          <span class="cook-dish" aria-hidden="true">${order.food.icon}</span>
          <div class="cook-recipe-titles">
            <div class="cook-dish-name">${escapeHtml(order.food.name)}</div>
            <div class="cook-for">${guestTag}</div>
          </div>
          <button class="cook-undo" data-act="undo" ${canUndo ? "" : "disabled"}>↶ Undo last</button>
        </div>
        <ol class="cook-recipe">${recipeSteps}</ol>
      </div>
      <div class="cook-arena">
        <div class="cook-ring">${ringBtns}</div>
        <div class="cook-plate">
          <div class="cook-plate-dish" aria-hidden="true">${order.food.icon}</div>
          <div class="cook-plate-progress">${doneCount} of ${totalCount}</div>
        </div>
      </div>
    `;

    list.querySelectorAll(".ring-btn").forEach((b) => {
      b.addEventListener("click", () => {
        sfx("ingredient");
        socket.emit("addIngredient", { ingredient: b.dataset.ing });
      });
    });
    list.querySelectorAll(".cook-undo").forEach((b) => {
      b.addEventListener("click", () => {
        sfx("tap");
        socket.emit("undoIngredient");
      });
    });
  }

  // Barista: my own drink ticket — two steps (cup + pour right drink).
  function renderBaristaStation() {
    const list = $("#barista-list");
    const me = getMe();
    const order = me && me.order;
    const customer = me && me.customer;
    if (!order || !customer || order.drinkDone) {
      list.innerHTML = `<p class="empty-note">Waiting for the next drink order…</p>`;
      return;
    }

    const cupDone = order.drinkProgress.cup;
    const drinkDone = order.drinkProgress.drink;

    const steps = `
      <ol>
        <li class="${cupDone ? "done" : ""} ${!cupDone ? "next" : ""}">🥤 Get a cup${cupDone ? " ✓" : ""}</li>
        <li class="${drinkDone ? "done" : ""} ${cupDone && !drinkDone ? "next" : ""}">${order.drink.icon} Pour ${escapeHtml(order.drink.name)}${drinkDone ? " ✓" : ""}</li>
      </ol>
    `;
    const guestTag = `for <b>${escapeHtml(customer.name)}</b>`;

    const drinks = roomState.menu.drinks;
    const pourBtns = Object.values(drinks).map((d) => `
      <button class="drink-step-btn pour-btn" data-step="pour" data-drink="${d.id}"
        ${!cupDone || drinkDone ? "disabled" : ""}>
        <span class="ico" aria-hidden="true">${d.icon}</span>
        <span>Pour ${escapeHtml(d.name)}</span>
      </button>
    `).join("");

    const card = document.createElement("div");
    card.className = "ticket-card";
    card.innerHTML = `
      <h4>${order.drink.icon} ${escapeHtml(order.drink.name)}</h4>
      <div class="for">${guestTag}</div>
      <div class="recipe">${steps}</div>
      <div class="drink-palette">
        <button class="drink-step-btn cup-btn" data-step="cup" ${cupDone ? "disabled" : ""}>
          <span class="ico" aria-hidden="true">🥤</span>
          <span>Get a cup</span>
        </button>
      </div>
      <div class="menu-title" style="margin-top:10px;">Then pour the right drink</div>
      <div class="drink-palette pour-grid">${pourBtns}</div>
    `;

    card.querySelectorAll(".drink-step-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const step = b.dataset.step;
        const payload = { step };
        if (step === "pour") payload.drinkId = b.dataset.drink;
        if (step === "cup") sfx("cup"); else sfx("pour");
        socket.emit("drinkStep", payload);
      });
    });

    list.innerHTML = "";
    list.appendChild(card);
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
      // In-game: TV is the competition's shared leaderboard display.
      const ranked = (roomState.players || []).slice().sort(
        (a, b) => (b.score || 0) - (a.score || 0) || (b.served || 0) - (a.served || 0)
      );
      const leader = ranked[0];
      const totalServed = (roomState.players || []).reduce((n, p) => n + (p.served || 0), 0);
      const totalLeft   = (roomState.players || []).reduce((n, p) => n + (p.left || 0), 0);
      const maxWave     = (roomState.players || []).reduce((w, p) => Math.max(w, p.wave || 1), 1);

      $("#tv-live-score").textContent   = leader ? leader.score || 0 : 0;
      $("#tv-live-code").textContent    = code;
      $("#tv-live-streak").textContent  = leader ? leader.streak || 0 : 0;
      $("#tv-live-wave").textContent    = maxWave;
      $("#tv-live-served").textContent  = totalServed;
      $("#tv-live-left").textContent    = totalLeft;

      // Mini card per player showing their current guest + progress
      const guestsEl = $("#tv-live-guests");
      const activePlayers = ranked.filter((p) => p.customer);
      if (activePlayers.length === 0) {
        guestsEl.innerHTML = `<p class="empty-note">Waiting for the first guests…</p>`;
      } else {
        guestsEl.innerHTML = "";
        for (const p of activePlayers) {
          const c = p.customer;
          const order = p.order;
          if (!c || !order) continue;
          const status = {
            waiting_take:  { text: "Taking order",         cls: "waiting" },
            preparing:     { text: "Cooking & brewing",    cls: "preparing" },
            ready_deliver: { text: "Ready to deliver!",    cls: "ready" },
            delivered:     { text: "Delivered 🎉",         cls: "delivered" },
            left:          { text: "Walked out 😞",         cls: "delivered" },
          }[c.status] || { text: c.status, cls: "" };

          const card = document.createElement("div");
          card.className = "tv-guest-card" + (c.vip ? " vip" : "");
          card.innerHTML = `
            <div class="tv-guest-head">
              <span class="tv-guest-face" aria-hidden="true">${c.vip ? "👑" : ""}${c.face}</span>
              <span class="tv-guest-name">
                ${escapeHtml(c.name)}${c.vip ? ' <span class="vip-tag">VIP</span>' : ""}
                <span class="tv-guest-player">— ${escapeHtml(p.name)}</span>
              </span>
            </div>
            <div class="tv-guest-order">${order.food.icon} ${escapeHtml(order.food.name)} &nbsp;+&nbsp; ${order.drink.icon} ${escapeHtml(order.drink.name)}</div>
            <div class="tv-guest-prog">
              <span class="tv-prog ${order.foodDone ? "done" : ""}">Food: ${order.foodProgress.length}/${order.food.ingredients.length}${order.foodDone ? " ✓" : ""}</span>
              <span class="tv-prog ${order.drinkDone ? "done" : ""}">Drink: ${drinkStepCount(order)}/2${order.drinkDone ? " ✓" : ""}</span>
            </div>
            <div class="tv-guest-status ${status.cls}">${status.text}</div>
            ${c.status !== "delivered" && c.status !== "left" ? patienceBarHtml(c) : ""}
          `;
          guestsEl.appendChild(card);
        }
      }

      // Leaderboard table — medals for the top three.
      const ul = $("#tv-live-players");
      ul.innerHTML = "";
      ranked.forEach((p, i) => {
        const medal = ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
        const li = document.createElement("li");
        li.className = "tv-leader-row" + (i < 3 ? " top" : "");
        li.innerHTML = `
          <span class="rank">${medal}</span>
          <span class="who">${escapeHtml(p.name)}</span>
          <span class="pts"><b>${p.score || 0}</b> pts · ${p.served || 0} served · 🔥${p.streak || 0}</span>
        `;
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
