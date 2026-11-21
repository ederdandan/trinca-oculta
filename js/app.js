/* =============================================================================
   TRINCA OCULTA — Motor do jogo
   - Perfil local (nome + foto/ícone) salvo em localStorage
   - Modos: Contra Bot, Passar Celular, Sala Online (PeerJS + BroadcastChannel)
   - O anfitrião é a autoridade da partida online; o convidado só envia ações.
   ============================================================================= */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------------------
     0. UTILITÁRIOS
     --------------------------------------------------------------------------- */
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  function randomId(len = 10) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  const STORAGE_KEYS = {
    profiles: 'trinca-oculta.profiles.v1',
    prefs: 'trinca-oculta.prefs.v1'
  };

  /* ---------------------------------------------------------------------------
     1. ÁUDIO PROCEDURAL + CONFETES
     --------------------------------------------------------------------------- */
  class SoundFX {
    constructor() {
      this.enabled = true;
      this.ctx = null;
    }
    init() {
      if (!this.enabled) return null;
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) this.ctx = new AC();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      } catch (_) {}
      return this.ctx;
    }
    beep(freq, type = 'sine', dur = 0.11, vol = 0.12, endFreq = null) {
      const ctx = this.init();
      if (!ctx) return;
      try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);
        if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, now + dur);
        gain.gain.setValueAtTime(vol, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + dur + 0.01);
      } catch (_) {}
    }
    vibrate(pattern) {
      if (!this.enabled || !navigator.vibrate) return;
      try { navigator.vibrate(pattern); } catch (_) {}
    }
    tap() { this.beep(520, 'sine', 0.05, 0.08); }
    flip() { this.beep(480, 'triangle', 0.07, 0.1, 690); this.vibrate(10); }
    match() {
      this.beep(587.33, 'sine', 0.1, 0.12);
      setTimeout(() => this.beep(880, 'sine', 0.14, 0.12), 75);
      this.vibrate(18);
    }
    miss() { this.beep(240, 'sawtooth', 0.18, 0.09, 155); this.vibrate([25, 25, 25]); }
    trio() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => setTimeout(() => this.beep(f, 'triangle', 0.18, 0.13), i * 75));
      this.vibrate([20, 30, 40]);
    }
    win() {
      [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => setTimeout(() => this.beep(f, 'triangle', 0.25, 0.14), i * 95));
      this.vibrate([30, 35, 60]);
    }
    lose() {
      [392, 349.23, 311.13, 261.63].forEach((f, i) => setTimeout(() => this.beep(f, 'triangle', 0.22, 0.11), i * 120));
      this.vibrate([60, 40, 60]);
    }
  }
  const sfx = new SoundFX();

  function launchConfetti(count = 36) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const layer = $('confetti-layer');
    if (!layer) return;
    const colors = ['#facc15', '#38bdf8', '#f43f5e', '#4ade80', '#c084fc'];
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.backgroundColor = colors[i % colors.length];
      piece.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      piece.style.animationDelay = (Math.random() * 0.25) + 's';
      layer.appendChild(piece);
      setTimeout(() => piece.remove(), 3300);
    }
  }

  function showToast(text) {
    const box = $('toast-container');
    if (!box || !text) return;
    box.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'toast-pill glass-panel mx-auto w-fit max-w-full px-3.5 py-1.5 rounded-2xl text-xs font-extrabold shadow-xl text-center';
    div.style.borderColor = 'var(--accent)';
    div.setAttribute('role', 'status');
    div.textContent = text;
    box.appendChild(div);
  }

  /* ---------------------------------------------------------------------------
     2. PERFIL LOCAL (LOGIN NO APARELHO)
     --------------------------------------------------------------------------- */
  const AVATAR_ICONS = ['🦊', '🐺', '🦁', '🐯', '🐼', '🐸', '🦉', '🐙', '🐲', '🦄', '👑', '🧙', '🥷', '🤠', '👽', '🎩'];
  const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
  const MAX_PHOTO_CHARS = 120000;

  function sanitizeName(value, fallback = 'Jogador') {
    const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
    return clean || fallback;
  }

  function sanitizeProfileAvatar(av) {
    if (av && av.type === 'photo' && typeof av.value === 'string' && av.value.length <= MAX_PHOTO_CHARS && PHOTO_RE.test(av.value)) {
      return { type: 'photo', value: av.value };
    }
    if (av && av.type === 'emoji' && typeof av.value === 'string' && av.value.length > 0 && av.value.length <= 8) {
      return { type: 'emoji', value: av.value };
    }
    return { type: 'emoji', value: '🙂' };
  }

  function loadProfileStore() {
    const raw = loadJSON(STORAGE_KEYS.profiles, null);
    const store = { activeId: null, profiles: [] };
    if (raw && Array.isArray(raw.profiles)) {
      store.profiles = raw.profiles
        .filter((p) => p && typeof p.id === 'string')
        .map((p) => ({
          id: p.id,
          name: sanitizeName(p.name),
          avatar: sanitizeProfileAvatar(p.avatar),
          stats: {
            played: Number(p.stats?.played) || 0,
            wins: Number(p.stats?.wins) || 0,
            losses: Number(p.stats?.losses) || 0,
            draws: Number(p.stats?.draws) || 0
          },
          createdAt: Number(p.createdAt) || Date.now()
        }));
      store.activeId = store.profiles.some((p) => p.id === raw.activeId) ? raw.activeId : (store.profiles[0]?.id ?? null);
    }
    return store;
  }

  const profileStore = loadProfileStore();

  function activeProfile() {
    return profileStore.profiles.find((p) => p.id === profileStore.activeId) || null;
  }

  function persistProfiles() {
    if (!saveJSON(STORAGE_KEYS.profiles, profileStore)) {
      showToast('⚠️ Sem espaço para salvar o perfil. Tente uma foto menor ou um ícone.');
      return false;
    }
    return true;
  }

  /* Avatares dentro da partida:
     { type:'emoji', value } | { type:'photo', owner:'host'|'guest'|'local:<profileId>' }
     Fotos nunca trafegam no estado da partida: cada aparelho resolve pelo dono. */
  function playerAvatarFromProfile(profile, owner) {
    if (profile && profile.avatar.type === 'photo') return { type: 'photo', owner };
    return { type: 'emoji', value: profile ? profile.avatar.value : '🙂' };
  }

  function resolvePhoto(owner) {
    if (typeof owner !== 'string') return null;
    if (owner.startsWith('local:')) {
      const p = profileStore.profiles.find((x) => x.id === owner.slice(6));
      return p && p.avatar.type === 'photo' ? p.avatar.value : null;
    }
    const myRole = net.isHost ? 'host' : 'guest';
    if (owner === myRole) {
      const me = activeProfile();
      return me && me.avatar.type === 'photo' ? me.avatar.value : null;
    }
    const remote = net.isHost ? net.guestProfile : net.hostProfile;
    return remote && remote.avatar.type === 'photo' ? remote.avatar.value : null;
  }

  const AVATAR_SIZES = {
    xs: 'w-5 h-5 text-xs',
    sm: 'w-7 h-7 text-base',
    md: 'w-10 h-10 text-2xl',
    lg: 'w-14 h-14 text-3xl',
    xl: 'w-24 h-24 text-6xl'
  };

  function avatarHtml(av, size = 'sm') {
    const cls = AVATAR_SIZES[size] || AVATAR_SIZES.sm;
    let src = null;
    if (av && av.type === 'photo') src = resolvePhoto(av.owner);
    else if (av && av.type === 'photo-src') src = av.value;
    if (src && PHOTO_RE.test(src)) {
      return `<img src="${src}" alt="" class="${cls} rounded-full object-cover shrink-0 border" style="border-color: var(--panel-border);" />`;
    }
    const emoji = av && av.type === 'emoji' ? av.value : '🙂';
    return `<span class="${cls} rounded-full soft-panel inline-flex items-center justify-center shrink-0 leading-none" aria-hidden="true">${escapeHtml(emoji)}</span>`;
  }

  function profileAvatarHtml(profile, size) {
    if (!profile) return avatarHtml(null, size);
    if (profile.avatar.type === 'photo') return avatarHtml({ type: 'photo-src', value: profile.avatar.value }, size);
    return avatarHtml(profile.avatar, size);
  }

  /* Recorta a imagem no centro (quadrado) e reduz para 160px JPEG (~10 KB). */
  function processPhotoFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        reject(new Error('Arquivo não é uma imagem.'));
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const size = 160;
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          const sx = (img.naturalWidth - side) / 2;
          const sy = (img.naturalHeight - side) / 2;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          let quality = 0.82;
          let data = canvas.toDataURL('image/jpeg', quality);
          while (data.length > MAX_PHOTO_CHARS && quality > 0.4) {
            quality -= 0.12;
            data = canvas.toDataURL('image/jpeg', quality);
          }
          resolve(data);
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Não foi possível abrir a imagem.'));
      };
      img.src = url;
    });
  }

  const profileUI = {
    editingId: null,          // null = criando novo
    draftAvatar: { type: 'emoji', value: AVATAR_ICONS[0] },
    firstRun: false
  };

  function openProfileScreen({ editId = profileStore.activeId, firstRun = false } = {}) {
    profileUI.firstRun = firstRun;
    profileUI.editingId = editId;
    const editing = profileStore.profiles.find((p) => p.id === editId) || null;
    profileUI.editingId = editing ? editing.id : null;
    profileUI.draftAvatar = editing ? { ...editing.avatar } : { type: 'emoji', value: AVATAR_ICONS[Math.floor(Math.random() * AVATAR_ICONS.length)] };

    $('input-profile-name').value = editing ? editing.name : '';
    $('profile-error').classList.add('hidden');
    $('btn-close-profile').classList.toggle('hidden', firstRun || !activeProfile());
    $('btn-delete-profile').classList.toggle('hidden', !editing);
    $('profile-kicker').textContent = firstRun ? 'Bem-vindo!' : 'Perfil';
    $('profile-title').textContent = editing ? 'Editar perfil' : (firstRun ? 'Crie seu perfil' : 'Novo jogador');
    $('btn-save-profile').textContent = editing ? 'Salvar' : 'Salvar e Jogar';

    renderProfileList();
    renderProfileStats(editing);
    renderProfileAvatarPicker();
    $('profile-screen').classList.remove('hidden');
    if (firstRun) setTimeout(() => $('input-profile-name').focus(), 50);
  }

  function closeProfileScreen() {
    if (!activeProfile()) return;
    $('profile-screen').classList.add('hidden');
  }

  function renderProfileList() {
    const section = $('profile-list-section');
    const others = profileStore.profiles;
    if (others.length === 0) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    $('profile-list').innerHTML = others.map((p) => {
      const isActive = p.id === profileStore.activeId;
      const isEditing = p.id === profileUI.editingId;
      return `
        <div class="flex items-center gap-1.5">
          <button type="button" data-profile-select="${escapeHtml(p.id)}" class="flex-1 min-w-0 soft-panel rounded-xl px-2.5 py-1.5 flex items-center gap-2 text-left border-2 transition" style="border-color: ${isActive ? 'var(--accent)' : 'transparent'};">
            ${profileAvatarHtml(p, 'sm')}
            <span class="min-w-0 flex-1">
              <span class="block text-xs font-extrabold truncate">${escapeHtml(p.name)}</span>
              <span class="block text-[10px] opacity-75">${p.stats.wins}V • ${p.stats.losses}D • ${p.stats.played} jogos</span>
            </span>
            ${isActive ? '<span class="text-[10px] font-extrabold" style="color: var(--accent);">● Jogando</span>' : ''}
          </button>
          <button type="button" data-profile-edit="${escapeHtml(p.id)}" class="soft-panel w-9 h-9 rounded-xl text-sm shrink-0 ${isEditing ? 'avatar-selected' : ''}" aria-label="Editar ${escapeHtml(p.name)}">✏️</button>
        </div>
      `;
    }).join('');
  }

  function renderProfileStats(profile) {
    const box = $('profile-stats');
    if (!profile) {
      box.classList.add('hidden');
      return;
    }
    const s = profile.stats;
    const rate = s.played ? Math.round((s.wins / s.played) * 100) : 0;
    box.classList.remove('hidden');
    box.innerHTML = [
      ['Jogos', s.played],
      ['Vitórias', s.wins],
      ['Derrotas', s.losses],
      ['Aprov.', rate + '%']
    ].map(([label, value]) => `
      <div>
        <div class="text-base font-black" style="color: var(--accent);">${value}</div>
        <div class="text-[9px] uppercase font-bold opacity-75">${label}</div>
      </div>
    `).join('');
  }

  function renderProfileAvatarPicker() {
    const draft = profileUI.draftAvatar;
    $('profile-avatar-preview').innerHTML = draft.type === 'photo'
      ? avatarHtml({ type: 'photo-src', value: draft.value }, 'xl')
      : avatarHtml(draft, 'xl');

    $('profile-icon-grid').innerHTML = AVATAR_ICONS.map((icon) => {
      const selected = draft.type === 'emoji' && draft.value === icon;
      return `<button type="button" data-avatar-icon="${icon}" class="soft-panel aspect-square rounded-xl text-xl flex items-center justify-center active:scale-90 transition ${selected ? 'avatar-selected' : ''}" aria-label="Ícone ${icon}" aria-pressed="${selected}">${icon}</button>`;
    }).join('');
  }

  async function handlePhotoInput(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await processPhotoFile(file);
      profileUI.draftAvatar = { type: 'photo', value: dataUrl };
      renderProfileAvatarPicker();
    } catch (err) {
      showToast('⚠️ ' + (err.message || 'Falha ao carregar a foto.'));
    }
  }

  function saveProfileFromForm(e) {
    e.preventDefault();
    const rawName = $('input-profile-name').value;
    const name = sanitizeName(rawName, '');
    const errEl = $('profile-error');
    if (name.length < 2) {
      errEl.textContent = 'Digite um nome com pelo menos 2 letras.';
      errEl.classList.remove('hidden');
      $('input-profile-name').focus();
      return;
    }
    const duplicate = profileStore.profiles.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== profileUI.editingId);
    if (duplicate) {
      errEl.textContent = 'Já existe um perfil com esse nome neste aparelho.';
      errEl.classList.remove('hidden');
      return;
    }

    const avatar = sanitizeProfileAvatar(profileUI.draftAvatar);
    let profile = profileStore.profiles.find((p) => p.id === profileUI.editingId);
    if (profile) {
      profile.name = name;
      profile.avatar = avatar;
    } else {
      profile = { id: randomId(10), name, avatar, stats: { played: 0, wins: 0, losses: 0, draws: 0 }, createdAt: Date.now() };
      profileStore.profiles.push(profile);
    }
    profileStore.activeId = profile.id;
    if (!persistProfiles()) return;

    sfx.tap();
    $('profile-screen').classList.add('hidden');
    onProfileChanged();
    if (profileUI.firstRun) {
      showToast(`Bem-vindo, ${profile.name}! 🎴`);
      openTutorialModal();
    } else {
      showToast('✓ Perfil salvo');
    }
  }

  async function deleteEditingProfile() {
    const profile = profileStore.profiles.find((p) => p.id === profileUI.editingId);
    if (!profile) return;
    const ok = await confirmDialog('Excluir perfil?', `O perfil "${profile.name}" e suas estatísticas serão apagados deste aparelho.`, 'Excluir');
    if (!ok) return;
    profileStore.profiles = profileStore.profiles.filter((p) => p.id !== profile.id);
    if (profileStore.activeId === profile.id) profileStore.activeId = profileStore.profiles[0]?.id ?? null;
    persistProfiles();
    onProfileChanged();
    if (!activeProfile()) openProfileScreen({ editId: null, firstRun: true });
    else openProfileScreen({ editId: profileStore.activeId });
  }

  function onProfileChanged() {
    const me = activeProfile();
    $('header-avatar').innerHTML = profileAvatarHtml(me, 'sm');
    $('btn-profile').title = me ? `Perfil: ${me.name}` : 'Perfil';
    $('lobby-greeting').textContent = me ? `Olá, ${me.name}!` : '';
    if (net.started) sendProfileToPeer();
    if (state.phase !== 'lobby') renderGameBoard();
    refreshLobbyUI();
  }

  function recordMatchStats() {
    if (state.phase !== 'gameover' || !state.result) return;
    if (localUI.statsRecordedFor === state.matchId) return;
    localUI.statsRecordedFor = state.matchId;

    const result = state.result;
    const apply = (profile, team) => {
      if (!profile) return;
      profile.stats.played++;
      if (!result.team) profile.stats.draws++;
      else if (result.team === team) profile.stats.wins++;
      else profile.stats.losses++;
    };

    if (state.squadType === 'pass') {
      state.players.forEach((p) => {
        if (p.profileId) apply(profileStore.profiles.find((x) => x.id === p.profileId), p.team);
      });
    } else {
      const mine = state.players[viewIdx()];
      if (mine) apply(activeProfile(), mine.team);
    }
    persistProfiles();
  }

  /* ---------------------------------------------------------------------------
     3. PREFERÊNCIAS (TEMA E SOM)
     --------------------------------------------------------------------------- */
  const prefs = Object.assign({ theme: 'mystic', sound: true }, loadJSON(STORAGE_KEYS.prefs, {}));
  function persistPrefs() { saveJSON(STORAGE_KEYS.prefs, prefs); }

  function applyTheme(themeKey) {
    if (!['mystic', 'wood', 'cyber'].includes(themeKey)) themeKey = 'mystic';
    prefs.theme = themeKey;
    document.documentElement.setAttribute('data-theme', themeKey);
    const metaColors = { mystic: '#0f172a', wood: '#1a2e05', cyber: '#060917' };
    $('meta-theme-color').setAttribute('content', metaColors[themeKey]);
    document.querySelectorAll('[data-theme-btn]').forEach((btn) => {
      const active = btn.dataset.themeBtn === themeKey;
      btn.style.background = active ? 'var(--accent)' : 'transparent';
      btn.style.color = active ? 'var(--accent-text)' : 'var(--text-primary)';
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function applySound(enabled) {
    prefs.sound = !!enabled;
    sfx.enabled = prefs.sound;
    $('btn-sound').textContent = prefs.sound ? '🔊' : '🔇';
    $('btn-sound').setAttribute('aria-pressed', String(prefs.sound));
  }

  /* ---------------------------------------------------------------------------
     4. CARTAS
     --------------------------------------------------------------------------- */
  function getCardTierVisual(num) {
    if (num === 7) return { badge: '★ 7 ★', colorClass: 'text-amber-400', symbol: '◆', hint: 'Suprema!' };
    if (num <= 4) return { badge: 'BAIXA', colorClass: 'text-sky-400', symbol: '▲', hint: `↔ ${num + 7}` };
    if (num <= 8) return { badge: 'MÉDIA', colorClass: 'text-emerald-400', symbol: '●', hint: num < 7 ? `↔ ${num + 7}` : `↔ ${num - 7}` };
    return { badge: 'ALTA', colorClass: 'text-rose-400', symbol: '■', hint: `↔ ${num - 7}` };
  }

  /* IDs são atribuídos DEPOIS do embaralhamento: o id não revela o número. */
  function buildShuffledDeck() {
    const nums = [];
    for (let num = 1; num <= 12; num++) for (let c = 0; c < 3; c++) nums.push(num);
    for (let i = nums.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nums[i], nums[j]] = [nums[j], nums[i]];
    }
    return nums.map((num, idx) => ({ id: idx + 1, num }));
  }

  function sortHandAscending(hand) {
    hand.sort((a, b) => a.num - b.num || a.id - b.id);
  }

  /* ---------------------------------------------------------------------------
     5. ESTADO
     --------------------------------------------------------------------------- */
  const state = {
    format: '1v1',        // '1v1' | '2v2'
    squadType: 'bots',    // 'bots' | 'pass' | 'online'
    ruleMode: 'classic',  // 'classic' | 'spicy'
    phase: 'lobby',       // 'lobby' | 'playing' | 'resolving' | 'gameover'
    matchId: null,
    players: [],
    tableCards: [],
    currentTurn: 0,
    turnReveals: [],
    result: null,         // { team: 'A'|'B'|null, winnerIdx, reason }
    events: [],
    eventSeq: 0
  };

  const localUI = {
    swapMode: false,
    privacyHold: false,
    lastEventSeq: 0,
    statsRecordedFor: null
  };

  let botMemory = {};     // só no anfitrião: cardId -> número já visto
  let matchToken = 0;     // invalida timers de partidas/telas anteriores

  function later(fn, ms) {
    const token = matchToken;
    setTimeout(() => {
      if (token === matchToken) fn();
    }, ms);
  }

  const SEATS_2V2 = ['Sul', 'Oeste', 'Norte', 'Leste'];

  function guestSeat() {
    return state.format === '1v1' ? 1 : 2;
  }

  function isGuestClient() {
    return !net.isHost && net.started;
  }

  function localSeat() {
    return isGuestClient() ? guestSeat() : 0;
  }

  function viewIdx() {
    return state.squadType === 'pass' ? state.currentTurn : localSeat();
  }

  function canLocalUserAct() {
    if (state.phase !== 'playing' || localUI.privacyHold) return false;
    const active = state.players[state.currentTurn];
    if (!active || active.isBot) return false;
    return state.currentTurn === viewIdx();
  }

  /* ---------------------------------------------------------------------------
     6. REDE (BROADCASTCHANNEL + PEERJS) — anfitrião é a autoridade
     --------------------------------------------------------------------------- */
  const net = {
    started: false,
    isHost: true,
    roomCode: null,
    instanceId: 'tab_' + randomId(8),
    bc: null,
    peer: null,
    conns: [],
    seen: new Set(),
    seenOrder: [],
    // anfitrião
    guestId: null,
    guestProfile: null,
    // convidado
    hostId: null,
    hostProfile: null,
    joinTimer: null,
    hostAttempts: 0
  };

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }

  function inviteUrl() {
    const u = new URL(window.location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('sala', net.roomCode || '');
    return u.toString();
  }

  function setUrlRoomParam(code) {
    try {
      const u = new URL(window.location.href);
      if (code) u.searchParams.set('sala', code);
      else u.searchParams.delete('sala');
      window.history.replaceState({}, '', u.toString());
    } catch (_) {}
  }

  function publicProfile() {
    const me = activeProfile();
    return me ? { name: me.name, avatar: me.avatar } : { name: 'Jogador', avatar: { type: 'emoji', value: '🙂' } };
  }

  function stopNetwork(notify = true) {
    if (notify && net.started) sendNet({ type: 'LEAVE' });
    clearTimeout(net.joinTimer);
    if (net.bc) { try { net.bc.close(); } catch (_) {} }
    if (net.peer) { try { net.peer.destroy(); } catch (_) {} }
    Object.assign(net, {
      started: false, isHost: true, roomCode: null, bc: null, peer: null, conns: [],
      guestId: null, guestProfile: null, hostId: null, hostProfile: null, joinTimer: null
    });
    setUrlRoomParam(null);
    refreshLobbyUI();
  }

  function startNetwork(code, joining) {
    stopNetwork(true);
    net.started = true;
    net.isHost = !joining;
    net.roomCode = code.toUpperCase();
    state.squadType = 'online';

    // Só o convidado mantém ?sala= na URL (recarregar = reentrar na sala).
    setUrlRoomParam(joining ? net.roomCode : null);
    renderRoomQR();

    if ('BroadcastChannel' in window) {
      try {
        net.bc = new BroadcastChannel('trinca_oculta_' + net.roomCode);
        net.bc.onmessage = (e) => handleNetworkMessage(e.data);
      } catch (_) {}
    }

    if (typeof window.Peer !== 'undefined') {
      try {
        const peer = new window.Peer(joining ? undefined : `trinca-oculta-${net.roomCode}`, { debug: 0 });
        net.peer = peer;
        peer.on('open', () => {
          if (net.peer !== peer) return;
          if (joining) {
            attachPeerConn(peer.connect(`trinca-oculta-${net.roomCode}`, { reliable: true }));
          } else {
            net.hostAttempts = 0;
          }
          refreshLobbyUI();
        });
        peer.on('connection', (conn) => {
          if (net.peer === peer && net.isHost) attachPeerConn(conn);
        });
        peer.on('disconnected', () => {
          if (net.peer === peer && !peer.destroyed) {
            try { peer.reconnect(); } catch (_) {}
          }
        });
        peer.on('error', (err) => {
          if (net.peer !== peer) return;
          handlePeerError(err, joining);
        });
      } catch (_) {}
    } else {
      showToast('⚠️ Biblioteca P2P indisponível: só funciona entre abas deste navegador.');
    }

    if (joining) {
      sendNet({ type: 'GUEST_HELLO', profile: publicProfile() });
      net.joinTimer = setTimeout(() => {
        if (net.started && !net.isHost && !net.hostId) {
          showToast(`❌ Sala ${net.roomCode} não encontrada ou anfitrião offline.`);
          stopNetwork(false);
          state.squadType = 'bots';
          refreshLobbyUI();
        }
      }, 12000);
    }

    refreshLobbyUI();
  }

  function handlePeerError(err, joining) {
    const type = err && err.type;
    if (type === 'unavailable-id' && !joining) {
      // Código já em uso no servidor: gera outro (até 3 tentativas).
      if (net.hostAttempts++ < 3) {
        startNetwork(generateRoomCode(), false);
      } else {
        showToast('⚠️ Não foi possível criar a sala. Tente novamente.');
      }
      return;
    }
    if (type === 'peer-unavailable') {
      if (joining && !net.hostId) {
        showToast(`❌ Sala ${net.roomCode} não encontrada.`);
        stopNetwork(false);
        state.squadType = 'bots';
        refreshLobbyUI();
      }
      return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(type)) {
      showToast('⚠️ Servidor P2P indisponível. Online só entre abas deste navegador.');
    }
  }

  function attachPeerConn(conn) {
    if (!conn) return;
    net.conns.push(conn);
    conn.on('open', () => {
      if (!net.isHost) sendNet({ type: 'GUEST_HELLO', profile: publicProfile() });
    });
    conn.on('data', (data) => {
      if (data && data.sender) conn._trincaSender = data.sender;
      handleNetworkMessage(data);
    });
    const drop = () => {
      net.conns = net.conns.filter((c) => c !== conn);
      if (conn._trincaSender) handlePeerGone(conn._trincaSender);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  function sendNet(payload) {
    if (!net.started) return;
    const envelope = { ...payload, mid: randomId(12), sender: net.instanceId, room: net.roomCode };
    if (net.bc) {
      try { net.bc.postMessage(envelope); } catch (_) {}
    }
    net.conns.forEach((c) => {
      if (c.open) {
        try { c.send(envelope); } catch (_) {}
      }
    });
  }

  function alreadySeen(mid) {
    if (!mid || net.seen.has(mid)) return true;
    net.seen.add(mid);
    net.seenOrder.push(mid);
    if (net.seenOrder.length > 500) net.seen.delete(net.seenOrder.shift());
    return false;
  }

  function handleNetworkMessage(msg) {
    if (!msg || typeof msg !== 'object' || !msg.type) return;
    if (msg.sender === net.instanceId || msg.room !== net.roomCode) return;
    if (msg.to && msg.to !== net.instanceId) return;
    if (alreadySeen(msg.mid)) return; // mesma mensagem por BroadcastChannel e PeerJS

    if (net.isHost) handleHostMessage(msg);
    else handleGuestMessage(msg);
  }

  /* --- lado do anfitrião --- */
  function handleHostMessage(msg) {
    switch (msg.type) {
      case 'GUEST_HELLO': {
        if (net.guestId && net.guestId !== msg.sender) {
          sendNet({ type: 'ROOM_FULL', to: msg.sender });
          return;
        }
        const isNew = net.guestId !== msg.sender;
        net.guestId = msg.sender;
        net.guestProfile = { name: sanitizeName(msg.profile?.name, 'Convidado'), avatar: sanitizeProfileAvatar(msg.profile?.avatar) };
        sendNet({ type: 'HOST_WELCOME', to: net.guestId, format: state.format, ruleMode: state.ruleMode, profile: publicProfile() });
        if (isNew) {
          sfx.match();
          showToast(`🤝 ${net.guestProfile.name} entrou na sala!`);
        }
        // Convidado que recarregou durante a partida volta para o mesmo lugar.
        if (state.phase !== 'lobby' && state.squadType === 'online') {
          const seatPlayer = state.players[guestSeat()];
          if (seatPlayer && !seatPlayer.isBot) {
            seatPlayer.name = net.guestProfile.name;
            seatPlayer.avatar = playerAvatarFromProfile(net.guestProfile, 'guest');
            renderGameBoard();
            broadcastGameState();
          }
        }
        refreshLobbyUI();
        break;
      }
      case 'PROFILE_UPDATE': {
        if (msg.sender !== net.guestId) return;
        net.guestProfile = { name: sanitizeName(msg.profile?.name, 'Convidado'), avatar: sanitizeProfileAvatar(msg.profile?.avatar) };
        const seatPlayer = state.players[guestSeat()];
        if (state.phase !== 'lobby' && seatPlayer && !seatPlayer.isBot) {
          seatPlayer.name = net.guestProfile.name;
          seatPlayer.avatar = playerAvatarFromProfile(net.guestProfile, 'guest');
          renderGameBoard();
          broadcastGameState();
        }
        refreshLobbyUI();
        break;
      }
      case 'ACTION':
        if (msg.sender !== net.guestId) return;
        handleGuestAction(msg);
        break;
      case 'GUEST_ABORT':
        if (msg.sender !== net.guestId) return;
        if (state.phase !== 'lobby' && state.squadType === 'online') {
          showToast('🚪 O convidado saiu da partida.');
          goToLobby();
        }
        break;
      case 'LEAVE':
        handlePeerGone(msg.sender);
        break;
      default:
        break;
    }
  }

  function handleGuestAction(msg) {
    if (state.squadType !== 'online' || state.phase !== 'playing') return;
    const seat = guestSeat();
    if (state.currentTurn !== seat) return; // fora da vez: ignora
    if (msg.kind === 'table') {
      revealTableCard(Number(msg.index));
    } else if (msg.kind === 'hand') {
      if (msg.edge !== 'min' && msg.edge !== 'max') return;
      revealHandEdge(Number(msg.targetIdx), msg.edge);
    } else if (msg.kind === 'swap') {
      executeSecretPartnerSwap(seat, Number(msg.handIndex));
    }
  }

  function handlePeerGone(senderId) {
    if (net.isHost) {
      if (!senderId || senderId !== net.guestId) return;
      const name = net.guestProfile?.name || 'Convidado';
      net.guestId = null;
      net.guestProfile = null;
      showToast(`🚪 ${name} saiu da sala.`);
      if (state.phase !== 'lobby' && state.squadType === 'online') goToLobby();
      refreshLobbyUI();
    } else if (senderId && senderId === net.hostId) {
      showToast('🚪 O anfitrião fechou a sala.');
      stopNetwork(false);
      state.squadType = 'bots';
      goToLobby();
    }
  }

  /* --- lado do convidado --- */
  function handleGuestMessage(msg) {
    if (msg.type === 'HOST_WELCOME') {
      if (net.hostId && net.hostId !== msg.sender) return;
      const firstTime = !net.hostId;
      net.hostId = msg.sender;
      clearTimeout(net.joinTimer);
      net.hostProfile = { name: sanitizeName(msg.profile?.name, 'Anfitrião'), avatar: sanitizeProfileAvatar(msg.profile?.avatar) };
      applyRoomConfig(msg);
      if (firstTime) {
        sfx.match();
        showToast(`🤝 Conectado à sala de ${net.hostProfile.name}!`);
      }
      refreshLobbyUI();
      return;
    }
    if (msg.type === 'ROOM_FULL') {
      showToast('🚫 Essa sala já está cheia.');
      stopNetwork(false);
      state.squadType = 'bots';
      refreshLobbyUI();
      return;
    }
    if (!net.hostId || msg.sender !== net.hostId) return;

    switch (msg.type) {
      case 'ROOM_CONFIG':
        applyRoomConfig(msg);
        break;
      case 'PROFILE_UPDATE':
        net.hostProfile = { name: sanitizeName(msg.profile?.name, 'Anfitrião'), avatar: sanitizeProfileAvatar(msg.profile?.avatar) };
        refreshLobbyUI();
        if (state.phase !== 'lobby') renderGameBoard();
        break;
      case 'STATE':
        applySnapshot(msg.snapshot);
        break;
      case 'MATCH_ABORT':
        if (state.phase !== 'lobby') {
          showToast('🚪 O anfitrião voltou ao lobby.');
          goToLobby();
        }
        break;
      case 'LEAVE':
        handlePeerGone(msg.sender);
        break;
      default:
        break;
    }
  }

  function applyRoomConfig(msg) {
    if (msg.format === '1v1' || msg.format === '2v2') state.format = msg.format;
    if (msg.ruleMode === 'classic' || msg.ruleMode === 'spicy') state.ruleMode = msg.ruleMode;
    refreshLobbyUI();
  }

  function sendProfileToPeer() {
    if (!net.started) return;
    if (net.isHost && net.guestId) sendNet({ type: 'PROFILE_UPDATE', to: net.guestId, profile: publicProfile() });
    if (!net.isHost && net.hostId) sendNet({ type: 'PROFILE_UPDATE', to: net.hostId, profile: publicProfile() });
  }

  /* Snapshot enviado ao convidado: esconde mãos alheias e cartas fechadas da mesa. */
  function buildGuestSnapshot() {
    const seat = guestSeat();
    return {
      matchId: state.matchId,
      format: state.format,
      ruleMode: state.ruleMode,
      phase: state.phase,
      currentTurn: state.currentTurn,
      result: state.result,
      events: state.events,
      players: state.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        team: p.team,
        isBot: p.isBot,
        avatar: p.avatar,
        trios: p.trios,
        usedSwap: p.usedSwap,
        hand: p.id === seat ? p.hand : p.hand.map(() => ({ id: 0, num: 0 }))
      })),
      tableCards: state.tableCards.map((c) => (c.revealed || c.removed
        ? { id: c.id, num: c.num, revealed: c.revealed, removed: c.removed }
        : { id: 0, num: 0, revealed: false, removed: false })),
      turnReveals: state.turnReveals.map((r) => ({ source: r.source, tableIndex: r.tableIndex, playerIdx: r.playerIdx, edge: r.edge, num: r.num }))
    };
  }

  function broadcastGameState() {
    if (net.started && net.isHost && net.guestId && state.squadType === 'online' && state.phase !== 'lobby') {
      sendNet({ type: 'STATE', to: net.guestId, snapshot: buildGuestSnapshot() });
    }
    state.events = [];
  }

  /* Normaliza tudo que vem da rede antes de renderizar (nada de HTML/atributos arbitrários). */
  function sanitizeSnapshot(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.players) || !Array.isArray(s.tableCards)) return null;
    const int = (v, min, max, fb = 0) => {
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) && n >= min && n <= max ? n : fb;
    };
    const card = (c) => ({ id: int(c?.id, 0, 99), num: int(c?.num, 0, 12) });
    const format = s.format === '2v2' ? '2v2' : '1v1';
    const count = format === '2v2' ? 4 : 2;
    if (s.players.length !== count) return null;
    const avatar = (av) => {
      if (av && av.type === 'photo' && (av.owner === 'host' || av.owner === 'guest')) return { type: 'photo', owner: av.owner };
      return { type: 'emoji', value: typeof av?.value === 'string' ? av.value.slice(0, 8) : '🙂' };
    };
    const phase = ['playing', 'resolving', 'gameover'].includes(s.phase) ? s.phase : 'playing';
    const res = s.result && typeof s.result === 'object' ? s.result : null;
    return {
      matchId: String(s.matchId || '').slice(0, 16),
      format,
      ruleMode: s.ruleMode === 'spicy' ? 'spicy' : 'classic',
      phase,
      currentTurn: int(s.currentTurn, 0, count - 1),
      result: res ? {
        team: res.team === 'A' || res.team === 'B' ? res.team : null,
        winnerIdx: res.winnerIdx == null ? null : int(res.winnerIdx, 0, count - 1),
        reason: String(res.reason || '').slice(0, 200)
      } : null,
      events: Array.isArray(s.events) ? s.events.slice(0, 20).map((ev) => ({
        seq: int(ev?.seq, 0, 1e9),
        kind: ['flip', 'match', 'miss', 'trio'].includes(ev?.kind) ? ev.kind : 'info',
        text: String(ev?.text || '').slice(0, 140)
      })) : [],
      players: s.players.map((p, i) => ({
        id: i,
        name: sanitizeName(p?.name, `Jogador ${i + 1}`),
        seat: format === '2v2' ? SEATS_2V2[i] : null,
        team: p?.team === 'B' ? 'B' : 'A',
        isBot: !!p?.isBot,
        avatar: avatar(p?.avatar),
        trios: Array.isArray(p?.trios) ? p.trios.slice(0, 12).map((n) => int(n, 1, 12, 1)) : [],
        usedSwap: !!p?.usedSwap,
        hand: Array.isArray(p?.hand) ? p.hand.slice(0, 36).map(card) : []
      })),
      tableCards: s.tableCards.slice(0, 16).map((c) => ({ ...card(c), revealed: !!c?.revealed, removed: !!c?.removed })),
      turnReveals: Array.isArray(s.turnReveals) ? s.turnReveals.slice(0, 3).map((r) => ({
        source: r?.source === 'hand' ? 'hand' : 'table',
        num: int(r?.num, 1, 12, 1)
      })) : []
    };
  }

  function applySnapshot(raw) {
    const s = sanitizeSnapshot(raw);
    if (!s) return;
    if (s.matchId !== state.matchId) {
      matchToken++;
      localUI.swapMode = false;
      localUI.lastEventSeq = 0;
      $('modal-gameover').classList.add('hidden');
    }
    Object.assign(state, {
      matchId: s.matchId,
      format: s.format === '2v2' ? '2v2' : '1v1',
      ruleMode: s.ruleMode === 'spicy' ? 'spicy' : 'classic',
      phase: s.phase,
      currentTurn: s.currentTurn,
      result: s.result,
      players: s.players,
      tableCards: s.tableCards,
      turnReveals: s.turnReveals,
      squadType: 'online'
    });
    if (state.phase !== 'playing') localUI.swapMode = false;

    showGameScreen();
    s.events.forEach((ev) => {
      if (ev && ev.seq > localUI.lastEventSeq) {
        localUI.lastEventSeq = ev.seq;
        playEvent(ev, false);
      }
    });
    renderGameBoard();
    if (state.phase === 'gameover') showGameOver();
  }

  /* ---------------------------------------------------------------------------
     7. EVENTOS (som + toast), replicados para o convidado
     --------------------------------------------------------------------------- */
  function emit(kind, text = '', guestText = text) {
    const ev = { seq: ++state.eventSeq, kind, text: guestText };
    state.events.push(ev);
    playEvent({ kind, text }, true);
  }

  function playEvent(ev) {
    switch (ev.kind) {
      case 'flip': sfx.flip(); break;
      case 'match': sfx.match(); break;
      case 'miss': sfx.miss(); break;
      case 'trio': sfx.trio(); launchConfetti(28); break;
      default: break;
    }
    if (ev.text) showToast(ev.text);
  }

  /* ---------------------------------------------------------------------------
     8. INÍCIO DE PARTIDA
     --------------------------------------------------------------------------- */
  function buildPlayers() {
    const is1v1 = state.format === '1v1';
    const me = activeProfile();
    const localOwner = (p) => (p ? `local:${p.id}` : null);
    const meAvatar = state.squadType === 'online' ? playerAvatarFromProfile(me, 'host') : playerAvatarFromProfile(me, localOwner(me));
    const meName = me ? me.name : 'Você';

    const slots = [];
    if (state.squadType === 'pass') {
      // Usa outros perfis salvos neste aparelho para os demais jogadores, se houver.
      const others = profileStore.profiles.filter((p) => p.id !== me?.id);
      const total = is1v1 ? 2 : 4;
      const defaultsIcons = ['🎭', '🃏', '🎲'];
      slots.push({ name: meName, avatar: meAvatar, profileId: me?.id || null });
      for (let i = 1; i < total; i++) {
        const prof = others[i - 1];
        slots.push(prof
          ? { name: prof.name, avatar: playerAvatarFromProfile(prof, localOwner(prof)), profileId: prof.id }
          : { name: `Jogador ${i + 1}`, avatar: { type: 'emoji', value: defaultsIcons[(i - 1) % 3] }, profileId: null });
      }
    } else if (state.squadType === 'online') {
      const guest = { name: net.guestProfile.name, avatar: playerAvatarFromProfile(net.guestProfile, 'guest') };
      if (is1v1) {
        slots.push({ name: meName, avatar: meAvatar }, guest);
      } else {
        slots.push(
          { name: meName, avatar: meAvatar },
          { name: 'Bot Oeste', avatar: { type: 'emoji', value: '🤖' }, isBot: true },
          guest,
          { name: 'Bot Leste', avatar: { type: 'emoji', value: '👾' }, isBot: true }
        );
      }
    } else if (is1v1) {
      slots.push({ name: meName, avatar: meAvatar }, { name: 'Bot Dedutivo', avatar: { type: 'emoji', value: '🤖' }, isBot: true });
    } else {
      slots.push(
        { name: meName, avatar: meAvatar },
        { name: 'Bot Oeste', avatar: { type: 'emoji', value: '🤖' }, isBot: true },
        { name: 'Bot Parceiro', avatar: { type: 'emoji', value: '🦾' }, isBot: true },
        { name: 'Bot Leste', avatar: { type: 'emoji', value: '👾' }, isBot: true }
      );
    }

    return slots.map((s, i) => ({
      id: i,
      name: s.name,
      seat: is1v1 ? null : SEATS_2V2[i],
      team: is1v1 ? (i === 0 ? 'A' : 'B') : (i % 2 === 0 ? 'A' : 'B'),
      isBot: !!s.isBot,
      avatar: s.avatar,
      profileId: s.profileId || null,
      hand: [],
      trios: [],
      usedSwap: false
    }));
  }

  function startNewMatch() {
    if (isGuestClient()) {
      showToast('⏳ Só o anfitrião pode iniciar a partida.');
      return;
    }
    if (!activeProfile()) {
      openProfileScreen({ editId: null, firstRun: true });
      return;
    }
    if (state.squadType === 'online' && !net.guestId) {
      showToast('⏳ Aguardando um jogador entrar na sala. Envie o convite!');
      return;
    }

    sfx.init();
    matchToken++;
    botMemory = {};

    const is1v1 = state.format === '1v1';
    const handSize = is1v1 ? 10 : 7;
    const tableSize = is1v1 ? 16 : 8;
    const deck = buildShuffledDeck();
    const players = buildPlayers();
    players.forEach((p) => {
      p.hand = deck.splice(0, handSize);
      sortHandAscending(p.hand);
    });

    Object.assign(state, {
      matchId: randomId(8),
      players,
      tableCards: deck.splice(0, tableSize).map((c) => ({ id: c.id, num: c.num, revealed: false, removed: false })),
      currentTurn: 0,
      turnReveals: [],
      result: null,
      events: [],
      eventSeq: 0,
      phase: 'playing'
    });
    localUI.swapMode = false;
    localUI.statsRecordedFor = null;

    $('modal-gameover').classList.add('hidden');
    showGameScreen();

    if (state.squadType === 'pass') {
      showPrivacyScreen();
    } else {
      $('privacy-screen').classList.add('hidden');
      localUI.privacyHold = false;
    }

    renderGameBoard();
    broadcastGameState();
    if (state.players[0].isBot) scheduleBotMove();
  }

  function showGameScreen() {
    $('lobby-screen').classList.add('hidden');
    $('game-screen').classList.remove('hidden');
    $('btn-back-lobby').classList.remove('hidden');
    $('rule-badge-hud').textContent = state.ruleMode === 'spicy' ? '🌶️ Picante' : '👑 Clássico';
  }

  function showPrivacyScreen() {
    const next = state.players[state.currentTurn];
    localUI.privacyHold = true;
    $('privacy-next-player').textContent = `Vez de ${next.name}`;
    $('privacy-avatar').innerHTML = avatarHtml(next.avatar, 'lg');
    $('privacy-screen').classList.remove('hidden');
  }

  /* ---------------------------------------------------------------------------
     9. JOGADAS (executadas só pelo anfitrião / aparelho local)
     --------------------------------------------------------------------------- */
  function onLocalTableClick(index) {
    if (!canLocalUserAct() || localUI.swapMode) return;
    if (isGuestClient()) {
      sendNet({ type: 'ACTION', to: net.hostId, kind: 'table', index });
      return;
    }
    revealTableCard(index);
  }

  function onLocalHandEdgeClick(targetIdx, edge) {
    if (!canLocalUserAct() || localUI.swapMode) return;
    if (isGuestClient()) {
      sendNet({ type: 'ACTION', to: net.hostId, kind: 'hand', targetIdx, edge });
      return;
    }
    revealHandEdge(targetIdx, edge);
  }

  function revealTableCard(tableIndex) {
    if (state.phase !== 'playing') return;
    const card = state.tableCards[tableIndex];
    if (!card || card.removed || card.revealed) return;

    card.revealed = true;
    botMemory[card.id] = card.num;
    state.turnReveals.push({ source: 'table', tableIndex, cardId: card.id, num: card.num });
    emit('flip');
    afterReveal();
  }

  function revealHandEdge(targetIdx, edge) {
    if (state.phase !== 'playing') return;
    const target = state.players[targetIdx];
    if (!target || target.hand.length === 0) return;

    const cardObj = edge === 'min' ? target.hand.shift() : target.hand.pop();
    if (!cardObj) return;

    botMemory[cardObj.id] = cardObj.num;
    state.turnReveals.push({ source: 'hand', playerIdx: targetIdx, edge, cardObj, cardId: cardObj.id, num: cardObj.num });
    emit('flip');
    afterReveal();
  }

  function syncBoard() {
    renderGameBoard();
    broadcastGameState();
  }

  function afterReveal() {
    const reveals = state.turnReveals;
    const active = state.players[state.currentTurn];
    const firstNum = reveals[0].num;
    const latestNum = reveals[reveals.length - 1].num;

    if (reveals.length >= 2 && latestNum !== firstNum) {
      state.phase = 'resolving';
      emit('miss', `✖ Diferente (${firstNum} ≠ ${latestNum})! Cartas voltam.`);
      syncBoard();
      later(() => {
        returnTurnCardsToOrigins();
        advanceToNextPlayer();
      }, 1200);
      return;
    }

    if (reveals.length === 3) {
      state.phase = 'resolving';
      active.trios.push(firstNum);
      reveals.forEach((r) => {
        if (r.source === 'table') state.tableCards[r.tableIndex].removed = true;
      });
      emit('trio', `🎉 ${active.name}: TRINCA DE ${firstNum}!`);
      syncBoard();
      later(() => {
        state.turnReveals = [];
        if (!checkVictoryCondition(active)) advanceToNextPlayer();
      }, 1150);
      return;
    }

    if (reveals.length === 2) emit('match', `✨ Par de ${firstNum}! Falta 1 para a Trinca.`);
    syncBoard();
    if (active.isBot) scheduleBotMove();
  }

  function returnTurnCardsToOrigins() {
    state.turnReveals.forEach((r) => {
      if (r.source === 'table') {
        state.tableCards[r.tableIndex].revealed = false;
      } else if (r.source === 'hand') {
        const owner = state.players[r.playerIdx];
        if (owner) {
          owner.hand.push(r.cardObj);
          sortHandAscending(owner.hand);
        }
      }
    });
    state.turnReveals = [];
  }

  function advanceToNextPlayer() {
    const anyCardsLeft = state.players.some((p) => p.hand.length > 0) || state.tableCards.some((c) => !c.removed);
    if (!anyCardsLeft) {
      finishByExhaustion();
      return;
    }

    state.currentTurn = (state.currentTurn + 1) % state.players.length;
    state.phase = 'playing';
    localUI.swapMode = false;

    if (state.squadType === 'pass') showPrivacyScreen();
    syncBoard();
    if (state.players[state.currentTurn].isBot) scheduleBotMove();
  }

  function teamTrios(team) {
    return state.players.filter((p) => p.team === team).flatMap((p) => p.trios);
  }

  function checkVictoryCondition(activePlayer) {
    const trios = teamTrios(activePlayer.team);
    const who = state.format === '2v2' ? 'A dupla conquistou' : 'Conquistou';

    if (trios.includes(7)) {
      triggerGameOver(activePlayer.team, activePlayer.id, `${who} a lendária TRINCA DE 7 (vitória instantânea)!`);
      return true;
    }
    if (state.ruleMode === 'classic') {
      if (trios.length >= 3) {
        triggerGameOver(activePlayer.team, activePlayer.id, `${who} ${trios.length} Trincas no Modo Clássico!`);
        return true;
      }
    } else {
      for (let i = 0; i < trios.length; i++) {
        for (let j = i + 1; j < trios.length; j++) {
          if (Math.abs(trios[i] - trios[j]) === 7) {
            triggerGameOver(activePlayer.team, activePlayer.id, `Trincas ${trios[i]} e ${trios[j]} conectadas (diferença de 7) no Modo Picante!`);
            return true;
          }
        }
      }
    }
    return false;
  }

  function finishByExhaustion() {
    const a = teamTrios('A').length;
    const b = teamTrios('B').length;
    if (a === b) {
      triggerGameOver(null, null, `Todas as cartas foram reveladas e o placar terminou empatado (${a} x ${b}).`);
    } else {
      const team = a > b ? 'A' : 'B';
      const winner = state.players.find((p) => p.team === team);
      triggerGameOver(team, winner.id, `Todas as cartas foram reveladas. Vitória por mais trincas (${Math.max(a, b)} x ${Math.min(a, b)}).`);
    }
  }

  function triggerGameOver(team, winnerIdx, reason) {
    state.phase = 'gameover';
    state.result = { team, winnerIdx, reason };
    localUI.swapMode = false;
    syncBoard();
    showGameOver();
  }

  function showGameOver() {
    const result = state.result;
    if (!result) return;
    const is2v2 = state.format === '2v2';
    const isPass = state.squadType === 'pass';
    const mine = state.players[viewIdx()];
    const winner = result.winnerIdx != null ? state.players[result.winnerIdx] : null;

    let icon = '🏆';
    let kicker = 'Vitória!';
    let title;
    if (!result.team) {
      icon = '🤝';
      kicker = 'Empate';
      title = 'Ninguém venceu desta vez';
    } else if (isPass) {
      title = is2v2
        ? `Dupla ${result.team === 'A' ? 'Sul + Norte' : 'Oeste + Leste'} venceu!`
        : `${winner ? winner.name : 'Jogador'} venceu!`;
    } else if (mine && mine.team === result.team) {
      title = is2v2 ? 'Sua dupla venceu!' : 'Você venceu!';
    } else {
      icon = '💀';
      kicker = 'Derrota';
      title = is2v2 ? 'A dupla rival venceu' : `${winner ? winner.name : 'Oponente'} venceu`;
    }

    const won = result.team && (isPass || (mine && mine.team === result.team));
    if (localUI.statsRecordedFor !== state.matchId) {
      if (won) { sfx.win(); launchConfetti(50); } else if (result.team) { sfx.lose(); } else { sfx.match(); }
    }
    recordMatchStats();

    $('gameover-icon').textContent = icon;
    $('gameover-kicker').textContent = kicker;
    $('gameover-winner-title').textContent = title;
    $('gameover-reason').textContent = result.reason;

    const triosText = (list) => (list.length ? list.map((n) => `[${n}]`).join(' ') : 'nenhuma');
    $('gameover-trios-summary').innerHTML = is2v2
      ? [['A', 'Sul + Norte'], ['B', 'Oeste + Leste']].map(([t, label]) => `
          <div class="flex justify-between gap-2 font-bold ${result.team === t ? '' : 'opacity-75'}">
            <span>${result.team === t ? '🏆 ' : ''}${label}</span><span>${triosText(teamTrios(t))}</span>
          </div>`).join('')
      : state.players.map((p) => `
          <div class="flex items-center justify-between gap-2 font-bold ${result.team === p.team ? '' : 'opacity-75'}">
            <span class="flex items-center gap-1.5 min-w-0">${avatarHtml(p.avatar, 'xs')}<span class="truncate">${escapeHtml(p.name)}</span></span>
            <span>${triosText(p.trios)}</span>
          </div>`).join('');

    const guest = isGuestClient();
    $('btn-rematch').disabled = guest;
    $('btn-rematch').textContent = guest ? '⏳ Aguardando anfitrião' : 'Jogar Novamente';
    $('modal-gameover').classList.remove('hidden');
  }

  /* ---------------------------------------------------------------------------
     10. TROCA SECRETA (2v2)
     --------------------------------------------------------------------------- */
  function toggleSecretSwapMode() {
    if (state.format !== '2v2') return;
    const me = state.players[viewIdx()];
    if (!me || me.usedSwap) return;
    if (localUI.swapMode) {
      localUI.swapMode = false;
    } else if (canLocalUserAct() && state.turnReveals.length === 0) {
      localUI.swapMode = true;
    } else {
      showToast('Use a Troca Secreta no início do seu turno!');
      return;
    }
    sfx.tap();
    renderGameBoard();
  }

  function onLocalSwapClick(handIndex) {
    if (!localUI.swapMode || !canLocalUserAct()) return;
    localUI.swapMode = false;
    if (isGuestClient()) {
      sendNet({ type: 'ACTION', to: net.hostId, kind: 'swap', handIndex });
      renderGameBoard();
      return;
    }
    executeSecretPartnerSwap(viewIdx(), handIndex);
  }

  function executeSecretPartnerSwap(actorIdx, handIndex) {
    if (state.format !== '2v2' || state.phase !== 'playing' || state.turnReveals.length > 0) return;
    if (state.currentTurn !== actorIdx) return;
    const me = state.players[actorIdx];
    const partner = state.players[(actorIdx + 2) % 4];
    if (!me || !partner || me.usedSwap || partner.hand.length === 0) return;
    if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= me.hand.length) return;

    const myCard = me.hand.splice(handIndex, 1)[0];
    const partnerCard = partner.hand.splice(Math.floor(partner.hand.length / 2), 1)[0];
    me.hand.push(partnerCard);
    partner.hand.push(myCard);
    sortHandAscending(me.hand);
    sortHandAscending(partner.hand);
    me.usedSwap = true;

    const isGuestActor = state.squadType === 'online' && actorIdx === guestSeat();
    const fullText = `⇄ Troca concluída! Você recebeu [${partnerCard.num}].`;
    const otherText = `⇄ ${me.name} fez a Troca Secreta com o parceiro.`;
    if (isGuestActor) emit('match', otherText, fullText);
    else emit('match', fullText, otherText);
    syncBoard();
  }

  /* ---------------------------------------------------------------------------
     11. IA DEDUTIVA (memória perfeita das cartas reveladas)
     --------------------------------------------------------------------------- */
  function scheduleBotMove() {
    later(botMove, 750);
  }

  function listBotMoves(bot) {
    const moves = [];
    state.players.forEach((p, idx) => {
      if (p.hand.length === 0) return;
      const known = (card) => (idx === bot.id ? card.num : botMemory[card.id]);
      const minCard = p.hand[0];
      moves.push({ type: 'hand', targetIdx: idx, edge: 'min', knownNum: known(minCard) });
      if (p.hand.length > 1) {
        const maxCard = p.hand[p.hand.length - 1];
        moves.push({ type: 'hand', targetIdx: idx, edge: 'max', knownNum: known(maxCard) });
      }
    });
    state.tableCards.forEach((tc, tIdx) => {
      if (!tc.removed && !tc.revealed) moves.push({ type: 'table', index: tIdx, knownNum: botMemory[tc.id] });
    });
    return moves;
  }

  /* Quantas cópias de cada número o bot sabe alcançar neste turno. */
  function reachableKnownCounts(bot) {
    const counts = {};
    const add = (n, k = 1) => { if (n !== undefined) counts[n] = (counts[n] || 0) + k; };

    state.tableCards.forEach((tc) => { if (!tc.removed && !tc.revealed) add(botMemory[tc.id]); });
    state.players.forEach((p, idx) => {
      const h = p.hand;
      if (h.length === 0) return;
      if (idx === bot.id) {
        // Mão própria: conhece as sequências iguais a partir de cada ponta.
        let runMin = 1;
        while (runMin < h.length && h[runMin].num === h[0].num) runMin++;
        add(h[0].num, Math.min(runMin, 3));
        if (runMin < h.length) {
          let runMax = 1;
          while (runMax < h.length - runMin && h[h.length - 1 - runMax].num === h[h.length - 1].num) runMax++;
          add(h[h.length - 1].num, Math.min(runMax, 3));
        }
      } else {
        add(botMemory[h[0].id]);
        if (h.length > 1) add(botMemory[h[h.length - 1].id]);
      }
    });
    return counts;
  }

  function botMove() {
    if (state.phase !== 'playing') return;
    const bot = state.players[state.currentTurn];
    if (!bot || !bot.isBot) return;

    const moves = listBotMoves(bot);
    if (moves.length === 0) {
      advanceToNextPlayer();
      return;
    }

    let chosen = null;
    if (state.turnReveals.length > 0) {
      const target = state.turnReveals[0].num;
      chosen = moves.find((m) => m.knownNum === target);
    } else {
      const counts = reachableKnownCounts(bot);
      const candidates = Object.keys(counts).map(Number).filter((n) => counts[n] >= 2);
      candidates.sort((a, b) => {
        const fullA = counts[a] >= 3 ? 1 : 0;
        const fullB = counts[b] >= 3 ? 1 : 0;
        if (fullA !== fullB) return fullB - fullA;
        if (a === 7 || b === 7) return a === 7 ? -1 : 1;
        return counts[b] - counts[a];
      });
      if (candidates.length > 0) chosen = moves.find((m) => m.knownNum === candidates[0]);
    }

    if (!chosen) {
      const unknown = moves.filter((m) => m.knownNum === undefined);
      const pool = unknown.length > 0 ? unknown : moves;
      chosen = pool[Math.floor(Math.random() * pool.length)];
    }

    if (chosen.type === 'table') revealTableCard(chosen.index);
    else revealHandEdge(chosen.targetIdx, chosen.edge);
  }

  /* ---------------------------------------------------------------------------
     12. RENDERIZAÇÃO DA MESA
     --------------------------------------------------------------------------- */
  function renderGameBoard() {
    if (!state.players.length) return;
    const myIdx = viewIdx();
    const me = state.players[myIdx];
    const activePlayer = state.players[state.currentTurn];
    const canAct = canLocalUserAct();
    const is1v1 = state.format === '1v1';
    const swapMode = localUI.swapMode && canAct;

    // 1) Placar
    const scoreEl = $('match-scoreboard');
    if (is1v1) {
      scoreEl.innerHTML = state.players.map((p, i) => `
        ${i === 1 ? '<span class="font-black opacity-50 text-[10px]">VS</span>' : ''}
        <div class="flex items-center gap-1.5 pl-1 pr-2.5 py-0.5 rounded-lg soft-panel whitespace-nowrap ${state.currentTurn === i ? 'ring-1 ring-amber-400' : ''}">
          ${avatarHtml(p.avatar, 'xs')}
          <span class="font-extrabold max-w-[5.5rem] truncate" ${p.id === myIdx ? 'style="color: var(--accent);"' : ''}>${escapeHtml(p.name)}</span>
          <span class="font-black">${p.trios.length}/3</span>
          <span class="opacity-85">${p.trios.map((n) => `[${n}]`).join('')}</span>
        </div>
      `).join('');
    } else {
      const myTeam = me.team;
      const rivalTeam = myTeam === 'A' ? 'B' : 'A';
      const label = (t) => (state.squadType === 'pass' ? (t === 'A' ? 'Sul+Norte' : 'Oeste+Leste') : (t === myTeam ? 'Sua Dupla' : 'Rivais'));
      scoreEl.innerHTML = [myTeam, rivalTeam].map((t, i) => {
        const trios = teamTrios(t);
        return `
          <div class="flex items-center gap-1.5 px-2 py-0.5 rounded-lg soft-panel whitespace-nowrap ${activePlayer.team === t ? 'ring-1 ring-amber-400' : ''}">
            <span class="font-extrabold" ${i === 0 ? 'style="color: var(--accent);"' : ''}>${label(t)}:</span>
            <span class="font-black">${trios.length}/3</span>
            <span class="opacity-80">${trios.map((n) => `[${n}]`).join('')}</span>
          </div>`;
      }).join('');
    }

    // 2) Oponentes / parceiro
    const oppRow = $('opponents-row');
    const edgeBtn = (p, edge, label, extra, canClick) => `
      <button type="button" ${canClick ? `data-action="hand-edge" data-target="${p.id}" data-edge="${edge}"` : 'disabled'}
        aria-label="Revelar ${edge === 'min' ? 'menor' : 'maior'} carta de ${escapeHtml(p.name)}"
        class="${extra} rounded-xl game-card-back font-black ${canClick ? 'playable-edge' : 'opacity-60'}">
        <span class="pointer-events-none">${label}</span>
      </button>`;

    if (is1v1) {
      const opp = state.players[myIdx === 0 ? 1 : 0];
      const count = opp.hand.length;
      const canClick = canAct && !swapMode && count > 0;
      oppRow.className = 'w-full max-w-md mx-auto my-1 shrink-0';
      oppRow.innerHTML = `
        <div class="glass-panel rounded-2xl p-2.5 flex items-center justify-between gap-2 ${opp.id === state.currentTurn ? 'ring-2 ring-amber-400' : ''}">
          ${edgeBtn(opp, 'min', '◀ MENOR', 'px-3.5 py-2.5 text-xs shrink-0', canClick)}
          <div class="flex items-center gap-2 min-w-0">
            ${avatarHtml(opp.avatar, 'md')}
            <div class="min-w-0 text-left">
              <div class="text-xs font-extrabold truncate">${escapeHtml(opp.name)}</div>
              <div class="text-[11px] font-bold opacity-80">🃏 ${count} ${count === 1 ? 'carta' : 'cartas'}</div>
            </div>
          </div>
          ${edgeBtn(opp, 'max', 'MAIOR ▶', 'px-3.5 py-2.5 text-xs shrink-0', canClick)}
        </div>`;
    } else {
      // Ordem relativa à visão: esquerda (rival), frente (parceiro), direita (rival)
      const order = [(myIdx + 1) % 4, (myIdx + 2) % 4, (myIdx + 3) % 4].map((i) => state.players[i]);
      oppRow.className = 'grid grid-cols-3 gap-1.5 w-full max-w-md mx-auto my-1 shrink-0';
      oppRow.innerHTML = order.map((p) => {
        const isPartner = p.team === me.team;
        const count = p.hand.length;
        const canClick = canAct && !swapMode && count > 0;
        return `
          <div class="glass-panel rounded-2xl p-2 flex flex-col items-center justify-between gap-1.5 ${p.id === state.currentTurn ? 'ring-2 ring-amber-400' : ''}">
            <div class="w-full flex items-center gap-1 text-[10px] min-w-0">
              ${avatarHtml(p.avatar, 'xs')}
              <span class="font-extrabold truncate flex-1 ${isPartner ? 'text-emerald-300' : ''}">${isPartner ? '🤝 ' : ''}${escapeHtml(p.name)}</span>
              <span class="font-bold opacity-75 shrink-0">🃏${count}</span>
            </div>
            <div class="w-full grid grid-cols-2 gap-1">
              ${edgeBtn(p, 'min', '◀ MIN', 'py-2 text-[10px] text-center', canClick)}
              ${edgeBtn(p, 'max', 'MAX ▶', 'py-2 text-[10px] text-center', canClick)}
            </div>
          </div>`;
      }).join('');
    }

    // 3) Faixa do turno
    const titleEl = $('turn-banner-title');
    const subEl = $('turn-banner-sub');
    if (state.phase === 'gameover') {
      titleEl.textContent = 'Partida encerrada';
      subEl.textContent = 'Confira o resultado';
    } else if (swapMode) {
      titleEl.textContent = '⇄ Troca Secreta com Parceiro';
      subEl.textContent = 'Toque em 1 carta da sua mão (ou no botão para cancelar)';
    } else if (canAct) {
      titleEl.textContent = state.squadType === 'pass' ? `Vez de ${activePlayer.name}` : 'Sua vez de deduzir!';
      subEl.textContent = state.turnReveals.length === 0
        ? 'Toque na mesa ou em uma ponta (MENOR / MAIOR)'
        : `Procure outra carta [${state.turnReveals[0].num}]…`;
    } else if (state.phase === 'resolving') {
      titleEl.textContent = `Turno: ${activePlayer.name}`;
      subEl.textContent = 'Resolvendo a jogada…';
    } else {
      titleEl.textContent = `Turno: ${activePlayer.name}`;
      subEl.textContent = activePlayer.isBot ? '🤖 Pensando… memorize as cartas!' : 'Aguardando a jogada… memorize as cartas!';
    }

    $('current-turn-slots').innerHTML = [0, 1, 2].map((idx) => {
      const rev = state.turnReveals[idx];
      if (!rev) {
        return '<div class="w-9 h-11 rounded-xl border border-dashed flex items-center justify-center text-xs opacity-40" style="border-color: var(--panel-border);">?</div>';
      }
      const vis = getCardTierVisual(rev.num);
      return `
        <div class="w-9 h-11 rounded-xl game-card-face flex flex-col items-center justify-center font-black">
          <span class="text-sm leading-none">${rev.num}</span>
          <span class="text-[9px] ${vis.colorClass}">${vis.symbol}</span>
        </div>`;
    }).join('');

    // 4) Mesa central
    const tableClickable = canAct && !swapMode;
    $('center-table-grid').innerHTML = state.tableCards.map((tc, idx) => {
      const cardDim = is1v1 ? 'w-full h-12 sm:h-14' : 'w-full h-16 sm:h-20';
      if (tc.removed) {
        return `<div class="${cardDim} rounded-xl opacity-15 border border-dashed" style="border-color: var(--panel-border);"></div>`;
      }
      if (tc.revealed) {
        const vis = getCardTierVisual(tc.num);
        return `
          <div class="${cardDim} rounded-xl game-card-face flex flex-col items-center justify-center">
            <span class="text-[7px] font-bold opacity-70">${vis.badge}</span>
            <span class="text-lg font-black leading-none">${tc.num}</span>
            <span class="text-[9px] ${vis.colorClass}">${vis.symbol}</span>
          </div>`;
      }
      return `
        <button type="button" ${tableClickable ? `data-action="table-card" data-index="${idx}"` : 'disabled'} aria-label="Revelar carta ${idx + 1} da mesa"
          class="${cardDim} rounded-xl game-card-back flex flex-col items-center justify-center ${tableClickable ? 'hover:scale-105 active:scale-95' : 'opacity-80'}">
          <span class="text-xs opacity-60 pointer-events-none">✦</span>
          <span class="text-[8px] font-bold opacity-50 pointer-events-none">MESA</span>
        </button>`;
    }).join('');

    // 5) Mão local
    const isPass = state.squadType === 'pass';
    $('local-hand-avatar').innerHTML = avatarHtml(me.avatar, 'xs');
    $('local-hand-owner').textContent = isPass ? `Mão de ${me.name}` : 'Sua mão ordenada';
    $('local-hand-count').textContent = `(${me.hand.length} ${me.hand.length === 1 ? 'carta' : 'cartas'})`;

    const swapBtn = $('btn-secret-swap');
    const swapAvailable = !is1v1 && !me.usedSwap && state.phase !== 'gameover';
    swapBtn.classList.toggle('hidden', !swapAvailable);
    $('secret-swap-label').textContent = swapMode ? 'Cancelar troca' : 'Troca Secreta (1x)';
    swapBtn.style.opacity = swapAvailable && canAct && state.turnReveals.length === 0 ? '1' : '0.55';

    const handEl = $('local-hand-container');
    if (localUI.privacyHold && isPass) {
      handEl.innerHTML = '<span class="w-full text-center text-xs opacity-70 font-semibold">🙈 Mão oculta</span>';
      return;
    }
    if (me.hand.length === 0) {
      handEl.innerHTML = '<span class="w-full text-center text-xs opacity-70 font-semibold">Você já revelou todas as suas cartas!</span>';
      return;
    }

    const ownEdgeAttr = (edge, handIndex) => {
      if (swapMode) return `data-action="swap-card" data-hand-index="${handIndex}"`;
      return canAct ? `data-action="hand-edge" data-target="${me.id}" data-edge="${edge}"` : '';
    };
    const footer = (vis) => (state.ruleMode === 'spicy' ? vis.hint : vis.badge);

    if (me.hand.length === 1) {
      const c = me.hand[0];
      const attr = ownEdgeAttr('min', 0);
      handEl.innerHTML = `
        <div class="w-full flex justify-center">
          <button type="button" ${attr || 'disabled'} class="w-16 h-20 rounded-2xl game-card-face flex flex-col items-center justify-between py-1.5 px-1 ${attr ? 'playable-edge' : ''}">
            <span class="text-[9px] font-black uppercase text-amber-400 pointer-events-none">ÚNICA</span>
            <span class="text-2xl font-black leading-none pointer-events-none">${c.num}</span>
            <span class="text-[9px] font-bold opacity-80 pointer-events-none">${footer(getCardTierVisual(c.num))}</span>
          </button>
        </div>`;
      return;
    }

    const minCard = me.hand[0];
    const maxCard = me.hand[me.hand.length - 1];
    const minAttr = ownEdgeAttr('min', 0);
    const maxAttr = ownEdgeAttr('max', me.hand.length - 1);
    const middle = me.hand.slice(1, -1);

    const middleHtml = middle.length === 0
      ? '<div class="text-[10px] opacity-45 font-semibold px-2">Sem cartas internas</div>'
      : middle.map((mc, mIdx) => {
          const vis = getCardTierVisual(mc.num);
          const attr = swapMode ? `data-action="swap-card" data-hand-index="${mIdx + 1}"` : 'disabled';
          return `
            <button type="button" ${attr} class="w-10 h-14 rounded-xl game-card-face flex flex-col items-center justify-between py-1 px-0.5 shrink-0 ${swapMode ? 'playable-edge' : 'opacity-85'}">
              <span class="text-[8px] ${vis.colorClass} pointer-events-none">${vis.symbol}</span>
              <span class="text-sm font-black leading-none pointer-events-none">${mc.num}</span>
              <span class="text-[7px] font-bold opacity-70 pointer-events-none">${state.ruleMode === 'spicy' ? vis.hint : ''}</span>
            </button>`;
        }).join('');

    handEl.innerHTML = `
      <button type="button" ${minAttr || 'disabled'} aria-label="Revelar sua menor carta"
        class="w-14 h-20 rounded-2xl game-card-face flex flex-col items-center justify-between py-1.5 px-1 shrink-0 ${minAttr ? 'playable-edge' : ''}">
        <span class="text-[9px] font-black uppercase text-sky-400 pointer-events-none">◀ MENOR</span>
        <span class="text-xl font-black leading-none pointer-events-none">${minCard.num}</span>
        <span class="text-[8px] font-bold opacity-75 pointer-events-none">${footer(getCardTierVisual(minCard.num))}</span>
      </button>
      <div class="flex-1 min-w-0 flex items-center justify-start gap-1 overflow-x-auto px-1 py-1 custom-scroll">
        <div class="flex gap-1 mx-auto">${middleHtml}</div>
      </div>
      <button type="button" ${maxAttr || 'disabled'} aria-label="Revelar sua maior carta"
        class="w-14 h-20 rounded-2xl game-card-face flex flex-col items-center justify-between py-1.5 px-1 shrink-0 ${maxAttr ? 'playable-edge' : ''}">
        <span class="text-[9px] font-black uppercase text-rose-400 pointer-events-none">MAIOR ▶</span>
        <span class="text-xl font-black leading-none pointer-events-none">${maxCard.num}</span>
        <span class="text-[8px] font-bold opacity-75 pointer-events-none">${footer(getCardTierVisual(maxCard.num))}</span>
      </button>`;
  }

  /* ---------------------------------------------------------------------------
     13. LOBBY, SALA ONLINE, QR, CONVITE
     --------------------------------------------------------------------------- */
  function renderRoomQR() {
    const container = $('qr-svg-container');
    $('qr-code-text').textContent = net.roomCode || '----';
    if (!container || !net.roomCode) return;
    if (typeof window.qrcode !== 'function') {
      container.textContent = 'QR indisponível';
      return;
    }
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(inviteUrl());
      qr.make();
      container.innerHTML = qr.createSvgTag(3, 2);
      const svg = container.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', '150');
        svg.setAttribute('height', '150');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'QR Code do convite da sala');
      }
    } catch (_) {
      container.textContent = 'QR indisponível';
    }
  }

  function refreshLobbyUI() {
    const guest = isGuestClient();
    const online = state.squadType === 'online';

    document.querySelectorAll('[data-format-btn]').forEach((btn) => {
      btn.style.borderColor = btn.dataset.formatBtn === state.format ? 'var(--accent)' : 'var(--panel-border)';
      btn.classList.toggle('is-locked', guest);
      btn.setAttribute('aria-pressed', String(btn.dataset.formatBtn === state.format));
    });
    document.querySelectorAll('[data-squad-btn]').forEach((btn) => {
      btn.style.borderColor = btn.dataset.squadBtn === state.squadType ? 'var(--accent)' : 'var(--panel-border)';
      btn.setAttribute('aria-pressed', String(btn.dataset.squadBtn === state.squadType));
    });
    document.querySelectorAll('[data-rule-btn]').forEach((btn) => {
      btn.style.borderColor = btn.dataset.ruleBtn === state.ruleMode ? 'var(--accent)' : 'var(--panel-border)';
      btn.classList.toggle('is-locked', guest);
      btn.setAttribute('aria-pressed', String(btn.dataset.ruleBtn === state.ruleMode));
    });
    $('config-lock-note').classList.toggle('hidden', !guest);

    // Cartão da sala
    $('room-card').classList.toggle('hidden', !online);
    $('header-room-wrap').classList.toggle('hidden', !(online && net.roomCode));
    $('lobby-room-code').textContent = net.roomCode || '----';
    $('header-room-code').textContent = net.roomCode || '----';
    $('host-room-actions').classList.toggle('hidden', guest);
    $('join-form').classList.toggle('hidden', guest);
    $('btn-leave-room').classList.toggle('hidden', !guest);
    if (guest) $('qr-box').classList.add('hidden');

    const pill = $('room-status-pill');
    const peerLine = $('room-peer-line');
    let pillText;
    let pillClass;
    let peer = null;
    if (!net.started) {
      pillText = '● Offline';
      pillClass = 'bg-slate-500/20 text-slate-300';
    } else if (guest) {
      if (net.hostId) {
        pillText = '● Conectado';
        pillClass = 'bg-emerald-500/20 text-emerald-300';
        peer = net.hostProfile && { ...net.hostProfile, role: 'Anfitrião' };
      } else {
        pillText = '● Entrando…';
        pillClass = 'bg-amber-500/20 text-amber-300';
      }
    } else if (net.guestId) {
      pillText = '● 2 na sala';
      pillClass = 'bg-emerald-500/20 text-emerald-300';
      peer = net.guestProfile && { ...net.guestProfile, role: 'Convidado' };
    } else {
      pillText = '● Aguardando jogador';
      pillClass = 'bg-amber-500/20 text-amber-300';
    }
    pill.textContent = pillText;
    pill.className = `text-[10px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap ${pillClass}`;
    if (peer) {
      peerLine.classList.remove('hidden');
      peerLine.innerHTML = `${profileAvatarHtml(peer, 'sm')}<span class="truncate">${escapeHtml(peer.name)}</span><span class="opacity-70 font-semibold">• ${peer.role}</span>`;
    } else {
      peerLine.classList.add('hidden');
      peerLine.innerHTML = '';
    }

    // Botão iniciar
    const startBtn = $('btn-start-match');
    let label = 'Iniciar Partida';
    let icon = '🎴';
    let disabled = false;
    if (guest) {
      label = net.hostId ? 'Aguardando anfitrião iniciar' : 'Conectando à sala…';
      icon = '⏳';
      disabled = true;
    } else if (online && !net.guestId) {
      label = 'Aguardando jogador entrar';
      icon = '⏳';
      disabled = true;
    }
    $('start-btn-label').textContent = label;
    $('start-btn-icon').textContent = icon;
    startBtn.disabled = disabled;
  }

  async function shareInvite() {
    sfx.tap();
    if (!net.roomCode) return;
    const url = inviteUrl();
    const lbl = $('copy-btn-label');
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Trinca Oculta', text: `Bora jogar Trinca Oculta? Sala ${net.roomCode}`, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch (_) {
      const tmp = document.createElement('input');
      tmp.value = url;
      document.body.appendChild(tmp);
      tmp.select();
      try { copied = document.execCommand('copy'); } catch (__) {}
      tmp.remove();
    }
    lbl.textContent = copied ? 'Copiado!' : 'Falhou';
    showToast(copied ? '🔗 Link copiado! Envie para o outro jogador.' : `Copie o link: ${url}`);
    setTimeout(() => { lbl.textContent = 'Convidar'; }, 1800);
  }

  function selectSquad(type) {
    if (type === state.squadType && (type !== 'online' || net.started)) return;
    if (isGuestClient() && type !== 'online') {
      confirmDialog('Sair da sala?', 'Você vai sair da sala online atual.', 'Sair').then((ok) => {
        if (!ok) return;
        stopNetwork(true);
        state.squadType = type;
        refreshLobbyUI();
      });
      return;
    }
    if (type === 'online') {
      startNetwork(generateRoomCode(), false);
    } else if (net.started) {
      stopNetwork(true);
    }
    state.squadType = type;
    refreshLobbyUI();
  }

  function goToLobby() {
    matchToken++;
    state.phase = 'lobby';
    state.turnReveals = [];
    localUI.swapMode = false;
    localUI.privacyHold = false;
    $('game-screen').classList.add('hidden');
    $('modal-gameover').classList.add('hidden');
    $('privacy-screen').classList.add('hidden');
    $('btn-back-lobby').classList.add('hidden');
    $('lobby-screen').classList.remove('hidden');
    refreshLobbyUI();
  }

  async function requestBackToLobby() {
    const inMatch = state.phase === 'playing' || state.phase === 'resolving';
    if (inMatch) {
      const ok = await confirmDialog('Abandonar a partida?', 'O progresso desta partida será perdido.', 'Abandonar');
      if (!ok) return;
    }
    if (state.squadType === 'online' && net.started && state.phase !== 'lobby') {
      if (net.isHost && net.guestId) sendNet({ type: 'MATCH_ABORT', to: net.guestId });
      if (!net.isHost && net.hostId && inMatch) sendNet({ type: 'GUEST_ABORT', to: net.hostId });
    }
    goToLobby();
  }

  /* ---------------------------------------------------------------------------
     14. MODAIS (CONFIRMAÇÃO + TUTORIAL)
     --------------------------------------------------------------------------- */
  let confirmResolver = null;
  function confirmDialog(title, text, okLabel = 'Confirmar') {
    if (confirmResolver) confirmResolver(false);
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('btn-confirm-ok').textContent = okLabel;
    $('modal-confirm').classList.remove('hidden');
    return new Promise((resolve) => { confirmResolver = resolve; });
  }
  function closeConfirm(result) {
    $('modal-confirm').classList.add('hidden');
    const r = confirmResolver;
    confirmResolver = null;
    if (r) r(result);
  }

  let tutIndex = 0;
  const TUTORIAL_STEPS = [
    {
      title: '1. Baralho Ordenado (1 a 12)',
      body: 'São <strong>36 cartas</strong> (números 1 a 12, três cópias de cada). Suas cartas ficam sempre ordenadas da <strong>MENOR</strong> (esquerda) para a <strong>MAIOR</strong> (direita).',
      demo: `<div class="flex justify-center gap-1.5 pt-1 font-black text-sm">
        <span class="px-2.5 py-1.5 rounded-lg game-card-face">2</span>
        <span class="px-2.5 py-1.5 rounded-lg game-card-face">5</span>
        <span class="px-2.5 py-1.5 rounded-lg game-card-face">7</span>
        <span class="px-2.5 py-1.5 rounded-lg game-card-face">11</span>
      </div>`
    },
    {
      title: '2. Só as Pontas!',
      body: 'No seu turno, vire cartas uma a uma para achar <strong>3 iguais</strong>. Na <strong>Mesa</strong> vale qualquer carta; nas mãos (inclusive a sua) só a <strong>MENOR</strong> ou a <strong>MAIOR</strong>. Errou? As cartas voltam e a vez passa.',
      demo: `<div class="flex justify-center items-center gap-2 pt-1 text-xs font-extrabold">
        <span class="px-2.5 py-1.5 rounded-lg game-card-back playable-edge">◀ MENOR</span>
        <span class="opacity-40">[ • • • ]</span>
        <span class="px-2.5 py-1.5 rounded-lg game-card-back playable-edge">MAIOR ▶</span>
      </div>`
    },
    {
      title: '3. Duelo 1v1 vs. Dupla 2v2',
      body: 'No <strong>Duelo 1v1</strong>, cada jogador recebe <strong>10 cartas</strong> e há <strong>16</strong> na mesa. Na <strong>Dupla 2v2</strong>, cada um recebe <strong>7 cartas</strong>, a dupla soma as trincas e cada jogador pode usar a <strong>Troca Secreta (1x)</strong> com o parceiro no início do turno.',
      demo: '<div class="text-center text-xs font-bold py-2 px-3 rounded-xl glass-panel">⚔️ 1v1 (10 cartas cada) • 🤝 2v2 (7 cartas cada)</div>'
    },
    {
      title: '4. Clássico vs. Picante 🌶️',
      body: 'No <strong>Clássico</strong>, vence quem fizer <strong>3 Trincas</strong> (ou a Trinca de <strong>7</strong>). No <strong>Picante</strong>, bastam <strong>2 Trincas Conectadas</strong> com diferença 7 (ex: <code>4</code> e <code>11</code>)!',
      demo: `<div class="flex justify-center items-center gap-2 pt-1 font-black text-xs">
        <span class="px-2.5 py-1 rounded-lg game-card-face">Trinca [4]</span>
        <span>+ 7 =</span>
        <span class="px-2.5 py-1 rounded-lg game-card-face">Trinca [11]</span>
      </div>`
    }
  ];

  function renderTutorialStep() {
    const step = TUTORIAL_STEPS[tutIndex];
    $('tutorial-step-content').innerHTML = `
      <div class="space-y-2">
        <h4 class="font-display text-base font-extrabold" style="color: var(--accent);">${step.title}</h4>
        <p class="text-xs leading-relaxed" style="color: var(--text-secondary);">${step.body}</p>
      </div>
      ${step.demo}`;
    $('btn-tut-prev').style.visibility = tutIndex === 0 ? 'hidden' : 'visible';
    $('btn-tut-next').textContent = tutIndex === TUTORIAL_STEPS.length - 1 ? 'Entendi! ✓' : 'Próximo →';
    $('tut-dots').innerHTML = TUTORIAL_STEPS.map((_, i) => `<span class="w-2 h-2 rounded-full ${i === tutIndex ? 'scale-125' : 'opacity-35'}" style="background: var(--accent);"></span>`).join('');
  }

  function openTutorialModal() {
    tutIndex = 0;
    renderTutorialStep();
    $('modal-tutorial').classList.remove('hidden');
  }

  /* ---------------------------------------------------------------------------
     15. EVENTOS DE INTERFACE
     --------------------------------------------------------------------------- */
  $('game-screen').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    if (action === 'table-card') onLocalTableClick(Number(btn.dataset.index));
    else if (action === 'hand-edge') onLocalHandEdgeClick(Number(btn.dataset.target), btn.dataset.edge);
    else if (action === 'swap-card') onLocalSwapClick(Number(btn.dataset.handIndex));
  });

  document.querySelectorAll('[data-theme-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sfx.tap();
      applyTheme(btn.dataset.themeBtn);
      persistPrefs();
    });
  });

  document.querySelectorAll('[data-format-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (isGuestClient()) return;
      sfx.tap();
      state.format = btn.dataset.formatBtn;
      refreshLobbyUI();
      if (net.guestId) sendNet({ type: 'ROOM_CONFIG', to: net.guestId, format: state.format, ruleMode: state.ruleMode });
    });
  });

  document.querySelectorAll('[data-squad-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sfx.tap();
      selectSquad(btn.dataset.squadBtn);
    });
  });

  document.querySelectorAll('[data-rule-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (isGuestClient()) return;
      sfx.tap();
      state.ruleMode = btn.dataset.ruleBtn;
      refreshLobbyUI();
      if (net.guestId) sendNet({ type: 'ROOM_CONFIG', to: net.guestId, format: state.format, ruleMode: state.ruleMode });
    });
  });

  $('btn-sound').addEventListener('click', () => {
    applySound(!prefs.sound);
    persistPrefs();
    if (prefs.sound) sfx.tap();
  });

  $('btn-header-help').addEventListener('click', () => { sfx.tap(); openTutorialModal(); });
  $('btn-lobby-rules').addEventListener('click', () => { sfx.tap(); openTutorialModal(); });
  $('btn-close-tutorial').addEventListener('click', () => $('modal-tutorial').classList.add('hidden'));
  $('btn-tut-prev').addEventListener('click', () => {
    sfx.tap();
    tutIndex = Math.max(0, tutIndex - 1);
    renderTutorialStep();
  });
  $('btn-tut-next').addEventListener('click', () => {
    sfx.tap();
    if (tutIndex + 1 >= TUTORIAL_STEPS.length) $('modal-tutorial').classList.add('hidden');
    else { tutIndex++; renderTutorialStep(); }
  });

  $('btn-toggle-qr').addEventListener('click', () => {
    sfx.tap();
    renderRoomQR();
    $('qr-box').classList.toggle('hidden');
  });
  $('btn-new-room').addEventListener('click', async () => {
    sfx.tap();
    if (net.guestId) {
      const ok = await confirmDialog('Criar nova sala?', 'O convidado atual será desconectado.', 'Nova sala');
      if (!ok) return;
    }
    startNetwork(generateRoomCode(), false);
  });
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sfx.tap();
    const input = $('input-join-room');
    const val = input.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (val.length !== 4) {
      showToast('Digite o código de 4 caracteres da sala.');
      return;
    }
    if (val === net.roomCode && net.isHost) {
      showToast('Esse é o código da sua própria sala. Envie para o outro jogador!');
      return;
    }
    input.value = '';
    input.blur();
    startNetwork(val, true);
  });
  $('btn-leave-room').addEventListener('click', () => selectSquad('bots'));
  $('btn-copy-link').addEventListener('click', shareInvite);

  $('btn-start-match').addEventListener('click', startNewMatch);
  $('btn-rematch').addEventListener('click', startNewMatch);
  $('btn-back-lobby').addEventListener('click', requestBackToLobby);
  $('btn-gameover-lobby').addEventListener('click', goToLobby);

  $('btn-confirm-privacy').addEventListener('click', () => {
    sfx.tap();
    localUI.privacyHold = false;
    $('privacy-screen').classList.add('hidden');
    renderGameBoard();
  });

  $('btn-secret-swap').addEventListener('click', toggleSecretSwapMode);

  $('btn-confirm-ok').addEventListener('click', () => closeConfirm(true));
  $('btn-confirm-cancel').addEventListener('click', () => closeConfirm(false));

  // Perfil
  $('btn-profile').addEventListener('click', () => { sfx.tap(); openProfileScreen(); });
  $('btn-close-profile').addEventListener('click', closeProfileScreen);
  $('btn-new-profile').addEventListener('click', () => openProfileScreen({ editId: null }));
  $('btn-delete-profile').addEventListener('click', deleteEditingProfile);
  $('profile-form').addEventListener('submit', saveProfileFromForm);
  $('input-photo-camera').addEventListener('change', handlePhotoInput);
  $('input-photo-gallery').addEventListener('change', handlePhotoInput);
  $('profile-icon-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-avatar-icon]');
    if (!btn) return;
    sfx.tap();
    profileUI.draftAvatar = { type: 'emoji', value: btn.dataset.avatarIcon };
    renderProfileAvatarPicker();
  });
  $('profile-list').addEventListener('click', (e) => {
    const sel = e.target.closest('[data-profile-select]');
    const edit = e.target.closest('[data-profile-edit]');
    if (edit) {
      sfx.tap();
      openProfileScreen({ editId: edit.dataset.profileEdit });
      return;
    }
    if (sel) {
      if (state.phase === 'playing' || state.phase === 'resolving') {
        showToast('Troque de jogador no lobby, fora da partida.');
        return;
      }
      sfx.tap();
      profileStore.activeId = sel.dataset.profileSelect;
      persistProfiles();
      onProfileChanged();
      $('profile-screen').classList.add('hidden');
      showToast(`Jogando como ${activeProfile().name}`);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modal-confirm').classList.contains('hidden')) closeConfirm(false);
    else if (!$('modal-tutorial').classList.contains('hidden')) $('modal-tutorial').classList.add('hidden');
    else if (!$('profile-screen').classList.contains('hidden')) closeProfileScreen();
  });

  window.addEventListener('pagehide', () => {
    if (net.started) sendNet({ type: 'LEAVE' });
  });

  /* ---------------------------------------------------------------------------
     16. PWA: SERVICE WORKER + BOTÃO INSTALAR
     --------------------------------------------------------------------------- */
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $('btn-install').classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    $('btn-install').classList.add('hidden');
    showToast('📲 Trinca Oculta instalado!');
  });
  $('btn-install').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    try { await deferredInstallPrompt.userChoice; } catch (_) {}
    deferredInstallPrompt = null;
    $('btn-install').classList.add('hidden');
  });

  if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  /* ---------------------------------------------------------------------------
     17. INICIALIZAÇÃO
     --------------------------------------------------------------------------- */
  applyTheme(prefs.theme);
  applySound(prefs.sound);
  onProfileChanged();

  let invited = null;
  try {
    invited = new URLSearchParams(window.location.search).get('sala');
  } catch (_) {}
  invited = invited ? invited.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';

  if (invited.length === 4) {
    state.squadType = 'online';
    if (activeProfile()) {
      startNetwork(invited, true);
    } else {
      // Entra na sala depois que o perfil for criado.
      const form = $('profile-form');
      const joinAfterProfile = () => {
        if (!activeProfile()) return;
        form.removeEventListener('submit', joinAfterProfile);
        startNetwork(invited, true);
      };
      form.addEventListener('submit', joinAfterProfile);
    }
  }
  refreshLobbyUI();

  if (!activeProfile()) openProfileScreen({ editId: null, firstRun: true });
})();
