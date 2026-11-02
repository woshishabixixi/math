import { GRADES, schedule, newCardState, describeInterval, buildQueue } from './srs.js';
import * as db from './db.js';

const DEFAULT_SETTINGS = { delaySec: 10, dailyNewLimit: 20, relearnGap: 3 };
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
  askOpen: [],
  ready: false,
  left: 10,
  timer: null,
  editor: null,
  search: '',
  libFilter: 'all',
  importMode: 'replace',
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
  const list = Array.from(state.cards.values());
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
      btn.textContent = state.ready ? '看破题动作' : '先自己想 · 还剩 ' + state.left + ' 秒';
      btn.classList.toggle('is-ready', state.ready);
      btn.disabled = !state.ready;
    }
  }, 1000);
}
function resetCardState() {
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
  if (!state.revealed) { toast('先看破题动作，再评分'); return; }
  const wasNew = card.state === 'new';
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

/** 每层提示对应的「这条提示的答案」：保留位置，第 i 项对应第 i 层（空的表示该层没答案） */
function cardTipAnswers(card) {
  if (!card || !Array.isArray(card.tipAnswers)) return [];
  return card.tipAnswers.map((x) => (x == null ? '' : String(x)));
}

function renderReview() {
  const card = currentCard();
  if (!card) {
    view.innerHTML = '<div class="empty"><strong>今天没有要练的题了</strong>'
      + '点下面「题库 → 拍题」把错题加进来。<br><span class="dim">第一次用建议先加 20–30 道你真正卡住的题。</span></div>';
    return;
  }
  const revealed = state.revealed;
  const steps = cardSteps(card);
  const tags = (card.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
  // 图和文字可以同时存在：图在上、题面在下
  const face = (card.image ? '<img class="shot" src="' + card.image + '" alt="题图">' : '')
    + (card.stem ? '<div class="stem">' + esc(formatStem(card.stem)) + '</div>' : (card.image ? '' : '<div class="stem">（无题干）</div>'));
  const problemBlock = '<div class="problem">' + face + '</div>';
  view.innerHTML = ''
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
        + (card.answer ? '<div class="answer-line"><span>答案</span>' + esc(card.answer) + '</div>' : '')
        + (card.basics ? '<div class="basics"><div class="move-label">必备知识</div><div class="basics-body">' + esc(formatStem(card.basics)) + '</div></div>' : '')
        + '<div class="move-label">破题动作（共 ' + steps.length + ' 步 · 卡住哪步点哪步）</div>'
        + '<div class="steps">'
        + steps.map((s, i) => {
            const open = state.expandedSteps.indexOf(i) >= 0;
            return '<div class="step' + (open ? ' is-open' : '') + '">'
              + '<div class="step-head">'
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
          ? '<div class="ask"><div class="ask-label">你来补完 · 先自己回答，答完点「看答案」</div>'
            + cardAsks(card).map((it, i) => {
                const open = state.askOpen.indexOf(i) >= 0;
                return '<div class="ask-item">'
                  + '<div class="ask-q"><span>' + esc(it.q) + '</span>'
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
        + '<div class="hint-line">先在脑子里说出「第一步做什么」，再点提示或看解法</div>')
    + '</div>'
    + '<div class="grade-bar' + (revealed ? '' : ' is-locked') + '">'
    + '<button class="grade" data-action="grade" data-g="0" type="button">没头绪</button>'
    + '<button class="grade" data-action="grade" data-g="1" type="button">想到方向</button>'
    + '<button class="grade" data-action="grade" data-g="2" type="button">秒出第一步</button>'
    + '</div>'
    + '<div class="row-actions"><button class="link-btn" data-action="master" type="button">这题已经会了 · 移出</button></div>';
}

function renderLibrary() {
  const q = state.search.trim();
  const all = Array.from(state.cards.values());
  const nActive = all.filter((c) => c.bucket !== 'mastered').length;
  const nMastered = all.filter((c) => c.bucket === 'mastered').length;
  const f = state.libFilter || 'all';
  const list = all
    .filter((c) => f === 'all' || (f === 'mastered' ? c.bucket === 'mastered' : c.bucket !== 'mastered'))
    .filter((c) => !q || (c.move || '').includes(q) || (c.stem || '').includes(q) || (c.tags || []).join(' ').includes(q))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const rows = list.map((c) => '<div class="row">'
    + (c.image ? '<img class="thumb" src="' + c.image + '" alt="">' : '<div class="thumb thumb-text">文</div>')
    + '<div class="row-main"><div class="row-word">' + esc((c.move || c.stem || '').slice(0, 28)) + (c.bucket === 'mastered' ? ' <span class="tag">已会</span>' : '') + '</div>'
    + '<div class="row-sub">' + esc((c.tags || []).join(' · ') || '未分类') + '</div></div>'
    + (c.bucket === 'mastered'
      ? '<button class="btn" data-action="restore" data-id="' + esc(c.id) + '" type="button">恢复</button>'
        + '<button class="btn" data-action="edit-card" data-id="' + esc(c.id) + '" type="button">改</button>'
      : '<button class="btn" data-action="edit-card" data-id="' + esc(c.id) + '" type="button">编辑</button>')
    + '</div>').join('');
  const tab = (k, label, n2) => '<button class="lib-tab' + (f === k ? ' on' : '') + '" data-action="lib-filter" data-f="' + k + '" type="button">' + label + ' ' + n2 + '</button>';
  view.innerHTML = (state.editor !== null && state.editor !== undefined ? renderEditor() : '')
    + '<div class="list-head"><input class="search" id="search" value="' + esc(state.search) + '" placeholder="搜破题动作或知识点">'
    + '<button class="btn primary" data-action="new-card" type="button">+ 拍题</button></div>'
    + '<div class="lib-tabs">' + tab('all', '全部', all.length) + tab('active', '在练', nActive) + tab('mastered', '已会', nMastered) + '</div>'
    + (list.length ? rows
      : (f === 'mastered'
        ? '<div class="empty"><strong>还没有移出的题</strong>在做题页点「这题已经会了 · 移出」，就会进到这里，随时可以恢复。</div>'
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
    + '<div class="field"><label>答案（选什么 / 结果是多少，可空）</label><input id="f-answer" value="' + esc(e.answer || '') + '" placeholder="如：B　或　n=6　或　(−∞,−6]"></div>'
    + '<div class="field"><label>必备知识（这题用到哪些定义、公式？写给零基础的自己看）</label><textarea id="f-basics" placeholder="如：① 基本不等式 a+b≥2√(ab)（a,b>0），等号当 a=b ② 换底公式 log_a b = log_c b / log_c a">' + esc(e.basics || '') + '</textarea></div>'
    + '<div class="field"><label>题干文字（不拍照时填这里，只填这个也行）</label><textarea id="f-stem" placeholder="如：已知 x+y=3, xy=2, 求 x²+y²">' + esc(e.stem || '') + '</textarea></div>'
    + '<div class="field"><label>破题动作（第一步做什么，一句话）</label><textarea id="f-move" placeholder="如：把 x²+y² 改写成 (x+y)²−2xy">' + esc(e.move || '') + '</textarea></div>'
    + '<div class="field"><label>分层提示（最多 5 层，从最虚到最实；<b>空着的层会被跳过</b>，简单题只填 1–2 层就行）</label>'
    + (() => {
        const tps = e.tips || [], ans = e.tipAnswers || [];
        let h = '';
        for (let i = 0; i < 5; i++) {
          h += '<div class="tip-pair"><div class="tip-pair-no">' + (i + 1) + '</div><div class="tip-pair-fields">'
            + '<input id="f-tip-' + i + '" value="' + esc(tps[i] || '') + '" placeholder="第 ' + (i + 1) + ' 层提示（空 = 不用这层）">'
            + '<input id="f-tipa-' + i + '" value="' + esc(ans[i] || '') + '" placeholder="这一层的答案（空 = 不显示「这条提示的答案」按钮）">'
            + '</div></div>';
        }
        return h;
      })()
    + '</div>'
    + '<div class="field"><label>你来补完（把这个难点的关键判断改成 1–3 个问句，诱导自己想）</label><textarea id="f-ask" placeholder="如：① t³ ≥ 2t 这一步，为什么两边可以除以 t？\n② 等号什么时候成立？">' + esc(e.ask || '') + '</textarea></div>'
    + '<div class="field"><label>问句的答案（一行对应上面一问；点了「看答案」才显示）</label><textarea id="f-askans" placeholder="对应第 1 问的答案&#10;对应第 2 问的答案">' + esc((e.askAnswers || []).join('\n')) + '</textarea></div>'
    + '<div class="field"><label>线索（题面上什么信号让你想到它）</label><input id="f-hint" value="' + esc(e.hint || '') + '" placeholder="如：看到「和」与「积」同时给出"></div>'
    + '<div class="field"><label>为什么这么想（可空）</label><textarea id="f-why" placeholder="解释给自己听，一两句就够">' + esc(e.why || '') + '</textarea></div>'
    + '<div class="field"><label>知识点（逗号分隔）</label><input id="f-tags" value="' + esc((e.tags || []).join('，')) + '" placeholder="如：代数变形，韦达定理"></div>'
    + '<div class="field"><label>属于哪一组（同模式的变式会被分开练，不会连着出）</label><select id="f-pattern">' + patternOptions(e.patternId) + '</select></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-card" type="button">保存</button>'
    + '<button class="btn ghost" data-action="cancel-card" type="button">取消</button>'
    + (isEdit ? '<button class="btn danger" data-action="drop-card" data-id="' + esc(e.id) + '" type="button">删除</button>' : '')
    + '</div></div>';
}

function renderSettings() {
  db.countCards().then((n) => {
    const el = document.getElementById('stats-line');
    if (el) el.textContent = '共 ' + n.total + ' 题 · 在练 ' + n.active + ' · 已会 ' + n.mastered;
  }).catch(() => {});
  view.innerHTML = '<div class="section"><h2>思考倒计时</h2>'
    + '<p class="sub">每题正面先强制想 N 秒才能看答案。这是整套训练的关键——没有这一步，就退化成「看答案」。</p>'
    + '<div class="field"><input id="f-delay" type="number" min="0" max="60" value="' + esc(state.settings.delaySec) + '"></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-delay" type="button">保存</button></div></div>'
    + '<div class="section"><h2>每日新题上限</h2><p class="sub">每天最多引入几道没见过的题。复习中的题不受限制。</p>'
    + '<div class="field"><input id="f-limit" type="number" min="0" max="100" value="' + esc(state.settings.dailyNewLimit) + '"></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-limit" type="button">保存</button></div></div>'
    + '<div class="section"><h2>没头绪的题，隔几题再出现</h2><p class="sub">范围 2–10，默认 3。</p>'
    + '<div class="field"><input id="f-gap" type="number" min="2" max="10" value="' + esc(relearnGap()) + '"></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-gap" type="button">保存</button></div></div>'
    + '<div class="section"><h2>数据</h2><p class="sub">题面图片也一起备份（文件会比较大）。换手机前务必导出。</p>'
    + '<div class="actions"><button class="btn primary" data-action="export" type="button">导出 JSON</button>'
    + '<button class="btn" data-action="import-merge" type="button">合并导入（保留现有）</button>'
    + '<button class="btn danger" data-action="import-replace" type="button">覆盖导入</button>'
    + '<input id="file" type="file" accept="application/json,.json" hidden></div>'
    + '<p class="sub">合并导入只加新题、同 id 的跳过——以后分批加题用它，不会冲掉你手机上已有的题。</p>'
    + '<p class="sub" id="stats-line">统计中…</p>'
    + '<div class="actions"><button class="btn danger" data-action="reset" type="button">重置全部数据</button></div></div>';
}

function render() {
  renderStats();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.route === state.route));
  if (!view) return;
  if (state.route === 'review') renderReview();
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
    tips: [0,1,2,3,4].map((i) => val('f-tip-' + i)).filter(Boolean),
    tipAnswers: (() => {
      const out = [];
      [0,1,2,3,4].forEach((i) => { if (val('f-tip-' + i)) out.push(val('f-tipa-' + i) || ''); });
      return out;
    })(),
    move: val('f-move'),
    hint: val('f-hint'),
    why: val('f-why'),
    tags: val('f-tags').split(/[，,、\s]+/).filter(Boolean),
    patternId: sel ? sel.value : (e.patternId || ''),
  };
}

async function saveCard() {
  const e = readEditor();
  if (!e.image && !e.stem) { toast('题面二选一：拍照，或填题干文字'); return; }
  if (!e.move) { toast('「破题动作」必须写——这才是要练的东西'); return; }
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
      return;
    }
    if (action === 'grade') { await gradeCard(Number(el.dataset.g)); return; }
    if (action === 'master') { const c = currentCard(); if (c) await masterCard(c.id); return; }
    if (action === 'restore') { await restoreCard(el.dataset.id); return; }
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
