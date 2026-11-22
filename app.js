/* =========================================================
   우리끼리 — 지인 전용 위치 공유
   · Supabase(설정 시) 또는 체험(데모) 모드로 동작
   · 배터리 · 체류 시간 · 동선(경로/타임라인) · 이동 속도
   ========================================================= */
(() => {
  'use strict';

  /* ───────────────────────── 0. 설정 ───────────────────────── */
  const CFG = Object.assign({
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    ROOM_PREFIX: 'DALKONG',
    REFRESH_SECONDS: 10,
  }, window.APP_CONFIG || {});

  const SUPABASE_URL = String(CFG.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const SUPABASE_KEY = String(CFG.SUPABASE_ANON_KEY || '').trim();
  const LIVE = /^https?:\/\//i.test(SUPABASE_URL) && SUPABASE_KEY.length > 20;

  const BASE = { lat: 37.5665, lng: 126.9780 };            // 서울시청 — 위치를 못 받을 때 기본 좌표
  const REFRESH_MS = Math.max(5, Number(CFG.REFRESH_SECONDS) || 10) * 1000;
  const STALE_MS = 10 * 60 * 1000;                          // 10분 넘게 갱신 없으면 '오프라인'
  const PALETTE = ['#0fb9a3', '#f59e0b', '#6366f1', '#ec4899', '#8b5cf6', '#0ea5e9', '#ef4444', '#14b8a6'];
  const EMOJIS = ['🙂', '🙌', '🏃', '🚇', '💼', '🏠', '🍜', '😴'];

  /* 배터리 API는 안드로이드 크롬 등에서만 열려 있어요(iOS 사파리는 막혀 있음). */
  const BATT_API = typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function';

  /* 체류·속도 규칙 */
  const STAY_RADIUS_M = 75;             // 같은 장소로 보는 반경(약 60~80m)
  const STAY_MIN_MS = 3 * 60 * 1000;    // 이 시간 이상 머물면 '체류'로 기록
  const MOVE_KMH = 2;                   // 이 속도 이상이면 '이동 중'
  const HISTORY_MAX = 240;              // 멤버당 보관 좌표 수
  const HISTORY_MAX_MS = 6 * 60 * 60 * 1000;

  const DEMO_FRIENDS = [
    {
      user_id: 'demo-minji', nickname: '민지', emoji: '🙌',
      status: '퇴근길이에요', statuses: ['퇴근길이에요', '버스 기다리는 중', '집 가는 중 🏠'],
      lat: 37.5580, lng: 126.8372, battery: 76, charging: true,   // 퇴근길 보조배터리로 충전 중
      color: '#f59e0b', heading: 1.9, seed: 20261123,
      plan: [
        { k: 'walk', kmh: 4.4, ticks: 5 },
        { k: 'stay', ticks: 9 },
        { k: 'bus', kmh: 26, ticks: 8 },
        { k: 'walk', kmh: 4.2, ticks: 6 },
        { k: 'stay', ticks: 11 },
      ],
      seedOpts: { kmhWalk: 4.4, kmhRide: 18, spanMin: 158 },
    },
    {
      user_id: 'demo-hyunwoo', nickname: '현우', emoji: '🏃',
      status: '한강 러닝 중', statuses: ['한강 러닝 중', '5km 완주!', '물 마시는 중 💧'],
      lat: 37.5666, lng: 126.8284, battery: 41, charging: false,
      color: '#6366f1', heading: 4.4, seed: 771013,
      plan: [
        { k: 'run', kmh: 9.2, ticks: 9 },
        { k: 'stay', ticks: 6 },
        { k: 'run', kmh: 10.2, ticks: 7 },
        { k: 'walk', kmh: 4.8, ticks: 5 },
      ],
      seedOpts: { kmhWalk: 9.2, kmhRide: 9.2, spanMin: 121 },
    },
  ];

  /* ───────────────────────── 1. 작은 도구들 ───────────────────────── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const LS = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} },
    del(key) { try { localStorage.removeItem(key); } catch (e) {} },
  };

  const pad2 = (n) => String(n).padStart(2, '0');

  function timeAgo(iso) {
    const t = new Date(iso).getTime();
    if (!t || isNaN(t)) return '—';
    const diff = Math.max(0, Date.now() - t) / 1000;
    if (diff < 45) return '방금';
    if (diff < 3600) return Math.max(1, Math.floor(diff / 60)) + '분 전';
    if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    return Math.floor(diff / 86400) + '일 전';
  }

  function clockOf(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function colorFor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function initialOf(name) {
    const s = String(name || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }

  function getUid() {
    let id = LS.get('locshare.uid', null);
    if (!id) {
      id = (crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      LS.set('locshare.uid', id);
    }
    return id;
  }

  function normalizeRoom(v) {
    return String(v == null ? '' : v)
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_-]/g, '')
      .toUpperCase()
      .slice(0, 20);
  }

  function isStale(m) {
    if (!m) return false;
    return Date.now() - new Date(m.updated_at).getTime() > STALE_MS;
  }

  function sessionKey(room) { return 'locshare.session.' + room; }
  function historyKey(room, uid) { return 'locshare.hist.' + room + '.' + uid; }

  /* ── 거리 · 시간 표기 ── */
  const R_EARTH = 6371000;

  function haversine(a, b) {
    if (!a || !b) return 0;
    const la1 = a.lat * Math.PI / 180;
    const la2 = b.lat * Math.PI / 180;
    const dLa = la2 - la1;
    const dLo = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLa / 2) * Math.sin(dLa / 2)
      + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function durText(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 1) return '1분 미만';
    if (mins < 60) return mins + '분';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + '시간' + (m ? ' ' + m + '분' : '');
  }

  function distText(m) {
    if (!isFinite(m)) return '—';
    if (m < 1000) return Math.round(m / 10) * 10 + 'm';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + 'km';
  }

  /* ── 배터리 ── */
  function batteryText(m) {
    if (m.battery == null || isNaN(m.battery)) return '';
    const level = Math.round(m.battery);
    return (m.charging ? '⚡' : '🔋') + ' ' + level + '%';
  }

  function batteryLong(m) {
    if (m.battery == null || isNaN(m.battery)) return '';
    const level = Math.round(m.battery);
    return (m.charging ? '⚡ 충전 중 · ' : '🔋 ') + level + '%';
  }

  /* ── 체류 시간 ── */
  function staySinceOf(m) {
    if (!m) return null;
    if (m.stay_since) return m.stay_since;
    // 서버 행에 체류 시작 시각이 없을 때(구버전 앱)는 남아 있는 이동 기록으로 추정
    const h = historyFor(m.user_id);
    if (h.length < 3) return null;
    const last = h[h.length - 1];
    let i = h.length - 1;
    while (i > 0 && haversine(h[i - 1], last) <= STAY_RADIUS_M) i--;
    if (i === h.length - 1) return null;
    const since = h[i].t;
    return (Date.now() - since >= 60 * 1000) ? new Date(since).toISOString() : null;
  }

  function stayMins(since) {
    if (!since) return 0;
    const ms = Date.now() - new Date(since).getTime();
    return Math.max(0, Math.floor(ms / 60000));
  }

  /* 18분째 머무르는 중 / 1시간 20분 체류 */
  function stayPhrase(since) {
    const mins = stayMins(since);
    if (!since) return '';
    if (mins < 60) return Math.max(1, mins) + '분째 머무르는 중';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + '시간' + (m ? ' ' + m + '분' : '') + ' 체류';
  }

  /* 핀·카드에 들어가는 짧은 표기: 18분째 / 1시간 12분 */
  function stayChip(since) {
    const mins = stayMins(since);
    if (mins < 60) return Math.max(1, mins) + '분째';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + '시간' + (m ? ' ' + m + '분' : '');
  }

  /* ── 이동 속도 ── */
  function moveKind(kmh) {
    if (kmh == null || !isFinite(kmh) || kmh < MOVE_KMH) return null;
    if (kmh >= 20) return { ico: '🚗', label: '차량' };
    if (kmh >= 7) return { ico: '🏃', label: '빠르게 이동' };
    return { ico: '🚶', label: '걷는 중' };
  }

  function speedText(m) {
    if (m.speed_kmh == null || !isFinite(m.speed_kmh)) return '';
    const k = moveKind(m.speed_kmh);
    if (!k) return '';
    return k.ico + ' ' + Math.max(1, Math.round(m.speed_kmh)) + 'km/h';
  }

  /* 핀·카드에 표시할 한 줄: 이동 중이면 속도, 멈춰 있으면 체류 시간 */
  function activityText(m) {
    const sp = speedText(m);
    if (sp) return { kind: 'move', text: sp };
    const since = staySinceOf(m);
    if (since) return { kind: 'stay', text: '⏱ ' + stayChip(since) };
    return null;
  }

  /* ───────────────────────── 2. 화면 요소 · 상태 ───────────────────────── */
  const el = {
    join: $('#joinScreen'),
    joinForm: $('#joinForm'),
    inputNick: $('#inputNick'),
    inputRoom: $('#inputRoom'),
    btnJoin: $('#btnJoin'),
    btnCreate: $('#btnCreate'),
    joinHint: $('#joinHint'),
    modeNote: $('#modeNote'),
    app: $('#app'),
    map: $('#map'),
    roomChip: $('#roomChip'),
    roomCode: $('#roomCodeLabel'),
    roomCount: $('#roomCountLabel'),
    sheet: $('#sheet'),
    sheetCount: $('#sheetCount'),
    memberList: $('#memberList'),
    btnCollapse: $('#btnCollapse'),
    btnInvite: $('#btnInvite'),
    btnShare: $('#btnShare'),
    btnLeave: $('#btnLeave'),
    btnUpdate: $('#btnUpdate'),
    updateSub: $('#updateSub'),
    btnAuto: $('#btnAuto'),
    btnCopy: $('#btnCopy'),
    btnLocate: $('#btnLocate'),
    toast: $('#toast'),
    modal: $('#memberModal'),
    mCard: $('#mCard'),
    mAvatar: $('#mAvatar'),
    mName: $('#mName'),
    mStatus: $('#mStatus'),
    mRows: $('#mRows'),
    mEdit: $('#mEdit'),
    mEmojis: $('#mEmojis'),
    mStatusInput: $('#mStatusInput'),
    mClose: $('#mClose'),
    mSave: $('#mSave'),
    mLocate: $('#mLocate'),
    mRouteBlock: $('#mRouteBlock'),
    mRouteSum: $('#mRouteSum'),
    mRouteToggle: $('#mRouteToggle'),
    mTimeline: $('#mTimeline'),
    mBatt: $('#mBatt'),
    mBattModes: $('#mBattModes'),
    mBattManual: $('#mBattManual'),
    mBattRange: $('#mBattRange'),
    mBattVal: $('#mBattVal'),
    mBattCharging: $('#mBattCharging'),
    permHint: $('#permHint'),
    permText: $('#permHint span'),
    btnPermAsk: $('#btnPermAsk'),
    btnPermClose: $('#btnPermClose'),
  };

  const state = {
    room: '',
    me: null,
    members: new Map(),
    markers: new Map(),
    markerSig: new Map(),
    map: null,
    routeGroup: null,
    routeFor: null,
    routeOn: true,
    liveRoutes: new Map(),
    history: new Map(),
    store: null,
    joined: false,
    joining: false,
    auto: true,
    selected: null,
    watchId: null,
    tickTimer: null,
    lastPublish: 0,
    lastHistAt: 0,
    battery: null,
    charging: false,
    battMode: BATT_API ? 'auto' : 'off',
    battManual: { level: 80, charging: false },
    lastFix: null,
    histWarned: false,
    errShown: false,
    geoDenied: false,
    gotFix: false,
    toastTimer: null,
    selectedEmoji: null,
  };

  /* ───────────────────────── 3. 토스트 · 공통 UI ───────────────────────── */
  function toast(message, ms = 2600) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), ms);
  }

  function updateSheetHeight() {
    if (!el.sheet || el.app.hidden) return;
    const h = Math.round(el.sheet.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--sheet-h', h + 'px');
  }

  function updateChrome() {
    const members = sortedMembers();
    el.roomCode.textContent = state.room || '—';
    el.roomCount.textContent = (LIVE ? '' : '체험 모드 · ') + members.length + '명';
    el.sheetCount.textContent = members.length;

    el.btnAuto.classList.toggle('is-on', state.auto);
    el.btnAuto.setAttribute('aria-pressed', String(state.auto));

    if (state.me) {
      const stale = isStale(state.me);
      el.updateSub.textContent = stale ? '오래됨' : timeAgo(state.me.updated_at);
    }
    updateSheetHeight();
  }

  function sortedMembers() {
    const arr = Array.from(state.members.values());
    arr.sort((a, b) => {
      const meId = state.me ? state.me.user_id : null;
      if (a.user_id === meId) return -1;
      if (b.user_id === meId) return 1;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
    return arr;
  }

  /* ───────────────────────── 4. 지도 ───────────────────────── */
  function initMap() {
    if (state.map || typeof L === 'undefined') return;
    const map = L.map('map', {
      zoomControl: false,
      attributionControl: false,
      maxZoom: 19,
      minZoom: 3,
      worldCopyJump: false,
    }).setView([BASE.lat, BASE.lng], 14);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 기여자',
    }).addTo(map);

    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);

    map.on('click', () => {
      if (!el.modal.hidden) { closeModal(); return; }
      state.selected = null;
      renderPins();
    });

    state.routeGroup = L.layerGroup().addTo(map);
    state.map = map;
    setTimeout(() => map.invalidateSize(), 60);
  }

  function pinSignature(m) {
    const act = activityText(m);
    return [
      m.user_id, m.nickname, m.emoji, m.status_text, m.color,
      isStale(m) ? 's' : '',
      state.selected === m.user_id ? 'sel' : '',
      state.me && m.user_id === state.me.user_id ? 'me' : '',
      act ? act.kind + act.text : '',
      batteryText(m),
    ].join('|');
  }

  function buildPinIcon(m) {
    const isMe = !!state.me && m.user_id === state.me.user_id;
    const stale = isStale(m);
    const cls = ['pin',
      isMe ? 'pin--me' : '',
      stale ? 'pin--stale' : '',
      state.selected === m.user_id ? 'is-selected' : '',
    ].filter(Boolean).join(' ');

    const label = m.status_text || '';
    const act = activityText(m);
    const batt = batteryText(m);

    const meta = (act || batt)
      ? '<span class="pin-meta">'
        + (act ? '<span class="pin-chip pin-chip--' + act.kind + '">' + esc(act.text) + '</span>' : '')
        + (batt ? '<span class="pin-chip">' + esc(batt) + '</span>' : '')
        + '</span>'
      : '';

    const html = '<div class="' + cls + '" style="--pin:' + esc(m.color || colorFor(m.user_id)) + '">'
      + '<div class="pin-dot">' + esc(initialOf(m.nickname))
      + '<span class="pin-emoji">' + esc(m.emoji || '🙂') + '</span></div>'
      + '<div class="pin-tag"><span class="pin-name">' + esc(m.nickname)
      + (isMe ? '<em class="pin-me">나</em>' : '') + '</span>'
      + (label ? '<span class="pin-status">' + esc(label) + '</span>' : '')
      + meta
      + '</div></div>';

    return L.divIcon({ className: 'pin-host', html, iconSize: [76, 76], iconAnchor: [38, 38] });
  }

  function renderPins() {
    if (!state.map) return;
    const seen = new Set();

    for (const m of state.members.values()) {
      seen.add(m.user_id);
      if (!isFinite(m.lat) || !isFinite(m.lng)) continue;

      const sig = pinSignature(m);
      const existing = state.markers.get(m.user_id);

      if (!existing) {
        const marker = L.marker([m.lat, m.lng], {
          icon: buildPinIcon(m),
          keyboard: false,
          riseOnHover: true,
          zIndexOffset: state.me && m.user_id === state.me.user_id ? 1200 : 0,
        }).addTo(state.map);
        marker.on('click', () => { openMember(m.user_id, true); });
        state.markers.set(m.user_id, marker);
        state.markerSig.set(m.user_id, sig);
      } else {
        existing.setLatLng([m.lat, m.lng]);
        if (state.markerSig.get(m.user_id) !== sig) {
          existing.setIcon(buildPinIcon(m));
          state.markerSig.set(m.user_id, sig);
        }
      }
    }

    for (const [id, marker] of Array.from(state.markers.entries())) {
      if (!seen.has(id)) {
        marker.remove();
        state.markers.delete(id);
        state.markerSig.delete(id);
      }
    }
  }

  function fitToMembers(animate = false) {
    if (!state.map) return;
    const pts = sortedMembers()
      .map((m) => [m.lat, m.lng])
      .filter((p) => isFinite(p[0]) && isFinite(p[1]));
    if (!pts.length) return;

    if (pts.length === 1) {
      state.map.setView(pts[0], 15, { animate });
      return;
    }
    const sheetH = el.sheet ? el.sheet.getBoundingClientRect().height : 240;
    const size = state.map.getSize();
    const bottomPad = Math.min(Math.round(sheetH + 78), Math.max(140, size.y - 150));

    state.map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [44, 98],
      paddingBottomRight: [44, bottomPad],
      maxZoom: 15,
      animate,
    });
  }

  function centerOn(m) {
    if (!state.map || !m) return;
    state.map.flyTo([m.lat, m.lng], Math.max(state.map.getZoom(), 15), { duration: 0.7 });
  }

  /* ───────────────────────── 5. 이동 기록 · 동선 ───────────────────────── */
  function historyFor(id) {
    return state.history.get(id) || [];
  }

  function setHistory(id, pts) {
    const clean = (pts || [])
      .map((p) => ({
        lat: Number(p && p.lat),
        lng: Number(p && p.lng),
        t: Number(p && p.t),
        speed: p && p.speed != null && p.speed !== '' ? Number(p.speed) : null,
        since: (p && p.since) || null,
      }))
      .filter((p) => isFinite(p.lat) && isFinite(p.lng) && isFinite(p.t))
      .sort((a, b) => a.t - b.t);
    const cutoff = Date.now() - HISTORY_MAX_MS;
    const trimmed = clean.filter((p) => p.t >= cutoff).slice(-HISTORY_MAX);
    state.history.set(id, trimmed);
    return trimmed;
  }

  function addHistoryPoint(id, p) {
    if (!id || !p || !isFinite(p.lat) || !isFinite(p.lng)) return false;
    const arr = historyFor(id);
    const last = arr[arr.length - 1];
    const t = p.t || Date.now();
    const speed = p.speed == null ? null : p.speed;
    const since = p.since || null;
    const point = { lat: Number(p.lat), lng: Number(p.lng), t, speed, since };

    if (last) {
      const d = haversine(last, point);
      if (t - last.t < 15 * 1000 && d < 12) return false;          // 너무 잦은 좌표는 버림
      if (d < 10 && t - last.t < 120 * 1000) {
        arr[arr.length - 1] = point;
        state.history.set(id, arr);
        return false;
      }
    }

    arr.push(point);
    if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
    state.history.set(id, arr);
    return true;
  }

  /* 좌표 배열 → 체류/이동 구간 타임라인 */
  function buildSegments(pts) {
    if (!pts || pts.length < 2) return [];
    const out = [];
    const clusters = [];
    let cur = { start: 0, end: 0 };

    for (let i = 1; i < pts.length; i++) {
      const far = haversine(pts[cur.start], pts[i]) > STAY_RADIUS_M;
      if (far) {
        clusters.push(cur);
        cur = { start: i, end: i };
      } else {
        cur.end = i;
      }
    }
    clusters.push(cur);

    const stays = clusters.filter((c) => pts[c.end].t - pts[c.start].t >= STAY_MIN_MS);
    let prev = 0;

    const pushMove = (from, to) => {
      if (to - from < 1) return;
      let dist = 0;
      for (let i = from + 1; i <= to; i++) dist += haversine(pts[i - 1], pts[i]);
      const ms = Math.max(1, pts[to].t - pts[from].t);
      out.push({
        kind: 'move',
        start: pts[from].t,
        end: pts[to].t,
        ms,
        meters: dist,
        kmh: (dist / 1000) / (ms / 3600000),
        from: pts[from],
        to: pts[to],
      });
    };

    for (const s of stays) {
      if (s.start > prev) pushMove(prev, s.start);
      const span = pts.slice(s.start, s.end + 1);
      const lat = span.reduce((a, p) => a + p.lat, 0) / span.length;
      const lng = span.reduce((a, p) => a + p.lng, 0) / span.length;
      out.push({
        kind: 'stay',
        start: pts[s.start].t,
        end: pts[s.end].t,
        ms: Math.max(1, pts[s.end].t - pts[s.start].t),
        lat, lng,
      });
      prev = s.end;
    }
    if (prev < pts.length - 1) pushMove(prev, pts.length - 1);

    return out;
  }

  function routeSummary(segs) {
    const moves = segs.filter((s) => s.kind === 'move');
    const stays = segs.filter((s) => s.kind === 'stay');
    const meters = moves.reduce((a, s) => a + s.meters, 0);
    if (!segs.length) return null;
    const first = segs[0].start;
    const last = segs[segs.length - 1].end;
    return {
      meters,
      stays: stays.length,
      spanMs: Math.max(0, last - first),
      kmh: moves.length ? meters / 1000 / Math.max(0.01, (last - first) / 3600000) : 0,
    };
  }

  function clearRoute() {
    state.routeFor = null;
    if (state.routeGroup) state.routeGroup.clearLayers();
    syncLiveRoutes();
  }

  function stayBadgeIcon(mins, color) {
    const html = '<div class="stay-badge" style="--c:' + esc(color) + '">'
      + '<span class="stay-dot"></span>' + esc(durText(mins * 60000)) + '</div>';
    return L.divIcon({ className: 'stay-badge-host', html, iconSize: [1, 1], iconAnchor: [0, 0] });
  }

  function drawRoute(m, opts = {}) {
    if (!state.map || !m) return;
    const pts = historyFor(m.user_id);
    if (state.routeGroup) state.routeGroup.clearLayers();
    state.routeFor = m.user_id;
    dropLiveRoute(m.user_id);   // 같은 멤버의 실시간 꼬리는 전체 경로로 대체

    if (pts.length < 2) return;

    const color = m.color || colorFor(m.user_id);
    const coords = pts.map((p) => [p.lat, p.lng]);

    L.polyline(coords, {
      color: '#ffffff', weight: 7, opacity: 0.85, lineJoin: 'round', lineCap: 'round',
    }).addTo(state.routeGroup);

    L.polyline(coords, {
      color, weight: 4, opacity: 0.95, lineJoin: 'round', lineCap: 'round',
      dashArray: null,
    }).addTo(state.routeGroup);

    const segs = buildSegments(pts);
    segs.filter((s) => s.kind === 'stay').forEach((s) => {
      // 지금 머물고 있는 자리는 핀이 이미 알려 주므로 뱃지를 겹치지 않게 생략
      if (m.speed_kmh == null || m.speed_kmh < MOVE_KMH) {
        if (haversine({ lat: m.lat, lng: m.lng }, { lat: s.lat, lng: s.lng }) < 30) return;
      }
      L.marker([s.lat, s.lng], {
        icon: stayBadgeIcon(Math.round(s.ms / 60000), color),
        keyboard: false,
        interactive: false,
        zIndexOffset: -300,
      }).addTo(state.routeGroup);
    });

    // 출발 지점
    L.circleMarker(coords[0], {
      radius: 4, color: '#ffffff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false,
    }).addTo(state.routeGroup);

    if (opts.fit !== false) {
      setTimeout(() => {
        if (!state.map) return;
        const size = state.map.getSize();
        const cardTop = (el.modal && !el.modal.hidden && el.mCard)
          ? el.mCard.getBoundingClientRect().top
          : (el.sheet ? el.sheet.getBoundingClientRect().top : size.y);
        const covered = Math.max(0, Math.round(size.y - cardTop)) + 14;
        const bottom = Math.min(covered, Math.max(120, size.y - 190));
        state.map.fitBounds(L.latLngBounds(coords), {
          paddingTopLeft: [46, 92],
          paddingBottomRight: [46, bottom],
          maxZoom: 16,
          animate: true,
        });
      }, 340);
    }
  }

  /* 이동 중인 멤버의 동선은 모달을 열지 않아도 지도 위에 실시간으로 이어 그린다 */
  const LIVE_TRAIL_MS = 30 * 60 * 1000;

  function dropLiveRoute(id) {
    const line = state.liveRoutes.get(id);
    if (!line) return;
    try { line.remove(); } catch (e) {}
    state.liveRoutes.delete(id);
  }

  function syncLiveRoutes() {
    if (!state.map) return;
    const keep = new Set();

    for (const m of state.members.values()) {
      if (m.user_id === state.routeFor) continue;

      const pts = historyFor(m.user_id).filter((p) => p.t > Date.now() - LIVE_TRAIL_MS);
      if (pts.length < 2) continue;

      const moving = m.speed_kmh != null && isFinite(m.speed_kmh) && m.speed_kmh >= MOVE_KMH;
      const hadTrail = state.liveRoutes.has(m.user_id);
      const lastT = pts[pts.length - 1].t;
      const recent = lastT && Date.now() - lastT < 3 * 60 * 1000;
      if (!moving && !(hadTrail && recent)) continue;

      keep.add(m.user_id);
      const coords = pts.map((p) => [p.lat, p.lng]);
      const color = m.color || colorFor(m.user_id);

      let line = state.liveRoutes.get(m.user_id);
      if (!line) {
        line = L.polyline(coords, {
          color, weight: 3.5, opacity: 0.85,
          lineJoin: 'round', lineCap: 'round', interactive: false,
        }).addTo(state.map);
        state.liveRoutes.set(m.user_id, line);
      } else {
        line.setStyle({ color });
        line.setLatLngs(coords);
      }
    }

    for (const [id, line] of Array.from(state.liveRoutes.entries())) {
      if (keep.has(id)) continue;
      try { line.remove(); } catch (e) {}
      state.liveRoutes.delete(id);
    }
  }

  /* ───────────────────────── 6. 목록 · 상세 ───────────────────────── */
  function memberCardHTML(m) {
    const isMe = !!state.me && m.user_id === state.me.user_id;
    const stale = isStale(m);
    const status = m.status_text || '상태를 남겨보세요';
    const batt = batteryText(m);
    const act = activityText(m);
    const cls = ['member-card', isMe ? 'is-me' : '',
      state.selected === m.user_id ? 'is-selected' : ''].filter(Boolean).join(' ');

    return '<button class="' + cls + '" type="button" data-id="' + esc(m.user_id) + '">'
      + '<span class="mc-avatar" style="--c:' + esc(m.color || colorFor(m.user_id)) + '">'
      + esc(initialOf(m.nickname)) + '<span class="mc-emoji">' + esc(m.emoji || '🙂') + '</span></span>'
      + '<span class="mc-body">'
      + '<span class="mc-top"><span class="mc-name">' + esc(m.nickname) + '</span>'
      + (isMe ? '<em class="mc-me">나</em>' : '') + '</span>'
      + '<span class="mc-status">' + esc(status) + '</span>'
      + (act ? '<span class="mc-activity mc-activity--' + act.kind + '">' + esc(act.text) + '</span>' : '')
      + '<span class="mc-meta">'
      + '<span class="' + (stale ? 'mc-stale' : '') + '">' + (stale ? '오프라인 · ' : '') + timeAgo(m.updated_at) + '</span>'
      + (batt ? '<span>' + esc(batt) + '</span>' : '')
      + '</span></span></button>';
  }

  function renderList() {
    if (!el.memberList) return;
    const members = sortedMembers();
    const keepScroll = el.memberList.scrollLeft;

    if (!members.length) {
      el.memberList.innerHTML = '<div class="members-empty">아직 아무도 없어요 — 친구를 초대해 보세요</div>';
      return;
    }
    el.memberList.innerHTML = members.map(memberCardHTML).join('');
    el.memberList.scrollLeft = keepScroll;
  }

  function renderAll() {
    renderPins();
    renderList();
    updateChrome();
    syncLiveRoutes();
  }

  function renderTimes() {
    renderList();
    updateChrome();
    refreshModalLive();
  }

  function upsertRow(row) {
    if (!row || !row.user_id) return;
    if (state.me && row.user_id === state.me.user_id) return;   // 내 행은 내 화면 값 우선
    state.members.set(row.user_id, normalizeRow(row));
    renderAll();
  }

  function normalizeRow(r) {
    return {
      user_id: String(r.user_id),
      nickname: String(r.nickname || '이름없음').slice(0, 20),
      emoji: r.emoji || '🙂',
      status_text: r.status_text || '',
      lat: Number(r.lat),
      lng: Number(r.lng),
      accuracy: r.accuracy == null ? null : Number(r.accuracy),
      battery: r.battery == null || r.battery === '' ? null : Number(r.battery),
      charging: !!r.charging,
      speed_kmh: r.speed_kmh == null || r.speed_kmh === '' ? null : Number(r.speed_kmh),
      stay_since: r.stay_since || null,
      color: r.color || colorFor(String(r.user_id)),
      updated_at: r.updated_at || new Date().toISOString(),
    };
  }

  let modalUser = null;

  function modalRow(key, label, value) {
    return '<div class="row" data-row="' + esc(key) + '"><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
  }

  function speedLong(m) {
    if (m.speed_kmh == null || !isFinite(m.speed_kmh)) return '측정 중';
    const k = moveKind(m.speed_kmh);
    if (!k) return '정지 중';
    return k.ico + ' ' + Math.max(1, Math.round(m.speed_kmh)) + 'km/h · ' + k.label;
  }

  function stayLong(m) {
    const since = staySinceOf(m);
    if (!since) return '<span class="muted">이동 중</span>';
    return esc(stayPhrase(since)) + ' <span class="sub">· ' + esc(clockOf(since)) + '부터</span>';
  }

  function batteryLongRow(m, isMe) {
    if (m.battery != null && isFinite(m.battery)) {
      const manual = isMe && state.battMode === 'manual';
      return esc(batteryLong(m)) + (manual ? ' <span class="sub">· 직접 입력</span>' : '');
    }
    if (isMe && !BATT_API) return '<span class="muted">미지원 (iOS 웹)</span>';
    if (isMe && state.battMode === 'off') return '<span class="muted">표시 안 함</span>';
    return '<span class="muted">측정 불가</span>';
  }

  function timelineHTML(segs) {
    if (!segs.length) return '';
    const recent = segs.slice(-5);   // 최근 구간만 (스크롤 없이 한눈에)
    const last = recent.length;
    return recent.map((s, i) => {
      const isLast = i === last - 1;
      if (s.kind === 'stay') {
        return '<li class="tl tl--stay' + (isLast ? ' is-now' : '') + '">'
          + '<span class="tl-dot"></span>'
          + '<span class="tl-body"><b>' + esc(durText(s.ms)) + ' 머무름</b>'
          + '<span>' + esc(clockOf(new Date(s.start).toISOString())) + ' ~ '
          + esc(clockOf(new Date(s.end).toISOString()))
          + (isLast ? ' · 지금' : '') + '</span></span></li>';
      }
      return '<li class="tl tl--move' + (isLast ? ' is-now' : '') + '">'
        + '<span class="tl-dot"></span>'
        + '<span class="tl-body"><b>이동 ' + esc(distText(s.meters)) + '</b>'
        + '<span>' + esc(durText(s.ms)) + ' · '
        + esc(moveKind(s.kmh) ? moveKind(s.kmh).ico + ' ' : '') + esc(Math.max(1, Math.round(s.kmh))) + 'km/h'
        + (isLast ? ' · 지금' : '') + '</span></span></li>';
    }).join('');
  }

  function renderRouteBlock(m) {
    const pts = historyFor(m.user_id);
    const segs = buildSegments(pts);

    if (pts.length < 2) {
      el.mRouteSum.textContent = LIVE
        ? '아직 이동 기록이 없어요 — 위치가 갱신되면 자동으로 쌓여요.'
        : '이동 기록을 준비 중이에요.';
      el.mTimeline.innerHTML = '';
      el.mRouteToggle.disabled = true;
      el.mRouteToggle.classList.remove('is-on');
      return;
    }

    const sum = routeSummary(segs);
    el.mRouteSum.textContent = sum
      ? '최근 ' + durText(sum.spanMs) + ' · 이동 ' + distText(sum.meters) + ' · 머문 곳 ' + sum.stays + '곳'
      : '이동 기록을 정리 중이에요';
    el.mTimeline.innerHTML = timelineHTML(segs);
    el.mRouteToggle.disabled = false;
    el.mRouteToggle.classList.toggle('is-on', state.routeOn);
    el.mRouteToggle.textContent = state.routeOn ? '경로 숨기기' : '경로 보기';
  }

  async function openMember(id, fromPin = false) {
    const m = state.members.get(id);
    if (!m) return;
    const isMe = !!state.me && m.user_id === state.me.user_id;
    modalUser = m.user_id;
    state.selected = id;
    state.routeOn = true;
    renderPins();

    el.mAvatar.textContent = initialOf(m.nickname);
    el.mAvatar.style.setProperty('--c', m.color || colorFor(m.user_id));
    el.mName.textContent = m.nickname + (isMe ? ' (나)' : '');
    el.mStatus.textContent = (m.emoji || '🙂') + ' ' + (m.status_text || '상태 없음');

    renderRows(m, isMe);

    el.mCard.classList.toggle('is-me', isMe);
    el.mEdit.hidden = !isMe;
    el.mSave.hidden = !isMe;
    el.mLocate.hidden = isMe;
    renderBatteryBox(isMe);

    // 내 카드에서는 상태·배터리 편집이 먼저 보이도록 동선 블록을 아래로 내린다
    const actions = el.mCard.querySelector('.modal-actions');
    if (actions) {
      el.mCard.insertBefore(el.mRouteBlock, isMe ? actions : el.mRows);
    }

    if (isMe) {
      state.selectedEmoji = state.me.emoji || '🙂';
      el.mStatusInput.value = state.me.status_text || '';
      el.mEmojis.innerHTML = EMOJIS.map((e) =>
        '<button class="emoji-btn' + ((state.me.emoji || '🙂') === e ? ' is-on' : '') + '" type="button" data-emoji="' + esc(e) + '">' + e + '</button>'
      ).join('');
    }

    el.modal.hidden = false;

    // 이동 기록: 없으면 서버·데모 샘플에서 채운다
    await ensureHistory(m);
    const fresh = state.members.get(id) || m;
    renderRows(fresh, isMe);
    renderRouteBlock(fresh);
    if (state.routeOn) drawRoute(fresh);
    else clearRoute();

    if (fromPin) { /* 핀을 눌렀을 때는 지도를 이미 보고 있음 */ }
  }

  function renderRows(m, isMe) {
    const rows = [];
    rows.push(modalRow('speed', '이동 속도', esc(speedLong(m))));
    rows.push(modalRow('stay', '체류', stayLong(m)));
    rows.push(modalRow('battery', '배터리', batteryLongRow(m, isMe)));
    rows.push(modalRow('updated', '최근 업데이트', esc(timeAgo(m.updated_at) + ' · ' + clockOf(m.updated_at))));
    rows.push(modalRow('acc', '위치 정확도', esc(m.accuracy != null && isFinite(m.accuracy) ? '±' + Math.round(m.accuracy) + 'm' : '—')));
    el.mRows.innerHTML = rows.join('');
  }

  /* 모달이 열려 있는 동안 바뀌는 값(속도·체류·업데이트)만 갱신 */
  function refreshModalLive() {
    if (!modalUser || el.modal.hidden) return;
    const m = state.members.get(modalUser);
    if (!m) return;
    const isMe = !!state.me && m.user_id === state.me.user_id;
    const set = (key, html) => {
      const dd = el.mRows.querySelector('[data-row="' + key + '"] dd');
      if (dd) dd.innerHTML = html;
    };
    set('updated', esc(timeAgo(m.updated_at) + ' · ' + clockOf(m.updated_at)));
    set('speed', esc(speedLong(m)));
    set('stay', stayLong(m));
    set('battery', batteryLongRow(m, isMe));
  }

  function closeModal() {
    el.modal.hidden = true;
    modalUser = null;
    state.selected = null;
    clearRoute();
    renderPins();
  }

  /* 배터리 입력 UI (배터리 API가 막힌 브라우저에서만) */
  function renderBatteryBox(isMe) {
    const show = isMe && !BATT_API;
    el.mBatt.hidden = !show;
    if (!show) return;
    $$('#mBattModes [data-mode]').forEach((b) => {
      b.classList.toggle('is-on', b.getAttribute('data-mode') === state.battMode);
    });
    el.mBattManual.hidden = state.battMode !== 'manual';
    el.mBattRange.value = String(state.battManual.level);
    el.mBattRange.style.setProperty('--p', state.battManual.level + '%');
    el.mBattVal.textContent = state.battManual.level + '%';
    el.mBattCharging.checked = !!state.battManual.charging;
  }

  /* ───────────────────────── 7. 세션 · 방 ───────────────────────── */
  function persistSession() {
    if (!state.me || !state.room) return;
    LS.set(sessionKey(state.room), {
      nickname: state.me.nickname,
      emoji: state.me.emoji,
      status: state.me.status_text,
      lat: state.me.lat,
      lng: state.me.lng,
      accuracy: state.me.accuracy,
      auto: state.auto,
    });
    LS.set('locshare.lastNick', state.me.nickname);
    LS.set('locshare.lastRoom', state.room);
  }

  function persistHistory() {
    if (!state.me || !state.room) return;
    LS.set(historyKey(state.room, state.me.user_id), historyFor(state.me.user_id).slice(-HISTORY_MAX));
  }

  function setUrlRoom(room) {
    try {
      const url = new URL(location.href);
      if (room) url.searchParams.set('room', room);
      else url.searchParams.delete('room');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) { /* file:// 등에서는 무시 */ }
  }

  function shareUrl(room) {
    const url = new URL(location.href);
    url.searchParams.set('room', room || state.room);
    return url.href;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 아래 대체 방법 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  async function copyRoomLink() {
    const url = shareUrl();
    const ok = await copyText(url);
    toast(ok
      ? '방 링크를 복사했어요 — 친구에게 붙여넣기 하세요'
      : '링크: ' + url, ok ? 3000 : 6000);
  }

  async function shareRoom() {
    const url = shareUrl();
    if (navigator.share) {
      try {
        await navigator.share({
          title: '우리끼리 — ' + state.room,
          text: '우리 방 코드는 ' + state.room + ' 이야. 링크로 들어와!',
          url,
        });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    await copyRoomLink();
  }

  async function generateRoomCode() {
    const prefix = String(CFG.ROOM_PREFIX || 'DALKONG').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'ROOM';
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 8; attempt++) {
      let tail = '';
      for (let i = 0; i < 4; i++) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
      const code = prefix + '-' + tail;
      if (state.store && typeof state.store.exists === 'function') {
        const taken = await state.store.exists(code).catch(() => false);
        if (!taken) return code;
      } else {
        return code;
      }
    }
    return prefix + '-' + Math.floor(1000 + Math.random() * 9000);
  }

  function setJoinBusy(busy) {
    el.btnJoin.disabled = busy;
    el.btnJoin.textContent = busy ? '들어가는 중…' : '방 들어가기';
  }

  /* ───────────────────────── 8. 데모용 이동 경로 샘플 ───────────────────────── */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* 끝 지점(endLat,endLng)에서 거꾸로 3개 체류 지점을 만들어 자연스러운 과거 동선을 만든다 */
  function seedDemoPath(endLat, endLng, seed, opts = {}) {
    const rnd = mulberry32((seed >>> 0) || 7);
    const walk = opts.kmhWalk || 4.4;
    const ride = opts.kmhRide || walk;
    const legs = [
      { kind: 'stay', min: 6 + Math.round(rnd() * 12) },
      { kind: 'move', min: 3 + Math.round(rnd() * 2), kmh: walk },
      { kind: 'stay', min: 9 + Math.round(rnd() * 11) },
      { kind: 'move', min: 3 + Math.round(rnd() * 2), kmh: ride },
      { kind: 'stay', min: 8 + Math.round(rnd() * 14) },
      { kind: 'move', min: 4 + Math.round(rnd() * 2), kmh: walk },
    ];

    let t = Date.now();
    let lat = endLat;
    let lng = endLng;
    let heading = rnd() * Math.PI * 2;
    const newestFirst = [];

    for (const leg of legs) {
      const durMs = leg.min * 60 * 1000;
      if (leg.kind === 'stay') {
        const steps = Math.max(3, Math.round(leg.min / 3));
        const from = t - durMs;
        const local = [];
        for (let i = 0; i <= steps; i++) {
          const tt = from + (durMs * i / steps);
          const jitterLat = (rnd() - 0.5) * 0.00035;    // ±15m 정도 흔들림
          const jitterLng = (rnd() - 0.5) * 0.00045;
          local.push({ lat: lat + jitterLat, lng: lng + jitterLng, t: tt, speed: 0 });
        }
        for (let i = local.length - 1; i >= 0; i--) newestFirst.push(local[i]);
        t = from;
      } else {
        const steps = Math.max(4, Math.round(leg.min * 60 / 40));
        const meters = (leg.kmh * 1000 / 3600) * (durMs / 1000);
        const stepMeters = meters / steps;
        let dir = heading;
        let pLat = lat;
        let pLng = lng;
        for (let i = 1; i <= steps; i++) {
          dir += (rnd() - 0.5) * 0.32;             // 길을 따라 조금씩 방향을 튼다
          pLat = pLat - (stepMeters * Math.cos(dir)) / 111320;
          pLng = pLng - (stepMeters * Math.sin(dir)) / (111320 * Math.cos(pLat * Math.PI / 180));
          newestFirst.push({ lat: pLat, lng: pLng, t: t - durMs * (i / steps), speed: leg.kmh });
        }
        lat = pLat;
        lng = pLng;
        t = t - durMs;
        heading += (rnd() - 0.5) * 3.4;
      }
    }

    const points = newestFirst.reverse();
    // 가장 최근 체류 구간의 시작 시각 계산
    let since = null;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].speed && points[i].speed > 0) break;
      since = points[i].t;
    }
    return { points, staySince: since ? new Date(since).toISOString() : null };
  }

  /* ───────────────────────── 9. 저장소: 체험(데모) ───────────────────────── */
  function createDemoStore() {
    const DB_KEY = 'locshare.demo.v2';
    let room = '';
    let rows = new Map();
    let hist = new Map();
    let simTimer = null;
    let onRow = null;

    const readDb = () => LS.get(DB_KEY, {});
    const save = () => {
      const db = readDb();
      db[room] = Array.from(rows.values()).map((r) => Object.assign({}, r));
      LS.set(DB_KEY, db);
    };

    /* 이동 경로는 방·멤버별로 localStorage에 남겨 새로고침해도 이어서 보인다 */
    function loadHist(uid) {
      const raw = LS.get(historyKey(room, uid), null);
      if (!Array.isArray(raw) || raw.length < 2) return [];
      return setHistory(uid, raw);
    }

    function saveHist(uid) {
      const arr = hist.get(uid) || historyFor(uid);
      if (!arr || !arr.length) return;
      LS.set(historyKey(room, uid), arr.slice(-HISTORY_MAX));
    }

    function saveAllHist() {
      DEMO_FRIENDS.forEach((f) => saveHist(f.user_id));
    }

    function friendRow(f) {
      return {
        user_id: f.user_id,
        nickname: f.nickname,
        emoji: f.emoji,
        status_text: f.status,
        lat: f.lat,
        lng: f.lng,
        accuracy: 15,
        battery: f.battery,
        charging: !!f.charging,
        speed_kmh: 0,
        stay_since: null,
        color: f.color,
        updated_at: new Date().toISOString(),
        _heading: f.heading,
        _planIdx: 0,
        _planTick: 0,
      };
    }

    function seedFriend(f, row) {
      const s = seedDemoPath(row.lat, row.lng, f.seed, f.seedOpts);
      setHistory(f.user_id, s.points);
      hist.set(f.user_id, historyFor(f.user_id).slice());
      row.stay_since = s.staySince;
      row.speed_kmh = 0;
      row._stayLat = row.lat;
      row._stayLng = row.lng;
    }

    function stepFriend(f, r, dtSec) {
      const plan = f.plan;
      if (typeof r._planIdx !== 'number') r._planIdx = 0;
      if (typeof r._planTick !== 'number') r._planTick = 0;
      const cur = plan[r._planIdx % plan.length];
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      if (cur.k === 'stay') {
        if (!r.stay_since) {
          r.stay_since = nowIso;
          r._stayLat = r.lat;
          r._stayLng = r.lng;
        }
        r.speed_kmh = 0;
        // 같은 자리에서 살짝만 흔들리게
        const jLat = (Math.random() - 0.5) * 0.00008;
        const jLng = (Math.random() - 0.5) * 0.00010;
        r.lat += jLat;
        r.lng += jLng;
      } else {
        r.stay_since = null;
        r._stayLat = r.lat;
        r._stayLng = r.lng;
        let heading = (typeof r._heading === 'number' ? r._heading : f.heading) + (Math.random() - 0.5) * 0.5;

        // 기본 좌표에서 2km 넘게 벗어나면 돌아오게
        const dy = (BASE.lat - r.lat) * 111320;
        const dx = (BASE.lng - r.lng) * 111320 * Math.cos(BASE.lat * Math.PI / 180);
        if (Math.hypot(dx, dy) > 2000) heading = Math.atan2(dx, dy);

        const kmh = cur.kmh * (0.9 + Math.random() * 0.2);
        const meters = (kmh * 1000 / 3600) * dtSec;
        r.lat += (meters * Math.cos(heading)) / 111320;
        r.lng += (meters * Math.sin(heading)) / (111320 * Math.cos(r.lat * Math.PI / 180));
        r._heading = heading;
        r.speed_kmh = kmh;
      }

      r.updated_at = nowIso;
      r.accuracy = 10 + Math.round(Math.random() * 16);

      if (r.charging) {
        r.battery = Math.min(100, Number(r.battery || 0) + 1);
        if (r.battery >= 92) r.charging = false;
      } else {
        r.battery = Math.max(3, Number(r.battery || 0) - Math.random() * 0.6);
        if (r.battery < 8) r.charging = true;
      }

      if (Math.random() < 0.12 && f.statuses && f.statuses.length) {
        const idx = f.statuses.indexOf(r.status_text);
        r.status_text = f.statuses[(idx + 1) % f.statuses.length];
      }

      const arr = hist.get(f.user_id) || [];
      const last = arr[arr.length - 1];
      const moved = !last || haversine(last, r) > 8 || (nowMs - last.t) > 25 * 1000;
      if (moved) {
        arr.push({ lat: r.lat, lng: r.lng, t: nowMs, speed: r.speed_kmh || 0, since: r.stay_since || null });
        if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
        hist.set(f.user_id, arr);
        state.history.set(f.user_id, arr.slice());
      }

      r._planTick++;
      if (r._planTick >= cur.ticks) { r._planTick = 0; r._planIdx++; }
      rows.set(f.user_id, r);
    }

    function step() {
      const dt = Math.max(5, REFRESH_MS) / 1000;
      for (const f of DEMO_FRIENDS) {
        const r = rows.get(f.user_id);
        if (!r) continue;
        stepFriend(f, r, dt);
        if (typeof onRow === 'function') onRow(Object.assign({}, r));
      }
      save();
      saveAllHist();
    }

    return {
      live: false,

      async connect(roomCode, meRow) {
        room = roomCode;
        rows = new Map();
        hist = new Map();
        const saved = readDb()[room];
        if (Array.isArray(saved)) {
          saved.forEach((r) => { if (r && r.user_id) rows.set(r.user_id, r); });
        }

        DEMO_FRIENDS.forEach((f) => {
          let row = rows.get(f.user_id);
          if (!row || !isFinite(Number(row.lat)) || !isFinite(Number(row.lng))) {
            row = friendRow(f);
            rows.set(f.user_id, row);
          }
          const kept = loadHist(f.user_id);
          if (kept.length) {
            hist.set(f.user_id, kept.slice());
            const lastP = kept[kept.length - 1];
            if (!row.stay_since && lastP.since) row.stay_since = lastP.since;
            if (row._stayLat == null) { row._stayLat = lastP.lat; row._stayLng = lastP.lng; }
            row.lat = lastP.lat;
            row.lng = lastP.lng;
          } else {
            seedFriend(f, row);
          }
          row.updated_at = new Date().toISOString();
          rows.set(f.user_id, row);
        });

        // 내 기록도 마지막 위치에서 이어서 복원
        const mine = loadHist(meRow.user_id);
        if (mine.length) {
          hist.set(meRow.user_id, mine.slice());
          const lastP = mine[mine.length - 1];
          if (!meRow.stay_since && lastP.since) meRow.stay_since = lastP.since;
        }

        rows.set(meRow.user_id, Object.assign({}, meRow));
        save();
        saveAllHist();
      },

      async exists(code) {
        const db = readDb();
        return !!db[code];
      },

      async publish(row) {
        rows.set(row.user_id, Object.assign({}, row));
        save();
      },

      async refresh() {
        return Array.from(rows.values()).map((r) => Object.assign({}, r));
      },

      async history(userId) {
        return (hist.get(userId) || state.history.get(userId) || []).slice();
      },

      async historySince(sinceMs) {
        const out = [];
        hist.forEach((pts, uid) => {
          (pts || []).forEach((p) => {
            if (p.t >= sinceMs) {
              out.push({ user_id: uid, lat: p.lat, lng: p.lng, t: p.t, speed: p.speed, since: p.since || null });
            }
          });
        });
        return out;
      },

      async appendHistory(userId, p) {
        const arr = hist.get(userId) || [];
        arr.push({
          lat: p.lat, lng: p.lng, t: p.t || Date.now(),
          speed: p.speed == null ? null : p.speed,
          since: p.since || null,
        });
        if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
        hist.set(userId, arr);
        state.history.set(userId, arr.slice());
        saveHist(userId);
      },

      subscribe() { /* 데모는 simulate()가 대신한다 */ },

      simulate(cb) {
        onRow = cb;
        if (simTimer) clearInterval(simTimer);
        simTimer = setInterval(step, Math.max(5000, REFRESH_MS));
      },

      async remove(userId) {
        rows.delete(userId);
        hist.delete(userId);
        LS.del(historyKey(room, userId));
        save();
      },

      dispose() {
        if (simTimer) clearInterval(simTimer);
        simTimer = null;
        onRow = null;
      },
    };
  }

  /* ───────────────────────── 10. 저장소: Supabase ───────────────────────── */
  function createLiveStore() {
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
    };
    let room = '';
    let onRow = cbNone;
    let onHist = cbNone;
    let ws = null;
    let hbTimer = null;
    let retryTimer = null;
    let ref = 0;
    let disposed = false;

    function cbNone() {}

    function mapPoint(r) {
      return {
        lat: Number(r.lat),
        lng: Number(r.lng),
        t: new Date(r.recorded_at).getTime(),
        speed: r.speed_kmh == null ? null : Number(r.speed_kmh),
        since: r.stay_since || null,
        accuracy: r.accuracy == null ? null : Number(r.accuracy),
      };
    }

    function mapPoints(rows) {
      return (Array.isArray(rows) ? rows : [])
        .map(mapPoint)
        .filter((p) => isFinite(p.lat) && isFinite(p.lng) && isFinite(p.t));
    }

    async function call(path, opts = {}) {
      const res = await fetch(SUPABASE_URL + path, Object.assign({}, opts, {
        headers: Object.assign({}, headers, opts.headers || {}),
        cache: 'no-store',
      }));
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 220); } catch (e) {}
        throw new Error('Supabase ' + res.status + (detail ? ' · ' + detail : ''));
      }
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    function connectWs() {
      if (disposed || !room) return;
      try {
        const wsUrl = SUPABASE_URL.replace(/^http/i, 'ws')
          + '/realtime/v1/websocket?apikey=' + encodeURIComponent(SUPABASE_KEY) + '&vsn=1.0.0';
        ws = new WebSocket(wsUrl);
      } catch (e) {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        if (!ws) return;
        ws.send(JSON.stringify({
          topic: 'realtime:locshare-' + room,
          event: 'phx_join',
          ref: String(++ref),
          payload: {
            config: {
              broadcast: { self: false },
              presence: { key: 'anon' },
              postgres_changes: [
                { event: '*', schema: 'public', table: 'locations', filter: 'room_code=eq.' + room },
                { event: 'INSERT', schema: 'public', table: 'location_history', filter: 'room_code=eq.' + room },
              ],
            },
          },
        }));
        clearInterval(hbTimer);
        hbTimer = setInterval(() => {
          if (!ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }));
        }, 25000);
      };

      ws.onmessage = (ev) => {
        let parsed;
        try { parsed = JSON.parse(ev.data); } catch (e) { return; }
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of list) {
          if (!msg || msg.event !== 'postgres_changes') continue;
          const data = msg.payload && msg.payload.data;
          const rec = data && (data.record || data.new);
          if (!rec || rec.room_code !== room) continue;
          const table = data && data.table;
          try {
            if (table === 'location_history') {
              if (state.me && rec.user_id === state.me.user_id) continue;
              onHist(rec);
            } else {
              onRow(rec);
            }
          } catch (e) { /* 렌더 오류는 무시 */ }
        }
      };

      ws.onerror = () => { /* onclose에서 재연결 */ };

      ws.onclose = () => {
        clearInterval(hbTimer);
        ws = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (disposed) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connectWs, 6000);
    }

    return {
      live: true,

      async connect(roomCode) {
        room = roomCode;
        await call('/rest/v1/rooms?on_conflict=code', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify([{ code: roomCode }]),
        });
        connectWs();
      },

      async exists(code) {
        const rows = await call('/rest/v1/rooms?code=eq.' + encodeURIComponent(code) + '&select=code');
        return Array.isArray(rows) && rows.length > 0;
      },

      async publish(row) {
        const body = [{
          room_code: room,
          user_id: row.user_id,
          nickname: String(row.nickname || '').slice(0, 20),
          emoji: row.emoji || '🙂',
          status_text: String(row.status_text || '').slice(0, 60),
          lat: row.lat,
          lng: row.lng,
          accuracy: row.accuracy == null ? null : row.accuracy,
          battery: row.battery == null ? null : Math.round(row.battery),
          charging: !!row.charging,
          speed_kmh: row.speed_kmh == null ? null : Number(row.speed_kmh),
          stay_since: row.stay_since || null,
          color: row.color || colorFor(row.user_id),
          updated_at: new Date().toISOString(),
        }];
        await call('/rest/v1/locations?on_conflict=room_code,user_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(body),
        });
      },

      async refresh() {
        const rows = await call('/rest/v1/locations?room_code=eq.' + encodeURIComponent(room) + '&select=*');
        return Array.isArray(rows) ? rows : [];
      },

      async history(userId) {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const rows = await call('/rest/v1/location_history?room_code=eq.' + encodeURIComponent(room)
          + '&user_id=eq.' + encodeURIComponent(userId)
          + '&recorded_at=gte.' + encodeURIComponent(since)
          + '&select=lat,lng,accuracy,speed_kmh,stay_since,recorded_at&order=recorded_at.asc&limit=500');
        return mapPoints(rows);
      },

      /* 방 전체의 최근 기록을 한 번에 (입장 시 경로·타임라인 복원용) */
      async historySince(sinceMs) {
        const rows = await call('/rest/v1/location_history?room_code=eq.' + encodeURIComponent(room)
          + '&recorded_at=gte.' + encodeURIComponent(new Date(sinceMs).toISOString())
          + '&select=user_id,lat,lng,accuracy,speed_kmh,stay_since,recorded_at&order=recorded_at.asc&limit=2000');
        return (Array.isArray(rows) ? rows : []).map((r) => Object.assign({ user_id: String(r.user_id) }, mapPoint(r)));
      },

      async appendHistory(userId, p) {
        await call('/rest/v1/location_history', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify([{
            room_code: room,
            user_id: userId,
            lat: p.lat,
            lng: p.lng,
            accuracy: p.accuracy == null ? null : p.accuracy,
            speed_kmh: p.speed == null ? null : Number(p.speed),
            stay_since: p.since || null,
            recorded_at: new Date(p.t || Date.now()).toISOString(),
          }]),
        });
      },

      subscribe(cb) { onRow = cb; },

      onHistory(cb) { onHist = cb; },

      async remove(userId) {
        await call('/rest/v1/locations?room_code=eq.' + encodeURIComponent(room)
          + '&user_id=eq.' + encodeURIComponent(userId), {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' },
        });
        try {
          await call('/rest/v1/location_history?room_code=eq.' + encodeURIComponent(room)
            + '&user_id=eq.' + encodeURIComponent(userId), {
            method: 'DELETE',
            headers: { Prefer: 'return=minimal' },
          });
        } catch (e) { /* 기록 표가 없으면 무시 */ }
      },

      dispose() {
        disposed = true;
        clearInterval(hbTimer);
        clearTimeout(retryTimer);
        if (ws) {
          try {
            ws.send(JSON.stringify({ topic: 'realtime:locshare-' + room, event: 'phx_leave', payload: {}, ref: String(++ref) }));
            ws.close();
          } catch (e) {}
          ws = null;
        }
      },
    };
  }

  function showStoreError(err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('[우리끼리]', msg);
    if (state.errShown) return;
    state.errShown = true;
    toast(LIVE
      ? '서버 연결에 문제가 있어요 — supabase_schema.sql 실행과 config.js 값을 확인해 주세요'
      : '위치 저장에 문제가 생겼어요: ' + msg, 5200);
  }

  function showHistoryError(err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[우리끼리] 이동 기록', msg);
    if (state.histWarned) return;
    state.histWarned = true;
    toast('이동 기록 표(location_history)가 없어 동선이 비어 있어요 — supabase_schema.sql을 다시 실행해 주세요', 5200);
  }

  /* ───────────────────────── 11. 이동 기록 채우기 ───────────────────────── */
  async function ensureHistory(m) {
    const id = m.user_id;
    const isMe = !!state.me && id === state.me.user_id;
    let pts = historyFor(id);

    // 내 기록은 로컬에 남겨 두고, 없으면 데모용 샘플을 만든다
    if (isMe && !pts.length && !LIVE) {
      const saved = LS.get(historyKey(state.room, id), null);
      if (Array.isArray(saved) && saved.length >= 2) {
        pts = setHistory(id, saved);
      }
      if (!pts.length) {
        const seed = seedDemoPath(m.lat, m.lng, 424242, { kmhWalk: 4.6, kmhRide: 19, spanMin: 132 });
        pts = setHistory(id, seed.points);
        if (!m.stay_since) m.stay_since = seed.staySince;
        persistHistory();
      }
    }

    if (pts.length >= 2) return pts;

    if (state.store && typeof state.store.history === 'function') {
      try {
        const remote = await state.store.history(id);
        if (remote && remote.length) pts = setHistory(id, remote);
      } catch (e) {
        if (LIVE) showHistoryError(e);
      }
    }

    if (!pts.length && !LIVE && !isMe) {
      const pts2 = seedDemoPath(m.lat, m.lng, (id.length * 977 + 31) >>> 0, {});
      pts = setHistory(id, pts2.points);
    }
    return pts;
  }

  /* ───────────────────────── 12. 지난 이동 기록 복원 ───────────────────────── */
  /* 방 전체의 지난 이동 기록을 불러와 경로·타임라인을 이어 붙인다 */
  async function loadRoomHistory() {
    if (!state.store || typeof state.store.historySince !== 'function') return;
    let rows = [];
    try {
      rows = await state.store.historySince(Date.now() - 24 * 3600 * 1000);
    } catch (e) {
      if (LIVE) showHistoryError(e);
      return;
    }
    if (!Array.isArray(rows) || !rows.length) return;

    const byUser = new Map();
    rows.forEach((r) => {
      if (!r || !r.user_id) return;
      const arr = byUser.get(r.user_id) || [];
      arr.push(r);
      byUser.set(r.user_id, arr);
    });

    byUser.forEach((pts, id) => {
      if (historyFor(id).length >= pts.length) return;
      setHistory(id, pts);
      const m = state.members.get(id);
      if (m && !m.stay_since && pts.length) {
        const lastP = pts[pts.length - 1];
        if (lastP.since) m.stay_since = lastP.since;
      }
    });
    renderAll();
  }

  /* ───────────────────────── 13. 위치 ───────────────────────── */
  function applyBattery() {
    if (state.battMode === 'manual') {
      state.battery = Math.max(0, Math.min(100, Math.round(state.battManual.level)));
      state.charging = !!state.battManual.charging;
    } else if (state.battMode === 'off') {
      state.battery = null;
      state.charging = false;
    }
    if (state.me) {
      state.me.battery = state.battery;
      state.me.charging = state.charging;
    }
  }

  async function readBattery() {
    if (!BATT_API) {
      state.battMode = LS.get('locshare.battMode', 'off') === 'manual' ? 'manual' : 'off';
      const saved = LS.get('locshare.battManual', null);
      if (saved && isFinite(saved.level)) state.battManual = { level: saved.level, charging: !!saved.charging };
      applyBattery();
      return;
    }
    try {
      const b = await navigator.getBattery();
      const apply = () => {
        state.battery = Math.round(b.level * 100);
        state.charging = !!b.charging;
        if (state.me) {
          state.me.battery = state.battery;
          state.me.charging = state.charging;
          renderList();
        }
      };
      apply();
      b.addEventListener('levelchange', apply);
      b.addEventListener('chargingchange', apply);
    } catch (e) { /* 지원하지 않는 브라우저 */ }
  }

  function computeSpeed(c, prev, now) {
    let speed = null;
    if (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0) speed = c.speed * 3.6;

    if (prev) {
      const dt = (now - prev.t) / 1000;
      const d = haversine(prev, { lat: c.latitude, lng: c.longitude });
      if (dt >= 1.5 && d >= 4) {
        const calc = (d / dt) * 3.6;
        if (calc > 200) return null;                  // 순간이동급 좌표는 버린다
        speed = (speed != null && Math.abs(calc - speed) <= 3) ? (speed * 0.5 + calc * 0.5) : calc;
      } else if (dt <= 90 && d < 8) {
        speed = 0;                                    // 제자리 GPS 흔들림은 정지로
      }
    }
    if (speed == null) return null;
    speed = Math.max(0, Math.min(160, speed));
    return speed < 1.5 ? 0 : speed;
  }

  function touchStay(m, lat, lng, speed) {
    if (speed != null && speed >= MOVE_KMH) {
      m.stay_since = null;
      m._stayLat = lat;
      m._stayLng = lng;
      return;
    }
    if (m._stayLat == null || m.stay_since == null) {
      m.stay_since = new Date().toISOString();
      m._stayLat = lat;
      m._stayLng = lng;
      return;
    }
    if (haversine({ lat: m._stayLat, lng: m._stayLng }, { lat, lng }) > STAY_RADIUS_M) {
      m.stay_since = new Date().toISOString();
      m._stayLat = lat;
      m._stayLng = lng;
    }
  }

  function onPosition(pos) {
    if (!state.me) return;
    const c = pos.coords;
    const now = Date.now();
    const lat = c.latitude;
    const lng = c.longitude;
    const me = state.me;
    const prevFix = state.lastFix;

    const raw = computeSpeed(c, prevFix, now);
    if (raw != null) {
      if (raw === 0) me.speed_kmh = 0;      // 제자리(±8m)면 바로 정지로 본다
      else me.speed_kmh = (me.speed_kmh == null) ? raw : (me.speed_kmh * 0.35 + raw * 0.65);
      if (me.speed_kmh < 1.5) me.speed_kmh = 0;
    }

    me.lat = lat;
    me.lng = lng;
    me.accuracy = c.accuracy == null ? null : c.accuracy;
    me.updated_at = new Date().toISOString();
    touchStay(me, lat, lng, me.speed_kmh);
    state.lastFix = { lat, lng, t: now };

    const first = !state.gotFix;
    // 실제 GPS가 처음 잡혔을 때 데모용 샘플 경로와 너무 멀면 샘플을 버린다
    if (first && !LIVE) {
      const arr = historyFor(me.user_id);
      const lastP = arr[arr.length - 1];
      if (lastP && haversine(lastP, { lat, lng }) > 400) {
        state.history.set(me.user_id, []);
        persistHistory();
      }
    }
    state.gotFix = true;
    state.geoDenied = false;
    el.permHint.hidden = true;

    state.members.set(me.user_id, me);

    const added = addHistoryPoint(me.user_id, { lat, lng, t: now, speed: me.speed_kmh, since: me.stay_since });
    if (added) {
      persistHistory();
      if (LIVE) pushHistoryPoint();   // 서버 기록에도 차곡차곡 (45초 간격으로 제한)
    }

    renderAll();
    if (first) {
      fitToMembers(false);
      toast('내 위치를 찾았어요', 1600);
    }

    if (now - state.lastPublish > REFRESH_MS * 0.8 && added) publishMe(false);
    else persistSession();
  }

  function onGeoError(err, silent) {
    const denied = err && (err.code === 1 || /denied|PERMISSION/i.test(err.message || ''));
    if (denied) state.geoDenied = true;

    if (!state.me) return;
    if (!state.gotFix) {
      state.me.updated_at = new Date().toISOString();
      state.members.set(state.me.user_id, state.me);
      renderAll();
    }
    if (!silent) {
      if (state.geoDenied) {
        el.permText.textContent = '위치 권한이 거부됐어요 — 브라우저 설정에서 허용해 주세요. 지금은 서울 도심 기준 위치로 표시 중이에요.';
        el.btnPermAsk.hidden = true;
        el.permHint.hidden = false;
        return;
      }
      el.permText.textContent = '위치를 확인하지 못했어요 — 잠시 서울 도심 기준 위치로 표시할게요.';
      el.btnPermAsk.hidden = false;
      el.permHint.hidden = false;
      toast('위치를 확인하지 못해 서울 도심 기준 위치로 표시 중이에요', 3400);
    }
  }

  function askLocation(opts = {}) {
    if (!navigator.geolocation) {
      if (!opts.silent) toast('이 브라우저는 위치 기능을 지원하지 않아요', 3000);
      return;
    }
    try {
      navigator.geolocation.getCurrentPosition(
        onPosition,
        (err) => onGeoError(err, !!opts.silent),
        { enableHighAccuracy: true, timeout: 9000, maximumAge: 3000 }
      );
    } catch (e) {
      onGeoError(e, !!opts.silent);
    }
  }

  function startWatch() {
    stopWatch();
    if (!navigator.geolocation) return;
    try {
      state.watchId = navigator.geolocation.watchPosition(
        onPosition,
        (err) => onGeoError(err, true),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
      );
    } catch (e) { state.watchId = null; }
  }

  function stopWatch() {
    if (state.watchId != null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (e) {}
    }
    state.watchId = null;
  }

  /* ───────────────────────── 14. 발행 · 토글 ───────────────────────── */
  async function publishMe(showFeedback) {
    if (!state.me || !state.store || !state.joined) return;
    applyBattery();
    state.me.updated_at = new Date().toISOString();
    state.members.set(state.me.user_id, state.me);
    state.lastPublish = Date.now();

    persistSession();
    renderAll();

    try {
      await state.store.publish(state.me);
      if (showFeedback) toast('위치를 업데이트했어요', 1800);
    } catch (e) {
      showStoreError(e);
    }
  }

  async function pushHistoryPoint() {
    if (!state.me || !state.store || !state.joined) return;
    if (typeof state.store.appendHistory !== 'function') return;
    const arr = historyFor(state.me.user_id);
    const last = arr[arr.length - 1];
    if (!last) return;
    if (Date.now() - state.lastHistAt < 45 * 1000) return;
    state.lastHistAt = Date.now();
    try {
      await state.store.appendHistory(state.me.user_id, last);
    } catch (e) {
      if (LIVE) showHistoryError(e);
    }
  }

  async function manualUpdate() {
    if (!state.me) return;
    el.btnUpdate.classList.add('is-busy');
    const prev = el.btnUpdate.querySelector('.btn-update-sub');
    if (prev) prev.textContent = '확인 중…';

    const done = () => {
      el.btnUpdate.classList.remove('is-busy');
      renderAll();
    };

    if (!navigator.geolocation) {
      await publishMe(true);
      done();
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        onPosition(pos);
        await publishMe(false);
        await pushHistoryPoint();
        const sp = state.me.speed_kmh;
        toast('내 위치를 업데이트했어요'
          + (sp != null && sp >= MOVE_KMH ? ' · ' + Math.round(sp) + 'km/h' : '')
          + (pos.coords.accuracy ? ' · 정확도 ±' + Math.round(pos.coords.accuracy) + 'm' : ''), 2200);
        done();
      },
      async (err) => {
        onGeoError(err, false);
        await publishMe(false);
        done();
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  async function setAuto(on) {
    state.auto = !!on;
    persistSession();
    updateChrome();
    if (state.auto) {
      startWatch();
      toast('자동 갱신 ON · ' + Math.round(REFRESH_MS / 1000) + '초마다 위치를 보내요', 2200);
      askLocation({ silent: true });
    } else {
      stopWatch();
      toast('자동 갱신 OFF · 버튼을 눌러야 위치가 갱신돼요', 2600);
    }
  }

  async function saveMyStatus() {
    if (!state.me) return;
    const text = el.mStatusInput.value.trim().slice(0, 24);
    state.me.emoji = state.selectedEmoji || state.me.emoji || '🙂';
    state.me.status_text = text;
    await publishMe(false);
    closeModal();
    toast('상태를 저장했어요', 1600);
  }

  async function setBatteryMode(mode) {
    if (!state.me) return;
    state.battMode = mode;
    LS.set('locshare.battMode', mode);
    applyBattery();
    renderBatteryBox(true);
    renderRows(state.me, true);
    await publishMe(false);
    toast(mode === 'manual' ? '배터리를 직접 입력해서 표시할게요' : '배터리를 표시하지 않을게요', 2000);
  }

  function saveBatteryManual() {
    state.battManual = { level: Number(el.mBattRange.value), charging: !!el.mBattCharging.checked };
    LS.set('locshare.battManual', state.battManual);
    applyBattery();
    if (state.me) {
      renderRows(state.me, true);
      publishMe(false);
    }
    toast('배터리 ' + state.battManual.level + '%' + (state.battManual.charging ? ' · 충전 중' : '') + '으로 표시할게요', 2000);
  }

  /* ───────────────────────── 15. 방 입장 · 퇴장 ───────────────────────── */
  async function enterRoom(roomCode, nickname) {
    const room = normalizeRoom(roomCode);
    const nick = String(nickname || '').trim().slice(0, 12);
    if (!room || !nick || state.joining) return;

    state.joining = true;
    setJoinBusy(true);

    try {
      const saved = LS.get(sessionKey(room), {}) || {};
      const uid = getUid();

      state.room = room;
      state.auto = saved.auto !== false;
      state.errShown = false;
      state.histWarned = false;
      state.gotFix = false;
      state.lastFix = null;
      state.lastHistAt = 0;
      state.history = new Map();

      state.me = {
        user_id: uid,
        nickname: nick,
        emoji: saved.emoji || '🙂',
        status_text: saved.status || '',
        lat: isFinite(saved.lat) ? saved.lat : BASE.lat + 0.0008,
        lng: isFinite(saved.lng) ? saved.lng : BASE.lng - 0.0006,
        accuracy: saved.accuracy == null ? null : saved.accuracy,
        battery: null,
        charging: false,
        speed_kmh: null,
        stay_since: null,
        color: colorFor(uid),
        updated_at: new Date().toISOString(),
      };
      applyBattery();

      state.store = LIVE ? createLiveStore() : createDemoStore();
      await state.store.connect(room, state.me);

      state.members = new Map();
      state.members.set(state.me.user_id, state.me);
      await state.store.publish(state.me);
      state.lastPublish = Date.now();

      const rows = await state.store.refresh();
      rows.forEach((r) => {
        if (!r || r.user_id === state.me.user_id) return;
        state.members.set(r.user_id, normalizeRow(r));
      });

      // 방에 이미 있는 색과 겹치지 않게 내 색을 고른다
      const used = new Set(Array.from(state.members.values())
        .filter((m) => m.user_id !== state.me.user_id)
        .map((m) => String(m.color || '').toLowerCase()));
      if (used.has(String(state.me.color).toLowerCase())) {
        const free = PALETTE.find((c) => !used.has(c.toLowerCase()));
        if (free) {
          state.me.color = free;
          state.members.set(state.me.user_id, state.me);
          await state.store.publish(state.me);
        }
      }

      // 화면 전환
      el.join.hidden = true;
      el.app.hidden = false;
      initMap();
      if (state.map) state.map.invalidateSize();
      state.joined = true;
      renderAll();
      fitToMembers(false);
      setUrlRoom(room);

      // 실시간 구독 · 데모 친구들
      state.store.subscribe((row) => upsertRow(row));
      if (typeof state.store.onHistory === 'function') {
        state.store.onHistory((rec) => {
          if (!rec || !rec.user_id) return;
          const t = rec.recorded_at ? new Date(rec.recorded_at).getTime() : Date.now();
          const added = addHistoryPoint(rec.user_id, {
            lat: Number(rec.lat), lng: Number(rec.lng), t,
            speed: rec.speed_kmh, since: rec.stay_since || null,
          });
          if (!added) return;
          renderAll();                       // 지도 위 경로도 즉시 이어서 그린다
          const m = state.members.get(rec.user_id);
          if (m && modalUser === rec.user_id) {
            if (state.routeOn) renderRouteBlock(m);
            renderRows(m, false);
          }
        });
      }
      if (typeof state.store.simulate === 'function') {
        state.store.simulate((row) => upsertRow(row));
      }

      await loadRoomHistory();

      // 데모에서는 내 캐릭터에도 현실적인 지난 동선 샘플을 깔아 둔다
      if (!LIVE && historyFor(state.me.user_id).length < 2) {
        const seed = seedDemoPath(state.me.lat, state.me.lng, 424242, { kmhWalk: 4.6, kmhRide: 19, spanMin: 132 });
        setHistory(state.me.user_id, seed.points);
        if (!state.me.stay_since) state.me.stay_since = seed.staySince;
        persistHistory();
      }

      renderAll();

      persistSession();
      readBattery();
      if (state.auto) startWatch();
      startTimers();

      setTimeout(() => askLocation({ silent: false }), 350);
    } catch (e) {
      console.error('[우리끼리] 입장 실패', e);
      toast(LIVE
        ? '방에 들어가지 못했어요. Supabase URL·키와 supabase_schema.sql 실행을 확인해 주세요. (' + (e.message || e) + ')'
        : '방에 들어가지 못했어요: ' + (e.message || e), 6000);
      try { if (state.store) state.store.dispose(); } catch (err) {}
      state.store = null;
      state.joining = false;
      setJoinBusy(false);
      return;
    }

    state.joining = false;
    setJoinBusy(false);
  }

  function startTimers() {
    stopTimers();
    state.tickTimer = setInterval(tick, REFRESH_MS);
  }

  function stopTimers() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = null;
  }

  async function tick() {
    if (!state.joined) return;
    if (state.auto) {
      if (state.watchId == null) askLocation({ silent: true });
      else if (Date.now() - state.lastPublish > REFRESH_MS * 0.9) publishMe(false);
    }
    if (state.store && state.store.live) {
      try {
        const rows = await state.store.refresh();
        rows.forEach((r) => {
          if (!r || !r.user_id || r.user_id === state.me.user_id) return;
          state.members.set(r.user_id, normalizeRow(r));
        });
        const ids = new Set(rows.map((r) => r.user_id));
        Array.from(state.members.keys()).forEach((id) => {
          if (id !== state.me.user_id && !ids.has(id)) state.members.delete(id);
        });
        renderAll();
      } catch (e) {
        showStoreError(e);
      }
    }
    renderTimes();
    if (modalUser && !el.modal.hidden && state.routeOn && state.routeFor === modalUser) {
      drawRoute(state.members.get(modalUser), { fit: false });
    }
  }

  async function leaveRoom() {
    if (!state.joined) return;
    const myId = state.me ? state.me.user_id : null;
    stopTimers();
    stopWatch();

    try {
      if (state.store && myId) await state.store.remove(myId);
    } catch (e) { console.warn('[우리끼리] 나가기 정리 실패', e); }
    try { if (state.store) state.store.dispose(); } catch (e) {}

    state.store = null;
    state.joined = false;
    state.members = new Map();
    state.selected = null;
    state.history = new Map();
    modalUser = null;

    if (state.map) {
      try { state.map.remove(); } catch (e) {}
      state.map = null;
      state.routeGroup = null;
    }
    state.markers.clear();
    state.markerSig.clear();

    el.modal.hidden = true;
    el.app.hidden = true;
    el.join.hidden = false;
    el.permHint.hidden = true;

    el.inputRoom.value = '';
    el.inputNick.value = state.me ? state.me.nickname : el.inputNick.value;
    el.joinHint.textContent = '새 방을 만들면 친구에게 보낼 링크가 바로 생겨요.';
    setUrlRoom('');
    el.toast.classList.remove('is-visible');
    state.room = '';
    state.me = null;
    setTimeout(() => el.inputRoom.focus(), 120);
  }

  /* ───────────────────────── 16. 이벤트 ───────────────────────── */
  function bindEvents() {
    el.joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const room = normalizeRoom(el.inputRoom.value);
      const nick = el.inputNick.value.trim();
      if (!nick) { toast('닉네임을 입력해 주세요', 2000); el.inputNick.focus(); return; }
      if (!room) { toast('방 코드를 입력하거나 새로 만들어 주세요', 2400); el.inputRoom.focus(); return; }
      enterRoom(room, nick);
    });

    el.inputRoom.addEventListener('input', () => {
      const pos = el.inputRoom.selectionStart;
      el.inputRoom.value = normalizeRoom(el.inputRoom.value);
      try { el.inputRoom.setSelectionRange(pos, pos); } catch (e) {}
    });

    el.btnCreate.addEventListener('click', async () => {
      const nick = el.inputNick.value.trim();
      el.btnCreate.disabled = true;
      const code = await generateRoomCode();
      el.btnCreate.disabled = false;
      el.inputRoom.value = code;
      if (nick) {
        enterRoom(code, nick);
      } else {
        toast('방 코드 ' + code + ' 를 만들었어요 — 닉네임을 입력해 주세요', 3600);
        el.inputNick.focus();
      }
    });

    el.roomChip.addEventListener('click', async () => {
      const ok = await copyText(state.room);
      toast(ok ? '방 코드 ' + state.room + ' 를 복사했어요' : '방 코드: ' + state.room, 2200);
    });
    el.btnShare.addEventListener('click', shareRoom);
    el.btnInvite.addEventListener('click', shareRoom);
    el.btnCopy.addEventListener('click', copyRoomLink);
    el.btnLeave.addEventListener('click', leaveRoom);

    el.btnUpdate.addEventListener('click', manualUpdate);
    el.btnAuto.addEventListener('click', () => setAuto(!state.auto));

    el.btnLocate.addEventListener('click', () => {
      if (!state.me) return;
      centerOn(state.me);
      askLocation({ silent: true });
    });

    el.btnCollapse.addEventListener('click', () => {
      el.sheet.classList.toggle('is-collapsed');
      setTimeout(updateSheetHeight, 240);
    });

    el.memberList.addEventListener('click', (e) => {
      const card = e.target.closest('[data-id]');
      if (!card) return;
      const id = card.getAttribute('data-id');
      const m = state.members.get(id);
      if (!m) return;
      openMember(id, false);
    });

    el.mClose.addEventListener('click', closeModal);
    el.modal.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.modal.hidden) closeModal();
    });

    el.mEmojis.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      state.selectedEmoji = btn.getAttribute('data-emoji');
      $$('.emoji-btn', el.mEmojis).forEach((b) => b.classList.toggle('is-on', b === btn));
    });

    el.mSave.addEventListener('click', saveMyStatus);
    el.mLocate.addEventListener('click', () => {
      const m = state.members.get(modalUser || state.selected);
      closeModal();
      if (m) centerOn(m);
    });

    el.mRouteToggle.addEventListener('click', () => {
      const m = state.members.get(modalUser);
      if (!m) return;
      state.routeOn = !state.routeOn;
      renderRouteBlock(m);
      if (state.routeOn) drawRoute(m);
      else clearRoute();
    });

    el.mBattModes.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      setBatteryMode(btn.getAttribute('data-mode'));
    });
    el.mBattRange.addEventListener('input', () => {
      el.mBattVal.textContent = el.mBattRange.value + '%';
      el.mBattRange.style.setProperty('--p', el.mBattRange.value + '%');
    });
    el.mBattRange.addEventListener('change', saveBatteryManual);
    el.mBattCharging.addEventListener('change', saveBatteryManual);

    el.btnPermAsk.addEventListener('click', () => askLocation({ silent: false }));
    el.btnPermClose.addEventListener('click', () => { el.permHint.hidden = true; });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.joined) return;
      if (state.map) state.map.invalidateSize();
      renderTimes();
      if (state.auto) askLocation({ silent: true });
    });

    window.addEventListener('online', () => { if (state.joined) renderTimes(); });

    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => updateSheetHeight());
      ro.observe(el.sheet);
    }
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      updateSheetHeight();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state.joined || !state.map) return;
        state.map.invalidateSize();
        if (el.modal.hidden) fitToMembers(false);
        else if (state.routeFor && state.routeOn) drawRoute(state.members.get(state.routeFor));
      }, 260);
    });
  }

  /* ───────────────────────── 17. 시작 ───────────────────────── */
  function init() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      setTimeout(() => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      }, 1500);
    }

    el.modeNote.hidden = LIVE;

    bindEvents();
    updateSheetHeight();
    readBattery();

    let roomParam = '';
    try { roomParam = normalizeRoom(new URLSearchParams(location.search).get('room') || ''); } catch (e) {}

    const lastNick = LS.get('locshare.lastNick', '');

    if (roomParam) {
      el.inputRoom.value = roomParam;
      const saved = LS.get(sessionKey(roomParam), {});
      if (saved && saved.nickname) {
        el.inputNick.value = saved.nickname;
        toast('초대 링크로 입장 중…', 1400);
        enterRoom(roomParam, saved.nickname);
        return;
      }
      el.joinHint.textContent = '초대 링크로 들어왔어요 — 닉네임만 입력하면 바로 입장돼요.';
      if (lastNick) el.inputNick.value = lastNick;
      setTimeout(() => el.inputNick.focus(), 250);
      return;
    }

    if (lastNick) el.inputNick.value = lastNick;
    setTimeout(() => {
      const target = lastNick ? el.inputRoom : el.inputNick;
      if (target) target.focus();
    }, 250);
  }

  window.__LS__ = {
    state,
    cfg: CFG,
    live: LIVE,
    demo: !LIVE,
    battApi: BATT_API,
    fit: () => fitToMembers(false),
    openMember,
    history: (id) => historyFor(id).slice(),
    segments: (id) => buildSegments(historyFor(id)),
    dump: () => ({
      room: state.room,
      me: state.me,
      members: Array.from(state.members.values()).map((m) => Object.assign({}, m)),
    }),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
