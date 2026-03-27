// notifications.js — Schedule & task notifications for Web, Desktop, and iOS.
//
// Periodically checks the schedule cache for upcoming events and tasks,
// then fires native notifications via the platform-appropriate API.
// Notifications are sent:
//   - 15 minutes before a timed event/task starts
//   - At the start of the day (8 AM) for all-day events/tasks on that day

const NOTIF_CHECK_INTERVAL = 60000;       // check every 60 seconds
const NOTIF_ADVANCE_MINUTES = 15;         // notify 15 min before timed events
const NOTIF_MORNING_HOUR = 8;             // morning summary hour
const _notifiedKeys = new Set();           // prevent duplicate notifications

let _notifPermissionGranted = false;
let _notifCheckTimer = null;
let _midnightTimeout = null;
let _midnightInterval = null;

// ── Permission request ──────────────────────────────────────────────────────

async function requestNotificationPermission() {
  // iOS / Android (Capacitor) — check first so native platforms use the
  // LocalNotifications plugin rather than the WKWebView/WebView Notification
  // API, which does not surface real system notifications on iOS.
  if (window.Capacitor?.Plugins?.LocalNotifications) {
    try {
      const result = await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
      _notifPermissionGranted = result.display === 'granted';
      return _notifPermissionGranted;
    } catch {
      return false;
    }
  }

  // Web / Desktop (Electron uses the same Notification API)
  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      _notifPermissionGranted = true;
      return true;
    }
    if (Notification.permission !== 'denied') {
      const result = await Notification.requestPermission();
      _notifPermissionGranted = result === 'granted';
      return _notifPermissionGranted;
    }
    return false;
  }

  return false;
}

// ── Send notification ────────────────────────────────────────────────────────

function sendNotification(title, body, tag) {
  if (!_notifPermissionGranted) return;

  // Deduplicate: don't re-send the same notification
  if (_notifiedKeys.has(tag)) return;
  _notifiedKeys.add(tag);

  // iOS (Capacitor)
  if (window.Capacitor?.Plugins?.LocalNotifications) {
    window.Capacitor.Plugins.LocalNotifications.schedule({
      notifications: [{
        title: title,
        body: body,
        id: Math.abs(hashCode(tag)),
        schedule: { at: new Date() },
        sound: 'default'
      }]
    }).catch(() => {});
    return;
  }

  // Web / Desktop
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, tag, icon: '001_Assets/favicon.ico' });
    } catch {
      // Some environments don't support Notification constructor
    }
  }
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// ── Check for upcoming notifications ─────────────────────────────────────────

async function checkScheduleNotifications() {
  // Re-sync permission for Web/Desktop from the live API on every check.
  // This catches the case where the user grants permission in OS Settings while
  // the app is already running, without requiring an app restart.
  // Capacitor's LocalNotifications has no synchronous permission check, so that
  // path keeps using the cached flag (refreshed on each iOS app resume).
  if (!window.Capacitor?.Plugins?.LocalNotifications && 'Notification' in window) {
    _notifPermissionGranted = Notification.permission === 'granted';
  }
  if (!_notifPermissionGranted) return;

  const now = new Date();
  const todayStr = toYYMMDD(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  let items;
  try {
    items = await getScheduleItems(todayStr);
  } catch (e) {
    console.warn('[notifications] Failed to fetch schedule items for today:', e);
    return;
  }

  // ── Morning summary for all-day events/tasks ──
  if (now.getHours() === NOTIF_MORNING_HOUR && now.getMinutes() < 2) {
    const allDay = items.filter(it => it.isAllDay && !it.isCompleted);
    if (allDay.length > 0) {
      const events = allDay.filter(it => !it.isTask);
      const tasks = allDay.filter(it => it.isTask);
      const parts = [];
      if (events.length > 0) parts.push(`${events.length} event${events.length > 1 ? 's' : ''}`);
      if (tasks.length > 0) parts.push(`${tasks.length} task${tasks.length > 1 ? 's' : ''}`);
      sendNotification(
        'Today\'s Schedule',
        `You have ${parts.join(' and ')} today.`,
        `morning-${todayStr}`
      );
    }
  }

  // ── 15-minute advance notification for timed events/tasks ──
  const timed = items.filter(it => !it.isAllDay && !it.isCompleted);
  for (const item of timed) {
    const startH = parseInt(item.startTime.slice(0, 2));
    const startM = parseInt(item.startTime.slice(2));
    const eventMinutes = startH * 60 + startM;
    const diff = eventMinutes - nowMinutes;

    if (diff > 0 && diff <= NOTIF_ADVANCE_MINUTES) {
      const label = item.isTask ? 'Task' : 'Event';
      const cleanText = stripMarkdownText(item.text || '') || 'Upcoming scheduled item';
      sendNotification(
        `${label} in ${diff} minute${diff > 1 ? 's' : ''}`,
        cleanText,
        `advance-${todayStr}-${item.startTime}-${item.text}`
      );
    }

    // Also notify at the exact start time. Window is -1..1 to tolerate
    // the 60-second check interval drifting by up to one minute.
    if (diff >= -1 && diff <= 1) {
      const label = item.isTask ? 'Task' : 'Event';
      const cleanText = stripMarkdownText(item.text || '') || 'Scheduled item starting';
      sendNotification(
        `${label} starting now`,
        cleanText,
        `start-${todayStr}-${item.startTime}-${item.text}`
      );
    }
  }

  // ── Overdue task reminder (once per day at morning hour) ──
  if (now.getHours() === NOTIF_MORNING_HOUR && now.getMinutes() < 2) {
    // Check yesterday for overdue tasks
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = toYYMMDD(yesterday);
    let yesterdayItems;
    try {
      yesterdayItems = await getScheduleItems(yesterdayStr);
    } catch (e) {
      console.warn('[notifications] Failed to fetch schedule items for yesterday:', e);
      return;
    }
    const overdueTasks = yesterdayItems.filter(it => it.isTask && !it.isCompleted);
    if (overdueTasks.length > 0) {
      sendNotification(
        'Overdue Tasks',
        `You have ${overdueTasks.length} overdue task${overdueTasks.length > 1 ? 's' : ''}.`,
        `overdue-${todayStr}`
      );
    }
  }
}

// ── Start / stop notification checking ───────────────────────────────────────

async function startNotifications() {
  const granted = await requestNotificationPermission();
  if (!granted) return;
  // Run an initial check
  checkScheduleNotifications();
  // Set up periodic checking
  if (_notifCheckTimer) clearInterval(_notifCheckTimer);
  _notifCheckTimer = setInterval(checkScheduleNotifications, NOTIF_CHECK_INTERVAL);
}

function stopNotifications() {
  if (_notifCheckTimer) {
    clearInterval(_notifCheckTimer);
    _notifCheckTimer = null;
  }
}

// Clear stale notification keys daily at midnight
function clearStaleNotificationKeys() {
  _notifiedKeys.clear();
}

function scheduleMidnightClear() {
  // Clear any previously scheduled timers before (re-)scheduling.
  if (_midnightTimeout)  { clearTimeout(_midnightTimeout);   _midnightTimeout  = null; }
  if (_midnightInterval) { clearInterval(_midnightInterval); _midnightInterval = null; }

  const now = new Date();
  const msUntilMidnight =
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  _midnightTimeout = setTimeout(() => {
    _midnightTimeout = null;
    clearStaleNotificationKeys();
    _midnightInterval = setInterval(clearStaleNotificationKeys, 86400000);
  }, msUntilMidnight);
}

// Auto-start notifications on load
if (document.readyState === 'complete') {
  startNotifications();
} else {
  window.addEventListener('load', startNotifications);
}

// On iOS, restart notifications when app resumes
if (window.Capacitor?.isNativePlatform()) {
  document.addEventListener('resume', () => {
    _notifiedKeys.clear();
    // scheduleMidnightClear is NOT called here; it runs once at module load.
    // startNotifications re-queries permissions and restarts the check interval.
    startNotifications();
  });
  document.addEventListener('pause', stopNotifications);
}

// Clear stale keys at midnight (anchored to actual midnight, not a rolling 24h interval)
scheduleMidnightClear(); // called once at module load; idempotent if called again
