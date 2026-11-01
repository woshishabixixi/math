/* 调度算法：三档评分 + 学习阶梯 + 易度因子（SM-2 变体）。纯函数，无副作用，不碰 DOM。 */
export const GRADES = Object.freeze({ AGAIN: 0, HARD: 1, GOOD: 2 });

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** 学习阶梯（分钟）：新卡先按天走，答错退回 10 分钟短间隔。 */
export const LEARNING_STEPS_MIN = Object.freeze([10, 1440]);
export const GRADUATE_DAYS = 3;
export const MAX_INTERVAL_DAYS = 365;
export const EF_DEFAULT = 2.5;
export const EF_MIN = 1.3;
export const EF_MAX = 3;

const round2 = (n) => Math.round(n * 100) / 100;
const clampEf = (n) => Math.min(EF_MAX, Math.max(EF_MIN, round2(n)));
const clampInterval = (d) => Math.min(MAX_INTERVAL_DAYS, Math.max(0.5, round2(d)));

export function newCardState(now = Date.now()) {
  return {
    state: 'new',
    step: 0,
    ef: EF_DEFAULT,
    interval: 0,
    due: now,
    reps: 0,
    lapses: 0,
    lastGrade: null,
    lastReviewAt: 0,
  };
}

export function isDue(state, now = Date.now()) {
  return state.state !== 'new' && state.due <= now;
}

export function schedule(state, grade, now = Date.now()) {
  if (!state) throw new Error('schedule: 缺少卡片状态');
  if (grade !== GRADES.AGAIN && grade !== GRADES.HARD && grade !== GRADES.GOOD) {
    throw new Error('schedule: 非法评分 ' + grade);
  }

  const wasReview = state.state === 'review';
  const s = {
    ...state,
    ef: state.ef || EF_DEFAULT,
    interval: state.interval || 0,
    step: state.step || 0,
    reps: (state.reps || 0) + 1,
    lapses: state.lapses || 0,
    lastGrade: grade,
    lastReviewAt: now,
  };

  if (grade === GRADES.GOOD) {
    if (wasReview) {
      s.ef = clampEf(s.ef + 0.1);
      s.interval = clampInterval(Math.max(1, s.interval * s.ef));
      s.due = now + s.interval * DAY;
    } else {
      const next = s.step + 1;
      if (next >= LEARNING_STEPS_MIN.length) {
        s.state = 'review';
        s.step = LEARNING_STEPS_MIN.length;
        s.interval = GRADUATE_DAYS;
        s.due = now + GRADUATE_DAYS * DAY;
      } else {
        s.state = 'learning';
        s.step = next;
        s.interval = round2(LEARNING_STEPS_MIN[next] / 1440);
        s.due = now + LEARNING_STEPS_MIN[next] * MINUTE;
      }
    }
    return s;
  }

  if (grade === GRADES.HARD) {
    s.ef = clampEf(s.ef - 0.15);
    if (wasReview) {
      s.interval = clampInterval(Math.max(0.5, s.interval * 1.2));
      s.due = now + s.interval * DAY;
    } else {
      // 关键：新卡评「模糊」也要离开新词池，否则会被当成新卡立刻重复抽到
      s.state = s.state === 'new' ? 'learning' : s.state;
      const gapDays = Math.max(LEARNING_STEPS_MIN[0] / 1440, s.interval * 1.2);
      s.interval = round2(gapDays);
      s.due = now + Math.max(LEARNING_STEPS_MIN[0] * MINUTE, gapDays * DAY);
    }
    return s;
  }

  // AGAIN：回到阶梯起点，10 分钟后重来
  s.step = 0;
  s.due = now + LEARNING_STEPS_MIN[0] * MINUTE;
  s.interval = round2(LEARNING_STEPS_MIN[0] / 1440);
  if (wasReview) {
    s.state = 'relearning';
    s.lapses += 1;
    s.ef = clampEf(s.ef - 0.2);
    s.interval = 1;
  } else {
    s.state = 'learning';
  }
  return s;
}

export function describeInterval(state) {
  const d = state && state.interval ? state.interval : 0;
  if (d <= 0) return '现在';
  if (d < 1 / 24) return Math.max(1, Math.round(d * 1440)) + ' 分钟';
  if (d < 1) return Math.round(d * 24) + ' 小时';
  if (d < 30) return round2(d) + ' 天';
  return Math.round(d) + ' 天';
}

/** 间隔 5 张旧卡插 1 张新卡；新卡受每日上限约束。 */
export function buildQueue(cards, { now = Date.now(), dailyNewLimit = 20, newDoneCount = 0 } = {}) {
  const active = cards.filter((c) => c.bucket === 'active');
  const due = active.filter((c) => isDue(c, now)).sort((a, b) => a.due - b.due);
  const allowance = Math.max(0, dailyNewLimit - newDoneCount);
  const fresh = active.filter((c) => c.state === 'new').slice(0, allowance);

  const out = [];
  let di = 0;
  let ni = 0;
  let sinceNew = 0;
  while (di < due.length || ni < fresh.length) {
    const wantNew = ni < fresh.length && (di >= due.length || sinceNew >= 5);
    if (wantNew) {
      out.push(fresh[ni++]);
      sinceNew = 0;
    } else {
      out.push(due[di++]);
      sinceNew += 1;
    }
  }
  return out;
}
