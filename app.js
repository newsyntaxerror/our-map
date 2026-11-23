/* =========================================================
   우리끼리 — 친구끼리만 위치·채팅 (v4)
   · 닉네임만으로 시작 → 고유 친구 코드 발급 → 서로 친구 맺기
   · 위치·동선·배터리·채팅은 '서로 친구(accepted)' 사이에만
   · Supabase RPC(서버 함수) + Realtime broadcast 신호
   ========================================================= */
(() => {
  'use strict';

  /* ───────────────────────── 0. 설정 ───────────────────────── */
  const CFG = Object.assign({
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    REFRESH_SECONDS: 10,
  }, window.APP_CONFIG || {});

  const SUPABASE_URL = String(CFG.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const SUPABASE_KEY = String(CFG.SUPABASE_ANON_KEY || '').trim();
  const READY = /^https?:\/\//i.test(SUPABASE_URL) && SUPABASE_KEY.length > 20;

  const BASE = { lat: 37.5665, lng: 126.9780 };            // 서울시청 — 위치를 못 받을 때 기본 좌표
  const REFRESH_MS = Math.max(5, Number(CFG.REFRESH_SECONDS) || 10) * 1000;
  const STALE_MS = 10 * 60 * 1000;                          // 10분 넘게 갱신 없으면 '오프라인'
  const PALETTE = ['#0fb9a3', '#f59e0b', '#6366f1', '#ec4899', '#8b5cf6', '#0ea5e9', '#ef4444', '#14b8a6'];
  const EMOJIS = ['🙂', '🙌', '🏃', '🚇', '💼', '🏠', '🍜', '😴'];

  /* 배터리 API는 안드로이드 크롬 등에서만 열려 있어요(iOS 사파리는 막혀 있음). */
  const BATT_API = typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function';

  /* 체류·속도 규칙 */
  const STAY_RADIUS_M = 75;             // 같은 장소로 보는 반경
  const STAY_MIN_MS = 3 * 60 * 1000;    // 이 시간 이상 머물면 '체류'로 기록
  const MOVE_KMH = 2;                   // 이 속도 이상이면 '이동 중'
  const HISTORY_MAX = 240;
  const HISTORY_MAX_MS = 6 * 60 * 60 * 1000;

  const ME_KEY = 'urikkiri.me.v1';
  const histKey = (uid) => 'urikkiri.hist.' + uid;

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
    if (!iso) return '—';
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

  function dayLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    const y = new Date();
    y.setDate(today.getDate() - 1);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, today)) return '오늘';
    if (same(d, y)) return '어제';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }

  function msgTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
      const h = d.getHours();
      const ap = h < 12 ? '오전' : '오후';
      const hh = h % 12 === 0 ? 12 : h % 12;
      return ap + ' ' + hh + ':' + pad2(d.getMinutes());
    }
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + clockOf(iso);
  }

  function colorFor(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function initialOf(name) {
    const s = String(name || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    try { crypto.getRandomValues(arr); } catch (e) {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function newIdentity() {
    const uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'u-' + Date.now().toString(36) + '-' + randomHex(8);
    return { user_id: uid, secret: randomHex(24) };
  }

  function normalizeCode(v) {
    return String(v == null ? '' : v)
      .trim()
      .replace(/\s+/g, '')
      .replace(/[^0-9A-Za-z-]/g, '')
      .toUpperCase()
      .slice(0, 12);
  }

  function isStale(m) {
    if (!m) return true;
    if (!m.updated_at) return true;
    return Date.now() - new Date(m.updated_at).getTime() > STALE_MS;
  }

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
    if (!m || m.battery == null || isNaN(m.battery)) return '';
    const level = Math.round(m.battery);
    return (m.charging ? '⚡' : '🔋') + ' ' + level + '%';
  }

  function batteryLong(m) {
    if (!m || m.battery == null || isNaN(m.battery)) return '';
    const level = Math.round(m.battery);
    return (m.charging ? '⚡ 충전 중 · ' : '🔋 ') + level + '%';
  }

  /* ── 체류 시간 ── */
  function staySinceOf(m) {
    if (!m) return null;
    if (m.stay_since) return m.stay_since;
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

  function stayPhrase(since) {
    const mins = stayMins(since);
    if (!since) return '';
    if (mins < 60) return Math.max(1, mins) + '분째 머무르는 중';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + '시간' + (m ? ' ' + m + '분' : '') + ' 체류';
  }

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
    if (!m || m.speed_kmh == null || !isFinite(m.speed_kmh)) return '';
    const k = moveKind(m.speed_kmh);
    if (!k) return '';
    return k.ico + ' ' + Math.max(1, Math.round(m.speed_kmh)) + 'km/h';
  }

  function activityText(m) {
    const sp = speedText(m);
    if (sp) return { kind: 'move', text: sp };
    const since = staySinceOf(m);
    if (since) return { kind: 'stay', text: '⏱ ' + stayChip(since) };
    return null;
  }

  /* ───────────────────────── 2. 화면 요소 ───────────────────────── */
  const el = {};
  [
    'joinScreen', 'joinForm', 'inputNick', 'btnStart', 'inviteNote', 'inviteCodeLabel',
    'app', 'map', 'meChip', 'meChipPin', 'myCode', 'myName', 'btnAddFriend', 'btnShare',
    'sheet', 'btnCollapse', 'tabs', 'tabFriends', 'tabChat', 'friendCount', 'chatBadge',
    'btnLocate', 'btnAddFriend2', 'reqBox', 'reqCount', 'reqList',
    'panelFriends', 'panelChat', 'memberList', 'btnUpdate', 'updateSub', 'btnAuto', 'btnCopy',
    'convoList', 'toast',
    'memberModal', 'mCard', 'mAvatar', 'mName', 'mStatus', 'mRows', 'mEdit', 'mNickInput',
    'mEmojis', 'mStatusInput', 'mCopyCode', 'mClose', 'mChat', 'mSave', 'mLocate', 'mRemove',
    'mRouteBlock', 'mRouteSum', 'mRouteHint', 'mRouteOpen',
    'routeView', 'rvBack', 'rvClose', 'rvWho', 'rvMeta', 'rvTlToggle', 'rvTlLabel',
    'rvTimeline', 'rvTlCount', 'rvTlHide', 'rvTlList',
    'mBatt', 'mBattModes', 'mBattManual', 'mBattRange', 'mBattVal', 'mBattCharging',
    'addModal', 'addForm', 'inputCode', 'btnSendReq', 'myCodeBig', 'btnCopyCode', 'btnCopyLink',
    'outgoingBox', 'outgoingList', 'addClose',
    'chatPanel', 'btnChatBack', 'chatAvatar', 'chatName', 'chatSub', 'btnChatLocate',
    'chatBody', 'chatForm', 'chatInput', 'btnChatSend', 'permHint', 'btnPermAsk', 'btnPermClose',
  ].forEach((id) => { el[id] = document.getElementById(id); });
  el.permText = el.permHint ? el.permHint.querySelector('span') : null;

  /* ───────────────────────── 3. 상태 ───────────────────────── */
  const state = {
    me: null,                 // 내 프로필 + 내 위치
    friends: new Map(),       // user_id → 친구(프로필+위치+안읽음)
    incoming: [],             // 받은 친구 요청
    outgoing: [],             // 보낸 친구 요청
    messages: new Map(),      // friend_id → 메시지 배열
    memberSortAt: new Map(),  // 정렬용
    map: null,
    markers: new Map(),
    markerSig: new Map(),
    routeGroup: null,
    routeFor: null,
    routeView: null,       // 상세 동선을 보고 있는 사용자 user_id
    routeModel: null,      // 현재 그린 동선 모델(핀·타임라인)
    routeSig: '',          // 다시 그릴 필요가 있는지 비교용
    routeTlOpen: false,    // 상세 타임라인 열림 여부
    liveRoutes: new Map(),
    history: new Map(),
    joined: false,
    joining: false,
    auto: true,
    tab: 'friends',
    selected: null,
    chatWith: null,
    watchId: null,
    tickTimer: null,
    lastPublish: 0,
    lastHistAt: 0,
    battery: null,
    charging: false,
    battMode: BATT_API ? 'auto' : 'off',
    battManual: { level: 80, charging: false },
    lastFix: null,
    gotFix: false,
    geoDenied: false,
    geoFallback: false,    // 정밀 위치 실패 → 네트워크 위치로 받은 상태
    toastTimer: null,
    selectedEmoji: null,
    feedReq: null,
    feedQueued: false,
    errShown: false,
    addAfterStart: '',
    lastMsgAt: {},
    readSending: {},
  };

  function selfArgs() {
    return { p_user: state.me.user_id, p_secret: state.me.secret };
  }

  function personById(id) {
    if (!id || !state.me) return null;
    if (id === state.me.user_id) return state.me;
    return state.friends.get(id) || null;
  }

  function allPeople() {
    const arr = [];
    if (state.me) arr.push(state.me);
    for (const f of state.friends.values()) arr.push(f);
    return arr;
  }

  function totalUnread() {
    let n = 0;
    for (const f of state.friends.values()) n += Number(f.unread || 0);
    return n;
  }

  /* ───────────────────────── 4. 서버(RPC) ───────────────────────── */
  const API = {
    async rpc(fn, args) {
      if (!READY) throw new Error('서버 설정이 비어 있어요');
      const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args || {}),
        cache: 'no-store',
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 240); } catch (e) {}
        const err = new Error('server ' + res.status + (detail ? ' · ' + detail : ''));
        err.status = res.status;
        err.detail = detail;
        throw err;
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
  };

  function errText(e) {
    const raw = String((e && (e.detail || e.message)) || e || '');
    if (/not_friends/.test(raw)) return '서로 친구가 아니에요';
    if (/unauthorized/.test(raw)) return '내 정보를 다시 확인해야 해요';
    if (/empty_message/.test(raw)) return '보낼 내용을 입력해 주세요';
    if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) return '인터넷 연결을 확인해 주세요';
    return raw.length > 90 ? raw.slice(0, 90) + '…' : raw;
  }

  /* ───────────────────────── 5. 토스트 · 공통 UI ───────────────────────── */
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

  function inviteLink() {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('add', state.me ? state.me.friend_code : '');
    return url.href;
  }

  async function copyMyCode() {
    if (!state.me) return;
    const ok = await copyText(state.me.friend_code);
    toast(ok ? '내 친구 코드 ' + state.me.friend_code + ' 를 복사했어요' : '내 친구 코드: ' + state.me.friend_code, 2400);
  }

  async function copyMyLink() {
    if (!state.me) return;
    const link = inviteLink();
    const ok = await copyText(link);
    toast(ok ? '초대 링크를 복사했어요 — 친구에게 붙여넣기 하세요' : '링크: ' + link, ok ? 3000 : 7000);
  }

  async function shareMyLink() {
    if (!state.me) return;
    const link = inviteLink();
    if (navigator.share) {
      try {
        await navigator.share({
          title: '우리끼리 — ' + state.me.nickname,
          text: '내 친구 코드는 ' + state.me.friend_code + ' 야. 이 링크로 들어와서 친구 맺자!',
          url: link,
        });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    await copyMyLink();
  }

  /* ───────────────────────── 6. 프로필 ───────────────────────── */
  function saveMe() {
    if (!state.me) return;
    LS.set(ME_KEY, {
      user_id: state.me.user_id,
      secret: state.me.secret,
      friend_code: state.me.friend_code,
      nickname: state.me.nickname,
      emoji: state.me.emoji,
      status_text: state.me.status_text,
      color: state.me.color,
      lat: state.me.lat,
      lng: state.me.lng,
      accuracy: state.me.accuracy,
      auto: state.auto,
    });
  }

  function applyProfile(prof) {
    if (!state.me) state.me = {};
    state.me.user_id = prof.user_id;
    state.me.friend_code = prof.friend_code;
    state.me.nickname = prof.nickname;
    state.me.emoji = prof.emoji || '🙂';
    state.me.status_text = prof.status_text || '';
    state.me.color = prof.color || colorFor(prof.user_id);
  }

  async function bootstrap(nickname) {
    let saved = LS.get(ME_KEY, null);
    if (!saved || !saved.user_id || !saved.secret) {
      saved = newIdentity();
    }
    state.me = Object.assign({
      emoji: '🙂', status_text: '', color: colorFor(saved.user_id),
      lat: isFinite(saved.lat) ? saved.lat : BASE.lat + 0.0008,
      lng: isFinite(saved.lng) ? saved.lng : BASE.lng - 0.0006,
      accuracy: saved.accuracy == null ? null : saved.accuracy,
      speed_kmh: null, stay_since: null, updated_at: null,
    }, saved);

    const prof = await API.rpc('friend_bootstrap', {
      p_user: state.me.user_id,
      p_secret: state.me.secret,
      p_nickname: String(nickname || '').trim().slice(0, 12),
    });
    applyProfile(prof);
    state.auto = saved.auto !== false;
    saveMe();
    return state.me;
  }

  async function updateProfile(patch) {
    if (!state.me) return;
    const prof = await API.rpc('friend_update_profile', Object.assign(selfArgs(), {
      p_nickname: patch.nickname != null ? patch.nickname : state.me.nickname,
      p_emoji: patch.emoji != null ? patch.emoji : state.me.emoji,
      p_status: patch.status_text != null ? patch.status_text : state.me.status_text,
    }));
    applyProfile(prof);
    saveMe();
  }

  /* ───────────────────────── 7. 피드(친구·요청·대화) ───────────────────────── */
  function normalizeFriend(f) {
    return {
      user_id: String(f.user_id),
      nickname: String(f.nickname || '친구').slice(0, 20),
      emoji: f.emoji || '🙂',
      status_text: f.status_text || '',
      color: f.color || colorFor(f.user_id),
      lat: f.lat == null ? null : Number(f.lat),
      lng: f.lng == null ? null : Number(f.lng),
      accuracy: f.accuracy == null ? null : Number(f.accuracy),
      battery: f.battery == null ? null : Number(f.battery),
      charging: !!f.charging,
      speed_kmh: f.speed_kmh == null ? null : Number(f.speed_kmh),
      stay_since: f.stay_since || null,
      updated_at: f.updated_at || null,
      unread: Number(f.unread || 0),
      last_message: f.last_message || '',
      last_message_at: f.last_message_at || null,
      last_from_me: !!f.last_from_me,
    };
  }

  function mergeFriends(list) {
    const seen = new Set();
    (list || []).forEach((raw) => {
      if (!raw || !raw.user_id) return;
      seen.add(String(raw.user_id));
      state.friends.set(String(raw.user_id), normalizeFriend(raw));
    });
    Array.from(state.friends.keys()).forEach((id) => {
      if (!seen.has(id)) {
        state.friends.delete(id);
        state.messages.delete(id);
        if (state.chatWith === id) closeChat();
      }
    });
  }

  function refreshFeed() {
    if (!state.me || !READY) return Promise.resolve();
    if (state.feedReq) { state.feedQueued = true; return state.feedReq; }
    state.feedReq = (async () => {
      try {
        const out = await API.rpc('friend_feed', selfArgs());
        if (!out) return;
        mergeFriends(out.friends);
        state.incoming = Array.isArray(out.incoming) ? out.incoming : [];
        state.outgoing = Array.isArray(out.outgoing) ? out.outgoing : [];
        markMyReadIfChatting();
        renderAll();
        syncRealtime();
      } catch (e) {
        if (!state.errShown) {
          state.errShown = true;
          toast('친구 목록을 불러오지 못했어요 — ' + errText(e), 4200);
        }
        console.warn('[우리끼리] feed', e);
      } finally {
        state.feedReq = null;
        if (state.feedQueued) {
          state.feedQueued = false;
          setTimeout(() => refreshFeed(), 400);
        }
      }
    })();
    return state.feedReq;
  }

  /* ───────────────────────── 8. 렌더링: 상단 · 카드 · 요청 · 대화 ───────────────────────── */
  /* 같은 내용이면 다시 그리지 않는다 (탭 위치·스크롤이 튀지 않게) */
  const paint = { members: '', convos: '', reqs: '', outgoing: '', chat: '' };

  function setHTML(node, html, key) {
    if (!node) return;
    if (key && paint[key] === html) return;
    if (key) paint[key] = html;
    node.innerHTML = html;
  }

  function updateChrome() {
    if (!state.me) return;
    el.myCode.textContent = state.me.friend_code;
    el.myName.textContent = state.me.nickname;
    el.meChipPin.textContent = state.me.emoji || '🙂';
    el.myCodeBig.textContent = state.me.friend_code;
    el.friendCount.textContent = state.friends.size;

    const unread = totalUnread();
    el.chatBadge.hidden = unread === 0;
    el.chatBadge.textContent = unread > 99 ? '99+' : String(unread);

    el.btnAuto.classList.toggle('is-on', state.auto);
    el.btnAuto.setAttribute('aria-pressed', String(state.auto));
    el.updateSub.textContent = state.me.updated_at ? (isStale(state.me) ? '오래됨' : timeAgo(state.me.updated_at)) : '대기 중';

    updateSheetHeight();
  }

  function sortedFriends() {
    return Array.from(state.friends.values()).sort((a, b) => {
      const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bt = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      if (at !== bt) return bt - at;
      return String(a.nickname).localeCompare(String(b.nickname), 'ko');
    });
  }

  function memberCardHTML(p, isMe) {
    const stale = isStale(p);
    const status = p.status_text || (isMe ? '상태를 남겨보세요' : '상태 없음');
    const batt = batteryText(p);
    const act = activityText(p);
    const unread = !isMe ? Number(p.unread || 0) : 0;
    const cls = ['member-card', isMe ? 'is-me' : '', state.selected === p.user_id ? 'is-selected' : ''].filter(Boolean).join(' ');

    return '<button class="' + cls + '" type="button" data-id="' + esc(p.user_id) + '">'
      + '<span class="mc-avatar" style="--c:' + esc(p.color || colorFor(p.user_id)) + '">'
      + esc(initialOf(p.nickname)) + '<span class="mc-emoji">' + esc(p.emoji || '🙂') + '</span>'
      + (unread ? '<span class="mc-badge">' + (unread > 9 ? '9+' : unread) + '</span>' : '')
      + '</span>'
      + '<span class="mc-body">'
      + '<span class="mc-top"><span class="mc-name">' + esc(p.nickname) + '</span>'
      + (isMe ? '<em class="mc-me">나</em>' : '') + '</span>'
      + '<span class="mc-status">' + esc(status) + '</span>'
      + (act ? '<span class="mc-activity mc-activity--' + act.kind + '">' + esc(act.text) + '</span>' : '')
      + '<span class="mc-meta">'
      + '<span class="' + (stale ? 'mc-stale' : '') + '">'
      + (isMe ? (p.lat ? '위치 공유 중' : '위치 대기') : (p.lat ? (stale ? '오프라인 · ' + timeAgo(p.updated_at) : timeAgo(p.updated_at)) : '위치 없음'))
      + '</span>'
      + (batt ? '<span>' + esc(batt) + '</span>' : '')
      + '</span></span></button>';
  }

  function renderList() {
    if (!el.memberList) return;
    const keepScroll = el.memberList.scrollLeft;
    const cards = [];
    if (state.me) cards.push(memberCardHTML(state.me, true));
    sortedFriends().forEach((f) => cards.push(memberCardHTML(f, false)));

    if (state.friends.size === 0) {
      cards.push('<div class="members-empty"><b>아직 친구가 없어요</b>'
        + '<span>내 초대 링크를 보내거나, 친구 코드를 입력해 보세요.</span>'
        + '<span class="empty-actions"><button type="button" data-act="share">초대 링크 복사</button>'
        + '<button type="button" data-act="add">친구 코드 입력</button></span></div>');
    }

    setHTML(el.memberList, cards.join(''), 'members');
    el.memberList.scrollLeft = keepScroll;
  }

  function renderRequests() {
    if (!el.reqBox) return;
    if (!state.incoming.length) {
      el.reqBox.hidden = true;
      setHTML(el.reqList, '', 'reqs');
      return;
    }
    el.reqBox.hidden = false;
    el.reqCount.textContent = state.incoming.length;
    setHTML(el.reqList, state.incoming.map((r) => (
      '<div class="req" data-req="' + esc(r.id) + '" data-uid="' + esc(r.user_id) + '">'
      + '<span class="req-avatar" style="--c:' + esc(r.color || colorFor(r.user_id)) + '">' + esc(initialOf(r.nickname)) + '</span>'
      + '<span class="req-body"><b>' + esc(r.nickname) + '</b><span>' + esc(timeAgo(r.created_at)) + ' · 친구 요청</span></span>'
      + '<span class="req-actions">'
      + '<button class="req-ok" type="button" data-accept="' + esc(r.id) + '">수락</button>'
      + '<button class="req-no" type="button" data-decline="' + esc(r.id) + '">거절</button>'
      + '</span></div>'
    )).join(''), 'reqs');
  }

  function convoRowHTML(f) {
    const unread = Number(f.unread || 0);
    const last = f.last_message ? ((f.last_from_me ? '나: ' : '') + f.last_message) : '아직 대화가 없어요';
    return '<button class="convo" type="button" data-chat="' + esc(f.user_id) + '">'
      + '<span class="convo-avatar" style="--c:' + esc(f.color || colorFor(f.user_id)) + '">'
      + esc(initialOf(f.nickname)) + '<span class="convo-emoji">' + esc(f.emoji || '🙂') + '</span></span>'
      + '<span class="convo-body">'
      + '<span class="convo-top"><b>' + esc(f.nickname) + '</b>'
      + '<span class="convo-time">' + esc(f.last_message_at ? msgTime(f.last_message_at) : '') + '</span></span>'
      + '<span class="convo-last' + (unread ? ' is-unread' : '') + '">' + esc(last) + '</span>'
      + '</span>'
      + (unread ? '<span class="convo-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '')
      + '</button>';
  }

  function renderConvos() {
    if (!el.convoList) return;
    const list = Array.from(state.friends.values()).sort((a, b) => {
      const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      if (at !== bt) return bt - at;
      return String(a.nickname).localeCompare(String(b.nickname), 'ko');
    });

    if (!list.length) {
      setHTML(el.convoList, '<div class="convo-empty">친구와 대화를 시작해 보세요.<br>'
        + '친구 탭에서 친구를 누르면 [채팅] 버튼이 있어요.</div>', 'convos');
      return;
    }
    setHTML(el.convoList, list.map(convoRowHTML).join(''), 'convos');
  }

  function renderAll() {
    renderPins();
    renderList();
    renderRequests();
    renderConvos();
    updateChrome();
    syncLiveRoutes();
    refreshRouteView();
  }

  function renderTimes() {
    renderList();
    renderConvos();
    updateChrome();
    refreshModalLive();
  }

  /* ───────────────────────── 9. 지도 ───────────────────────── */
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
      if (!el.memberModal.hidden) { closeModal(); return; }
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
    const stale = isStale(m) && !isMe;
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

    if (state.routeView) {
      for (const [id, marker] of Array.from(state.markers.entries())) {
        marker.remove();
        state.markers.delete(id);
        state.markerSig.delete(id);
      }
      return;
    }

    for (const m of allPeople()) {
      if (!isFinite(m.lat) || !isFinite(m.lng) || m.lat == null) continue;
      seen.add(m.user_id);

      const sig = pinSignature(m);
      const existing = state.markers.get(m.user_id);

      if (!existing) {
        const marker = L.marker([m.lat, m.lng], {
          icon: buildPinIcon(m),
          keyboard: false,
          riseOnHover: true,
          zIndexOffset: state.me && m.user_id === state.me.user_id ? 1200 : 0,
        }).addTo(state.map);
        marker.on('click', () => { openMember(m.user_id); });
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

  function fitToPeople(animate = false) {
    if (!state.map) return;
    const pts = allPeople()
      .filter((m) => isFinite(m.lat) && isFinite(m.lng) && m.lat != null)
      .map((m) => [m.lat, m.lng]);
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
    if (!state.map || !m || !isFinite(m.lat) || !isFinite(m.lng)) return;
    state.map.flyTo([m.lat, m.lng], Math.max(state.map.getZoom(), 15), { duration: 0.7 });
  }

  /* ───────────────────────── 10. 이동 기록 · 동선 ───────────────────────── */
  function historyFor(id) {
    return state.history.get(id) || [];
  }

  function setHistory(id, pts) {
    const clean = (pts || [])
      .map((p) => ({
        lat: Number(p && p.lat),
        lng: Number(p && p.lng),
        t: Number(p && (p.t != null ? p.t : (p.recorded_at ? new Date(p.recorded_at).getTime() : 0))),
        speed: p && p.speed != null && p.speed !== '' ? Number(p.speed) : (p && p.speed_kmh != null ? Number(p.speed_kmh) : null),
        since: (p && (p.since || p.stay_since)) || null,
      }))
      .filter((p) => isFinite(p.lat) && isFinite(p.lng) && isFinite(p.t) && p.t > 0)
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
    const point = {
      lat: Number(p.lat), lng: Number(p.lng), t,
      speed: p.speed == null ? null : Number(p.speed),
      since: p.since || null,
    };

    if (last) {
      const d = haversine(last, point);
      if (t - last.t < 15 * 1000 && d < 12) return false;
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
        kind: 'move', start: pts[from].t, end: pts[to].t, ms,
        meters: dist,
        kmh: (dist / 1000) / (ms / 3600000),
        from: pts[from], to: pts[to],
      });
    };

    for (const s of stays) {
      if (s.start > prev) pushMove(prev, s.start);
      const span = pts.slice(s.start, s.end + 1);
      const lat = span.reduce((a, p) => a + p.lat, 0) / span.length;
      const lng = span.reduce((a, p) => a + p.lng, 0) / span.length;
      out.push({
        kind: 'stay', start: pts[s.start].t, end: pts[s.end].t,
        ms: Math.max(1, pts[s.end].t - pts[s.start].t), lat, lng,
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
    state.routeModel = null;
    if (state.routeGroup) state.routeGroup.clearLayers();
    syncLiveRoutes();
  }

  /* ── 상세 동선 모델: 핀(출발·체류·현재)과 타임라인 줄을 함께 만든다 ── */
  function routeModel(pts) {
    const segs = buildSegments(pts);
    if (!segs.length) return null;

    const stays = segs.filter((s) => s.kind === 'stay');
    const moves = segs.filter((s) => s.kind === 'move');
    const meters = moves.reduce((a, s) => a + s.meters, 0);
    const startT = pts[0].t;
    const endT = pts[pts.length - 1].t;
    const spanMs = Math.max(1, endT - startT);
    const kmh = meters / 1000 / Math.max(0.01, spanMs / 3600000);

    const firstStay = stays[0] || null;
    const lastStay = stays[stays.length - 1] || null;
    const startIsStay = !!firstStay && firstStay.start === startT;
    const endIsStay = !!lastStay && lastStay.end === endT;

    const pins = [];
    stays.forEach((s, i) => {
      pins.push({
        key: 's' + i, kind: 'stay', num: i + 1, lat: s.lat, lng: s.lng,
        start: s.start, end: s.end, ms: s.ms,
        first: i === 0 && startIsStay,
        last: i === stays.length - 1 && endIsStay,
      });
    });

    if (!startIsStay) {
      pins.push({ key: 'start', kind: 'start', num: 0, lat: pts[0].lat, lng: pts[0].lng, start: startT, end: startT, ms: 0, first: true, last: false });
    }
    if (!endIsStay) {
      const last = pts[pts.length - 1];
      pins.push({ key: 'now', kind: 'now', num: 0, lat: last.lat, lng: last.lng, start: endT, end: endT, ms: 0, first: false, last: true });
    }

    const rows = segs.map((s, i) => {
      if (s.kind === 'stay') {
        const pin = pins.find((p) => p.kind === 'stay' && p.start === s.start);
        return { key: 'r' + i, kind: 'stay', seg: s, pinKey: pin ? pin.key : '', start: s.start, end: s.end, ms: s.ms, meters: 0, kmh: 0 };
      }
      return { key: 'r' + i, kind: 'move', seg: s, pinKey: '', start: s.start, end: s.end, ms: s.ms, meters: s.meters, kmh: s.kmh };
    });

    return { pts, segs, stays, moves, meters, spanMs, kmh, pins, rows, startT, endT, startIsStay, endIsStay };
  }

  function hhmm(t) {
    return clockOf(new Date(t).toISOString());
  }

  function pinByKey(key) {
    const model = state.routeModel;
    if (!model) return null;
    return model.pins.find((p) => p.key === key) || null;
  }

  function nextMoveAfter(seg, model) {
    const i = model.segs.indexOf(seg);
    for (let j = i + 1; j < model.segs.length; j++) {
      if (model.segs[j].kind === 'move') return model.segs[j];
    }
    return null;
  }

  /* ── 상세 동선: 선 · 방향 화살표 · 출발/체류/현재 핀 ── */
  function bearingDeg(a, b) {
    const la1 = a[0] * Math.PI / 180;
    const la2 = b[0] * Math.PI / 180;
    const dLo = (b[1] - a[1]) * Math.PI / 180;
    const y = Math.sin(dLo) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function arrowsAlong(coords) {
    const lens = [];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = haversine({ lat: coords[i - 1][0], lng: coords[i - 1][1] }, { lat: coords[i][0], lng: coords[i][1] });
      lens.push(d);
      total += d;
    }
    if (total < 45) return [];

    const count = Math.max(1, Math.min(7, Math.round(total / 800)));
    const step = total / (count + 1);
    const out = [];
    let acc = 0;
    let target = step;

    for (let i = 0; i < lens.length && out.length < count; i++) {
      const d = lens[i];
      while (target <= acc + d && out.length < count) {
        const f = d > 0 ? (target - acc) / d : 0;
        const a = coords[i];
        const b = coords[i + 1];
        out.push({
          lat: a[0] + (b[0] - a[0]) * f,
          lng: a[1] + (b[1] - a[1]) * f,
          deg: bearingDeg(a, b),
        });
        target += step;
      }
      acc += d;
    }
    return out;
  }

  function routePinIcon(pin, m, color) {
    let inner = '';
    if (pin.kind === 'stay') {
      inner = '<span class="rv-pin-num">' + pin.num + '</span>'
        + '<span class="rv-pin-txt">' + esc(durText(pin.ms)) + '</span>';
      if (pin.first) inner += '<span class="rv-pin-tag">출발</span>';
      if (pin.last) inner += '<span class="rv-pin-tag rv-pin-tag--now">지금</span>';
    } else if (pin.kind === 'start') {
      inner = '<span class="rv-pin-dot"></span>'
        + '<span class="rv-pin-txt"><b>출발</b> ' + esc(hhmm(pin.start)) + '</span>';
    } else {
      const fresh = Date.now() - pin.start < 15 * 60 * 1000;
      inner = '<span class="rv-pin-dot"></span>'
        + '<span class="rv-pin-txt"><b>' + (fresh ? '현재' : '최근') + '</b> ' + esc(hhmm(pin.start)) + '</span>';
    }

    const html = '<div class="rv-pin rv-pin--' + pin.kind + '" style="--c:' + esc(color) + '">' + inner + '</div>';
    return L.divIcon({ className: 'rv-pin-host', html, iconSize: [1, 1], iconAnchor: [0, 0] });
  }

  function popupRows(rows) {
    return '<dl>' + rows.map((r) =>
      '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'
    ).join('') + '</dl>';
  }

  function stayPopupHTML(pin, model) {
    const seg = model.segs.find((s) => s.kind === 'stay' && s.start === pin.start);
    const next = seg ? nextMoveAfter(seg, model) : null;
    const title = pin.first ? '출발한 자리' : (pin.last ? '지금 머무는 곳' : '머문 곳 ' + pin.num);
    const rows = [
      ['머문 시간', durText(pin.ms)],
      ['시각', hhmm(pin.start) + ' ~ ' + hhmm(pin.end)],
    ];
    if (next) {
      rows.push(['다음 이동', distText(next.meters) + ' · ' + durText(next.ms) + (next.kmh >= MOVE_KMH ? ' · ' + Math.round(next.kmh) + 'km/h' : '')]);
    }
    return '<div class="rv-pop-k">' + esc(title) + '</div>'
      + '<div class="rv-pop-t">' + esc(hhmm(pin.start)) + ' ~ ' + esc(hhmm(pin.end)) + '</div>'
      + popupRows(rows);
  }

  function edgePopupHTML(pin, model, m) {
    const isStart = pin.kind === 'start';
    const seg = model.segs[0];
    const rows = [['시각', hhmm(pin.start)]];
    if (isStart && seg && seg.kind === 'move') {
      rows.push(['첫 이동', distText(seg.meters) + ' · ' + durText(seg.ms) + (seg.kmh >= MOVE_KMH ? ' · ' + Math.round(seg.kmh) + 'km/h' : '')]);
    }
    if (!isStart) {
      const acc = m.accuracy != null && isFinite(m.accuracy) ? '±' + Math.round(m.accuracy) + 'm' : null;
      rows.push(['최근 갱신', m.updated_at ? timeAgo(m.updated_at) + ' · ' + clockOf(m.updated_at) : '—']);
      if (acc) rows.push(['위치 정확도', acc]);
    }
    return '<div class="rv-pop-k">' + (isStart ? '출발 지점' : '최근 · 현재 위치') + '</div>'
      + '<div class="rv-pop-t">' + esc(hhmm(pin.start)) + '</div>'
      + popupRows(rows)
      + '<p class="rv-pop-note">' + (isStart ? '이 자리에서 이동 기록이 시작됐어요.' : '지도 위 마지막으로 기록된 자리예요.') + '</p>';
  }

  function movePopupHTML(seg) {
    const kind = moveKind(seg.kmh);
    return '<div class="rv-pop-k">이동 구간</div>'
      + '<div class="rv-pop-t">' + esc(distText(seg.meters)) + ' · ' + esc(durText(seg.ms)) + '</div>'
      + popupRows([
        ['시각', hhmm(seg.start) + ' ~ ' + hhmm(seg.end)],
        ['평균 속도', (kind ? kind.ico + ' ' : '') + Math.max(1, Math.round(seg.kmh)) + 'km/h' + (kind ? ' · ' + kind.label : '')],
      ]);
  }

  function popupOpts() {
    return { className: 'rv-pop', maxWidth: 268, autoPanPaddingTopLeft: [24, 104], autoPanPaddingBottomRight: [24, 110] };
  }

  function routeFitPadding() {
    const size = state.map ? state.map.getSize() : { x: 360, y: 640 };
    const top = 104;
    let bottom = 92;
    if (state.routeTlOpen && el.rvTimeline && !el.rvTimeline.hidden) {
      bottom = el.rvTimeline.getBoundingClientRect().height + 36;
    }
    return {
      paddingTopLeft: [34, top],
      paddingBottomRight: [34, Math.min(bottom, Math.max(70, size.y - top - 90))],
    };
  }

  function fitRoute(model) {
    if (!state.map || !model || !model.pts.length) return;
    state.map.fitBounds(L.latLngBounds(model.pts.map((p) => [p.lat, p.lng])), Object.assign({
      maxZoom: 16, animate: true, duration: 0.45,
    }, routeFitPadding()));
  }

  function focusLatLng(lat, lng, zoom) {
    if (!state.map) return;
    const z = Math.max(state.map.getZoom(), zoom || 15);
    const p = state.map.project([lat, lng], z);
    const top = 110;
    const bottom = (state.routeTlOpen && el.rvTimeline && !el.rvTimeline.hidden)
      ? el.rvTimeline.getBoundingClientRect().height + 30 : 86;
    const dy = Math.max(0, (bottom - top) / 2);
    const center = state.map.unproject(p.add([0, dy]), z);
    state.map.flyTo(center, z, { duration: 0.5 });
  }

  function drawRouteDetail(m, opts = {}) {
    if (!state.map || !m) return null;
    const pts = historyFor(m.user_id);
    const model = routeModel(pts);
    if (state.routeGroup) state.routeGroup.clearLayers();
    if (!model) { state.routeModel = null; return null; }

    const color = m.color || colorFor(m.user_id);
    const coords = pts.map((p) => [p.lat, p.lng]);

    if (coords.length > 1) {
      L.polyline(coords, {
        color: '#ffffff', weight: 9, opacity: 0.9, lineJoin: 'round', lineCap: 'round', interactive: false,
      }).addTo(state.routeGroup);
      L.polyline(coords, {
        color, weight: 5, opacity: 0.96, lineJoin: 'round', lineCap: 'round', interactive: false,
      }).addTo(state.routeGroup);
    }

    arrowsAlong(coords).forEach((a) => {
      L.marker([a.lat, a.lng], {
        icon: L.divIcon({
          className: 'rv-arrow-host',
          html: '<div class="rv-arrow" style="--a:' + (a.deg - 90).toFixed(1) + 'deg;--c:' + esc(color) + '">'
            + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.5 17 12l-9 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>',
          iconSize: [1, 1], iconAnchor: [0, 0],
        }),
        keyboard: false, interactive: false, zIndexOffset: 200,
      }).addTo(state.routeGroup);
    });

    model.pins.forEach((pin) => {
      const marker = L.marker([pin.lat, pin.lng], {
        icon: routePinIcon(pin, m, color),
        keyboard: false,
        riseOnHover: true,
        zIndexOffset: pin.kind === 'now' ? 700 : (pin.kind === 'start' ? 500 : 400),
      });
      marker.bindPopup(pin.kind === 'stay' ? stayPopupHTML(pin, model) : edgePopupHTML(pin, model, m), popupOpts());
      marker.addTo(state.routeGroup);
      pin.marker = marker;
    });

    state.routeModel = model;
    if (opts.fit !== false) fitRoute(model);
    return model;
  }

  function routeSigOf(m) {
    const pts = historyFor(m.user_id);
    const last = pts[pts.length - 1];
    return [pts.length, last ? last.t : 0, m.lat, m.lng, m.updated_at || ''].join('|');
  }

  function renderRouteBar(m, model) {
    if (!el.rvWho) return;
    el.rvWho.textContent = m.nickname + ' 님의 이동 동선';
    const bits = [model.pins.length + '개 지점', '총 ' + distText(model.meters), durText(model.spanMs)];
    el.rvMeta.textContent = bits.join(' · ');
    el.rvTlCount.textContent = model.rows.length + '개 구간';
  }

  function routeRowHTML(row, model, color) {
    const t = hhmm(row.start) + ' ~ ' + hhmm(row.end);
    if (row.kind === 'stay') {
      const pin = model.pins.find((p) => p.key === row.pinKey);
      return '<li><button type="button" class="rv-row rv-row--stay" data-row="' + esc(row.key) + '">'
        + '<span class="rv-row-num" style="--c:' + esc(color) + '">' + (pin ? pin.num : '·') + '</span>'
        + '<span class="rv-row-body"><b>' + esc(durText(row.ms)) + ' 머묾</b><span>' + esc(t) + '</span></span>'
        + '<span class="rv-row-go">핀</span></button></li>';
    }
    const kind = moveKind(row.kmh);
    return '<li><button type="button" class="rv-row rv-row--move" data-row="' + esc(row.key) + '">'
      + '<span class="rv-row-ico">' + (kind ? kind.ico : '🚶') + '</span>'
      + '<span class="rv-row-body"><b>이동 ' + esc(distText(row.meters)) + '</b><span>' + esc(t) + ' · ' + esc(durText(row.ms)) + ' · ' + Math.max(1, Math.round(row.kmh)) + 'km/h</span></span>'
      + '<span class="rv-row-go">구간</span></button></li>';
  }

  function renderRouteTimeline(model) {
    if (!el.rvTlList || !model) return;
    const m = state.routeView ? personById(state.routeView) : null;
    const color = m ? (m.color || colorFor(m.user_id)) : '#0fb9a3';
    el.rvTlList.innerHTML = model.rows.map((r) => routeRowHTML(r, model, color)).join('')
      || '<li class="rv-empty">아직 나눌 구간이 없어요.</li>';
    el.rvTlCount.textContent = model.rows.length + '개 구간';
  }

  function renderRouteBlock(m) {
    const pts = historyFor(m.user_id);
    const model = pts.length >= 2 ? routeModel(pts) : null;

    if (!model) {
      el.mRouteSum.textContent = pts.length
        ? '이동 기록이 아직 짧아요 — 위치가 두 번 이상 갱신되면 동선이 그려져요.'
        : '아직 이동 기록이 없어요 — 위치가 갱신되면 자동으로 쌓여요.';
      el.mRouteHint.textContent = '';
      el.mRouteOpen.disabled = true;
      return;
    }

    el.mRouteSum.textContent = '최근 ' + durText(model.spanMs) + ' · ' + model.pins.length + '개 지점 · 총 ' + distText(model.meters)
      + (model.stays.length ? ' · 머문 곳 ' + model.stays.length + '곳' : '');
    el.mRouteHint.textContent = hhmm(model.startT) + '~' + hhmm(model.endT);
    el.mRouteOpen.disabled = false;
  }

  function closeRouteView() {
    if (!state.routeView) return;
    state.routeView = null;
    state.routeFor = null;
    state.routeModel = null;
    state.routeSig = '';
    state.routeTlOpen = false;
    el.routeView.hidden = true;
    el.rvTimeline.hidden = true;
    el.app.classList.remove('is-route');
    if (state.routeGroup) state.routeGroup.clearLayers();
    if (state.map) {
      try { state.map.closePopup(); } catch (e) {}
    }
    renderPins();
    syncLiveRoutes();
  }

  function openRouteView(id) {
    const m = personById(id);
    if (!m || !state.map) return;
    const pts = historyFor(m.user_id);
    const model = pts.length >= 2 ? routeModel(pts) : null;
    if (!model) {
      toast('아직 이동 기록이 짧아 동선을 그릴 수 없어요', 2600);
      return;
    }

    if (!el.memberModal.hidden) {
      el.memberModal.hidden = true;
      modalUser = null;
      state.selected = null;
    }

    state.routeView = m.user_id;
    state.routeFor = m.user_id;
    state.routeSig = '';
    state.routeTlOpen = false;
    el.routeView.hidden = false;
    el.app.classList.add('is-route');
    el.rvTimeline.hidden = true;
    el.rvTlToggle.classList.remove('is-on');
    el.rvTlToggle.setAttribute('aria-expanded', 'false');
    el.rvTlLabel.textContent = '타임라인';

    renderRouteBar(m, model);
    renderRouteTimeline(model);
    dropLiveRoute(m.user_id);
    renderPins();
    syncLiveRoutes();

    setTimeout(() => {
      if (state.routeView !== m.user_id) return;
      state.map.invalidateSize();
      const drawn = drawRouteDetail(m, { fit: true });
      if (drawn) {
        renderRouteBar(m, drawn);
        renderRouteTimeline(drawn);
        state.routeSig = routeSigOf(m);
      }
    }, 70);
  }

  function setRouteTimeline(open) {
    state.routeTlOpen = !!open;
    el.rvTimeline.hidden = !state.routeTlOpen;
    el.rvTlToggle.classList.toggle('is-on', state.routeTlOpen);
    el.rvTlToggle.setAttribute('aria-expanded', String(state.routeTlOpen));
    el.rvTlLabel.textContent = state.routeTlOpen ? '타임라인 닫기' : '타임라인';
    if (state.routeModel) {
      setTimeout(() => { if (state.routeView) fitRoute(state.routeModel); }, 40);
    }
  }

  function focusRouteRow(key) {
    const model = state.routeModel;
    if (!model || !state.map) return;
    const row = model.rows.find((r) => r.key === key);
    if (!row) return;

    $$('.rv-row', el.rvTlList).forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-row') === key));

    if (row.kind === 'stay') {
      const pin = pinByKey(row.pinKey);
      if (!pin) return;
      focusLatLng(pin.lat, pin.lng, 15.5);
      if (pin.marker) setTimeout(() => { try { pin.marker.openPopup(); } catch (e) {} }, 320);
      return;
    }

    const s = row.seg;
    const bounds = L.latLngBounds([[s.from.lat, s.from.lng], [s.to.lat, s.to.lng]]);
    state.map.flyToBounds(bounds, Object.assign({ maxZoom: 16, animate: true, duration: 0.5 }, routeFitPadding()));
    const mid = [(s.from.lat + s.to.lat) / 2, (s.from.lng + s.to.lng) / 2];
    setTimeout(() => {
      if (!state.routeView) return;
      L.popup(popupOpts()).setLatLng(mid).setContent(movePopupHTML(s)).openOn(state.map);
    }, 320);
  }

  function refreshRouteView() {
    if (!state.routeView || !state.map) return;
    const m = personById(state.routeView);
    if (!m) { closeRouteView(); return; }
    const sig = routeSigOf(m);
    if (sig === state.routeSig) return;
    state.routeSig = sig;

    const model = drawRouteDetail(m, { fit: false });
    if (!model) { closeRouteView(); toast('동선 기록이 사라졌어요', 2400); return; }
    renderRouteBar(m, model);
    const scroll = el.rvTlList ? el.rvTlList.scrollTop : 0;
    renderRouteTimeline(model);
    if (el.rvTlList) el.rvTlList.scrollTop = scroll;
  }

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

    for (const m of allPeople()) {
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

  /* ───────────────────────── 11. 상세 모달 ───────────────────────── */
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

  function renderRows(m, isMe) {
    const rows = [];
    rows.push(modalRow('speed', '이동 속도', esc(speedLong(m))));
    rows.push(modalRow('stay', '체류', stayLong(m)));
    rows.push(modalRow('battery', '배터리', batteryLongRow(m, isMe)));
    rows.push(modalRow('updated', '최근 업데이트', esc(m.updated_at ? timeAgo(m.updated_at) + ' · ' + clockOf(m.updated_at) : '아직 없음')));
    rows.push(modalRow('acc', '위치 정확도', esc(m.accuracy != null && isFinite(m.accuracy) ? '±' + Math.round(m.accuracy) + 'm' : '—')));
    el.mRows.innerHTML = rows.join('');
  }

  function refreshModalLive() {
    if (!modalUser || el.memberModal.hidden) return;
    const m = personById(modalUser);
    if (!m) return;
    const isMe = !!state.me && m.user_id === state.me.user_id;
    el.mChat.setAttribute('data-unread', String(isMe ? 0 : Number(m.unread || 0)));
    const set = (key, html) => {
      const dd = el.mRows.querySelector('[data-row="' + key + '"] dd');
      if (dd) dd.innerHTML = html;
    };
    set('updated', esc(m.updated_at ? timeAgo(m.updated_at) + ' · ' + clockOf(m.updated_at) : '아직 없음'));
    set('speed', esc(speedLong(m)));
    set('stay', stayLong(m));
    set('battery', batteryLongRow(m, isMe));
  }

  async function openMember(id) {
    const m = personById(id);
    if (!m) return;
    const isMe = m.user_id === state.me.user_id;
    modalUser = m.user_id;
    state.selected = id;
    renderPins();

    el.mAvatar.textContent = initialOf(m.nickname);
    el.mAvatar.style.setProperty('--c', m.color || colorFor(m.user_id));
    el.mName.textContent = m.nickname + (isMe ? ' (나)' : '');
    el.mStatus.textContent = (m.emoji || '🙂') + ' ' + (m.status_text || '상태 없음');

    renderRows(m, isMe);

    el.mChat.setAttribute('data-unread', String(isMe ? 0 : Number(m.unread || 0)));
    el.mCard.classList.toggle('is-me', isMe);
    el.mEdit.hidden = !isMe;
    el.mSave.hidden = !isMe;
    el.mChat.hidden = isMe;
    el.mLocate.hidden = isMe || m.lat == null;
    el.mRemove.hidden = isMe;
    renderBatteryBox(isMe);

    const actions = el.mCard.querySelector('.modal-actions');
    if (actions) {
      el.mCard.insertBefore(el.mRouteBlock, isMe ? actions : el.mRows);
    }

    if (isMe) {
      state.selectedEmoji = state.me.emoji || '🙂';
      el.mNickInput.value = state.me.nickname || '';
      el.mStatusInput.value = state.me.status_text || '';
      el.mEmojis.innerHTML = EMOJIS.map((e) =>
        '<button class="emoji-btn' + ((state.me.emoji || '🙂') === e ? ' is-on' : '') + '" type="button" data-emoji="' + esc(e) + '">' + e + '</button>'
      ).join('');
    }

    el.memberModal.hidden = false;

    await ensureHistory(m);
    const fresh = personById(id) || m;
    renderRows(fresh, isMe);
    renderRouteBlock(fresh);
    clearRoute();
  }

  function closeModal() {
    el.memberModal.hidden = true;
    modalUser = null;
    state.selected = null;
    clearRoute();
    renderPins();
  }

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

  /* ───────────────────────── 12. 채팅 ───────────────────────── */
  function openChat(friendId) {
    const f = state.friends.get(friendId);
    if (!f) { toast('친구 목록에 없는 사람이에요', 2200); return; }
    state.chatWith = friendId;
    state.selected = friendId;
    el.chatPanel.hidden = false;
    el.chatAvatar.textContent = initialOf(f.nickname);
    el.chatAvatar.style.setProperty('--c', f.color || colorFor(friendId));
    el.chatName.textContent = f.nickname;
    renderChatSub();
    renderChatMessages();
    el.chatBody.scrollTop = el.chatBody.scrollHeight;
    loadMessages(friendId, { full: true }).then(() => {
      markRead(friendId);
      el.chatInput.focus();
      el.chatBody.scrollTop = el.chatBody.scrollHeight;
    });
  }

  function renderChatSub() {
    const f = state.chatWith ? state.friends.get(state.chatWith) : null;
    if (!f) return;
    const bits = [];
    if (f.status_text) bits.push(f.status_text);
    if (f.lat != null) {
      const since = staySinceOf(f);
      if (since) bits.push(stayChip(since) + ' 머무는 중');
      else if (f.updated_at) bits.push(timeAgo(f.updated_at) + ' 위치');
      else bits.push('위치 공유 중');
    } else {
      bits.push('위치 없음');
    }
    el.chatSub.textContent = bits.join(' · ');
  }

  function closeChat() {
    state.chatWith = null;
    el.chatPanel.hidden = true;
    renderAll();
  }

  function renderChatMessages() {
    if (!el.chatBody) return;
    const id = state.chatWith;
    if (!id) { el.chatBody.innerHTML = ''; return; }
    const list = state.messages.get(id) || [];

    if (!list.length) {
      setHTML(el.chatBody, '<div class="chat-empty">첫 메시지를 보내 보세요.<br>이 대화는 친구끼리만 보여요.</div>', 'chat');
      return;
    }

    let html = '';
    let lastDay = '';
    list.forEach((msg) => {
      const day = dayLabel(msg.created_at);
      if (day && day !== lastDay) {
        html += '<div class="day-sep">' + esc(day) + '</div>';
        lastDay = day;
      }
      const mine = state.me && msg.sender_id === state.me.user_id;
      html += '<div class="msg' + (mine ? ' msg--me' : '') + '" data-msg="' + esc(msg.id) + '">'
        + '<span class="msg-bubble">' + esc(msg.body) + '</span>'
        + '<span class="msg-time">' + esc(msgTime(msg.created_at)) + (mine ? (msg.read_at ? ' · 읽음' : '') : '') + '</span>'
        + '</div>';
    });
    setHTML(el.chatBody, html, 'chat');
  }

  async function loadMessages(friendId, opts = {}) {
    if (!state.me) return [];
    try {
      const args = Object.assign(selfArgs(), { p_friend: friendId });
      if (!opts.full) {
        const list = state.messages.get(friendId) || [];
        const last = list[list.length - 1];
        if (last && last.created_at) args.p_since = last.created_at;
      }
      const rows = await API.rpc('friend_messages', args);
      const incoming = Array.isArray(rows) ? rows : [];
      const prev = opts.full ? [] : (state.messages.get(friendId) || []);
      const byId = new Map(prev.map((m) => [String(m.id), m]));
      incoming.forEach((m) => { byId.set(String(m.id), m); });
      const merged = Array.from(byId.values()).sort((a, b) => {
        const at = new Date(a.created_at).getTime();
        const bt = new Date(b.created_at).getTime();
        if (at !== bt) return at - bt;
        return Number(a.id) - Number(b.id);
      });
      state.messages.set(friendId, merged);

      if (state.chatWith === friendId && !el.chatPanel.hidden) {
        const nearBottom = el.chatBody.scrollHeight - el.chatBody.scrollTop - el.chatBody.clientHeight < 90;
        renderChatMessages();
        if (nearBottom || opts.full) el.chatBody.scrollTop = el.chatBody.scrollHeight;
      }
      return merged;
    } catch (e) {
      if (!/not_friends/.test(String(e.detail || e.message))) {
        console.warn('[우리끼리] messages', e);
      }
      return [];
    }
  }

  function markMyReadIfChatting() {
    if (!state.chatWith) return;
    const f = state.friends.get(state.chatWith);
    if (f && f.unread) markRead(state.chatWith);
  }

  async function markRead(friendId) {
    if (!state.me || !friendId) return;
    const f = state.friends.get(friendId);
    if (f) f.unread = 0;
    updateChrome();
    if (state.readSending[friendId]) return;
    state.readSending[friendId] = true;
    try {
      await API.rpc('friend_mark_read', Object.assign(selfArgs(), { p_friend: friendId }));
    } catch (e) { /* 다음 피드에서 다시 시도 */ }
    setTimeout(() => { state.readSending[friendId] = false; }, 1200);
  }

  async function sendMessage() {
    const friendId = state.chatWith;
    if (!friendId || !state.me) return;
    const body = String(el.chatInput.value || '').trim();
    if (!body) return;
    el.chatInput.value = '';
    el.btnChatSend.classList.add('is-busy');
    try {
      await API.rpc('friend_send_message', Object.assign(selfArgs(), { p_to: friendId, p_body: body }));
      await loadMessages(friendId, { full: false });
      const f = state.friends.get(friendId);
      if (f) {
        f.last_message = body;
        f.last_message_at = new Date().toISOString();
        f.last_from_me = true;
      }
      renderConvos();
      el.chatBody.scrollTop = el.chatBody.scrollHeight;
      rt.send(pairTopic(friendId), 'msg', { from: state.me.user_id });
    } catch (e) {
      toast('메시지를 보내지 못했어요 — ' + errText(e), 3600);
      if (!el.chatInput.value) el.chatInput.value = body;
    } finally {
      el.btnChatSend.classList.remove('is-busy');
    }
  }

  /* ───────────────────────── 13. 친구 요청 · 수락 ───────────────────────── */
  async function sendFriendRequest(code, opts = {}) {
    const c = normalizeCode(code);
    if (!c) { toast('친구 코드를 입력해 주세요', 2000); return; }
    if (state.me && c === state.me.friend_code) { toast('내 친구 코드예요', 2000); return; }

    el.btnSendReq.disabled = true;
    try {
      const out = await API.rpc('friend_request', Object.assign(selfArgs(), { p_code: c }));
      const st = out && out.status;
      if (st === 'sent') {
        toast(out.nickname + ' 님에게 친구 요청을 보냈어요', 3000);
        rt.send('friend-' + out.user_id, 'req', { from: state.me.user_id });
        el.inputCode.value = '';
      } else if (st === 'accepted') {
        toast(out.nickname + ' 님과 바로 친구가 됐어요!', 3000);
        rt.send('friend-' + out.user_id, 'req', { from: state.me.user_id });
        el.inputCode.value = '';
      } else if (st === 'already_friends') {
        toast('이미 친구예요 — ' + out.nickname, 2400);
      } else if (st === 'already_requested') {
        toast('이미 요청을 보내고 기다리는 중이에요', 2600);
      } else if (st === 'self') {
        toast('내 친구 코드예요', 2000);
      } else {
        toast('그런 친구 코드를 찾지 못했어요 — 코드를 다시 확인해 주세요', 3200);
      }
      await refreshFeed();
      renderOutgoing();
      if (opts.closeOnSent && (st === 'sent' || st === 'accepted')) {
        setTimeout(closeAddModal, 600);
      }
    } catch (e) {
      toast('요청을 보내지 못했어요 — ' + errText(e), 3600);
    } finally {
      el.btnSendReq.disabled = false;
    }
  }

  async function respondRequest(id, accept) {
    const req = state.incoming.find((r) => String(r.id) === String(id));
    try {
      const out = await API.rpc('friend_respond', Object.assign(selfArgs(), { p_id: Number(id), p_accept: !!accept }));
      if (out && out.status === 'not_found') {
        toast('이미 처리된 요청이에요', 2200);
      } else if (accept) {
        toast((req ? req.nickname + ' 님과' : '') + ' 친구가 됐어요!', 2600);
      } else {
        toast('요청을 거절했어요', 2000);
      }
      if (req) rt.send('friend-' + req.user_id, 'req', { from: state.me.user_id });
    } catch (e) {
      toast('요청을 처리하지 못했어요 — ' + errText(e), 3200);
    }
    await refreshFeed();
  }

  async function cancelRequest(userId) {
    try {
      await API.rpc('friend_remove', Object.assign(selfArgs(), { p_friend: userId }));
      toast('보낸 요청을 취소했어요', 2000);
      await refreshFeed();
      renderOutgoing();
    } catch (e) {
      toast('취소하지 못했어요 — ' + errText(e), 3000);
    }
  }

  async function removeFriend(friendId) {
    const f = state.friends.get(friendId);
    if (!f) return;
    if (!window.confirm(f.nickname + ' 님과 친구를 끊을까요?\n서로의 위치와 대화가 보이지 않게 됩니다.')) return;
    try {
      await API.rpc('friend_remove', Object.assign(selfArgs(), { p_friend: friendId }));
      toast(f.nickname + ' 님과 친구를 끊었어요', 2400);
      closeModal();
      closeChat();
      await refreshFeed();
    } catch (e) {
      toast('친구를 끊지 못했어요 — ' + errText(e), 3200);
    }
  }

  function renderOutgoing() {
    if (!el.outgoingBox) return;
    if (!state.outgoing.length) {
      el.outgoingBox.hidden = true;
      setHTML(el.outgoingList, '', 'outgoing');
      return;
    }
    el.outgoingBox.hidden = false;
    setHTML(el.outgoingList, state.outgoing.map((r) => (
      '<div class="out-item" data-uid="' + esc(r.user_id) + '">'
      + esc(r.nickname) + '<span>' + esc(timeAgo(r.created_at)) + ' 요청</span>'
      + '<button type="button" data-cancel="' + esc(r.user_id) + '">취소</button></div>'
    )).join(''), 'outgoing');
  }

  /* ───────────────────────── 14. 친구 추가 모달 · 탭 ───────────────────────── */
  function openAddModal() {
    el.addModal.hidden = false;
    el.myCodeBig.textContent = state.me ? state.me.friend_code : '—';
    renderOutgoing();
    setTimeout(() => { try { el.inputCode.focus(); } catch (e) {} }, 120);
  }

  function closeAddModal() {
    el.addModal.hidden = true;
    el.inputCode.value = '';
  }

  function setTab(tab) {
    state.tab = tab === 'chat' ? 'chat' : 'friends';
    el.tabFriends.classList.toggle('is-on', state.tab === 'friends');
    el.tabChat.classList.toggle('is-on', state.tab === 'chat');
    el.panelFriends.hidden = state.tab !== 'friends';
    el.panelChat.hidden = state.tab !== 'chat';
    el.sheet.classList.toggle('sheet--chat', state.tab === 'chat');
    setTimeout(updateSheetHeight, 30);
    if (state.tab === 'chat') renderConvos();
  }

  /* ───────────────────────── 15. 이동 기록 채우기 ───────────────────────── */
  async function ensureHistory(person) {
    const id = person.user_id;
    const isMe = !!state.me && id === state.me.user_id;
    let pts = historyFor(id);

    if (isMe) {
      const saved = LS.get(histKey(id), null);
      if (Array.isArray(saved) && saved.length >= 2) {
        const merged = new Map();
        saved.concat(pts).forEach((p) => {
          const t = Number(p.t);
          if (isFinite(t)) merged.set(t, { lat: Number(p.lat), lng: Number(p.lng), t, speed: p.speed == null ? null : Number(p.speed), since: p.since || null });
        });
        pts = setHistory(id, Array.from(merged.values()));
      }
    }

    if (pts.length >= 2) return pts;

    try {
      const rows = await API.rpc('friend_history', Object.assign(selfArgs(), {
        p_friend: isMe ? '' : id,
        p_since: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      }));
      if (Array.isArray(rows) && rows.length) pts = setHistory(id, rows.map((r) => ({
        lat: r.lat, lng: r.lng,
        t: new Date(r.recorded_at).getTime(),
        speed: r.speed_kmh,
        since: r.stay_since,
      })));
    } catch (e) {
      console.warn('[우리끼리] history', e);
    }

    return pts;
  }

  async function loadHistoryAll() {
    try {
      const rows = await API.rpc('friends_history_since', Object.assign(selfArgs(), {
        p_since: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      }));
      if (!Array.isArray(rows) || !rows.length) return;

      const byUser = new Map();
      rows.forEach((r) => {
        if (!r || !r.user_id) return;
        const arr = byUser.get(r.user_id) || [];
        arr.push({
          lat: r.lat, lng: r.lng, t: new Date(r.recorded_at).getTime(),
          speed: r.speed_kmh, since: r.stay_since,
        });
        byUser.set(r.user_id, arr);
      });

      byUser.forEach((pts, id) => {
        if (historyFor(id).length >= pts.length) return;
        setHistory(id, pts);
      });
      renderAll();
    } catch (e) {
      console.warn('[우리끼리] history all', e);
    }
  }

  function persistMyHistory() {
    if (!state.me) return;
    const arr = historyFor(state.me.user_id);
    if (arr.length) LS.set(histKey(state.me.user_id), arr.slice(-HISTORY_MAX));
  }

  /* ───────────────────────── 16. 위치 ───────────────────────── */
  function applyBattery() {
    if (!state.me) return;
    if (state.battMode === 'manual') {
      state.battery = Math.max(0, Math.min(100, Math.round(state.battManual.level)));
      state.charging = !!state.battManual.charging;
    } else if (state.battMode === 'off') {
      state.battery = null;
      state.charging = false;
    }
    state.me.battery = state.battery;
    state.me.charging = state.charging;
  }

  async function readBattery() {
    if (!BATT_API) {
      state.battMode = LS.get('urikkiri.battMode', 'off') === 'manual' ? 'manual' : 'off';
      const saved = LS.get('urikkiri.battManual', null);
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
        if (calc > 200) return null;
        speed = (speed != null && Math.abs(calc - speed) <= 3) ? (speed * 0.5 + calc * 0.5) : calc;
      } else if (dt <= 90 && d < 8) {
        speed = 0;
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
      if (raw === 0) me.speed_kmh = 0;
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
    state.gotFix = true;
    state.geoDenied = false;
    if (el.permHint) el.permHint.hidden = true;

    const added = addHistoryPoint(me.user_id, { lat, lng, t: now, speed: me.speed_kmh, since: me.stay_since });
    if (added) {
      persistMyHistory();
      pushHistoryPoint();
    }

    renderAll();
    if (first) {
      fitToPeople(false);
      toast('내 위치를 찾았어요', 1600);
    }

    if (now - state.lastPublish > REFRESH_MS * 0.8 && added) publishMe(false); else saveMe();
  }

  function onGeoError(err, silent) {
    const denied = err && (err.code === 1 || /denied|PERMISSION/i.test(err.message || ''));
    if (denied) state.geoDenied = true;
    if (!state.me) return;

    if (!state.gotFix) {
      state.me.updated_at = new Date().toISOString();
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

  /* 정밀 위치(enableHighAccuracy)가 실패하면 네트워크 위치로 한 번 더 시도한다.
     PC 와이파이·실내처럼 GPS 가 없는 환경에서도 위치가 잡히게. */
  const GEO_FINE = { enableHighAccuracy: true, timeout: 9000, maximumAge: 3000 };
  const GEO_COARSE = { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 };

  function getPosition(onOk, onErr, opts = {}) {
    if (!navigator.geolocation) {
      onErr({ code: 0, message: 'geolocation unsupported' });
      return;
    }
    const fine = Object.assign({}, GEO_FINE, opts);
    const coarse = Object.assign({}, GEO_COARSE, { maximumAge: opts.maximumAge != null ? opts.maximumAge : GEO_COARSE.maximumAge, timeout: GEO_COARSE.timeout });

    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => { state.geoFallback = false; onOk(pos); },
        (err) => {
          const retryable = err && (err.code === 2 || err.code === 3);
          if (!retryable) { onErr(err); return; }
          try {
            navigator.geolocation.getCurrentPosition(
              (pos) => { state.geoFallback = true; onOk(pos); },
              (err2) => onErr(err2),
              coarse
            );
          } catch (e) { onErr(err); }
        },
        fine
      );
    } catch (e) { onErr(e); }
  }

  function askLocation(opts = {}) {
    if (!navigator.geolocation) {
      if (!opts.silent) toast('이 브라우저는 위치 기능을 지원하지 않아요', 3000);
      return;
    }
    getPosition(
      onPosition,
      (err) => onGeoError(err, !!opts.silent),
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 3000 }
    );
  }

  function startWatch() {
    stopWatch();
    if (!navigator.geolocation) return;
    startWatchPass(false);
  }

  function startWatchPass(coarse) {
    try {
      state.watchId = navigator.geolocation.watchPosition(
        (pos) => { state.geoFallback = coarse; onPosition(pos); },
        (err) => {
          const retryable = err && (err.code === 2 || err.code === 3);
          if (retryable && !coarse) {
            // 정밀 위치가 이 환경에서 안 잡힌다 → 네트워크 위치로 다시 감시 시작
            stopWatch();
            startWatchPass(true);
            return;
          }
          onGeoError(err, true);
        },
        coarse
          ? { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 }
          : { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
      );
    } catch (e) { state.watchId = null; }
  }

  function stopWatch() {
    if (state.watchId != null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (e) {}
    }
    state.watchId = null;
  }

  /* ───────────────────────── 17. 발행 ───────────────────────── */
  async function publishMe(showFeedback) {
    if (!state.me || !state.joined || !READY) return;
    applyBattery();
    state.me.updated_at = new Date().toISOString();
    state.lastPublish = Date.now();
    saveMe();
    renderAll();

    try {
      await API.rpc('friend_publish', Object.assign(selfArgs(), {
        p_lat: state.me.lat,
        p_lng: state.me.lng,
        p_accuracy: state.me.accuracy == null ? null : state.me.accuracy,
        p_battery: state.me.battery == null ? null : Math.round(state.me.battery),
        p_charging: !!state.me.charging,
        p_speed_kmh: state.me.speed_kmh == null ? null : Number(state.me.speed_kmh),
        p_stay_since: state.me.stay_since || null,
      }));
      notifyFriends('loc', { from: state.me.user_id });
      if (showFeedback) toast('위치를 업데이트했어요', 1800);
    } catch (e) {
      if (!state.errShown) {
        state.errShown = true;
        toast('위치를 보내지 못했어요 — ' + errText(e), 4200);
      }
      console.warn('[우리끼리] publish', e);
    }
  }

  async function pushHistoryPoint() {
    if (!state.me || !state.joined || !READY) return;
    const arr = historyFor(state.me.user_id);
    const last = arr[arr.length - 1];
    if (!last) return;
    if (Date.now() - state.lastHistAt < 45 * 1000) return;
    state.lastHistAt = Date.now();
    try {
      await API.rpc('friend_log_point', Object.assign(selfArgs(), {
        p_lat: last.lat,
        p_lng: last.lng,
        p_accuracy: state.me.accuracy == null ? null : state.me.accuracy,
        p_speed_kmh: last.speed == null ? null : last.speed,
        p_stay_since: last.since || null,
        p_recorded_at: new Date(last.t).toISOString(),
      }));
    } catch (e) {
      console.warn('[우리끼리] history point', e);
    }
  }

  async function manualUpdate() {
    if (!state.me) return;
    el.btnUpdate.classList.add('is-busy');

    const done = () => {
      el.btnUpdate.classList.remove('is-busy');
      renderAll();
    };

    if (!navigator.geolocation) {
      await publishMe(true);
      done();
      return;
    }

    getPosition(
      async (pos) => {
        onPosition(pos);
        await publishMe(false);
        await pushHistoryPoint();
        const sp = state.me.speed_kmh;
        toast('내 위치를 업데이트했어요'
          + (sp != null && sp >= MOVE_KMH ? ' · ' + Math.round(sp) + 'km/h' : '')
          + (pos.coords.accuracy ? ' · 정확도 ±' + Math.round(pos.coords.accuracy) + 'm' : '')
          + (state.geoFallback ? ' · 네트워크 위치' : ''), 2400);
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
    saveMe();
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

  async function saveMyProfile() {
    if (!state.me) return;
    const nick = el.mNickInput.value.trim().slice(0, 12);
    if (!nick) { toast('닉네임을 입력해 주세요', 1800); return; }
    const status = el.mStatusInput.value.trim().slice(0, 24);
    el.mSave.disabled = true;
    try {
      await updateProfile({ nickname: nick, emoji: state.selectedEmoji || state.me.emoji, status_text: status });
      await publishMe(false);
      closeModal();
      toast('내 정보를 저장했어요', 1600);
    } catch (e) {
      toast('저장하지 못했어요 — ' + errText(e), 3200);
    } finally {
      el.mSave.disabled = false;
    }
  }

  async function setBatteryMode(mode) {
    if (!state.me) return;
    state.battMode = mode;
    LS.set('urikkiri.battMode', mode);
    applyBattery();
    renderBatteryBox(true);
    renderRows(state.me, true);
    await publishMe(false);
    toast(mode === 'manual' ? '배터리를 직접 입력해서 표시할게요' : '배터리를 표시하지 않을게요', 2000);
  }

  function saveBatteryManual() {
    state.battManual = { level: Number(el.mBattRange.value), charging: !!el.mBattCharging.checked };
    LS.set('urikkiri.battManual', state.battManual);
    applyBattery();
    if (state.me) {
      renderRows(state.me, true);
      publishMe(false);
    }
    toast('배터리 ' + state.battManual.level + '%' + (state.battManual.charging ? ' · 충전 중' : '') + '으로 표시할게요', 2000);
  }

  /* ───────────────────────── 18. 실시간 신호(broadcast) ───────────────────────── */
  function pairTopic(friendId) {
    const a = state.me.user_id;
    const pair = [a, friendId].sort();
    return 'pair-' + pair[0] + '__' + pair[1];
  }

  function notifyFriends(event, payload) {
    if (!state.me) return;
    for (const id of state.friends.keys()) {
      rt.send(pairTopic(id), event, payload || {});
    }
  }

  const rt = (() => {
    let ws = null;
    let hb = null;
    let retry = null;
    let ref = 0;
    let disposed = false;
    let want = [];
    const joined = new Set();

    function wsUrl() {
      return SUPABASE_URL.replace(/^http/i, 'ws')
        + '/realtime/v1/websocket?apikey=' + encodeURIComponent(SUPABASE_KEY) + '&vsn=1.0.0';
    }

    function sendRaw(topic, event, payload) {
      if (!ws || ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({
          topic: 'realtime:' + topic,
          event,
          payload: payload || {},
          ref: String(++ref),
        }));
      } catch (e) {}
    }

    function join(topic) {
      sendRaw(topic, 'phx_join', {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: '' },
          postgres_changes: [],
        },
      });
    }

    function handleBroadcast(topic, event, payload) {
      if (event === 'loc') {
        scheduleFeedRefresh(900);
      } else if (event === 'msg') {
        const friendId = topic.replace(/^pair-/, '').split('__').find((id) => id !== state.me.user_id);
        if (!friendId) return;
        if (state.chatWith === friendId && !el.chatPanel.hidden) {
          loadMessages(friendId, { full: false }).then(() => markRead(friendId));
        }
        scheduleFeedRefresh(200);
      } else if (event === 'req') {
        scheduleFeedRefresh(300);
      }
    }

    function connect() {
      if (disposed || !READY || !state.me) return;
      try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }

      ws.onopen = () => {
        joined.clear();
        want.forEach((t) => { join(t); joined.add(t); });
        clearInterval(hb);
        hb = setInterval(() => {
          if (!ws || ws.readyState !== 1) return;
          try {
            ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }));
          } catch (e) {}
        }, 25000);
      };

      ws.onmessage = (ev) => {
        let parsed;
        try { parsed = JSON.parse(ev.data); } catch (e) { return; }
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of list) {
          if (!msg) continue;
          const topic = String(msg.topic || '').replace(/^realtime:/, '');
          if (msg.event === 'broadcast') {
            const data = msg.payload || {};
            handleBroadcast(topic, data.event, data.payload || {});
          } else if (msg.event === 'phx_error' || msg.event === 'phx_close') {
            joined.delete(topic);
          }
        }
      };

      ws.onerror = () => {};
      ws.onclose = () => {
        clearInterval(hb);
        joined.clear();
        ws = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (disposed) return;
      clearTimeout(retry);
      retry = setTimeout(connect, 6000);
    }

    return {
      connect,
      setTopics(topics) {
        const next = Array.from(new Set(topics.filter(Boolean)));
        want = next;
        if (!ws || ws.readyState !== 1) return;
        next.forEach((t) => { if (!joined.has(t)) { join(t); joined.add(t); } });
        Array.from(joined).forEach((t) => {
          if (next.indexOf(t) === -1) {
            sendRaw(t, 'phx_leave', {});
            joined.delete(t);
          }
        });
      },
      send(topic, event, payload) {
        if (!topic || !ws || ws.readyState !== 1) return;
        sendRaw(topic, 'broadcast', { type: 'broadcast', event, payload: payload || {} });
      },
      dispose() {
        disposed = true;
        clearInterval(hb);
        clearTimeout(retry);
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      },
    };
  })();

  let feedTimer = null;
  function scheduleFeedRefresh(ms) {
    if (feedTimer) return;
    feedTimer = setTimeout(() => {
      feedTimer = null;
      refreshFeed();
    }, Math.max(150, ms || 600));
  }

  function syncRealtime() {
    if (!state.me) return;
    const topics = ['friend-' + state.me.user_id];
    for (const id of state.friends.keys()) topics.push(pairTopic(id));
    rt.setTopics(topics);
  }

  /* ───────────────────────── 19. 타이머 ───────────────────────── */
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
    await refreshFeed();
    renderTimes();
    if (state.routeView) refreshRouteView();
    const opened = modalUser && !el.memberModal.hidden ? personById(modalUser) : null;
    if (opened) renderRouteBlock(opened);
    if (state.chatWith && !el.chatPanel.hidden) {
      renderChatSub();
      loadMessages(state.chatWith, { full: false });
    }
  }

  /* ───────────────────────── 20. 입장 ───────────────────────── */
  async function enterApp() {
    if (!state.me) return;
    el.joinScreen.hidden = true;
    el.app.hidden = false;
    initMap();
    if (state.map) state.map.invalidateSize();
    state.joined = true;
    applyBattery();
    renderAll();
    fitToPeople(false);
    updateChrome();
    rt.connect();

    await publishMe(false);
    await refreshFeed();
    await loadHistoryAll();
    renderAll();

    readBattery();
    if (state.auto) startWatch();
    startTimers();
    setTimeout(() => askLocation({ silent: false }), 400);

    if (state.addAfterStart) {
      const code = state.addAfterStart;
      state.addAfterStart = '';
      setTimeout(() => sendFriendRequest(code), 500);
    }
    clearAddParam();
  }

  function setJoinBusy(busy) {
    el.btnStart.disabled = busy;
    el.btnStart.textContent = busy ? '시작하는 중…' : '시작하기';
  }

  async function startFromJoin(nickname) {
    if (state.joining) return;
    state.joining = true;
    setJoinBusy(true);
    try {
      await bootstrap(nickname);
      LS.set('urikkiri.lastNick', state.me.nickname);
      state.joining = false;
      setJoinBusy(false);
      await enterApp();
    } catch (e) {
      console.error('[우리끼리] 시작 실패', e);
      state.joining = false;
      setJoinBusy(false);
      toast('시작하지 못했어요 — ' + errText(e), 5200);
    }
  }

  /* ───────────────────────── 21. 이벤트 ───────────────────────── */
  function bindEvents() {
    el.joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nick = el.inputNick.value.trim();
      if (!nick) { toast('닉네임을 입력해 주세요', 2000); el.inputNick.focus(); return; }
      startFromJoin(nick);
    });
    el.inputNick.addEventListener('input', () => {
      el.inputNick.value = el.inputNick.value.slice(0, 12);
    });

    el.meChip.addEventListener('click', () => openMember(state.me.user_id));
    el.btnShare.addEventListener('click', shareMyLink);
    el.btnAddFriend.addEventListener('click', openAddModal);
    el.btnAddFriend2.addEventListener('click', openAddModal);
    el.btnCopy.addEventListener('click', copyMyLink);
    el.btnUpdate.addEventListener('click', manualUpdate);
    el.btnAuto.addEventListener('click', () => setAuto(!state.auto));
    el.btnLocate.addEventListener('click', () => {
      centerOn(state.me);
      askLocation({ silent: true });
    });

    el.btnCollapse.addEventListener('click', () => {
      el.sheet.classList.toggle('is-collapsed');
      setTimeout(updateSheetHeight, 240);
    });

    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      setTab(btn.getAttribute('data-tab'));
    });

    el.memberList.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) {
        const what = act.getAttribute('data-act');
        if (what === 'share') copyMyLink();
        if (what === 'add') openAddModal();
        return;
      }
      const card = e.target.closest('[data-id]');
      if (!card) return;
      const id = card.getAttribute('data-id');
      if (!personById(id)) return;
      openMember(id);
    });

    el.convoList.addEventListener('click', (e) => {
      const row = e.target.closest('[data-chat]');
      if (!row) return;
      openChat(row.getAttribute('data-chat'));
    });

    el.reqList.addEventListener('click', (e) => {
      const ok = e.target.closest('[data-accept]');
      const no = e.target.closest('[data-decline]');
      if (ok) { respondRequest(ok.getAttribute('data-accept'), true); return; }
      if (no) { respondRequest(no.getAttribute('data-decline'), false); }
    });

    el.outgoingList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cancel]');
      if (!btn) return;
      cancelRequest(btn.getAttribute('data-cancel'));
    });

    el.mClose.addEventListener('click', closeModal);
    el.memberModal.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) closeModal();
    });
    el.addModal.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) closeAddModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!el.addModal.hidden) { closeAddModal(); return; }
      if (!el.chatPanel.hidden) { closeChat(); return; }
      if (state.routeView) { closeRouteView(); return; }
      if (!el.memberModal.hidden) closeModal();
    });

    el.mEmojis.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      state.selectedEmoji = btn.getAttribute('data-emoji');
      $$('.emoji-btn', el.mEmojis).forEach((b) => b.classList.toggle('is-on', b === btn));
    });

    el.mSave.addEventListener('click', saveMyProfile);
    el.mChat.addEventListener('click', () => {
      const id = modalUser;
      closeModal();
      if (id) openChat(id);
    });
    el.mLocate.addEventListener('click', () => {
      const m = personById(modalUser || state.selected);
      closeModal();
      if (m) centerOn(m);
    });
    el.mRemove.addEventListener('click', () => {
      const id = modalUser;
      if (id) removeFriend(id);
    });
    el.mCopyCode.addEventListener('click', copyMyCode);

    el.mRouteOpen.addEventListener('click', () => {
      const id = modalUser;
      if (id) openRouteView(id);
    });
    el.rvClose.addEventListener('click', closeRouteView);
    el.rvBack.addEventListener('click', closeRouteView);
    el.rvTlToggle.addEventListener('click', () => setRouteTimeline(!state.routeTlOpen));
    el.rvTlHide.addEventListener('click', () => setRouteTimeline(false));
    el.rvTlList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-row]');
      if (btn) focusRouteRow(btn.getAttribute('data-row'));
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

    el.addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendFriendRequest(el.inputCode.value, { closeOnSent: true });
    });
    el.inputCode.addEventListener('input', () => {
      const pos = el.inputCode.selectionStart;
      el.inputCode.value = normalizeCode(el.inputCode.value);
      try { el.inputCode.setSelectionRange(pos, pos); } catch (e) {}
    });
    el.addClose.addEventListener('click', closeAddModal);
    el.btnCopyCode.addEventListener('click', copyMyCode);
    el.btnCopyLink.addEventListener('click', copyMyLink);

    el.btnChatBack.addEventListener('click', closeChat);
    el.btnChatLocate.addEventListener('click', () => {
      const id = state.chatWith;
      closeChat();
      const f = id ? state.friends.get(id) : null;
      if (f && f.lat != null) centerOn(f);
    });
    el.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage();
    });
    el.btnPermAsk.addEventListener('click', () => askLocation({ silent: false }));
    el.btnPermClose.addEventListener('click', () => { el.permHint.hidden = true; });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.joined) return;
      if (state.map) state.map.invalidateSize();
      renderTimes();
      refreshFeed();
      if (state.auto) askLocation({ silent: true });
    });

    window.addEventListener('online', () => { if (state.joined) { refreshFeed(); rt.connect(); } });

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
        if (state.routeView) {
          const m = personById(state.routeView);
          if (m) {
            const model = drawRouteDetail(m, { fit: true });
            if (model) { renderRouteBar(m, model); renderRouteTimeline(model); }
          }
        } else if (el.memberModal.hidden) fitToPeople(false);
      }, 260);
    });
  }

  function clearAddParam() {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has('add')) return;
      url.searchParams.delete('add');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {}
  }

  /* ───────────────────────── 22. 시작 ───────────────────────── */
  async function init() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      setTimeout(() => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      }, 1500);
    }

    bindEvents();
    updateSheetHeight();
    readBattery();

    let addCode = '';
    try { addCode = normalizeCode(new URLSearchParams(location.search).get('add') || ''); } catch (e) {}
    if (addCode) {
      el.inviteNote.hidden = false;
      el.inviteCodeLabel.textContent = addCode;
    }

    if (!READY) {
      el.joinScreen.hidden = false;
      toast('서버 설정(config.js)이 비어 있어요', 5000);
      return;
    }

    const saved = LS.get(ME_KEY, null);
    if (saved && saved.user_id && saved.secret) {
      try {
        await bootstrap(saved.nickname || '나');
        state.addAfterStart = addCode;
        await enterApp();
        return;
      } catch (e) {
        if (/unauthorized/.test(String(e.detail || e.message))) {
          LS.del(ME_KEY);
          console.warn('[우리끼리] 저장된 내 정보가 서버와 맞지 않아 새로 시작합니다');
        } else {
          console.warn('[우리끼리] 자동 시작 실패', e);
          state.addAfterStart = addCode;
          // 잠시 후 다시 시도할 수 있도록 시작 화면을 보여 준다
          el.joinScreen.hidden = false;
          toast('연결이 잠시 불안정해요 — 다시 시도해 주세요', 4200);
          if (saved.nickname) el.inputNick.value = saved.nickname;
          return;
        }
      }
    }

    state.addAfterStart = addCode;
    el.joinScreen.hidden = false;
    const lastNick = LS.get('urikkiri.lastNick', '');
    if (lastNick) el.inputNick.value = lastNick;
    setTimeout(() => { try { el.inputNick.focus(); } catch (e) {} }, 250);
  }

  window.__URIKKIRI__ = {
    state,
    api: API,
    live: READY,
    refreshFeed,
    sendFriendRequest,
    openChat,
    openMember,
    closeChat,
    closeMember: closeModal,
    history: (id) => historyFor(id).slice(),
    segments: (id) => buildSegments(historyFor(id)),
    fit: () => fitToPeople(false),
    dump: () => ({
      me: state.me ? { ...state.me } : null,
      friends: Array.from(state.friends.values()),
      incoming: state.incoming,
      outgoing: state.outgoing,
      chatWith: state.chatWith,
      errors: (window.__ERRORS__ || []).slice(),
    }),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
