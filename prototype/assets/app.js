/* ============================================================
   IMNU 校园义卖 · 原型交互逻辑
   所有状态存在 localStorage，纯前端模拟，不接任何后端。
   这里模拟的并发/幂等行为只是为了让流程可点，真实规则见 docs/
   ============================================================ */

const BZ = (() => {
  const KEY = 'imnu_bazaar_state_v1';

  /* ---------------- 状态 ---------------- */
  function blank() {
    return {
      user: null,
      items: ITEMS.map((i) => ({ ...i })),
      reservations: SEED_RESERVATIONS.map((r, idx) => {
        const seeded = {
          qty: 1,
          createdAt: Date.now(),
          redeemedAt: null,
          operator: null,
          ...r,
        };
        // 预置的已核销记录必须补一个核销时间，否则界面上会显示成「—」
        if (seeded.status === 'redeemed' && !seeded.redeemedAt) {
          seeded.redeemedAt = Date.now() - (idx + 1) * 15 * 60 * 1000;
        }
        return seeded;
      }),
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      const s = JSON.parse(raw);
      if (!s || !Array.isArray(s.items)) return blank();
      return s;
    } catch (e) {
      return blank();
    }
  }

  let state = load();

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) { /* 原型可忽略 */ }
  }

  function reset() {
    state = blank();
    save();
  }

  /* ---------------- 查询 ---------------- */
  const items = () => state.items;
  const stalls = () => STALLS;
  const item = (id) => state.items.find((i) => i.id === id) || null;
  const stall = (id) => STALLS.find((s) => s.id === id) || null;
  const stallName = (id) => (stall(id) || {}).name || '—';
  const user = () => state.user;
  const allReservations = () => state.reservations;

  const mine = () => {
    const u = user();
    if (!u) return [];
    return state.reservations.filter((r) => r.sid === u.sid);
  };

  const reservation = (id) => state.reservations.find((r) => r.id === id) || null;

  const myReservationFor = (itemId) => {
    const u = user();
    if (!u) return null;
    return state.reservations.find(
      (r) => r.itemId === itemId && r.sid === u.sid && r.status === 'reserved'
    ) || null;
  };

  /* ---------------- 身份 ---------------- */
  function signup(sid, name) {
    sid = String(sid || '').trim();
    name = String(name || '').trim();
    if (!/^\d{6,16}$/.test(sid)) return { ok: false, reason: 'sid', msg: '请输入 6–16 位数字学号' };
    if (name.length < 2) return { ok: false, reason: 'name', msg: '请输入真实姓名' };

    const dup = state.reservations.some((r) => r.sid === sid);
    if (dup) return { ok: false, reason: 'dup', msg: '该学号已登记过，请勿重复登记' };

    state.user = { sid, name, role: 'student' };
    // 预置一条已取货记录，让「已取货」分组不是空的
    state.reservations.push({
      id: 'r-' + Math.random().toString(36).slice(2, 9),
      itemId: 'i10', qty: 1, code: '603884',
      userName: name, userSid: sid, sid,
      status: 'redeemed', createdAt: Date.now() - 86400000,
      redeemedAt: Date.now() - 3600000, operator: '志愿者 陈亦航',
    });
    save();
    return { ok: true };
  }

  function isVolunteer() {
    const u = user();
    return !!u && (u.role === 'volunteer' || u.role === 'admin');
  }

  /* ---------------- 取货码 ---------------- */
  function genCode() {
    const used = new Set(state.reservations.map((r) => r.code));
    for (let n = 0; n < 200; n++) {
      let c = '';
      for (let i = 0; i < 6; i++) c += Math.floor(Math.random() * 10);
      if (!used.has(c)) return c;
    }
    return String(Date.now()).slice(-6);
  }

  /* ---------------- 预定 ---------------- */
  function reserve(itemId, qty) {
    qty = qty || 1;
    const it = item(itemId);
    if (!it) return { ok: false, reason: 'notfound', msg: '物品不存在' };
    if (!state.user) return { ok: false, reason: 'noauth', msg: '请先完成身份登记' };

    // 同一个物品只能有一笔待取货预定
    if (myReservationFor(itemId)) {
      return { ok: false, reason: 'dup', msg: '你已经预定过这件物品了' };
    }
    // 模拟服务端原子扣减的结果：名额不足即失败
    if (it.remaining < qty) {
      return { ok: false, reason: 'soldout', msg: '手慢了，名额刚刚被约满' };
    }

    it.remaining -= qty;

    const r = {
      id: 'r-' + Math.random().toString(36).slice(2, 9),
      itemId, qty, code: genCode(),
      userName: state.user.name, userSid: state.user.sid, sid: state.user.sid,
      status: 'reserved', createdAt: Date.now(),
      redeemedAt: null, operator: null,
    };
    state.reservations.push(r);
    save();
    return { ok: true, reservation: r };
  }

  function cancel(rid) {
    const r = reservation(rid);
    if (!r) return { ok: false, msg: '预定不存在' };
    if (r.status !== 'reserved') return { ok: false, msg: '该预定已无法取消' };

    r.status = 'cancelled';
    r.cancelledAt = Date.now();
    const it = item(r.itemId);
    if (it) it.remaining += r.qty; // 名额释放
    save();
    return { ok: true };
  }

  /* ---------------- 核销 ---------------- */
  function redeem(code, operator) {
    code = String(code || '').replace(/\s/g, '');
    const r = state.reservations.find((x) => x.code === code);
    if (!r) return { ok: false, reason: 'invalid', msg: '取货码不存在' };
    if (r.status === 'redeemed') {
      return { ok: false, reason: 'redeemed', msg: '该取货码已经核销过了', reservation: r };
    }
    if (r.status === 'cancelled') {
      return { ok: false, reason: 'cancelled', msg: '该预定已被学生取消', reservation: r };
    }

    r.status = 'redeemed';
    r.redeemedAt = Date.now();
    r.operator = operator || '志愿者 陈亦航';
    save();
    return { ok: true, reservation: r };
  }

  function firstPending() {
    return state.reservations.find((r) => r.status === 'reserved') || null;
  }

  function seedCodes() {
    const pending = state.reservations.find((r) => r.status === 'reserved');
    const done = state.reservations.find((r) => r.status === 'redeemed');
    return {
      pending: pending ? pending.code : null,
      done: done ? done.code : null,
    };
  }

  /* ---------------- 展示辅助 ---------------- */
  function timeText(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function clockText(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function groupCode(code) {
    return String(code || '').replace(/(\d{3})(?=\d)/g, '$1 ');
  }

  const STATUS_TEXT = {
    reserved: '待取货',
    redeemed: '已取货',
    cancelled: '已取消',
  };

  /* ---------------- 交互组件 ---------------- */
  function toast(msg, ms) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('on'), ms || 1600);
  }

  function openSheet(id) {
    const s = document.getElementById(id);
    const m = document.getElementById(id + '-mask');
    if (m) m.classList.add('on');
    if (s) s.classList.add('on');
  }

  function closeSheet(id) {
    const s = document.getElementById(id);
    const m = document.getElementById(id + '-mask');
    if (m) m.classList.remove('on');
    if (s) s.classList.remove('on');
  }

  /* 参数 */
  function param(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function go(url) {
    location.href = url;
  }

  /* 需要身份登记的页面调用它 */
  function requireUser() {
    if (!state.user) {
      const next = encodeURIComponent(location.pathname.split('/').pop() + location.search);
      location.replace('s1-signup.html?next=' + next);
      return false;
    }
    return true;
  }

  /* 伪造二维码：由取货码字符串确定性生成，仅用于原型观感 */
  function fakeQR(el, seed) {
    const N = 25, S = 6;
    let h = 2166136261;
    const seedStr = String(seed || 'seed');
    for (let i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const rnd = () => {
      h ^= h << 13; h >>>= 0;
      h ^= h >>> 17;
      h ^= h << 5;  h >>>= 0;
      return h / 4294967296;
    };
    const inFinder = (x, y) =>
      (x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7);
    const finderOn = (x, y) => {
      let lx = x, ly = y;
      if (x >= N - 7) lx = x - (N - 7);
      if (y >= N - 7) ly = y - (N - 7);
      const d = Math.min(lx, ly, 6 - lx, 6 - ly);
      return d === 0 || d === 2 || d === 3;
    };

    let cells = '';
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const on = inFinder(x, y) ? finderOn(x, y) : rnd() > 0.52;
        if (on) {
          cells += `<rect x="${x * S}" y="${y * S}" width="${S}" height="${S}" rx="1.3"/>`;
        }
      }
    }
    el.innerHTML =
      `<svg viewBox="0 0 ${N * S} ${N * S}" width="100%" height="100%" fill="#2B2119">${cells}</svg>`;
  }

  /* 演示台通过 postMessage 重置，避开 file:// 的跨源限制 */
  window.addEventListener('message', (e) => {
    if (e.data === 'bz:reset') {
      reset();
      location.href = location.pathname.indexOf('/pages/') >= 0
        ? 's2-items.html'
        : 'pages/s2-items.html';
    }
  });

  return {
    EVENT, items, stalls, item, stall, stallName, user, allReservations,
    mine, reservation, myReservationFor, isVolunteer,
    signup, reserve, cancel, redeem, firstPending, seedCodes,
    timeText, clockText, groupCode, STATUS_TEXT,
    toast, openSheet, closeSheet, param, go, requireUser, fakeQR,
    reset, save,
  };
})();
