/**
 * Backend unique (Google Apps Script) pour "Viens me voir à Londres".
 *
 * Deux responsabilités :
 *  1. regenerateAndPublish() — relit l'agenda Google, recalcule l'état
 *     (séjours Paris / réservations / jours libres) et republie index.html
 *     sur GitHub. Appelée par un déclencheur temporel (voir
 *     installDailyTrigger) ET après chaque réservation.
 *  2. doPost(e) — point d'entrée du Web App public. Reçoit une sélection
 *     d'un ou plusieurs jours depuis la page, crée le ou les événements
 *     dans l'agenda, notifie par email, puis republie la page.
 *
 * La page ne contient plus de HTML pré-rendu par jour : index.html embarque
 * juste un petit bloc de données (marqueur DATA) que le calendrier, écrit une
 * fois pour toutes côté front, lit pour dessiner la grille. Voir le <script>
 * de données dans index.html.
 *
 * Secret requis : une propriété de script GITHUB_TOKEN (Project Settings >
 * Script Properties), jamais écrite en dur ici. Voir README.md pour la
 * procédure complète.
 */

// ---- Configuration -------------------------------------------------------

const CONFIG = {
  githubOwner: 'knlpsl',
  githubRepo: 'agenda',
  githubBranch: 'main',
  githubFilePath: 'index.html',
  notifyEmail: 'c.pelissolo@gmail.com',
  timeZone: 'Europe/Paris',
  windowAnchor: { year: 2026, month: 11, day: 14 }, // début, jamais avant cette date (1-indexed month)
  windowMonths: 15, // longueur glissante de la fenêtre à partir du début
  windowLatestEnd: { year: 2028, month: 6, day: 30 }, // fin, jamais après cette date (dernier jour affiché)
  parisEventTitle: 'KNL à Paris',
  visitTitlePattern: /^(.+?)\s+en visite à Londres$/i,
  maxDatesPerBooking: 60,
};

const FR_MONTHS_FULL = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
const FR_WEEKDAYS = [
  'dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi',
];

// ---- Entry points ----------------------------------------------------------

/**
 * Run once manually from the Apps Script editor to grant Calendar/Gmail/
 * external-request scopes, then again any time you want to force a sync.
 * Also wired to the daily time-driven trigger (see installDailyTrigger).
 */
function regenerateAndPublish() {
  publishState(computeState());
}

/**
 * Web App entry point (deploy as: Execute as Me, Access: Anyone).
 * Expects a JSON body: {"name": "...", "dates": ["YYYY-MM-DD", ...]}
 * `dates` can be any number of days, contiguous or not — one all-day
 * Calendar event is created per contiguous run of selected days.
 */
function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, message: 'Requête invalide.' });
  }

  const name = (payload.name || '').toString().trim();
  const rawDates = Array.isArray(payload.dates) ? payload.dates : [];
  const dates = [...new Set(rawDates.map(String))].sort();

  if (!name || name.length > 60) {
    return jsonResponse({ ok: false, message: 'Prénom manquant ou trop long.' });
  }
  if (!dates.length || dates.length > CONFIG.maxDatesPerBooking) {
    return jsonResponse({ ok: false, message: 'Sélection de jours invalide.' });
  }
  if (!dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    return jsonResponse({ ok: false, message: 'Format de date invalide.' });
  }

  const state = computeState();
  const unavailable = dates.find((d) => !state.freeSet.has(d));
  if (unavailable) {
    return jsonResponse({ ok: false, message: `Le ${formatDDMM(parseDateKey(unavailable))} vient d'être pris entre-temps, désolé — recharge la page.` });
  }

  groupConsecutive(dates).forEach((run) => {
    const start = parseDateKey(run[0]);
    const end = addDays(parseDateKey(run[run.length - 1]), 1); // exclusif
    CalendarApp.getDefaultCalendar().createAllDayEvent(`${name} en visite à Londres`, start, end);
  });

  try {
    notifyNewBooking(name, dates);
  } catch (err) {
    // Ne bloque jamais la réservation si l'email échoue.
  }

  // Republier immédiatement pour refléter la réservation sur la page.
  regenerateAndPublish();

  return jsonResponse({ ok: true });
}

/** À exécuter une seule fois pour poser le déclencheur quotidien. */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'regenerateAndPublish')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('regenerateAndPublish').timeBased().everyDays(1).atHour(6).create();
}

// ---- State computation -------------------------------------------------------

function computeWindow() {
  const tz = CONFIG.timeZone;
  const anchor = new Date(CONFIG.windowAnchor.year, CONFIG.windowAnchor.month - 1, CONFIG.windowAnchor.day);
  const today = dateOnly(new Date(), tz);
  const windowStart = today > anchor ? today : anchor;

  const rollingEnd = new Date(windowStart);
  rollingEnd.setMonth(rollingEnd.getMonth() + CONFIG.windowMonths);

  const latestLastDay = new Date(CONFIG.windowLatestEnd.year, CONFIG.windowLatestEnd.month - 1, CONFIG.windowLatestEnd.day);
  const latestEnd = addDays(latestLastDay, 1); // exclusif

  const windowEnd = rollingEnd < latestEnd ? rollingEnd : latestEnd;
  return { windowStart, windowEnd };
}

/**
 * Lit l'agenda et calcule l'état complet : séjours Paris, réservations, et
 * l'ensemble des jours libres (freeSet) dans la fenêtre glissante.
 */
function computeState() {
  const { windowStart, windowEnd } = computeWindow();
  const events = CalendarApp.getDefaultCalendar().getEvents(windowStart, windowEnd);

  const parisRanges = [];
  const bookings = [];

  events.forEach((ev) => {
    const title = ev.getTitle().trim();
    const { start, end } = eventDateRange(ev);
    if (title === CONFIG.parisEventTitle) {
      parisRanges.push({ start, end });
      return;
    }
    const match = title.match(CONFIG.visitTitlePattern);
    if (match) {
      bookings.push({ name: match[1].trim(), start, end });
    }
  });

  const mergedParis = mergeAdjacentRanges(parisRanges).sort((a, b) => a.start - b.start);
  const sortedBookings = bookings.sort((a, b) => a.start - b.start);

  const covered = new Set();
  const markCovered = (range) => {
    const from = new Date(Math.max(range.start, windowStart));
    const to = new Date(Math.min(range.end, windowEnd));
    for (let d = from; d < to; d.setDate(d.getDate() + 1)) covered.add(formatDateKey(d));
  };
  mergedParis.forEach(markCovered);
  sortedBookings.forEach(markCovered);

  const freeSet = new Set();
  for (let d = new Date(windowStart); d < windowEnd; d.setDate(d.getDate() + 1)) {
    const key = formatDateKey(d);
    if (!covered.has(key)) freeSet.add(key);
  }

  return { windowStart, windowEnd, parisRanges: mergedParis, bookings: sortedBookings, freeSet };
}

function eventDateRange(ev) {
  if (ev.isAllDayEvent()) {
    return { start: dateOnly(ev.getAllDayStartDate(), CONFIG.timeZone), end: dateOnly(ev.getAllDayEndDate(), CONFIG.timeZone) };
  }
  return { start: dateOnly(ev.getStartTime(), CONFIG.timeZone), end: dateOnly(addDays(ev.getEndTime(), 1), CONFIG.timeZone) };
}

function mergeAdjacentRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [];
  sorted.forEach((r) => {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = r.end > last.end ? r.end : last.end;
    } else {
      merged.push({ ...r });
    }
  });
  return merged;
}

/** Regroupe une liste triée de clés 'YYYY-MM-DD' en runs de jours consécutifs. */
function groupConsecutive(sortedKeys) {
  const groups = [];
  let current = [sortedKeys[0]];
  for (let i = 1; i < sortedKeys.length; i++) {
    const expected = formatDateKey(addDays(parseDateKey(sortedKeys[i - 1]), 1));
    if (sortedKeys[i] === expected) {
      current.push(sortedKeys[i]);
    } else {
      groups.push(current);
      current = [sortedKeys[i]];
    }
  }
  groups.push(current);
  return groups;
}

// ---- Publishing ---------------------------------------------------------

function publishState(state) {
  const dataBlock = buildDataBlock(state);
  const lastDayShown = addDays(state.windowEnd, -1);
  const footerText = `Dernière mise à jour : ${formatFullDateWithWeekday(new Date())} — calendrier affiché du ${formatFullDate(state.windowStart)} au ${formatFullDate(lastDayShown)}`;

  const current = ghGetFile();
  let html = current.content;
  html = replaceBetweenMarkers(html, 'DATA', dataBlock);
  html = replaceBetweenMarkers(html, 'FOOTER', footerText);

  if (html === current.content) return; // rien à publier

  ghPutFile(html, current.sha, `Sync agenda: ${formatFullDateWithWeekday(new Date())}`);
}

function buildDataBlock(state) {
  const parisRanges = state.parisRanges.map((r) => [formatDateKey(r.start), formatDateKey(addDays(r.end, -1))]);
  const bookings = state.bookings.map((b) => ({ name: b.name, start: formatDateKey(b.start), end: formatDateKey(addDays(b.end, -1)) }));
  return [
    `const WINDOW_START = ${JSON.stringify(formatDateKey(state.windowStart))};`,
    `const WINDOW_END = ${JSON.stringify(formatDateKey(state.windowEnd))};`,
    `const PARIS_RANGES = ${JSON.stringify(parisRanges)};`,
    `const BOOKINGS = ${JSON.stringify(bookings)};`,
  ].join('\n      ');
}

// ---- GitHub Contents API ----------------------------------------------------

function ghGetFile() {
  const url = `https://api.github.com/repos/${CONFIG.githubOwner}/${CONFIG.githubRepo}/contents/${CONFIG.githubFilePath}?ref=${CONFIG.githubBranch}`;
  const res = UrlFetchApp.fetch(url, { headers: ghHeaders(), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error(`GitHub GET failed (${res.getResponseCode()}): ${res.getContentText()}`);
  }
  const body = JSON.parse(res.getContentText());
  const bytes = Utilities.base64Decode(body.content.replace(/\n/g, ''));
  const content = Utilities.newBlob(bytes).getDataAsString('UTF-8');
  return { content, sha: body.sha };
}

function ghPutFile(newContent, sha, message) {
  const url = `https://api.github.com/repos/${CONFIG.githubOwner}/${CONFIG.githubRepo}/contents/${CONFIG.githubFilePath}`;
  const encoded = Utilities.base64Encode(Utilities.newBlob(newContent, 'text/html', CONFIG.githubFilePath).getBytes());
  const payload = {
    message,
    content: encoded,
    sha,
    branch: CONFIG.githubBranch,
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'put',
    headers: ghHeaders(),
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200 && res.getResponseCode() !== 201) {
    throw new Error(`GitHub PUT failed (${res.getResponseCode()}): ${res.getContentText()}`);
  }
}

function ghHeaders() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Script property GITHUB_TOKEN manquante.');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// ---- Notification ------------------------------------------------------------

function notifyNewBooking(name, dates) {
  const labels = dates.map((d) => formatDDMM(parseDateKey(d))).join(', ');
  MailApp.sendEmail({
    to: CONFIG.notifyEmail,
    subject: `Nouvelle visite à Londres : ${name}`,
    body: `${name} vient de réserver ${dates.length > 1 ? 'les jours suivants' : 'le jour suivant'} sur "Viens me voir à Londres" : ${labels}.\n\nL'événement a été ajouté à ton agenda et la page a été republiée.`,
  });
}

// ---- Small date/string utilities ---------------------------------------------

function dateOnly(d, tz) {
  const key = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  return parseDateKey(key);
}
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function formatDateKey(d) {
  return Utilities.formatDate(d, CONFIG.timeZone, 'yyyy-MM-dd');
}
function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}
function formatDDMM(d) {
  return Utilities.formatDate(d, CONFIG.timeZone, 'dd/MM');
}
function formatFullDate(d) {
  return `${d.getDate()} ${FR_MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
}
function formatFullDateWithWeekday(d) {
  return `${FR_WEEKDAYS[d.getDay()]} ${formatFullDate(d)}`;
}
function replaceBetweenMarkers(html, name, inner) {
  const startTag = `<!-- ${name}_START -->`;
  const endTag = `<!-- ${name}_END -->`;
  const startIdx = html.indexOf(startTag);
  const endIdx = html.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Marqueurs ${name} introuvables dans index.html`);
  }
  const before = html.slice(0, startIdx + startTag.length);
  const after = html.slice(endIdx);
  return `${before}\n      ${inner}\n      ${after}`;
}
function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
