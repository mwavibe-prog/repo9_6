/* Friendly Diner — audio engine.
 *
 * No asset files: everything is synthesised in the browser with Web Audio so
 * the game works offline and loads instantly. Two streams mix through a
 * master gain:
 *   • SFX  — short blips/chimes triggered on gameplay events
 *   • MUSIC — a gentle C-major arpeggio loop for restaurant ambience
 * Both can be toggled by the player via window.Audio.toggle(). Audio must be
 * started by a user gesture (browser autoplay policy), so the first call to
 * ensureAudio() happens on the first button tap.
 */
(function () {
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  let master = null;
  let musicBus = null;
  let sfxBus = null;
  let musicTimer = null;
  let unlocked = false;

  // Persisted preferences (off by default the very first visit — elderly
  // players can opt in; once toggled, the choice sticks).
  const store = {
    get on() { return localStorage.getItem("fd.audio.on") !== "0"; },
    set on(v) { localStorage.setItem("fd.audio.on", v ? "1" : "0"); },
    get music() { return localStorage.getItem("fd.audio.music") !== "0"; },
    set music(v) { localStorage.setItem("fd.audio.music", v ? "1" : "0"); },
  };

  function ensureAudio() {
    if (ctx) return ctx;
    if (!AudioCtxClass) return null;
    try {
      ctx = new AudioCtxClass();
      master = ctx.createGain();
      master.gain.value = store.on ? 0.6 : 0.0;
      master.connect(ctx.destination);

      musicBus = ctx.createGain();
      musicBus.gain.value = store.music ? 0.35 : 0.0;
      musicBus.connect(master);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = 1.0;
      sfxBus.connect(master);
    } catch (_) { ctx = null; }
    return ctx;
  }

  // Unlock on any first user gesture. Resumes a suspended context too.
  function unlockOnGesture() {
    if (unlocked) return;
    const done = () => {
      unlocked = true;
      const c = ensureAudio();
      if (c && c.state === "suspended") c.resume().catch(() => {});
      document.removeEventListener("click", done, true);
      document.removeEventListener("touchend", done, true);
      document.removeEventListener("keydown", done, true);
    };
    document.addEventListener("click", done, true);
    document.addEventListener("touchend", done, true);
    document.addEventListener("keydown", done, true);
  }
  unlockOnGesture();

  // Low-level tone. Attack/release envelope so it never clicks.
  function tone(freq, duration, type, volume, bus) {
    const c = ensureAudio();
    if (!c) return;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type || "sine";
    osc.frequency.value = freq;
    const t = c.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(volume, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g);
    g.connect(bus || sfxBus);
    osc.start(t);
    osc.stop(t + duration + 0.04);
  }

  function sfx(name) {
    const c = ensureAudio();
    if (!c || !store.on) return;
    switch (name) {
      case "tap":           tone(660, 0.05, "sine", 0.15); break;
      case "pick":          tone(520, 0.08, "triangle", 0.18); break;
      case "newCustomer":
        tone(880, 0.12, "sine", 0.2);
        setTimeout(() => tone(1320, 0.15, "sine", 0.2), 100);
        break;
      case "orderSent":
        tone(784, 0.1, "sine", 0.2);
        setTimeout(() => tone(988, 0.12, "sine", 0.2), 90);
        setTimeout(() => tone(1318, 0.18, "sine", 0.2), 180);
        break;
      case "ingredient":    tone(420, 0.06, "square", 0.08); break;
      case "cup":           tone(300, 0.08, "square", 0.1); break;
      case "pour":
        tone(520, 0.3, "sawtooth", 0.06);
        setTimeout(() => tone(620, 0.25, "sawtooth", 0.05), 60);
        break;
      case "ready":         tone(1047, 0.2, "sine", 0.22); break;
      case "deliver":
        [0, 90, 180, 340].forEach((t, i) => {
          const notes = [523, 659, 784, 1047]; // C E G C
          setTimeout(() => tone(notes[i], i === 3 ? 0.4 : 0.15, "sine", 0.22), t);
        });
        break;
      case "wrong":
        tone(330, 0.18, "triangle", 0.14);
        setTimeout(() => tone(247, 0.22, "triangle", 0.14), 110);
        break;
    }
  }

  // Restaurant ambience: slow broken-chord arpeggio, two octaves, very soft.
  // Triangle waves give a gentle kalimba-ish feel.
  const MUSIC_NOTES = [
    261.63, 329.63, 392.00, 523.25, // C4 E4 G4 C5
    392.00, 329.63, 261.63, 196.00, // G4 E4 C4 G3
    293.66, 369.99, 440.00, 587.33, // D4 F#4 A4 D5  (gentle lift)
    349.23, 293.66, 261.63, 196.00, // F4 D4 C4 G3  (resolve)
  ];

  function startMusic() {
    if (musicTimer) return;
    const c = ensureAudio();
    if (!c) return;
    let step = 0;
    const play = () => {
      const freq = MUSIC_NOTES[step % MUSIC_NOTES.length];
      // Dual-voice pluck — fundamental + soft octave
      tone(freq, 1.8, "triangle", 0.18, musicBus);
      tone(freq * 2, 1.4, "sine", 0.05, musicBus);
      // Occasional bass root every 4 steps for warmth
      if (step % 4 === 0) tone(freq / 2, 2.4, "sine", 0.10, musicBus);
      step++;
    };
    play();
    musicTimer = setInterval(play, 720);
  }

  function stopMusic() {
    if (musicTimer) clearInterval(musicTimer);
    musicTimer = null;
  }

  function setMaster(on) {
    store.on = on;
    const c = ensureAudio();
    if (!c) return;
    const t = c.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.linearRampToValueAtTime(on ? 0.6 : 0.0001, t + 0.2);
  }

  function setMusic(on) {
    store.music = on;
    const c = ensureAudio();
    if (!c) return;
    const t = c.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.linearRampToValueAtTime(on ? 0.35 : 0.0001, t + 0.2);
    if (on) startMusic(); else stopMusic();
  }

  window.Audio = {
    sfx,
    startMusic,
    stopMusic,
    setMaster,
    setMusic,
    get on()    { return store.on; },
    get music() { return store.music; },
  };
})();
