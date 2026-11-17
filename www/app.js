/* ==========================================================================
   CalmMind Full-Stack Frontend (PHP + MySQL Backend + Offline Fallback)
   ========================================================================== */

const API_BASE = '../api';
const LOCAL_CACHE_PREFIX = 'calmmind_mysql_user_';
const GUEST_SESSION_KEY = 'calmmind_mysql_guest';

let activeUser = null; // { id, username, full_name, isGuest }
let authMode = 'login'; // 'login' | 'register'

// -------------------- HELPERS --------------------

function getLocalDateKey(dateObj = new Date()) {
  return dateObj.toLocaleDateString('en-CA');
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createDefaultState() {
  return {
    exams: [],
    tasks: [],
    focusLogs: {},
    points: 0,
    streak: 0,
    lastActiveDate: null,
    moodHistory: [],
    timerMinutes: 25
  };
}

function normalizeState(rawObj) {
  const base = createDefaultState();
  if (!rawObj || typeof rawObj !== 'object') return base;

  return {
    ...base,
    ...rawObj,
    exams: Array.isArray(rawObj.exams)
      ? rawObj.exams.map((e) => ({
          ...e,
          completed: Boolean(e.completed),
          completedAt: e.completed ? (e.completedAt || getLocalDateKey()) : null
        }))
      : [],
    tasks: Array.isArray(rawObj.tasks)
      ? rawObj.tasks.map((t) => ({
          ...t,
          completed: Boolean(t.completed),
          date: t.date || getLocalDateKey()
        }))
      : []
  };
}

let appState = createDefaultState();
let timerInterval = null;
let isTimerRunning = false;
let timerEndTime = null;
let remainingSeconds = 25 * 60;
let dbSyncTimeout = null;

// -------------------- AUTHENTICATION (PHP + MYSQL) --------------------

function setAuthFeedback(msg, isSuccess = false) {
  const el = document.getElementById('auth-feedback-msg');
  if (!el) return;
  el.textContent = msg || '';
  el.className = isSuccess ? 'auth-feedback-text success' : 'auth-feedback-text';
}

function switchAuthMode(mode) {
  authMode = mode;
  setAuthFeedback('');

  const nameField = document.getElementById('auth-name-field');
  const confirmField = document.getElementById('auth-confirm-field');
  const submitBtn = document.getElementById('auth-submit-btn');

  const isRegister = mode === 'register';
  if (nameField) nameField.style.display = isRegister ? 'block' : 'none';
  if (confirmField) confirmField.style.display = isRegister ? 'block' : 'none';
  if (submitBtn) submitBtn.textContent = isRegister ? 'Create Account' : 'Sign In';
}

async function handleAuthSubmit() {
  const fullName = (document.getElementById('auth-name-input')?.value || '').trim();
  const username = (document.getElementById('auth-username-input')?.value || '').trim().toLowerCase();
  const password = document.getElementById('auth-password-input')?.value || '';
  const confirmPass = document.getElementById('auth-confirm-input')?.value || '';
  const submitBtn = document.getElementById('auth-submit-btn');

  if (!username || !password) {
    setAuthFeedback('Please enter both username and password.');
    return;
  }

  if (authMode === 'register') {
    if (!fullName) {
      setAuthFeedback('Please enter your full name.');
      return;
    }
    if (password.length < 6) {
      setAuthFeedback('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPass) {
      setAuthFeedback('Passwords do not match.');
      return;
    }
  }

  try {
    setAuthFeedback('');
    if (submitBtn) submitBtn.disabled = true;

    const endpoint = authMode === 'register'
      ? `${API_BASE}/auth.php?action=register`
      : `${API_BASE}/auth.php?action=login`;

    const payload = authMode === 'register'
      ? { full_name: fullName, username, password }
      : { username, password };

    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Authentication failed.');
    }

    await enterAppForUser(data.user, false);
  } catch (err) {
    setAuthFeedback(err.message || 'Could not reach PHP server. Make sure Apache & MySQL are running in XAMPP.');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function enterGuestMode() {
  localStorage.setItem(GUEST_SESSION_KEY, 'true');
  await enterAppForUser(
    { id: 'guest', username: 'offline_guest', full_name: 'Student' },
    true
  );
}

async function enterAppForUser(user, isGuest = false) {
  activeUser = { ...user, isGuest };

  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('main-tabs').style.display = 'flex';

  const welcomeEl = document.getElementById('welcome-user-label');
  const accountLabelEl = document.getElementById('account-user-label');

  if (welcomeEl) welcomeEl.textContent = `Welcome back, ${user.full_name}`;
  if (accountLabelEl) {
    accountLabelEl.textContent = isGuest
      ? 'Offline Local Mode'
      : `${user.full_name} (@${user.username})`;
  }

  const cacheKey = `${LOCAL_CACHE_PREFIX}${user.id}`;
  const cachedRaw = localStorage.getItem(cacheKey);
  appState = cachedRaw ? normalizeState(JSON.parse(cachedRaw)) : createDefaultState();

  remainingSeconds = (appState.timerMinutes || 25) * 60;
  const timerSegment = document.getElementById('timer-preset-segment');
  if (timerSegment) timerSegment.value = String(appState.timerMinutes || 25);

  renderAll();

  if (!isGuest) {
    await pullFromMySQL();
  } else {
    updateSyncStatus('Offline Mode: Data saved locally in browser.');
  }
}

async function signOutUser() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  isTimerRunning = false;
  localStorage.removeItem(GUEST_SESSION_KEY);

  if (activeUser && !activeUser.isGuest) {
    try {
      await fetch(`${API_BASE}/auth.php?action=logout`, {
        method: 'POST',
        credentials: 'include'
      });
    } catch (_) {}
  }

  activeUser = null;
  document.getElementById('main-tabs').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  setAuthFeedback('');
}

// -------------------- MYSQL DATABASE SYNC --------------------

function updateSyncStatus(text) {
  const el = document.getElementById('cloud-sync-status');
  if (el) el.textContent = text;
}

function saveState() {
  if (!activeUser) return;
  localStorage.setItem(`${LOCAL_CACHE_PREFIX}${activeUser.id}`, JSON.stringify(appState));

  if (!activeUser.isGuest) {
    clearTimeout(dbSyncTimeout);
    dbSyncTimeout = setTimeout(() => {
      pushToMySQL(true);
    }, 800);
  }
}

async function pushToMySQL(silent = false) {
  if (!activeUser || activeUser.isGuest) return;

  try {
    if (!silent) updateSyncStatus('Saving to MySQL database...');

    const res = await fetch(`${API_BASE}/study_data.php`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: appState })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Sync failed.');
    }

    updateSyncStatus(`Saved to MySQL at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error('MySQL push error:', err);
    updateSyncStatus('Offline or server unreachable — saved locally on device.');
  }
}

async function pullFromMySQL() {
  if (!activeUser || activeUser.isGuest) return;

  try {
    updateSyncStatus('Loading data from MySQL...');

    const res = await fetch(`${API_BASE}/study_data.php`, {
      method: 'GET',
      credentials: 'include'
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Failed to load data.');
    }

    if (data.state) {
      appState = normalizeState(data.state);
      localStorage.setItem(`${LOCAL_CACHE_PREFIX}${activeUser.id}`, JSON.stringify(appState));

      remainingSeconds = (appState.timerMinutes || 25) * 60;
      const timerSegment = document.getElementById('timer-preset-segment');
      if (timerSegment) timerSegment.value = String(appState.timerMinutes || 25);

      renderAll();
      updateSyncStatus(`Synced with MySQL at ${new Date().toLocaleTimeString()}`);
    } else {
      await pushToMySQL(true);
    }
  } catch (err) {
    console.error('MySQL pull error:', err);
    updateSyncStatus('Using local cache (MySQL server unreachable).');
  }
}

// -------------------- SELECTORS & ACTIVITY TRACKING --------------------

function getActiveExams() {
  return appState.exams
    .filter((exam) => exam.completed === false)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function getCompletedExams() {
  return appState.exams
    .filter((exam) => exam.completed === true)
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
}

function recordStudyActivity(pointsEarned = 10) {
  const today = getLocalDateKey();
  if (appState.lastActiveDate !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = getLocalDateKey(yesterday);

    appState.streak = appState.lastActiveDate === yesterdayKey ? appState.streak + 1 : 1;
    appState.lastActiveDate = today;
  }
  appState.points += pointsEarned;
}

// -------------------- EXAMS & TASKS CRUD --------------------

function addExam() {
  const subjectInput = document.getElementById('exam-subject-input');
  const titleInput = document.getElementById('exam-title-input');
  const dateInput = document.getElementById('exam-date-input');

  const subject = (subjectInput?.value || '').trim();
  const title = (titleInput?.value || '').trim();
  const date = dateInput?.value || getLocalDateKey();

  if (!subject || !title) {
    alert('Please enter both the subject and exam topic.');
    return;
  }

  const newExam = {
    id: `exam_${Date.now()}`,
    subject,
    title,
    date,
    completed: false,
    completedAt: null
  };

  appState.exams.push(newExam);

  appState.tasks.push({
    id: `task_${Date.now()}_1`,
    examId: newExam.id,
    title: `Review ${subject}: ${title}`,
    date: getLocalDateKey(),
    completed: false
  });

  if (subjectInput) subjectInput.value = '';
  if (titleInput) titleInput.value = '';

  saveState();
  renderAll();
}

function toggleExamCompleted(examId) {
  const exam = appState.exams.find((e) => e.id === examId);
  if (!exam) return;

  exam.completed = !exam.completed;
  exam.completedAt = exam.completed ? getLocalDateKey() : null;

  if (exam.completed) {
    recordStudyActivity(25);
  }

  saveState();
  renderAll();
}

function deleteExam(examId) {
  appState.exams = appState.exams.filter((e) => e.id !== examId);
  appState.tasks = appState.tasks.filter((t) => t.examId !== examId);
  saveState();
  renderAll();
}

function addStudyTask() {
  const titleInput = document.getElementById('task-title-input');
  const dateInput = document.getElementById('task-date-input');

  const title = (titleInput?.value || '').trim();
  const date = dateInput?.value || getLocalDateKey();

  if (!title) {
    alert('Please enter a study task description.');
    return;
  }

  appState.tasks.push({
    id: `task_${Date.now()}`,
    examId: null,
    title,
    date,
    completed: false
  });

  if (titleInput) titleInput.value = '';

  saveState();
  renderAll();
}

function toggleTaskCompleted(taskId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;

  task.completed = !task.completed;
  if (task.completed) {
    recordStudyActivity(10);
  }

  saveState();
  renderAll();
}

function deleteTask(taskId) {
  appState.tasks = appState.tasks.filter((t) => t.id !== taskId);
  saveState();
  renderAll();
}

// -------------------- POMODORO TIMER (15m, 25m, 45m) --------------------

function formatSeconds(sec) {
  const mins = Math.floor(sec / 60);
  const secs = sec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateTimerUI() {
  const displayEl = document.getElementById('timer-display');
  const captionEl = document.getElementById('timer-preset-caption');
  const btnEl = document.getElementById('timer-start-pause-btn');

  if (displayEl) displayEl.textContent = formatSeconds(remainingSeconds);
  if (captionEl) captionEl.textContent = `${appState.timerMinutes} minute session`;

  if (btnEl) {
    btnEl.innerHTML = isTimerRunning
      ? '<ion-icon slot="start" name="pause-outline"></ion-icon>Pause'
      : '<ion-icon slot="start" name="play-outline"></ion-icon>Start Focus';
  }
}

function setTimerPreset(minutes) {
  const parsed = parseInt(minutes, 10);
  if (isNaN(parsed) || parsed <= 0) return;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  isTimerRunning = false;
  timerEndTime = null;

  appState.timerMinutes = parsed;
  remainingSeconds = parsed * 60;

  const segment = document.getElementById('timer-preset-segment');
  if (segment && segment.value !== String(parsed)) {
    segment.value = String(parsed);
  }

  const statusLabel = document.getElementById('timer-status-label');
  if (statusLabel) statusLabel.textContent = 'Ready to Focus';

  saveState();
  updateTimerUI();
}

function toggleTimer() {
  const statusLabel = document.getElementById('timer-status-label');

  if (isTimerRunning) {
    clearInterval(timerInterval);
    timerInterval = null;
    isTimerRunning = false;
    timerEndTime = null;
    if (statusLabel) statusLabel.textContent = 'Paused';
    updateTimerUI();
    return;
  }

  isTimerRunning = true;
  timerEndTime = Date.now() + remainingSeconds * 1000;
  if (statusLabel) statusLabel.textContent = 'Deep Focus Active';
  updateTimerUI();

  timerInterval = setInterval(() => {
    const diffMs = timerEndTime - Date.now();
    remainingSeconds = Math.max(0, Math.ceil(diffMs / 1000));
    updateTimerUI();

    if (remainingSeconds <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      isTimerRunning = false;
      timerEndTime = null;

      const today = getLocalDateKey();
      appState.focusLogs[today] = (appState.focusLogs[today] || 0) + appState.timerMinutes;
      recordStudyActivity(appState.timerMinutes);

      remainingSeconds = appState.timerMinutes * 60;
      if (statusLabel) statusLabel.textContent = 'Session Complete!';

      saveState();
      renderAll();
      playCompletionBeep();
    }
  }, 500);
}

function resetTimer() {
  setTimerPreset(appState.timerMinutes || 25);
}

function playCompletionBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (_) {}
}

// -------------------- UI RENDERING --------------------

function renderDashboard() {
  const today = getLocalDateKey();

  const todaysTasks = appState.tasks.filter((t) => t.date === today);
  const completedTasksToday = todaysTasks.filter((t) => t.completed);
  const completedExamsToday = appState.exams.filter(
    (e) => e.completed === true && e.completedAt === today
  );

  const totalItems = todaysTasks.length + completedExamsToday.length;
  const doneItems = completedTasksToday.length + completedExamsToday.length;
  const ratio = totalItems === 0 ? 0 : doneItems / totalItems;
  const percent = Math.round(ratio * 100);

  const progressText = document.getElementById('today-progress-text');
  const progressPercent = document.getElementById('today-progress-percent');
  const progressBar = document.getElementById('today-progress-bar');
  const focusSummary = document.getElementById('today-focus-summary');

  if (progressText) progressText.textContent = `${doneItems}/${totalItems} completed today`;
  if (progressPercent) progressPercent.textContent = `${percent}%`;
  if (progressBar) progressBar.value = ratio;
  if (focusSummary) {
    const minsToday = appState.focusLogs[today] || 0;
    focusSummary.textContent = `Focus logged today: ${minsToday} mins`;
  }

  const activeExams = getActiveExams();
  const upcomingCountEl = document.getElementById('stat-upcoming-exams');
  const nextExamNameEl = document.getElementById('stat-next-exam-name');
  const nextExamCardEl = document.getElementById('dashboard-next-exam-card');

  if (upcomingCountEl) upcomingCountEl.textContent = activeExams.length;

  if (activeExams.length > 0) {
    const next = activeExams[0];
    if (nextExamNameEl) nextExamNameEl.textContent = `${next.subject} • ${next.date}`;
    if (nextExamCardEl) {
      nextExamCardEl.innerHTML = `
        <div class="exam-card-row">
          <div class="exam-info">
            <h4>${escapeHTML(next.subject)}: ${escapeHTML(next.title)}</h4>
            <p>Scheduled on <strong>${escapeHTML(next.date)}</strong></p>
          </div>
          <ion-button size="small" color="success" onclick="toggleExamCompleted('${escapeHTML(next.id)}')">
            Mark Done
          </ion-button>
        </div>
      `;
    }
  } else {
    if (nextExamNameEl) nextExamNameEl.textContent = 'None scheduled';
    if (nextExamCardEl) {
      nextExamCardEl.innerHTML = '<p class="empty-state">No active exams. Add one in the Planner tab!</p>';
    }
  }

  const streakEl = document.getElementById('stat-streak-days');
  const pointsEl = document.getElementById('stat-total-points');
  if (streakEl) streakEl.textContent = `${appState.streak} 🔥`;
  if (pointsEl) pointsEl.textContent = `${appState.points} Calm Points`;

  const dashTaskList = document.getElementById('dashboard-today-tasks');
  if (dashTaskList) {
    if (todaysTasks.length === 0) {
      dashTaskList.innerHTML = '<p class="empty-state">No tasks scheduled for today.</p>';
    } else {
      dashTaskList.innerHTML = todaysTasks
        .map(
          (t) => `
          <ion-item>
            <ion-checkbox slot="start" checked="${t.completed}" onclick="toggleTaskCompleted('${escapeHTML(t.id)}')"></ion-checkbox>
            <ion-label class="${t.completed ? 'task-done-text' : ''}">${escapeHTML(t.title)}</ion-label>
          </ion-item>
        `
        )
        .join('');
    }
  }
}

function renderPlanner() {
  const activeExams = getActiveExams();
  const completedExams = getCompletedExams();

  const activeCountEl = document.getElementById('active-exams-count');
  const completedCountEl = document.getElementById('completed-exams-count');
  const activeListEl = document.getElementById('active-exams-list');
  const completedListEl = document.getElementById('completed-exams-list');

  if (activeCountEl) activeCountEl.textContent = activeExams.length;
  if (completedCountEl) completedCountEl.textContent = completedExams.length;

  if (activeListEl) {
    activeListEl.innerHTML = activeExams.length
      ? activeExams
          .map(
            (exam) => `
            <ion-card>
              <ion-card-content class="exam-card-row">
                <div class="exam-info">
                  <h4>${escapeHTML(exam.subject)} — ${escapeHTML(exam.title)}</h4>
                  <p>Exam Date: ${escapeHTML(exam.date)}</p>
                </div>
                <div class="exam-actions">
                  <ion-button size="small" color="success" onclick="toggleExamCompleted('${escapeHTML(exam.id)}')">
                    Complete
                  </ion-button>
                  <ion-button size="small" fill="clear" color="danger" onclick="deleteExam('${escapeHTML(exam.id)}')">
                    <ion-icon slot="icon-only" name="trash-outline"></ion-icon>
                  </ion-button>
                </div>
              </ion-card-content>
            </ion-card>
          `
          )
          .join('')
      : '<p class="empty-state">No active exams right now.</p>';
  }

  if (completedListEl) {
    completedListEl.innerHTML = completedExams.length
      ? completedExams
          .map(
            (exam) => `
            <ion-card class="exam-completed-card">
              <ion-card-content class="exam-card-row">
                <div class="exam-info">
                  <h4>${escapeHTML(exam.subject)} — ${escapeHTML(exam.title)}</h4>
                  <p>Completed on ${escapeHTML(exam.completedAt || exam.date)}</p>
                </div>
                <div class="exam-actions">
                  <ion-button size="small" fill="outline" color="medium" onclick="toggleExamCompleted('${escapeHTML(exam.id)}')">
                    Undo
                  </ion-button>
                  <ion-button size="small" fill="clear" color="danger" onclick="deleteExam('${escapeHTML(exam.id)}')">
                    <ion-icon slot="icon-only" name="trash-outline"></ion-icon>
                  </ion-button>
                </div>
              </ion-card-content>
            </ion-card>
          `
          )
          .join('')
      : '<p class="empty-state">No completed exams yet.</p>';
  }

  const allTasksEl = document.getElementById('all-tasks-list');
  if (allTasksEl) {
    if (appState.tasks.length === 0) {
      allTasksEl.innerHTML = '<p class="empty-state">Your study checklist is empty.</p>';
    } else {
      allTasksEl.innerHTML = appState.tasks
        .map(
          (task) => `
          <ion-item>
            <ion-checkbox slot="start" checked="${task.completed}" onclick="toggleTaskCompleted('${escapeHTML(task.id)}')"></ion-checkbox>
            <ion-label class="${task.completed ? 'task-done-text' : ''}">
              <h3>${escapeHTML(task.title)}</h3>
              <p>Target: ${escapeHTML(task.date)}</p>
            </ion-label>
            <ion-button slot="end" fill="clear" color="danger" onclick="deleteTask('${escapeHTML(task.id)}')">
              <ion-icon slot="icon-only" name="trash-outline"></ion-icon>
            </ion-button>
          </ion-item>
        `
        )
        .join('');
    }
  }
}

function renderBadges() {
  const badgesGrid = document.getElementById('badges-grid');
  if (!badgesGrid) return;

  const totalFocusMins = Object.values(appState.focusLogs).reduce((a, b) => a + b, 0);
  const completedExamsCount = getCompletedExams().length;

  const badges = [
    { icon: '🌱', title: 'First Step', unlocked: appState.points >= 10 },
    { icon: '⏱️', title: 'Focus Starter (15m+)', unlocked: totalFocusMins >= 15 },
    { icon: '🔥', title: '3-Day Streak', unlocked: appState.streak >= 3 },
    { icon: '🎓', title: 'Exam Crusher', unlocked: completedExamsCount >= 1 },
    { icon: '🧠', title: 'Deep Worker (60m+)', unlocked: totalFocusMins >= 60 },
    { icon: '🏆', title: 'Calm Master (200pts)', unlocked: appState.points >= 200 }
  ];

  badgesGrid.innerHTML = badges
    .map(
      (b) => `
      <div class="badge-item ${b.unlocked ? 'unlocked' : ''}">
        <div class="badge-icon">${b.icon}</div>
        <div class="badge-title">${b.title}</div>
      </div>
    `
    )
    .join('');
}

function renderAll() {
  renderDashboard();
  renderPlanner();
  renderBadges();
  updateTimerUI();
}

// -------------------- BOOTSTRAP & SESSION CHECK --------------------

document.addEventListener('DOMContentLoaded', async () => {
  const today = getLocalDateKey();
  const examDateInput = document.getElementById('exam-date-input');
  const taskDateInput = document.getElementById('task-date-input');
  if (examDateInput) examDateInput.value = today;
  if (taskDateInput) taskDateInput.value = today;

  // Auth Segment Switcher
  const authSegment = document.getElementById('auth-mode-segment');
  if (authSegment) {
    authSegment.addEventListener('ionChange', (e) => {
      if (e.detail?.value) switchAuthMode(e.detail.value);
    });
    authSegment.querySelectorAll('ion-segment-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('value');
        if (val) switchAuthMode(val);
      });
    });
  }

  document.getElementById('auth-submit-btn')?.addEventListener('click', handleAuthSubmit);
  document.getElementById('guest-mode-btn')?.addEventListener('click', enterGuestMode);
  document.getElementById('header-logout-btn')?.addEventListener('click', signOutUser);
  document.getElementById('account-logout-btn')?.addEventListener('click', signOutUser);

  document.getElementById('header-sync-btn')?.addEventListener('click', () => pushToMySQL(false));
  document.getElementById('manual-cloud-sync-btn')?.addEventListener('click', () => pushToMySQL(false));

  // Planner Buttons
  document.getElementById('add-exam-btn')?.addEventListener('click', addExam);
  document.getElementById('add-task-btn')?.addEventListener('click', addStudyTask);

  // Timer Preset Dual Binding
  const timerSegment = document.getElementById('timer-preset-segment');
  if (timerSegment) {
    timerSegment.addEventListener('ionChange', (event) => {
      if (event.detail?.value) setTimerPreset(event.detail.value);
    });
    timerSegment.querySelectorAll('ion-segment-button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('value');
        if (val) setTimerPreset(val);
      });
    });
  }

  document.getElementById('timer-start-pause-btn')?.addEventListener('click', toggleTimer);
  document.getElementById('timer-reset-btn')?.addEventListener('click', resetTimer);

  // Mood Check-in
  document.querySelectorAll('.mood-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mood = btn.getAttribute('data-mood');
      appState.moodHistory.push({ mood, date: getLocalDateKey() });
      recordStudyActivity(10);
      saveState();
      renderAll();

      const feedback = document.getElementById('mood-feedback');
      if (feedback) {
        feedback.textContent = `Logged "${mood}" (+10 Calm Points). Take a deep breath!`;
      }
    });
  });

  // Local JSON Backup Export / Import
  document.getElementById('export-json-btn')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(appState, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calmmind-backup-${getLocalDateKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const fileInput = document.getElementById('import-json-file');
  document.getElementById('import-json-btn')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        appState = normalizeState(imported);
        saveState();
        renderAll();
        alert('Backup restored successfully!');
      } catch (_) {
        alert('Invalid backup JSON file.');
      }
    };
    reader.readAsText(file);
  });

  // Check active PHP session on load
  try {
    const res = await fetch(`${API_BASE}/auth.php?action=me`, { credentials: 'include' });
    const data = await res.json();
    if (data.authenticated && data.user) {
      await enterAppForUser(data.user, false);
      return;
    }
  } catch (_) {}

  if (localStorage.getItem(GUEST_SESSION_KEY) === 'true') {
    await enterGuestMode();
  }
});
