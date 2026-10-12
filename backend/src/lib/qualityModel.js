// Predicts the probability a session starting now will be rated
// "focused" (vs neutral/distracted), learned per-user from their own
// labeled session history - see routes/cron.js's trainQualityModels
// for where this gets refit weekly, and priorityEngine.js's
// predictedQualityScore for where the frontend turns a prediction into
// part of the suggestion ranking.
//
// This is NOT a replacement for the existing hand-tuned ENERGY_FIT
// logic in priorityEngine.js (which asks "when do you log the most
// TIME"). This asks "when were your sessions actually rated good" -
// a quality signal, not a volume signal. The two can and do disagree
// (grinding out a lot of hours somewhere you consistently rate
// "distracted" is exactly the case this exists to catch).

// Below this many labeled sessions, logistic regression on ~8 features
// is more likely to fit noise than a real pattern - the model simply
// doesn't train, and the frontend falls back to the existing energy-fit
// heuristic alone. Matches the same "don't trust a pattern without
// enough samples" discipline already used throughout analytics.js
// (e.g. EFFORT_FIT_MIN_TAG_SESSIONS, CONSISTENCY_MIN_ACTIVE_DAYS).
const MIN_LABELED_SESSIONS = 40;
// A split this lopsided (e.g. 95% "focused") means the model could get
// near-perfect accuracy by always predicting the majority class without
// learning anything about WHEN - not useful for ranking.
const MIN_MINORITY_CLASS_FRACTION = 0.1;

const FEATURE_NAMES = [
  "bias",
  "hour_sin",
  "hour_cos",
  "is_weekend",
  "session_minutes",
  "has_task",
  "minutes_logged_today_before",
  "hours_since_last_session",
  "is_deep_work",
];

// Same deep-work/quick-admin split priorityEngine.js's classifyTagType
// actually uses: a tag's own median session length against a single
// fixed-minutes threshold (not a comparison against other tags'
// medians - an earlier version of this file got that wrong). Duplicated
// here rather than imported because this runs on the backend (ESM on
// Node) while priorityEngine.js is a frontend-only module pulled into
// the Vite bundle; kept deliberately identical so a session looks the
// same way to both the training data and the ranking that consumes its
// predictions. If DEEP_WORK_MIN_MEDIAN_MINUTES in priorityWeights.js
// ever changes, this constant needs to change with it.
const DEEP_WORK_MIN_MEDIAN_MINUTES = 25;

function classifyDeepWork(tagId, tagMedianMinutes) {
  if (!tagId || tagMedianMinutes == null) return 0;
  return tagMedianMinutes >= DEEP_WORK_MIN_MEDIAN_MINUTES ? 1 : 0;
}

// `context` carries the per-session state that isn't on the session
// row itself: minutes already logged that calendar day before this
// session started, and hours since the previous session ended (capped
// at 24 so one multi-day gap doesn't dominate the feature's scale).
function extractFeatureVector(session, context, tagStats) {
  const started = new Date(session.started_at);
  const hour = started.getHours() + started.getMinutes() / 60;
  const angle = (hour / 24) * 2 * Math.PI;
  const dayOfWeek = started.getDay(); // 0 = Sunday
  const durationMinutes = (new Date(session.ended_at).getTime() - started.getTime()) / 60000;
  const stats = tagStats.get(session.tag_id);

  return [
    1, // bias
    Math.sin(angle),
    Math.cos(angle),
    dayOfWeek === 0 || dayOfWeek === 6 ? 1 : 0,
    durationMinutes,
    session.task_id ? 1 : 0,
    context.minutesLoggedTodayBefore,
    Math.min(context.hoursSinceLastSession, 24),
    classifyDeepWork(session.tag_id, stats?.medianMinutes),
  ];
}

function sigmoid(z) {
  // Clamped before exponentiating - z can swing large during early
  // gradient-descent iterations with unscaled features, and
  // Math.exp of a large positive number overflows to Infinity,
  // which would turn a confident prediction into NaN instead of 0.
  if (z >= 0) {
    const e = Math.exp(-Math.min(z, 500));
    return 1 / (1 + e);
  }
  const e = Math.exp(Math.max(z, -500));
  return e / (1 + e);
}

// z-score standardization, fit on the training set and reused as-is at
// inference time - logistic regression's gradient descent converges
// reliably when features share a scale (session_minutes can be in the
// hundreds, hour_sin/cos are in [-1, 1]; without this the longer-range
// feature dominates the gradient and training needs far more
// iterations, or diverges).
function standardize(X, meanOverride, stdOverride) {
  const n = X.length;
  const d = X[0].length;
  const mean = meanOverride || Array(d).fill(0);
  const std = stdOverride || Array(d).fill(1);
  if (!meanOverride) {
    for (let j = 0; j < d; j++) {
      if (j === 0) continue; // never touch the bias column
      let sum = 0;
      for (let i = 0; i < n; i++) sum += X[i][j];
      mean[j] = sum / n;
    }
    for (let j = 0; j < d; j++) {
      if (j === 0) continue;
      let sq = 0;
      for (let i = 0; i < n; i++) sq += (X[i][j] - mean[j]) ** 2;
      // A feature that's constant across every session (std 0) would
      // divide by zero below; falling back to 1 just leaves that
      // column at its (now zero, since mean-subtracted) value instead
      // of blowing up - mathematically inert rather than NaN-producing.
      std[j] = Math.sqrt(sq / n) || 1;
    }
  }
  return X.map((row) => row.map((v, j) => (j === 0 ? v : (v - mean[j]) / std[j])));
}

// Batch gradient descent with L2 regularization (the bias term is
// deliberately excluded from the penalty - regularizing it would bias
// the model toward predicting 50/50 regardless of how skewed the
// user's real focused-vs-not split is).
function trainLogisticRegression(X, y, { iterations = 1000, learningRate = 0.3, l2 = 0.5 } = {}) {
  const n = X.length;
  const d = X[0].length;
  const weights = Array(d).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    const gradients = Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((sum, x, j) => sum + x * weights[j], 0);
      const pred = sigmoid(z);
      const error = pred - y[i];
      for (let j = 0; j < d; j++) gradients[j] += error * X[i][j];
    }
    for (let j = 0; j < d; j++) {
      const reg = j === 0 ? 0 : l2 * weights[j];
      weights[j] -= (learningRate * (gradients[j] / n + reg / n));
    }
  }
  return weights;
}

// Returns null when there isn't enough (or enough balanced) labeled
// data to trust a fitted model - callers must treat null as "no
// prediction available," not "predict 0."
function trainQualityModel(sessions) {
  const labeled = sessions.filter((s) => s.quality === "focused" || s.quality === "neutral" || s.quality === "distracted");
  if (labeled.length < MIN_LABELED_SESSIONS) return null;

  const y = labeled.map((s) => (s.quality === "focused" ? 1 : 0));
  const positiveFraction = y.reduce((a, b) => a + b, 0) / y.length;
  if (Math.min(positiveFraction, 1 - positiveFraction) < MIN_MINORITY_CLASS_FRACTION) return null;

  // Per-tag median session length, used only to classify deep-work vs
  // quick-admin (see classifyDeepWork) - computed across ALL sessions
  // (not just labeled ones) for a more stable median, same reasoning
  // priorityEngine.js's own tag-typical-seconds computation already
  // uses a wider sample than just the scored subset.
  const byTag = new Map();
  for (const s of sessions) {
    if (!s.tag_id) continue;
    const mins = (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000;
    if (!byTag.has(s.tag_id)) byTag.set(s.tag_id, []);
    byTag.get(s.tag_id).push(mins);
  }
  const tagStats = new Map();
  for (const [tagId, durations] of byTag) {
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    tagStats.set(tagId, { medianMinutes: median });
  }

  // Per-session context (minutes already logged that day, gap since
  // the previous session) requires the FULL chronological session list
  // to compute, not just the labeled subset - a labeled session's
  // "minutes logged today before it" still depends on earlier
  // unlabeled sessions that same day.
  const sortedAll = [...sessions].sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  const contextById = new Map();
  let lastEnd = null;
  const dayTotals = new Map(); // "YYYY-MM-DD" -> minutes so far
  for (const s of sortedAll) {
    const started = new Date(s.started_at);
    const dayKey = started.toISOString().slice(0, 10);
    const minutesLoggedTodayBefore = dayTotals.get(dayKey) || 0;
    const hoursSinceLastSession = lastEnd ? (started.getTime() - lastEnd.getTime()) / 3600000 : 24;
    contextById.set(s.id, { minutesLoggedTodayBefore, hoursSinceLastSession });
    const durationMinutes = (new Date(s.ended_at).getTime() - started.getTime()) / 60000;
    dayTotals.set(dayKey, minutesLoggedTodayBefore + durationMinutes);
    lastEnd = new Date(s.ended_at);
  }

  const X = labeled.map((s) => extractFeatureVector(s, contextById.get(s.id), tagStats));
  const mean = Array(FEATURE_NAMES.length).fill(0);
  const std = Array(FEATURE_NAMES.length).fill(1);
  const Xstd = standardize(X, null, null);
  // standardize() computed mean/std as a side effect into fresh arrays
  // internally; re-derive them here the same way so they can be stored
  // alongside the weights for inference to reuse exactly.
  for (let j = 1; j < FEATURE_NAMES.length; j++) {
    let sum = 0;
    for (const row of X) sum += row[j];
    mean[j] = sum / X.length;
    let sq = 0;
    for (const row of X) sq += (row[j] - mean[j]) ** 2;
    std[j] = Math.sqrt(sq / X.length) || 1;
  }

  const weights = trainLogisticRegression(Xstd, y);
  return { weights, mean, std, featureNames: FEATURE_NAMES, trainedOn: labeled.length };
}

// For a single candidate session-to-start, builds its feature vector
// the same way training did and returns the predicted probability of
// it being rated "focused." `context`/`tagStats` must be computed the
// same way as during training (see trainQualityModel) for the
// prediction to mean anything.
function predictQuality(model, session, context, tagStats) {
  if (!model) return null;
  const raw = extractFeatureVector(session, context, tagStats);
  const standardized = raw.map((v, j) => (j === 0 ? v : (v - model.mean[j]) / model.std[j]));
  const z = standardized.reduce((sum, x, j) => sum + x * model.weights[j], 0);
  return sigmoid(z);
}

export {
  FEATURE_NAMES,
  MIN_LABELED_SESSIONS,
  extractFeatureVector,
  trainLogisticRegression,
  trainQualityModel,
  predictQuality,
  sigmoid,
};
