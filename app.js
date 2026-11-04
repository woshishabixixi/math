import { GRADES, schedule, newCardState, describeInterval, buildQueue } from './srs.js';
import * as db from './db.js';

const DEFAULT_SETTINGS = { delaySec: 3, dailyNewLimit: 20, relearnGap: 3, speechRate: 1, autoSpeak: false };
const RELEARN_GAP_MIN = 2;
const MAX_SIDE = 1200;

const state = {
  route: 'review',
  cards: new Map(),
  settings: { ...DEFAULT_SETTINGS },
  streak: { lastDate: '', count: 0 },
  newDone: { date: '', count: 0 },
  queue: [],
  relearn: [],
  revealed: false,
  tipLevel: 0,
  tipAnsCount: 0,
  expandedSteps: [],
  speaking: false,
  askOpen: [],
  ready: false,
  left: 10,
  timer: null,
  editor: null,
  search: '',
  libFilter: 'all',
  importMode: 'replace',
  lastUndo: null,
  buried: [],
  buriedDate: '',
  fav: { lines: [], correct: [] },
  favTab: 'lines',
  quiz: null,
  anim: 0,
  drill: { mode: 'order', order: null, tf: null, score: { ok: 0, total: 0 } },
  run: { cur: 0, best: 0, total: 0, m3: 0, m5: 0, m10: 0 },
  sound: 'on',
};

const view = document.getElementById('view');
const toastEl = document.getElementById('toast');
const bootErrorEl = document.getElementById('boot-error');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function yesterdayKey() { const d = new Date(); d.setDate(d.getDate() - 1); return dayKey(d); }

function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 2400);
}
function bootError(msg) {
  if (!bootErrorEl) return;
  bootErrorEl.textContent = msg;
  bootErrorEl.hidden = false;
}

/* ---------- 示例题（首次打开时塞两张，让你先看见它怎么用） ---------- */
function svgCard(lines) {
  const body = lines.map((t, i) => `<text x="24" y="${44 + i * 40}" font-size="24" fill="#1f2933" font-family="sans-serif">${t}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${40 + lines.length * 40}" viewBox="0 0 640 ${40 + lines.length * 40}"><rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const SAMPLES = [
  {
    image: svgCard(['已知 x + y = 3，xy = 2，', '求 x² + y² 的值。']),
    move: '不要解出 x、y。直接把 x² + y² 改写成 (x+y)² − 2xy，再代入 3² − 2×2。',
    hint: '看到「和」与「积」同时给出',
    why: 'x²+y² 是关于和与积的对称式，用恒等变形一步到位；硬解方程会引入开方，慢且容易错。',
    tags: ['代数变形', '韦达定理'],
  },
  {
    image: svgCard(['若 a > 0，b > 0，且 a + b = 1，', '求 1/a + 1/b 的最小值。']),
    move: '先通分：1/a + 1/b = (a+b)/(ab) = 1/(ab)，问题立刻变成「求 ab 的最大值」。',
    hint: '分式相加 + 已知和 a+b=1',
    why: '分子的和是已知量，把它整体换掉，未知就只剩 ab 一个，基本不等式才有地方落地。',
    tags: ['基本不等式'],
  },
];

async function ensureSamples() {
  const done = await db.getMeta('samplesAdded', 0);
  if (done) return;
  const now = Date.now();
  const cards = SAMPLES.map((s, i) => ({
    id: 'sample-' + (i + 1),
    patternId: 'p-sample-' + (i + 1),
    patternLabel: s.tags.join('·'),
    image: s.image,
    move: s.move,
    hint: s.hint,
    why: s.why,
    tags: s.tags,
    origin: 'sample',
    bucket: 'active',
    createdAt: now,
    masteredAt: 0,
    ...newCardState(now),
  }));
  await db.putCards(cards);
  await db.setMeta('samplesAdded', 1);
}

/* ---------- 数据装载 ---------- */
async function loadAll() {
  const all = await db.getAllCards();
  state.cards = new Map(all.map((c) => [c.id, c]));
  const settings = await db.getMeta('settings', null);
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  state.streak = (await db.getMeta('streak', null)) || { lastDate: '', count: 0 };
  state.newDone = (await db.getMeta('newDone', null)) || { date: '', count: 0 };
  state.run = (await db.getMeta('run', null)) || { cur: 0, best: 0, total: 0, m3: 0, m5: 0, m10: 0 };
  state.sound = (await db.getMeta('sound', null)) || 'on';
  state.fav = (await db.getMeta('fav', null)) || { lines: [], correct: [] };
  if (!Array.isArray(state.fav.lines)) state.fav.lines = [];
  if (!Array.isArray(state.fav.correct)) state.fav.correct = [];
  const buriedMeta = await db.getMeta('buried', null);
  if (buriedMeta && buriedMeta.date === dayKey()) { state.buried = buriedMeta.ids || []; state.buriedDate = buriedMeta.date; }
}

function newDoneToday() { return state.newDone.date === dayKey() ? state.newDone.count : 0; }
function relearnGap() {
  const n = Number(state.settings.relearnGap);
  return Math.max(RELEARN_GAP_MIN, Math.min(10, Number.isFinite(n) && n ? n : 3));
}

/* ---------- 队列：交错 + 重学 ---------- */
function interleave(ids) {
  // 相邻两张若是同一模式（同一组的变式），往后找一个不同模式的换上来
  for (let i = 1; i < ids.length; i += 1) {
    const a = state.cards.get(ids[i - 1]);
    const b = state.cards.get(ids[i]);
    if (!a || !b || !a.patternId || a.patternId !== b.patternId) continue;
    for (let j = i + 1; j < ids.length; j += 1) {
      const c = state.cards.get(ids[j]);
      if (c && c.patternId !== a.patternId) {
        const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
        break;
      }
    }
  }
  return ids;
}

function rebuildQueue() {
  const tagFilter = state.settings.tagFilter || '';
  const buriedToday = state.buriedDate === dayKey() ? state.buried : [];
  const list = Array.from(state.cards.values())
    .filter((c) => !tagFilter || (c.tags || [])[0] === tagFilter)
    .filter((c) => !buriedToday.includes(c.id));
  let q = buildQueue(list, {
    now: Date.now(),
    dailyNewLimit: state.settings.dailyNewLimit,
    newDoneCount: newDoneToday(),
  }).map((c) => c.id);
  q = interleave(q);

  state.relearn = state.relearn.filter((e) => {
    const c = state.cards.get(e.id);
    return !!c && c.bucket === 'active';
  });
  for (const e of state.relearn) {
    q = q.filter((x) => x !== e.id);
    q.splice(e.gap > 0 ? Math.min(e.gap, q.length) : 0, 0, e.id);
  }
  state.queue = q;
}

function currentCard() {
  while (state.queue.length) {
    const card = state.cards.get(state.queue[0]);
    if (card && card.bucket === 'active') return card;
    state.queue.shift();
  }
  return null;
}

/* ---------- 倒计时 ---------- */
function stopTimer() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}
function startCountdown() {
  stopTimer();
  const sec = Math.max(0, Number(state.settings.delaySec) || 0);
  state.ready = sec === 0;
  state.left = sec;
  if (state.ready) return;
  state.timer = setInterval(() => {
    state.left -= 1;
    if (state.left <= 0) {
      state.left = 0;
      state.ready = true;
      stopTimer();
    }
    const btn = document.getElementById('reveal-btn');
    if (btn) {
      btn.textContent = state.ready ? '看详解' : '先自己想 · 还剩 ' + state.left + ' 秒';
      btn.classList.toggle('is-ready', state.ready);
      btn.disabled = !state.ready;
    }
  }, 1000);
}
/* ---------- 朗读：用浏览器自带语音合成，离线可用 ---------- */
function speechReady() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}
function cleanForSpeech(raw) {
  return String(raw || '')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g, '。')
    .replace(/\*\*/g, '')
    .replace(/C₆H₁₂O₆|C6H12O6/g, '葡萄糖')
    .replace(/\[H\]/g, '还原氢')
    .replace(/CO₂|CO2/g, '二氧化碳')
    .replace(/H₂O|H2O/g, '水')
    .replace(/O₂|O2(?![a-z])/g, '氧气')
    .replace(/→|->/g, '生成')
    .replace(/\+/g, '加')
    .replace(/[=＝]/g, '等于')
    .replace(/²/g, '的平方')
    .replace(/√/g, '根号')
    .replace(/\s*\n+\s*/g, '。')
    .replace(/。{2,}/g, '。')
    .replace(/\s+/g, ' ')
    .trim();
}
let currentAudio = null;
function stopAudio() {
  if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
}
function playAudioUrl(url) {
  if (!url) return false;
  stopAudio();
  if (speechReady()) window.speechSynthesis.cancel();
  currentAudio = new Audio(url);
  currentAudio.onended = () => {
    state.speaking = false;
    const b = document.getElementById('spk-stop');
    if (b) b.hidden = true;
  };
  currentAudio.play().catch(() => { toast('音频播放失败，改用系统语音'); });
  state.speaking = true;
  return true;
}
function stopSpeak() {
  stopAudio();
  if (speechReady()) window.speechSynthesis.cancel();
  state.speaking = false;
}
function speakText(raw) {
  if (!speechReady()) { toast('这个浏览器不支持朗读，换 Chrome 试试'); return; }
  const text = cleanForSpeech(raw);
  if (!text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = Number(state.settings.speechRate) || 1;
  u.onend = () => { state.speaking = false; const b = document.getElementById('spk-stop'); if (b) b.hidden = true; };
  state.speaking = true;
  window.speechSynthesis.speak(u);
}

function resetCardState() {
  stopSpeak();
  state.revealed = false;
  state.tipLevel = 0;
  state.tipAnsCount = 0;
  state.expandedSteps = [];
  state.askOpen = [];
  stopTimer();
  startCountdown();
}

/* ---------- 写入 ---------- */
async function persist(card) {
  state.cards.set(card.id, card);
  await db.putCard(card);
}
function bumpNewDone() {
  const today = dayKey();
  const count = (state.newDone.date === today ? state.newDone.count : 0) + 1;
  state.newDone = { date: today, count };
  db.setMeta('newDone', state.newDone);
}
function bumpStreak() {
  const today = dayKey();
  if (state.streak.lastDate === today) return;
  const count = state.streak.lastDate === yesterdayKey() ? state.streak.count + 1 : 1;
  state.streak = { lastDate: today, count };
  db.setMeta('streak', state.streak);
}

async function gradeCard(g) {
  const card = currentCard();
  if (!card) return;
  const wasNew = card.state === 'new';
  // 撤销快照：评分前把卡片与计数状态整份存下来，按 U 可以整份还原
  state.lastUndo = {
    card: JSON.parse(JSON.stringify(card)),
    wasNew,
    newDone: { ...state.newDone },
    relearn: JSON.parse(JSON.stringify(state.relearn)),
    grade: g,
  };
  const patched = { ...card, ...schedule(card, g, Date.now()) };
  await persist(patched);
  db.logReview({ id: card.id, grade: g });
  if (wasNew) bumpNewDone();
  bumpStreak();
  if (g === GRADES.GOOD) {
    state.relearn = state.relearn.filter((e) => e.id !== card.id);
  } else {
    const gap = relearnGap();
    const hit = state.relearn.find((e) => e.id === card.id);
    if (hit) hit.gap = gap; else state.relearn.push({ id: card.id, gap });
  }
  state.relearn.forEach((e) => { if (e.id !== card.id) e.gap = Math.max(0, e.gap - 1); });
  rebuildQueue();
  resetCardState();
  render();
}

async function undoLast() {
  const u = state.lastUndo;
  if (!u) { toast('没有可撤销的操作'); return; }
  await persist(u.card);
  state.newDone = { ...u.newDone };
  await db.setMeta('newDone', state.newDone);
  state.relearn = u.relearn;
  state.lastUndo = null;
  rebuildQueue();
  state.queue = [u.card.id].concat(state.queue.filter((x) => x !== u.card.id));
  state.revealed = true;
  render();
  toast('已撤销上一次评分');
}

async function buryCurrent() {
  const card = currentCard();
  if (!card) return;
  const today = dayKey();
  if (state.buriedDate !== today) { state.buried = []; state.buriedDate = today; }
  if (!state.buried.includes(card.id)) state.buried.push(card.id);
  await db.setMeta('buried', { date: state.buriedDate, ids: state.buried });
  rebuildQueue();
  resetCardState();
  render();
  toast('这张今天不再出现');
}

async function masterCard(id) {
  const card = state.cards.get(id);
  if (!card) return;
  await persist({ ...card, bucket: 'mastered', masteredAt: Date.now() });
  state.relearn = state.relearn.filter((e) => e.id !== id);
  rebuildQueue();
  resetCardState();
  render();
  toast('已移出训练 · 在「题库 → 已会」里可以恢复');
}
async function restoreCard(id) {
  const card = state.cards.get(id);
  if (!card) return;
  const now = Date.now();
  await persist({ ...card, bucket: 'active', state: 'review', step: 2, due: now, interval: 1, ef: Math.max(card.ef || 2.5, 1.3) });
  rebuildQueue();
  render();
  toast('已回到队列');
}

/* ---------- 视图 ---------- */
function renderStats() {
  const now = Date.now();
  const active = Array.from(state.cards.values()).filter((c) => c.bucket === 'active');
  const due = active.filter((c) => c.state !== 'new' && c.due <= now).length;
  const fresh = active.filter((c) => c.state === 'new').length;
  const left = Math.max(0, state.settings.dailyNewLimit - newDoneToday());
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  set('stat-due', due);
  set('stat-new', Math.min(fresh, left));
  set('stat-streak', state.streak.lastDate === dayKey() || state.streak.lastDate === yesterdayKey() ? state.streak.count : 0);
}

/** 把挤在一行的 A./B. 选项拆成每行一个；①②③ 小题同理；已经是多行的保持原样 */
function formatStem(text) {
  if (!text) return '';
  let s = String(text).replace(/\r\n?/g, '\n');
  s = s.replace(/([^\n])\s*([A-D])[.．]\s*/g, (m, before, letter) => before + '\n' + letter + '. ');
  s = s.replace(/([^\n])\s*([①②③④⑤⑥])/g, (m, before, mark) => before + '\n' + mark);
  return s.replace(/\n{2,}/g, '\n').trim();
}

/** 把一段解析拆成「步骤」：①②③ 或 1. 开头算新步骤，缩进续行归上一步 */
function cardSteps(card) {
  if (card && Array.isArray(card.steps) && card.steps.length) return card.steps;
  const raw = formatStem(card && card.move ? card.move : '');
  const groups = [];
  const MARK = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const startsNew = MARK.test(line.trim()) || /^\d+[.、]/.test(line.trim()) || !/^\s/.test(line);
    if (!groups.length || startsNew) groups.push([line]);
    else groups[groups.length - 1].push(line);
  }
  return groups.map((g, i) => {
    const full = g.join('\n');
    const bare = full.replace(MARK, '').trim();
    const colon = bare.search(/[：:]/);
    let brief;
    if (colon > 0 && colon <= 18) brief = bare.slice(0, colon);
    else brief = bare.slice(0, 16) + (bare.length > 16 ? '…' : '');
    if (card && Array.isArray(card.stepBriefs) && card.stepBriefs[i]) brief = card.stepBriefs[i];
    return { brief, detail: full };
  });
}

/** 取一张卡的多层提示：优先用 tips 数组，兼容旧的 tip / tip2 字段 */
function cardTips(card) {
  if (!card) return [];
  if (Array.isArray(card.tips) && card.tips.length) return card.tips.filter(Boolean);
  return [card.tip, card.tip2].filter(Boolean);
}

/** 「你来补完」的问句与对应答案 */
function cardAsks(card) {
  const qs = formatStem(card && card.ask ? card.ask : '').split('\n').map((s) => s.trim()).filter(Boolean);
  const as = card && Array.isArray(card.askAnswers) ? card.askAnswers : [];
  return qs.map((q, i) => ({ q, a: as[i] || '' }));
}

/** 每层提示对应的「这条提示的答案」 */
function cardTipAnswers(card) {
  return card && Array.isArray(card.tipAnswers) ? card.tipAnswers.filter(Boolean) : [];
}

/** 顶部「知识点分类」筛选条：全部 / 各知识点（带数量） */
function basicsLines(card) {
  return String(card.basics || '')
    .split(/\n+/)
    .map((s) => s.replace(/^\s*[①-⑳]\s*/, '').trim())
    .filter(Boolean);
}

function favKey(cardId, text) { return cardId + '|' + text; }

function stepLines(card) {
  return cardSteps(card).map((s) => String(s.detail || '').replace(/^\s*[①-⑳]\s*/, '').trim()).filter(Boolean);
}

function askLines(card) {
  return cardAsks(card).map((it) => String(it.q || '').trim()).filter(Boolean);
}

function askAnswerAt(card, idx) {
  const as = cardAsks(card);
  return (as[Number(idx)] || {}).a || '';
}

function favText(card, kind, idx) {
  const lines = kind === 'step' ? stepLines(card) : kind === 'ask' ? askLines(card) : basicsLines(card);
  return lines[Number(idx)] || '';
}

function starBtn(cardId, kind, idx, text) {
  const on = state.fav.lines.some((f) => f.key === favKey(cardId, text));
  return '<button class="star' + (on ? ' on' : '') + '" data-action="fav-line" data-id="' + esc(cardId)
    + '" data-kind="' + kind + '" data-i="' + esc(idx) + '" type="button" title="收藏这条">'
    + (on ? '★' : '☆') + '</button>';
}

function renderBasics(card) {
  const lines = basicsLines(card);
  if (!lines.length) return esc(formatStem(card.basics));
  return lines.map((t, i) => '<div class="bline">'
    + starBtn(card.id, 'basic', i, t)
    + '<span>' + esc(formatStem(t)) + '</span></div>').join('');
}

async function toggleFavLine(cardId, idx, kind) {
  const card = state.cards.get(cardId);
  if (!card) return;
  const kindName = kind === 'step' ? 'step' : kind === 'ask' ? 'ask' : 'basic';
  const text = favText(card, kindName, idx);
  if (!text) return;
  const key = favKey(cardId, text);
  const at = state.fav.lines.findIndex((f) => f.key === key);
  if (at >= 0) {
    state.fav.lines.splice(at, 1);
    toast('已取消收藏');
  } else {
    state.fav.lines.unshift({ key, cardId, text, kind: kindName, answer: card.answer || '', stem: card.stem || '', ans: kindName === 'ask' ? askAnswerAt(card, idx) : '' });
    toast('已收藏 · 可去「收藏 → 填空」练');
  }
  await db.setMeta('fav', state.fav);
  render();
}

function quizPool() {
  // 题库只从收藏的要点里出；干扰项优先取同一分类的其它卡
  return state.fav.lines.map((f) => {
    const card = state.cards.get(f.cardId);
    return { ...f, tag: (card && (card.tags || [])[0]) || '' };
  });
}

function buildQuiz() {
  const pool = quizPool();
  if (pool.length < 2) { state.quiz = { error: 'short' }; return; }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const own = pick.stem || (state.cards.get(pick.cardId) || {}).stem || '';
  const short = (s) => String(s || '').replace(/\s+/g, '').replace(/[？?。].*$/, '').slice(0, 18);
  const right = short(own);
  const same = Array.from(state.cards.values())
    .filter((c) => c.id !== pick.cardId && short(c.stem) && short(c.stem) !== right)
    .filter((c) => ((c.tags || [])[0] || '') === pick.tag);
  const other = Array.from(state.cards.values())
    .filter((c) => c.id !== pick.cardId && short(c.stem) && short(c.stem) !== right);
  const pool2 = same.length >= 3 ? same : other;
  const distract = [];
  const used = new Set([right]);
  const shuffled = pool2.sort(() => Math.random() - 0.5);
  for (const c of shuffled) {
    const s = short(c.stem);
    if (used.has(s)) continue;
    used.add(s); distract.push(s);
    if (distract.length === 3) break;
  }
  const options = [right, ...distract].sort(() => Math.random() - 0.5);
  state.quiz = { item: pick, options, right, picked: null, done: false };
}

function renderFav() {
  const tab = (k, label, n) => '<button class="lib-tab' + (state.favTab === k ? ' on' : '') + '" data-action="fav-tab" data-f="' + k + '" type="button">' + label + ' ' + n + '</button>';
  const kindTag = (k) => '<span class="tag">' + (k === 'step' ? '详解' : k === 'ask' ? '自测' : '要点') + '</span>';
  const lines = state.fav.lines.map((f) => '<div class="fav-card"><div class="fav-head"><b>' + kindTag(f.kind) + esc((f.stem || '').slice(0, 24)) + '</b>'
    + '<button class="btn" data-action="unfav" data-key="' + esc(f.key) + '" type="button">取消</button></div>'
    + '<div class="fav-line">' + esc(f.text) + '</div>'
    + (f.ans ? '<div class="fav-line dim">答：' + esc(f.ans) + '</div>' : '')
    + '</div>').join('');
  const correct = state.fav.correct.map((f) => '<div class="fav-card"><div class="fav-head"><b>' + esc((f.stem || '').slice(0, 24)) + '</b>'
    + '<button class="btn" data-action="unfav-correct" data-key="' + esc(f.key) + '" type="button">移出</button></div>'
    + '<div class="fav-line">' + esc(f.text) + '</div></div>').join('');
  view.innerHTML = '<div class="lib-tabs">' + tab('lines', '要点收藏', state.fav.lines.length) + tab('correct', '答对列表', state.fav.correct.length) + '</div>'
    + '<div class="quiz-entry"><button class="btn primary" data-action="start-quiz" type="button">开始填空练习</button>'
    + '<span class="dim">从收藏里出题：给一句要点或自测问句，选出它属于哪张卡</span>'
    + '<div class="drill-entry"><button class="btn" data-action="start-drill" data-m="order" type="button">排序练习</button>'
    + '<button class="btn" data-action="start-drill" data-m="tf" type="button">判断对错</button></div></div>'
    + (state.favTab === 'lines'
      ? (lines || '<div class="empty"><strong>还没有收藏</strong>卡片里每条要点、详解步骤、自测问句左边都有 ☆，点一下就能收藏。</div>')
      : (correct || '<div class="empty"><strong>还没有答对记录</strong>去填空练习答对，就会进到这里。</div>'));
}

function renderQuiz() {
  const q = state.quiz;
  if (!q || q.error === 'short') {
    view.innerHTML = '<div class="empty"><strong>收藏还不够出题</strong>至少收藏 2 条再来。'
      + '<br><button class="btn primary" data-action="go-fav" type="button" style="margin-top:10px">去收藏</button></div>';
    return;
  }
  const opts = q.options.map((o, i) => {
    let cls = 'qopt';
    if (q.done) {
      if (o === q.right) cls += ' right';
      else if (o === q.picked) cls += ' wrong';
    }
    return '<button class="' + cls + '" data-action="pick" data-o="' + i + '" type="button"'
      + (q.done ? ' disabled' : '') + '>' + String.fromCharCode(65 + i) + '　' + esc(o) + '</button>';
  }).join('');
  view.innerHTML = streakBadgeHtml() + '<div class="quiz-head">这句要点说的是哪一项？</div>'
    + '<div class="quiz-sentence">' + esc(q.item.text) + '</div>'
    + '<div class="quiz-opts">' + opts + '</div>'
    + (q.done
      ? '<div class="quiz-result">' + (q.picked === q.right ? '✅ 答对了 · 已加入答对列表' : '❌ 正确答案：' + esc(q.right))
        + '</div><div class="quiz-actions"><button class="btn primary" data-action="next-quiz" type="button">下一题</button>'
        + jumpBtn(q.item.cardId)
        + '<button class="btn" data-action="go-review" type="button">回去背卡</button></div>'
      : '')
    + (q.done ? '<div class="quiz-answer">核心答案：' + esc((q.item.answer || '').slice(0, 120)) + '</div>' : '');
}

async function pickOption(i) {
  const q = state.quiz;
  if (!q || q.done) return;
  const picked = q.options[i];
  q.picked = picked; q.done = true;
  if (picked === q.right) {
    const key = q.item.key;
    if (!state.fav.correct.some((f) => f.key === key)) {
      state.fav.correct.unshift({ ...q.item });
    }
    state.fav.lines = state.fav.lines.filter((f) => f.key !== key);
    await db.setMeta('fav', state.fav);
    runAnswer(true);
    celebrate();
  }
  renderQuiz();
}

function cardTerm(card) {
  return card.term || String(card.stem || '').replace(/[？?].*$/, '').trim().slice(0, 14) || '这张卡';
}

function drillPool() {
  return Array.from(state.cards.values()).filter((c) => c.bucket !== 'mastered');
}

function buildOrder() {
  // 只出「步骤有真实先后」的卡（显式标了 orderSteps 的），避免把辨析要点当流程排
  const pool = drillPool().filter((c) => Array.isArray(c.orderSteps) && c.orderSteps.length >= 3);
  if (!pool.length) { state.drill.order = { error: 'short' }; return; }
  const card = pool[Math.floor(Math.random() * pool.length)];
  const right = card.orderSteps.map((x) => String(x).trim());
  const items = right.slice().sort(() => Math.random() - 0.5);
  state.drill.order = { cardId: card.id, term: cardTerm(card), stem: card.stem || '', items, right, picked: [], done: false, ok: false };
}


function tfTricks(line, pool, card, term) {
  const tricks = [];
  const swap = (from, to, note) => {
    if (line.includes(from)) tricks.push({ text: line.split(from).join(to), note });
  };
  swap('不一定', '一定', '把「不一定」说成了「一定」');
  swap('没有', '有', '把「没有」说成了「有」');
  swap('不能', '能', '把「不能」说成了「能」');
  swap('不是', '是', '把「不是」说成了「是」');
  swap('无关', '有关', '把「无关」说成了「有关」');
  swap('必须', '不必', '把「必须」说成了「不必」');
  swap('需要', '不需要', '把「需要」说成了「不需要」');
  swap('含有', '不含', '把「含有」说成了「不含」');
  swap('都能', '都不能', '把「都能」说成了「都不能」');
  swap('都可以', '都不可以', '把「都可以」说成了「都不可以」');
  swap('升高', '降低', '把「升高」说成了「降低」');
  swap('降低', '升高', '把「降低」说成了「升高」');
  swap('促进', '抑制', '把「促进」说成了「抑制」');
  swap('抑制', '促进', '把「抑制」说成了「促进」');
  swap('兴奋', '抑制', '把「兴奋」说成了「抑制」');
  swap('大于', '小于', '把「大于」说成了「小于」');
  swap('小于', '大于', '把「小于」说成了「大于」');
  swap('高于', '低于', '把「高于」说成了「低于」');
  swap('增加', '减少', '把「增加」说成了「减少」');
  swap('减少', '增加', '把「减少」说成了「增加」');
  swap('全部', '部分', '把「全部」说成了「部分」');
  swap('等于', '大于', '把「等于」说成了「大于」');
  swap('反比', '正比', '把「反比」说成了「正比」');
  swap('正比', '反比', '把「正比」说成了「反比」');
  swap('无核膜', '有核膜', '把「无核膜」说成了「有核膜」');
  swap('越暗', '越亮', '把「越暗」说成了「越亮」');
  swap('越亮', '越暗', '把「越亮」说成了「越暗」');
  swap('越大', '越小', '把「越大」说成了「越小」');
  swap('越小', '越大', '把「越小」说成了「越大」');
  swap('越少', '越多', '把「越少」说成了「越多」');
  swap('越多', '越少', '把「越多」说成了「越少」');
  // 只是把一个整体名词换成另一个（如「原核」↔「真核」），换成后仍是通顺句子
  const pairs = [['原核', '真核'], ['真核', '原核'], ['光能自养', '化能自养'], ['异养', '自养'], ['自养', '异养']];
  for (const [a, b] of pairs) swap(a, b, '把「' + a + '」说成了「' + b + '」');
  const m = line.match(/[0-9]+/);
  if (m) {
    const n2 = String(Number(m[0]) + 1);
    tricks.push({ text: line.replace(m[0], n2), note: '数字从 ' + m[0] + ' 改成了 ' + n2 });
  }
  return tricks;
}

function buildTF() {
  const pool = drillPool();
  if (pool.length < 2) { state.drill.tf = { error: 'short' }; return; }
  const card = pool[Math.floor(Math.random() * pool.length)];
  const term = cardTerm(card);
  const all = basicsLines(card);
  if (!all.length) { state.drill.tf = { error: 'short' }; return; }
  const scored = all.map((l) => ({ line: l, tricks: tfTricks(l, pool, card, term) }));
  const withTricks = scored.filter((x) => x.tricks.length);
  // 有时优先挑「能被改坏」的那句，这样错句比例高、题目更像真题
  const preferFalse = withTricks.length > 0 && Math.random() < 0.75;
  const base = preferFalse
    ? withTricks[Math.floor(Math.random() * withTricks.length)]
    : scored[Math.floor(Math.random() * scored.length)];
  const useFalse = base.tricks.length > 0 && Math.random() < 0.8;
  const picked = useFalse ? base.tricks[Math.floor(Math.random() * base.tricks.length)] : null;
  state.drill.tf = {
    cardId: card.id, term, statement: picked ? picked.text : base.line, truth: base.line,
    isTrue: !picked, wrongTerm: '', note: picked ? picked.note : '',
    done: false, ok: false, picked: null,
  };
}


function startDrill(mode) {
  state.drill.mode = mode;
  if (mode === 'order') buildOrder(); else buildTF();
  state.route = 'drill';
  render();
}

function renderDrill() {
  const mode = state.drill.mode || 'order';
  const tab = (k, label) => '<button class="lib-tab' + (mode === k ? ' on' : '') + '" data-action="drill-mode" data-m="' + k + '" type="button">' + label + '</button>';
  const head = '<div class="lib-tabs">' + tab('order', '排序题') + tab('tf', '判断对错') + '</div>';
  const body = mode === 'order' ? renderOrderBody() : renderTFBody();
  view.innerHTML = head + body;
}

function renderOrderBody() {
  const o = state.drill.order;
  if (!o || o.error) {
    return '<div class="empty"><strong>排序题暂时出不了</strong>'
      + '排序题只从「有明确先后步骤」的卡出题（如实验流程、生理过程），现在题库里还没有这类卡。<br>'
      + '<span class="dim">请用「合并导入」导入最新的 bio-deck 文件（含流程数据）。</span><br>'
      + '<button class="btn primary" data-action="drill-mode" data-m="tf" type="button" style="margin-top:10px">先做判断对错</button></div>';
  }
  const list = o.items.map((t) => {
    const at = o.picked.indexOf(t);
    return '<button class="order-item' + (at >= 0 ? ' picked' : '') + '" data-action="order-pick" data-t="' + esc(t) + '" type="button"'
      + (o.done ? ' disabled' : '') + '>' + (at >= 0 ? '<b>' + (at + 1) + '</b>' : '<b class="dim-num">·</b>')
      + '<span>' + esc(t) + '</span></button>';
  }).join('');
  const right = o.done
    ? '<div class="order-right"><h3>正确顺序</h3>' + o.right.map((t, i) => '<div class="order-line"><b>' + (i + 1) + '</b><span>' + esc(t) + '</span></div>').join('') + '</div>'
    : '';
  return streakBadgeHtml() + '<div class="quiz-head">按正确顺序点击步骤 · ' + esc(o.term) + '</div>'
    + '<div class="order-list">' + list + '</div>'
    + (o.done
      ? '<div class="quiz-result">' + (o.ok ? '✅ 顺序全对' : '❌ 顺序不对，看下面的正确顺序') + '</div>' + right
      : '<div class="quiz-actions"><button class="btn primary" data-action="order-check" type="button"'
        + (o.picked.length === o.items.length ? '' : ' disabled') + '>检查顺序</button>'
        + '<button class="btn" data-action="order-reset" type="button">重新点</button></div>')
    + '<div class="quiz-actions"><button class="btn" data-action="drill-next" type="button">下一题</button>'
    + (o.done ? jumpBtn(o.cardId) : '') + '</div>';
}

function renderTFBody() {
  const t = state.drill.tf;
  if (!t || t.error) return '<div class="empty"><strong>题量还不够</strong>至少要有两张卡。</div>';
  const back = t.done
    ? '<div class="tf-explain"><div class="quiz-result">' + (t.ok ? '✅ 判断正确' : '❌ 判断错了') + '</div>'
      + '<div class="tf-truth">这句说的是<b>' + esc(t.term) + '</b>。正确表述：' + esc(t.truth) + '</div>'
      + (t.isTrue ? '' : '<div class="tf-truth dim">错在：' + esc(t.note) + '</div>') + '</div>'
    : '';
  return streakBadgeHtml() + '<div class="quiz-head">这句话对不对？</div>'
    + '<div class="quiz-sentence">' + esc(t.statement) + '</div>'
    + '<div class="tf-actions">'
    + '<button class="qopt tf-btn' + (t.done && t.picked === true ? (t.isTrue ? ' right' : ' wrong') : '') + '" data-action="tf-pick" data-v="1" type="button"' + (t.done ? ' disabled' : '') + '>✔ 对</button>'
    + '<button class="qopt tf-btn' + (t.done && t.picked === false ? (t.isTrue ? ' wrong' : ' right') : '') + '" data-action="tf-pick" data-v="0" type="button"' + (t.done ? ' disabled' : '') + '>✘ 错</button>'
    + '</div>' + back
    + '<div class="quiz-actions"><button class="btn primary" data-action="drill-next" type="button">下一题</button>'
    + (t.done ? jumpBtn(t.cardId) : '') + '</div>';
}

function drillEntryHtml() {
  return '<div class="drill-entry">'
    + '<button class="btn" data-action="start-drill" data-m="order" type="button">排序练习</button>'
    + '<button class="btn" data-action="start-drill" data-m="tf" type="button">判断对错</button>'
    + '<button class="btn" data-action="start-quiz" type="button">填空练习</button></div>';
}

function renderTagBar() {
  const active = Array.from(state.cards.values()).filter((c) => c.bucket !== 'mastered');
  const counts = new Map();
  for (const c of active) {
    const k = (c.tags || [])[0] || '未分类';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const cur = state.settings.tagFilter || '';
  const chip = (key, label, n) =>
    '<button class="tag-chip' + (cur === key ? ' on' : '') + '" data-action="set-tag" data-tag="' + esc(key) + '" type="button">'
    + esc(label) + '<span class="tag-n">' + n + '</span></button>';
  let html = '<div class="tag-bar">' + chip('', '全部', active.length);
  for (const [k, n] of counts) html += chip(k, k, n);
  html += '</div>';
  return html;
}

function renderReview() {
  const card = currentCard();
  if (!card) {
    const cur = state.settings.tagFilter || '';
    view.innerHTML = renderTagBar()
      + (cur
        ? '<div class="empty"><strong>「' + esc(cur) + '」这一类今天没有要背的卡了</strong>'
          + '换一类继续，或者回「全部」看看。<br>'
          + '<button class="btn primary" data-action="set-tag" data-tag="" type="button" style="margin-top:10px">看全部</button>'
          + '<div class="dim" style="margin-top:14px">今天背完了，可以做练习巩固：</div>'
          + drillEntryHtml() + '</div>'
        : '<div class="empty"><strong>今天没有要背的卡了</strong>'
          + '去「题库 → 合并导入」把题库导进来。<br><span class="dim">导入后这里会按分类显示今天要背的卡片。</span>'
          + '<div class="dim" style="margin-top:14px">也可以先做练习：</div>'
          + drillEntryHtml() + '</div>');
    return;
  }
  const revealed = state.revealed;
  const steps = cardSteps(card);
  const tags = (card.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
  // 图和文字可以同时存在：图在上、题面在下
  const face = (card.image ? '<img class="shot" src="' + card.image + '" alt="题图">' : '')
    + (card.stem ? '<div class="stem">' + esc(formatStem(card.stem)) + '</div>' : (card.image ? '' : '<div class="stem">（无题干）</div>'));
  const problemBlock = '<div class="problem">' + face + '</div>';
  const doneToday = Array.from(state.cards.values())
    .filter((c) => c.lastReviewAt && dayKey(new Date(c.lastReviewAt)) === dayKey()).length;
  const totalToday = doneToday + state.queue.length;
  const pct = totalToday ? Math.round((doneToday / totalToday) * 100) : 0;
  view.innerHTML = renderTagBar()
    + '<div class="today-bar"><div class="today-fill" style="width:' + pct + '%"></div></div>'
    + drillEntryHtml()
    + '<div class="today-text">今日进度 ' + doneToday + ' / ' + totalToday
    + (state.lastUndo ? '　<span class="undo-tip">按 U 撤销上一步</span>' : '') + '</div>'
    // 翻开解法后，题面变成悬浮窗（宽屏浮在左侧、窄屏吸顶），方便边看解析边瞟题
    + (revealed ? '<div class="float-stem"><div class="float-tag">题目</div>' + problemBlock + '</div>' : problemBlock)
    + '<div class="control">'
    + (revealed
      ? '<div class="answer">'
        + (cardTips(card).length
          ? '<div class="tip-in-answer"><span>当时的提示（共 ' + cardTips(card).length + ' 层）</span>'
            + cardTips(card).map((s, i) => '<div class="tipline"><b>' + (i + 1) + '</b>' + esc(formatStem(s))
                + (cardTipAnswers(card)[i] ? '<div class="tipans-inline">→ ' + esc(formatStem(cardTipAnswers(card)[i])) + '</div>' : '')
                + '</div>').join('')
            + '</div>'
          : '')
        + (card.answer ? '<div class="answer-line"><span>答案</span>' + esc(card.answer)
            + '<button class="spk" data-action="speak-answer" type="button" title="朗读答案">🔊</button></div>' : '')
        + '<div class="speak-row">'
        + '<button class="spk-btn" data-action="speak-all" type="button">🔊 连读：答案 + 要点</button>'
        + '<button class="spk-btn ghost" data-action="stop-speak" id="spk-stop" type="button" hidden>停止</button>'
        + '<button class="spk-btn auto' + (state.settings.autoSpeak ? ' on' : '') + '" data-action="toggle-auto-speak" type="button">'
        + (state.settings.autoSpeak ? '🔁 自动播放：开' : '🔁 自动播放：关') + '</button>'
        + '</div>'
        + (card.basics ? '<div class="basics"><div class="move-label">要点<button class="spk small" data-action="speak-basics" type="button" title="朗读要点">🔊</button></div><div class="basics-body">' + renderBasics(card) + '</div></div>' : '')
        + '<div class="move-label">展开详解（共 ' + steps.length + ' 步 · 卡住哪步点哪步）</div>'
        + '<div class="steps">'
        + steps.map((s, i) => {
            const open = state.expandedSteps.indexOf(i) >= 0;
            return '<div class="step' + (open ? ' is-open' : '') + '">'
              + '<div class="step-head">'
              + starBtn(card.id, 'step', i, favText(card, 'step', i))
              + '<span class="step-title">' + esc(s.brief) + '</span>'
              + '<button class="step-btn" data-action="toggle-step" data-i="' + i + '" type="button">' + (open ? '收起' : '展开') + '</button>'
              + '</div>'
              + (open ? '<div class="step-detail">' + esc(s.detail) + '</div>' : '')
              + '</div>';
          }).join('')
        + '</div>'
        + (steps.length > 1
          ? '<button class="move-toggle" data-action="steps-all" type="button">'
            + (state.expandedSteps.length >= steps.length ? '全部收起' : '全部展开')
            + '</button>'
          : '')
        + (cardAsks(card).length
          ? '<div class="ask"><div class="ask-label">自测 · 先自己回答，答完点「看答案」</div>'
            + cardAsks(card).map((it, i) => {
                const open = state.askOpen.indexOf(i) >= 0;
                return '<div class="ask-item">'
                  + '<div class="ask-q">' + starBtn(card.id, 'ask', i, it.q) + '<span>' + esc(it.q) + '</span>'
                  + (it.a ? '<button class="step-btn" data-action="toggle-ask" data-i="' + i + '" type="button">' + (open ? '收起' : '看答案') + '</button>' : '<span class="ask-na">暂无</span>')
                  + '</div>'
                  + (open ? '<div class="ask-a">' + esc(it.a) + '</div>' : '')
                  + '</div>';
              }).join('')
            + '</div>'
          : '')
        + (card.hint ? '<div class="line"><b>线索</b><div class="line-body">' + esc(formatStem(card.hint)) + '</div></div>' : '')
        + (card.why ? '<div class="line"><b>为什么</b><div class="line-body">' + esc(formatStem(card.why)) + '</div></div>' : '')
        + (tags ? '<div class="tags">' + tags + '</div>' : '')
        + '</div>'
      : '<button id="reveal-btn" class="reveal" data-action="reveal" type="button"' + (state.ready ? '' : ' disabled') + '>'
        + (state.ready ? '看完整解法' : '先自己想 · 还剩 ' + state.left + ' 秒') + '</button>'
        + '<div class="tip-row">'
        + (state.tipLevel < cardTips(card).length
          ? '<button class="tip-btn" data-action="tip" type="button">'
            + (state.tipLevel === 0
              ? '还是没头绪？先看提示（共 ' + cardTips(card).length + ' 层）'
              : '再看下一条（剩 ' + (cardTips(card).length - state.tipLevel) + '）')
            + '</button>'
          : '')
        + (state.tipLevel > 0 && state.tipAnsCount < state.tipLevel && cardTipAnswers(card)[state.tipLevel - 1]
          ? '<button class="tip-ans-btn" data-action="tip-answer" type="button">这条提示的答案</button>'
          : '')
        + '</div>'
        + cardTips(card).slice(0, state.tipLevel).map((s, i) =>
            '<div class="tip"><span>提示 ' + (i + 1) + ' / ' + cardTips(card).length + '</span>' + esc(formatStem(s))
            + (i < state.tipAnsCount && cardTipAnswers(card)[i]
              ? '<div class="tip-ans"><b>答案</b>' + esc(formatStem(cardTipAnswers(card)[i])) + '</div>'
              : '')
            + '</div>').join('')
        + '<div class="hint-line">先在脑子里说出「第一步做什么」，再点提示或看解法</div>'
        + '<div class="speak-row"><button class="spk-btn auto' + (state.settings.autoSpeak ? ' on' : '') + '" data-action="toggle-auto-speak" type="button">'
        + (state.settings.autoSpeak ? '🔁 自动播放：开（翻开答案就朗读）' : '🔁 自动播放：关（翻开答案不朗读）') + '</button></div>')
    + '</div>'
    + '<div class="grade-bar">'
    + '<button class="grade" data-action="grade" data-g="0" type="button">没头绪<em>1</em></button>'
    + '<button class="grade" data-action="grade" data-g="1" type="button">想到方向<em>2</em></button>'
    + '<button class="grade" data-action="grade" data-g="2" type="button">秒出第一步<em>3</em></button>'
    + '<button class="grade bury" data-action="bury" type="button">今天<br>不再出现<em>B</em></button>'
    + '</div>'
    + '<div class="row-actions">'
    + (state.lastUndo ? '<button class="link-btn undo" data-action="undo" type="button">↩ 撤销上一步（U）</button>' : '')
    + '<button class="link-btn" data-action="master" type="button">这条已经会了 · 移出</button>'
    + '<span class="dim kbd">快捷键：1/2/3 评分 · 空格 看详解 · B 藏起 · U 撤销</span>'
    + '</div>';
}

function renderLibrary() {
  const q = state.search.trim();
  const all = Array.from(state.cards.values());
  const nActive = all.filter((c) => c.bucket !== 'mastered').length;
  const nMastered = all.filter((c) => c.bucket === 'mastered').length;
  const f = state.libFilter || 'all';
  const list = all
    .filter((c) => {
      if (f === 'all') return true;
      if (f === 'mastered') return c.bucket === 'mastered';
      if (f === 'hard') return c.bucket !== 'mastered' && (c.lapses || 0) >= 3;
      return c.bucket !== 'mastered';
    })
    .filter((c) => !q || (c.move || '').includes(q) || (c.stem || '').includes(q) || (c.tags || []).join(' ').includes(q))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const rows = list.map((c) => '<div class="row">'
    + (c.image ? '<img class="thumb" src="' + c.image + '" alt="">' : '<div class="thumb thumb-text">文</div>')
    + '<div class="row-main"><div class="row-word">' + esc((c.move || c.stem || '').slice(0, 28)) + (c.bucket === 'mastered' ? ' <span class="tag">已会</span>' : ((c.lapses || 0) >= 3 ? ' <span class="tag hard">难词 ×' + (c.lapses || 0) + '</span>' : '')) + '</div>'
    + '<div class="row-sub">' + esc((c.tags || []).join(' · ') || '未分类') + '</div></div>'
    + (c.bucket === 'mastered'
      ? '<button class="btn" data-action="restore" data-id="' + esc(c.id) + '" type="button">恢复</button>'
        + '<button class="btn" data-action="edit-card" data-id="' + esc(c.id) + '" type="button">改</button>'
      : '<button class="btn" data-action="edit-card" data-id="' + esc(c.id) + '" type="button">编辑</button>')
    + '</div>').join('');
  const tab = (k, label, n2) => '<button class="lib-tab' + (f === k ? ' on' : '') + '" data-action="lib-filter" data-f="' + k + '" type="button">' + label + ' ' + n2 + '</button>';
  view.innerHTML = (state.editor !== null && state.editor !== undefined ? renderEditor() : '')
    + drillEntryHtml()
    + '<div class="list-head"><input class="search" id="search" value="' + esc(state.search) + '" placeholder="搜术语或详解">'
    + '<button class="btn primary" data-action="new-card" type="button">+ 拍题</button></div>'
    + '<div class="lib-tabs">' + tab('all', '全部', all.length) + tab('active', '在练', nActive)
      + tab('hard', '难词', all.filter((c) => c.bucket !== 'mastered' && (c.lapses || 0) >= 3).length)
      + tab('mastered', '已会', nMastered) + '</div>'
    + (list.length ? rows
      : (f === 'mastered'
        ? '<div class="empty"><strong>还没有移出的题</strong>在做题页点「这条已经会了 · 移出」，就会进到这里，随时可以恢复。</div>'
        : '<div class="empty"><strong>题库还是空的</strong>点右上「+ 拍题」，从相册选或直接拍。</div>'));
}

function patternOptions(currentId) {
  const groups = new Map();
  state.cards.forEach((c) => {
    if (!c.patternId) return;
    if (!groups.has(c.patternId)) groups.set(c.patternId, c.patternLabel || (c.move || '').slice(0, 16));
  });
  let html = '<option value="">新的一组（这是一道新模式的题）</option>';
  groups.forEach((label, pid) => {
    html += '<option value="' + esc(pid) + '"' + (pid === currentId ? ' selected' : '') + '>' + esc(label) + '</option>';
  });
  return html;
}

function renderEditor() {
  const e = state.editor || {};
  const isEdit = !!e.id;
  return '<div class="section"><h2>' + (isEdit ? '编辑这道题' : '加一道错题') + '</h2>'
    + '<div class="field"><label>题面（拍照或选图）</label>'
    + '<input id="f-photo" type="file" accept="image/*" capture="environment" hidden>'
    + '<div class="photo-slot" data-action="pick-photo">' + (e.image ? '<img src="' + e.image + '" alt="">' : '点这里拍照 / 从相册选') + '</div></div>'
    + '<div class="field"><label>核心答案（一句话说清，可空）</label><input id="f-answer" value="' + esc(e.answer || '') + '" placeholder="如：着丝点分裂，姐妹染色单体分开"></div>'
    + '<div class="field"><label>要点（分条写：定义、关键特征、易错点）</label><textarea id="f-basics" placeholder="如：① 定义：逆浓度梯度、需载体、耗能的跨膜运输 ② 易错：协助扩散也需载体但不耗能">' + esc(e.basics || '') + '</textarea></div>'
    + '<div class="field"><label>术语 / 问题（要背的那个点，如「有丝分裂后期」）</label><textarea id="f-stem" placeholder="如：主动运输">' + esc(e.stem || '') + '</textarea></div>'
    + '<div class="field"><label>展开详解（一行一步，点标题才展开）</label><textarea id="f-move" placeholder="如：① 逆浓度梯度 ② 需载体 ③ 耗 ATP">' + esc(e.move || '') + '</textarea></div>'
    + '<div class="field"><label>每条提示的答案（一行对应上面一层；点了「这条提示的答案」才显示）</label><textarea id="f-tipans" placeholder="第 1 层对应的结论&#10;第 2 层对应的结论&#10;第 3 层对应的结论">' + esc((e.tipAnswers || []).join('\n')) + '</textarea></div>'
    + '<div class="field"><label>提示（一行一层，从最虚到最实；点一次出下一层）</label><textarea id="f-tips" placeholder="第一行：给方向，如「先想想两边同乘什么」&#10;第二行：给下一步动作，如「通分后会变成 1/(ab)」&#10;第三行：给关键式子或等号条件">' + esc((e.tips || []).join('\n')) + '</textarea></div>'
    + '<div class="field"><label>你来补完（把这个难点的关键判断改成 1–3 个问句，诱导自己想）</label><textarea id="f-ask" placeholder="如：① t³ ≥ 2t 这一步，为什么两边可以除以 t？\n② 等号什么时候成立？">' + esc(e.ask || '') + '</textarea></div>'
    + '<div class="field"><label>问句的答案（一行对应上面一问；点了「看答案」才显示）</label><textarea id="f-askans" placeholder="对应第 1 问的答案&#10;对应第 2 问的答案">' + esc((e.askAnswers || []).join('\n')) + '</textarea></div>'
    + '<div class="field"><label>线索（看到什么该想起它）</label><input id="f-hint" value="' + esc(e.hint || '') + '" placeholder="如：看到「逆浓度梯度」就想到主动运输"></div>'
    + '<div class="field"><label>为什么（可空）</label><textarea id="f-why" placeholder="解释给自己听，一两句就够">' + esc(e.why || '') + '</textarea></div>'
    + '<div class="field"><label>知识点（逗号分隔）</label><input id="f-tags" value="' + esc((e.tags || []).join('，')) + '" placeholder="如：代数变形，韦达定理"></div>'
    + '<div class="field"><label>属于哪一组（同模式的变式会被分开练，不会连着出）</label><select id="f-pattern">' + patternOptions(e.patternId) + '</select></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-card" type="button">保存</button>'
    + '<button class="btn ghost" data-action="cancel-card" type="button">取消</button>'
    + (isEdit ? '<button class="btn danger" data-action="drop-card" data-id="' + esc(e.id) + '" type="button">删除</button>' : '')
    + '</div></div>';
}

function statsSection() {
  const cards = Array.from(state.cards.values());
  const today = dayKey();
  const doneToday = cards.filter((c) => c.lastReviewAt && dayKey(new Date(c.lastReviewAt)) === today);
  const byGrade = [0, 1, 2].map((g) => doneToday.filter((c) => c.lastGrade === g).length);
  const labels = ['没头绪', '想到方向', '秒出第一步'];
  const rows = byGrade.map((n, i) => '<div class="stat-row"><span>' + labels[i] + '</span>'
    + '<div class="stat-bar"><i style="width:' + (doneToday.length ? Math.round((n / doneToday.length) * 100) : 0) + '%"></i></div>'
    + '<b>' + n + '</b></div>').join('');
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const key = dayKey(d);
    const n = cards.filter((c) => c.bucket !== 'mastered' && c.due && dayKey(new Date(c.due)) === key).length;
    days.push({ label: i === 0 ? '今天' : (i + '天后'), n });
  }
  const maxN = Math.max(1, ...days.map((d) => d.n));
  const bars = days.map((d) => '<div class="fc"><i style="height:' + Math.round((d.n / maxN) * 100) + '%"></i>'
    + '<span>' + d.n + '</span><em>' + d.label + '</em></div>').join('');
  const soundOn = state.sound !== 'off';
  return '<div class="section"><h2>连对成就</h2>'
    + '<div class="ach-row"><span>历史最高</span><b>×' + state.run.best + '</b></div>'
    + '<div class="ach-row"><span>三连 / 五连 / 十连</span><b>' + state.run.m3 + ' / ' + state.run.m5 + ' / ' + state.run.m10 + '</b></div>'
    + '<div class="ach-row"><span>累计答对</span><b>' + state.run.total + '</b></div>'
    + '<div class="actions"><button class="btn" data-action="toggle-sound" type="button">音效：' + (soundOn ? '开（随机古琴/风铃/木鱼）' : '关') + '</button></div></div>'
    + '<div class="section"><h2>统计</h2>'
    + '<p class="sub">今天已评 ' + doneToday.length + ' 张</p>' + (rows || '<p class="sub dim">今天还没开始</p>')
    + '<h3>未来 7 天到期</h3><div class="forecast">' + bars + '</div></div>';
}

function renderSettings() {
  db.countCards().then((n) => {
    const el = document.getElementById('stats-line');
    if (el) el.textContent = '共 ' + n.total + ' 题 · 在练 ' + n.active + ' · 已会 ' + n.mastered;
    const au = Array.from(state.cards.values()).filter((c) => !!c.audio).length;
    const line = document.getElementById('audio-line');
    if (line) {
      line.textContent = '语音包：' + au + ' / ' + n.total + ' 张有 Breeze 音频'
        + (au === 0 ? '（旧题库，请用「覆盖导入」重新导入含音频的版本）' : '');
      line.style.color = au === n.total && n.total > 0 ? '#2f6b45' : '#b45309';
    }
  }).catch(() => {});
  view.innerHTML = statsSection() + '<div class="section"><h2>思考倒计时</h2>'
    + '<p class="sub">每题正面先强制想 N 秒才能看答案。这是整套训练的关键——没有这一步，就退化成「看答案」。</p>'
    + '<div class="field"><input id="f-delay" type="number" min="0" max="60" value="' + esc(state.settings.delaySec) + '"></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-delay" type="button">保存</button></div></div>'
    + '<div class="section"><h2>每日新题上限</h2><p class="sub">每天最多引入几道没见过的题。复习中的题不受限制。</p>'
    + '<div class="field"><input id="f-limit" type="number" min="0" max="100" value="' + esc(state.settings.dailyNewLimit) + '"></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-limit" type="button">保存</button></div></div>'
    + '<div class="section"><h2>没头绪的题，隔几题再出现</h2><p class="sub">范围 2–10，默认 3。</p>'
    + '<div class="field"><input id="f-gap" type="number" min="2" max="10" value="' + esc(relearnGap()) + '"></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-gap" type="button">保存</button></div></div>'
    + '<div class="section"><h2>朗读（多感官记忆）</h2><p class="sub">用手机自带的语音合成把答案读出来，离线可用。语速建议 0.9–1.1。</p>'
    + '<div class="field"><label>语速</label><input id="f-rate" type="number" min="0.5" max="1.5" step="0.1" value="' + esc(state.settings.speechRate || 1) + '"></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-speech" type="button">保存语速</button></div>'
    + '<div class="actions"><button class="btn" data-action="toggle-auto-speak" type="button">'
    + (state.settings.autoSpeak ? '✅ 打开答案后自动朗读' : '⬜ 打开答案后自动朗读') + '</button></div></div>'
    + '<div class="section"><h2>数据</h2><p class="sub">题面图片也一起备份（文件会比较大）。换手机前务必导出。</p>'
    + '<div class="actions"><button class="btn primary" data-action="export" type="button">导出 JSON</button>'
    + '<button class="btn" data-action="import-merge" type="button">合并导入（保留现有）</button>'
    + '<button class="btn danger" data-action="import-replace" type="button">覆盖导入</button>'
    + '<input id="file" type="file" accept="application/json,.json" hidden></div>'
    + '<p class="sub">合并导入只加新题、同 id 的跳过——以后分批加题用它，不会冲掉你手机上已有的题。</p>'
    + '<p class="sub" id="audio-line">语音包：检测中…</p>'
    + '<p class="sub" id="stats-line">统计中…</p>'
    + '<p class="sub dim">代码版本 v10-grade-front（如果你看不到这一行，说明页面还是旧代码，按 Ctrl+Shift+R 强制刷新）</p>'
    + '<div class="actions"><button class="btn danger" data-action="reset" type="button">重置全部数据</button></div></div>';
}

function render() {
  renderStats();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.route === state.route));
  if (!view) return;
  if (state.route === 'review') renderReview();
  else if (state.route === 'quiz') renderQuiz();
  else if (state.route === 'drill') renderDrill();
  else if (state.route === 'fav') renderFav();
  else if (state.route === 'library') renderLibrary();
  else renderSettings();
}

/* ---------- 图片压缩 ---------- */
async function fileToCard(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.82);
}

function readEditor() {
  const e = state.editor || {};
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const sel = document.getElementById('f-pattern');
  return {
    ...e,
    stem: val('f-stem'),
    answer: val('f-answer'),
    basics: val('f-basics'),
    ask: val('f-ask'),
    askAnswers: val('f-askans').split('\n').map((s) => s.trim()).filter(Boolean),
    tips: val('f-tips').split('\n').map((s) => s.trim()).filter(Boolean),
    tipAnswers: val('f-tipans').split('\n').map((s) => s.trim()).filter(Boolean),
    move: val('f-move'),
    hint: val('f-hint'),
    why: val('f-why'),
    tags: val('f-tags').split(/[，,、\s]+/).filter(Boolean),
    patternId: sel ? sel.value : (e.patternId || ''),
  };
}

async function saveCard() {
  const e = readEditor();
  if (!e.image && !e.stem) { toast('内容二选一：拍照，或填术语'); return; }
  if (!e.move) { toast('「展开详解」必须写——这才是要背的东西'); return; }
  const now = Date.now();
  const isNewPattern = !e.patternId;
  const card = {
    ...(e.id ? state.cards.get(e.id) : { origin: 'custom', bucket: 'active', createdAt: now, masteredAt: 0, ...newCardState(now) }),
    id: e.id || 'q-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    patternId: e.patternId || 'p-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 5),
    patternLabel: isNewPattern ? (e.tags[0] || e.move.slice(0, 14)) : (state.cards.get(e.patternId) || {}).patternLabel || e.move.slice(0, 14),
    image: e.image || '',
    stem: e.stem || '',
    tips: (e.tips || []).filter(Boolean),
    tipAnswers: (e.tipAnswers || []).filter(Boolean),
    answer: e.answer || '',
    basics: e.basics || '',
    ask: e.ask || '',
    askAnswers: (e.askAnswers || []).filter(Boolean),

    move: e.move,
    // 手动编辑后步骤结构可能变了，清掉人工标题让它重新自动生成
    stepBriefs: [],
    hint: e.hint || '',
    why: e.why || '',
    tags: e.tags,
  };
  await persist(card);
  state.editor = null;
  rebuildQueue();
  resetCardState();
  state.route = 'review';
  render();
  toast(e.id ? '已保存' : '已加入题库');
}

function exportAll() {
  const payload = {
    app: 'math-pattern-srs', version: 1, exportedAt: new Date().toISOString(),
    settings: state.settings, streak: state.streak, newDone: state.newDone,
    cards: Array.from(state.cards.values()),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const d = new Date();
  const name = 'math-questions-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('已导出 ' + name);
}

async function importAll(file, mode) {
  if (!file) return;
  const merge = mode === 'merge';
  if (!merge && !confirm('覆盖导入会清空当前全部题库，确定？')) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.cards)) throw new Error('文件格式不对');
    if (merge) {
      const existing = await db.getAllCards();
      const byId = new Map(existing.map((c) => [c.id, c]));
      const toWrite = [];
      let added = 0;
      let updated = 0;
      for (const c of data.cards) {
        if (!c || !c.id) continue;
        const cur = byId.get(c.id);
        if (!cur) { toWrite.push(c); added += 1; continue; }
        // 同 id：只更新题面内容，复习进度（state/due/ef/bucket 等）原样保留
        toWrite.push({
          ...cur,
          stem: c.stem ?? cur.stem,
          answer: c.answer ?? cur.answer,
          basics: c.basics ?? cur.basics,
          ask: c.ask ?? cur.ask,
          askAnswers: c.askAnswers ?? cur.askAnswers,
          tips: c.tips ?? cur.tips,
          tipAnswers: c.tipAnswers ?? cur.tipAnswers,
          tip2: c.tip2 ?? cur.tip2,
          move: c.move ?? cur.move,
          hint: c.hint ?? cur.hint,
          why: c.why ?? cur.why,
          tags: c.tags ?? cur.tags,
          image: c.image || cur.image,
          stepBriefs: c.stepBriefs ?? cur.stepBriefs,
          // 语音与其它后加字段也要一起更新，否则重新导入后仍是旧的无音频版本
          audio: c.audio ?? cur.audio,
          audioSec: c.audioSec ?? cur.audioSec,
          patternId: c.patternId ?? cur.patternId,
          patternLabel: c.patternLabel ?? cur.patternLabel,
        });
        updated += 1;
      }
      await db.putCards(toWrite);
      await db.setMeta('samplesAdded', 1);
      await loadAll();
      rebuildQueue();
      resetCardState();
      render();
      toast('合并完成：新增 ' + added + ' 题 · 更新 ' + updated + ' 题（进度已保留）');
      return;
    }
    await db.clearAll();
    await db.putCards(data.cards);
    if (data.settings) await db.setMeta('settings', data.settings);
    if (data.streak) await db.setMeta('streak', data.streak);
    if (data.newDone) await db.setMeta('newDone', data.newDone);
    await db.setMeta('samplesAdded', 1);
    await loadAll();
    rebuildQueue();
    resetCardState();
    render();
    toast('已导入 ' + data.cards.length + ' 道题');
  } catch (err) {
    bootError('导入失败：' + err.message);
  }
}

/* ---------- 事件 ---------- */
const tabs = document.getElementById('tabs');
if (tabs) {
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-route]');
    if (!btn) return;
    state.route = btn.dataset.route;
    state.editor = null;
    if (state.route === 'review') resetCardState();
    render();
  });
}

if (view) {
  view.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'tip') { state.tipLevel = Math.min(state.tipLevel + 1, cardTips(currentCard()).length); render(); return; }
    if (action === 'tip-answer') { state.tipAnsCount = state.tipLevel; render(); return; }
    if (action === 'toggle-ask') {
      const i = Number(el.dataset.i);
      const at = state.askOpen.indexOf(i);
      if (at >= 0) state.askOpen.splice(at, 1); else state.askOpen.push(i);
      render();
      return;
    }
    if (action === 'toggle-step') {
      const i = Number(el.dataset.i);
      const at = state.expandedSteps.indexOf(i);
      if (at >= 0) state.expandedSteps.splice(at, 1); else state.expandedSteps.push(i);
      render();
      return;
    }
    if (action === 'steps-all') {
      state.expandedSteps = state.expandedSteps.length >= cardSteps(currentCard()).length
        ? []
        : cardSteps(currentCard()).map((_, i) => i);
      render();
      return;
    }
    if (action === 'reveal') {
      if (!state.ready) return;
      state.revealed = true;
      stopTimer();
      render();
      if (state.settings.autoSpeak) {
        const c = currentCard();
        if (c) {
          if (c.audio) playAudioUrl(c.audio);
          else speakText([c.answer, c.basics].filter(Boolean).join('。'));
        }
      }
      return;
    }
    if (action === 'speak-answer') {
      const c = currentCard();
      if (c) {
        if (c.audio) playAudioUrl(c.audio); else speakText(c.answer);
        const b = document.getElementById('spk-stop'); if (b) b.hidden = false;
      }
      return;
    }
    if (action === 'speak-basics') { const c = currentCard(); if (c) { speakText(c.basics); const b = document.getElementById('spk-stop'); if (b) b.hidden = false; } return; }
    if (action === 'speak-all') {
      const c = currentCard();
      if (c) {
        if (c.audio) {
          if (c.basics) currentAudio = null;
          playAudioUrl(c.audio);
        } else {
          speakText([c.answer, c.basics].filter(Boolean).join('。'));
        }
        const b = document.getElementById('spk-stop'); if (b) b.hidden = false;
      }
      return;
    }
    if (action === 'stop-speak') { stopSpeak(); render(); return; }
    if (action === 'save-speech') {
      const r = Number(document.getElementById('f-rate').value) || 1;
      state.settings = { ...state.settings, speechRate: r };
      await db.setMeta('settings', state.settings);
      toast('语速已保存：' + r + ' 倍');
      return;
    }
    if (action === 'toggle-auto-speak') {
      state.settings = { ...state.settings, autoSpeak: !state.settings.autoSpeak };
      await db.setMeta('settings', state.settings);
      render();
      return;
    }
    if (action === 'grade') { await gradeCard(Number(el.dataset.g)); return; }
    if (action === 'undo') { await undoLast(); return; }
    if (action === 'fav-line') { await toggleFavLine(el.dataset.id, el.dataset.i, el.dataset.kind); return; }
    if (action === 'fav-tab') { state.favTab = el.dataset.f; render(); return; }
    if (action === 'unfav') {
      state.fav.lines = state.fav.lines.filter((f) => f.key !== el.dataset.key);
      await db.setMeta('fav', state.fav); render(); return;
    }
    if (action === 'unfav-correct') {
      state.fav.correct = state.fav.correct.filter((f) => f.key !== el.dataset.key);
      await db.setMeta('fav', state.fav); render(); return;
    }
    if (action === 'start-quiz') { buildQuiz(); state.route = 'quiz'; render(); return; }
    if (action === 'start-drill') { startDrill(el.dataset.m || 'order'); return; }
    if (action === 'drill-mode') { startDrill(el.dataset.m || 'order'); return; }
    if (action === 'drill-next') { startDrill(state.drill.mode); return; }
    if (action === 'goto-card') { state.quiz = null; state.drill.order = null; state.drill.tf = null; gotoCard(el.dataset.id); return; }
    if (action === 'toggle-sound') {
      state.sound = state.sound === 'off' ? 'on' : 'off';
      await db.setMeta('sound', state.sound);
      if (state.sound === 'on') playSound('answer');
      render();
      return;
    }
    if (action === 'order-pick') {
      const o = state.drill.order;
      if (!o || o.done) return;
      const t = el.dataset.t;
      const at = o.picked.indexOf(t);
      if (at >= 0) o.picked.splice(at, 1); else o.picked.push(t);
      render();
      return;
    }
    if (action === 'order-reset') { state.drill.order.picked = []; render(); return; }
    if (action === 'order-check') {
      const o = state.drill.order;
      if (!o || o.picked.length !== o.items.length) return;
      o.ok = o.picked.every((t, i) => t === o.right[i]);
      o.done = true;
      state.drill.score.total++;
      runAnswer(o.ok);
      if (o.ok) { state.drill.score.ok++; celebrate(); }
      render();
      return;
    }
    if (action === 'tf-pick') {
      const t = state.drill.tf;
      if (!t || t.done) return;
      t.picked = el.dataset.v === '1';
      t.ok = t.picked === t.isTrue;
      t.done = true;
      state.drill.score.total++;
      runAnswer(t.ok);
      if (t.ok) { state.drill.score.ok++; celebrate(); }
      render();
      return;
    }
    if (action === 'next-quiz') { buildQuiz(); render(); return; }
    if (action === 'pick') { await pickOption(Number(el.dataset.o)); return; }
    if (action === 'go-fav') { state.route = 'fav'; render(); return; }
    if (action === 'go-review') { state.route = 'review'; resetCardState(); render(); return; }
    if (action === 'bury') { await buryCurrent(); return; }
    if (action === 'master') { const c = currentCard(); if (c) await masterCard(c.id); return; }
    if (action === 'restore') { await restoreCard(el.dataset.id); return; }
    if (action === 'set-tag') {
      state.settings = { ...state.settings, tagFilter: el.dataset.tag || '' };
      await db.setMeta('settings', state.settings);
      rebuildQueue();
      resetCardState();
      render();
      return;
    }
    if (action === 'lib-filter') { state.libFilter = el.dataset.f; render(); return; }
    if (action === 'new-card') { state.editor = {}; state.route = 'library'; render(); return; }
    if (action === 'edit-card') {
      const c = state.cards.get(el.dataset.id);
      if (!c) return;
      state.editor = { id: c.id, image: c.image, stem: c.stem, answer: c.answer, basics: c.basics, ask: c.ask, askAnswers: (c.askAnswers || []), tips: cardTips(c), tipAnswers: cardTipAnswers(c), move: c.move, hint: c.hint, why: c.why, tags: c.tags, patternId: c.patternId };
      render();
      return;
    }
    if (action === 'pick-photo') { const f = document.getElementById('f-photo'); if (f) f.click(); return; }
    if (action === 'save-card') { await saveCard(); return; }
    if (action === 'cancel-card') { state.editor = null; render(); return; }
    if (action === 'drop-card') {
      const id = el.dataset.id;
      if (!confirm('删除这道题？')) return;
      await db.deleteCard(id);
      state.cards.delete(id);
      state.editor = null;
      rebuildQueue();
      render();
      toast('已删除');
      return;
    }
    if (action === 'save-delay') {
      const v = Math.max(0, Math.min(60, Number((document.getElementById('f-delay') || {}).value) || 0));
      state.settings = { ...state.settings, delaySec: v };
      await db.setMeta('settings', state.settings);
      render(); toast('思考时间设为 ' + v + ' 秒');
      return;
    }
    if (action === 'save-limit') {
      const v = Math.max(0, Math.min(100, Number((document.getElementById('f-limit') || {}).value) || 0));
      state.settings = { ...state.settings, dailyNewLimit: v };
      await db.setMeta('settings', state.settings);
      rebuildQueue(); render(); toast('每日新题上限 ' + v);
      return;
    }
    if (action === 'save-gap') {
      const v = Math.max(RELEARN_GAP_MIN, Math.min(10, Number((document.getElementById('f-gap') || {}).value) || 3));
      state.settings = { ...state.settings, relearnGap: v };
      await db.setMeta('settings', state.settings);
      rebuildQueue(); render(); toast('间隔设为 ' + v + ' 题');
      return;
    }
    if (action === 'export') { exportAll(); return; }
    if (action === 'import-merge' || action === 'import-replace') {
      state.importMode = action === 'import-merge' ? 'merge' : 'replace';
      const f = document.getElementById('file');
      if (f) f.click();
      return;
    }
    if (action === 'reset') {
      if (!confirm('清空全部题库和进度？')) return;
      await db.clearAll();
      await loadAll();
      await ensureSamples();
      await loadAll();
      rebuildQueue(); resetCardState(); render();
      toast('已重置');
      return;
    }
  });

  view.addEventListener('change', async (e) => {
    if (e.target && e.target.id === 'f-photo') {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await fileToCard(file);
        state.editor = { ...(readEditor()), image: dataUrl };
        render();
        toast('题面已加入');
      } catch (err) {
        bootError('图片处理失败：' + err.message);
      }
    }
    if (e.target && e.target.id === 'file') {
      importAll(e.target.files && e.target.files[0], state.importMode || 'replace');
      e.target.value = '';
    }
  });

  view.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'search') { state.search = e.target.value; renderLibrary(); const el = document.getElementById('search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  });
}

/* ---------- 启动 ---------- */
(async function boot() {
  try {
    await db.openDB();
  } catch (err) {
    bootError('浏览器存储不可用（' + err.message + '）。请用 Chrome/Edge 打开，不要用微信内置浏览器。');
    return;
  }
  try {
    await ensureSamples();
    await loadAll();
    rebuildQueue();
    resetCardState();
    render();
  } catch (err) {
    bootError('启动失败：' + err.message);
  }
  try { if (navigator.serviceWorker) navigator.serviceWorker.register('./sw.js').catch(() => {}); } catch (err) { /* 忽略 */ }
})();

document.addEventListener('keydown', (e) => {
  if (!state.ready || state.route !== 'review' || state.editor !== null) return;
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'u') { e.preventDefault(); undoLast(); return; }
  if (k === 'b') { e.preventDefault(); buryCurrent(); return; }
  if (k === ' ' || k === 'p') {
    e.preventDefault();
    if (!state.revealed) { const btn = document.getElementById('reveal-btn'); if (btn) btn.click(); }
    return;
  }
  if (k === '1' || k === '2' || k === '3') { e.preventDefault(); gradeCard(Number(k) - 1); }
});

const CELEBRATIONS = [
  { emoji: '🎉', text: '答对了！', cls: 'pop', color: '#15803d' },
  { emoji: '✨', text: '漂亮！', cls: 'swing', color: '#0ea5e9' },
  { emoji: '👏', text: '一字不差', cls: 'slideUp', color: '#f59e0b' },
  { emoji: '🔥', text: '稳！', cls: 'bounce', color: '#ef4444' },
  { emoji: '🎯', text: '正中靶心', cls: 'zoomIn', color: '#8b5cf6' },
  { emoji: '📖', text: '记住了', cls: 'flip', color: '#0891b2' },
  { emoji: '⭐', text: '这题满分', cls: 'spin', color: '#eab308' },
  { emoji: '🏮', text: '生物通了', cls: 'wobble', color: '#dc2626' },
  { emoji: '🍃', text: '轻舟已过', cls: 'drift', color: '#16a34a' },
  { emoji: '💯', text: '漂亮，继续', cls: 'burst', color: '#f97316' },
];

function playSound(kind) {
  if (state.sound === 'off') return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = playSound.ctx || (playSound.ctx = new AC());
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const timbres = ['qin', 'bell', 'wood'];
    const pick = kind === 'milestone' ? 'qin' : timbres[Math.floor(Math.random() * timbres.length)];
    const base = 196 + Math.floor(Math.random() * 6) * 28;
    const out = ctx.createGain();
    out.gain.value = 0.16;
    out.connect(ctx.destination);
    if (pick === 'qin') {
      const len = Math.floor(ctx.sampleRate * 1.6);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      const period = Math.max(2, Math.round(ctx.sampleRate / base));
      for (let i = 0; i < period; i++) data[i] = Math.random() * 2 - 1;
      for (let i = period; i < len; i++) data[i] = 0.996 * 0.5 * (data[i - period] + data[i - period + 1]);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2600;
      src.connect(lp); lp.connect(out);
      src.start(now);
    } else if (pick === 'bell') {
      [1, 2.01].forEach(function (mul, i) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = base * 2 * mul;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(i ? 0.06 : 0.12, now + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + (i ? 0.6 : 1.1));
        o.connect(g); g.connect(out);
        o.start(now); o.stop(now + 1.2);
      });
    } else {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const bp = ctx.createBiquadFilter();
      o.type = 'triangle'; o.frequency.value = base * 1.5;
      bp.type = 'bandpass'; bp.frequency.value = base * 1.5; bp.Q.value = 6;
      g.gain.setValueAtTime(0.2, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      o.connect(bp); bp.connect(g); g.connect(out);
      o.start(now); o.stop(now + 0.14);
    }
  } catch (e) { /* 静默失败 */ }
}

function streakLevel() {
  const n = state.run.cur;
  if (n >= 10) return 4;
  if (n >= 5) return 3;
  if (n >= 3) return 2;
  if (n >= 2) return 1;
  return 0;
}

function streakBadgeHtml() {
  const n = state.run.cur;
  const goal = n >= 10 ? '登峰' : n >= 5 ? '再 ' + (10 - n) + ' 题到十连' : n >= 3 ? '再 ' + (5 - n) + ' 题到五连' : '再 ' + (3 - n) + ' 题到三连';
  return '<div class="streak-row"><span class="streak-badge lv' + streakLevel() + '">连对 ×' + n + '</span>'
    + '<span class="streak-goal">' + goal + '</span>'
    + '<div class="streak-bar"><i class="lv' + streakLevel() + '" style="width:' + Math.min(100, (n / 10) * 100) + '%"></i></div></div>';
}

function milestoneBanner(n) {
  const bar = document.createElement('div');
  bar.className = 'milestone-bar';
  bar.textContent = n === 3 ? '🏅 三连达成 · 已记入成就' : n === 5 ? '🏆 五连达成 · 越来越稳' : '👑 十连登峰 · 已记入成就';
  document.body.appendChild(bar);
  setTimeout(function () { bar.remove(); }, 2400);
}

function runAnswer(ok) {
  if (ok) {
    state.run.cur += 1;
    state.run.total += 1;
    if (state.run.cur > state.run.best) state.run.best = state.run.cur;
    if (state.run.cur === 3) state.run.m3 += 1;
    if (state.run.cur === 5) state.run.m5 += 1;
    if (state.run.cur === 10) state.run.m10 += 1;
    if ([3, 5, 10].indexOf(state.run.cur) >= 0) { milestoneBanner(state.run.cur); playSound('milestone'); }
    else playSound('answer');
  } else {
    state.run.cur = 0;
    playSound('answer');
  }
  db.setMeta('run', state.run);
}

function gotoCard(id) {
  const c = state.cards.get(id);
  if (!c) { toast('这张卡不在题库里'); return; }
  state.queue = [id].concat(state.queue.filter(function (x) { return x !== id; }));
  state.route = 'review';
  state.revealed = true;
  render();
  toast('已跳到这张卡的知识点');
}

function jumpBtn(cardId) {
  return '<button class="btn jump" data-action="goto-card" data-id="' + esc(cardId) + '" type="button">📖 看这张卡的知识点</button>';
}

function celebrate() {
  const c = CELEBRATIONS[Math.floor(Math.random() * CELEBRATIONS.length)];
  const layer = document.createElement('div');
  layer.className = 'celebrate-layer';
  const pieces = [];
  for (let i = 0; i < 22; i++) {
    const left = Math.round(Math.random() * 100);
    const delay = (Math.random() * 0.35).toFixed(2);
    const dur = (1.1 + Math.random() * 0.6).toFixed(2);
    const size = 6 + Math.round(Math.random() * 8);
    const round = Math.random() > 0.5 ? '50%' : '2px';
    pieces.push('<i style="left:' + left + '%;width:' + size + 'px;height:' + (size * (Math.random() > 0.5 ? 1 : 2)) +
      'px;border-radius:' + round + ';background:' + c.color + ';animation-delay:' + delay + 's;animation-duration:' + dur + 's"></i>');
  }
  layer.innerHTML = '<div class="confetti">' + pieces.join('') + '</div>'
    + '<div class="celebrate-card ' + c.cls + '"><div class="celebrate-emoji">' + c.emoji + '</div>'
    + '<div class="celebrate-text">' + c.text + '</div></div>';
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1700);
}
