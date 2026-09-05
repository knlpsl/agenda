/**
 * Backend unique (Google Apps Script) pour "Viens me voir à Londres".
 *
 * Deux responsabilités :
 *  1. regenerateAndPublish() — relit l'agenda Google, recalcule les 3 sections
 *     de la page, et republie index.html sur GitHub. Appelée par un
 *     déclencheur temporel (voir installDailyTrigger) ET après chaque
 *     réservation.
 *  2. doPost(e) — point d'entrée du Web App public. Reçoit une demande de
 *     réservation depuis la page, crée l'événement dans l'agenda, notifie
 *     par email, puis republie la page.
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
  windowAnchor: { year: 2026, month: 11, day: 14 }, // 1-indexed month
  windowMonths: 6,
  parisEventTitle: 'KNL à Paris',
  visitTitlePattern: /^(.+?)\s+en visite à Londres$/i,
};

const FR_MONTHS_FULL = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
const FR_MONTHS_SHORT = [
  'Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin',
  'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.',
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
  const { windowStart, windowEnd } = computeWindow();
  const sections = computeSections(windowStart, windowEnd);
  publishSections(sections, windowStart, windowEnd);
}

/**
 * Web App entry point (deploy as: Execute as Me, Access: Anyone).
 * Expects a JSON body: {"name": "...", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}
 * where `end` is the exclusive end date already computed by the front-end
 * (start + 2 days for a Saturday-Sunday weekend).
 */
function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, message: 'Requête invalide.' });
  }

  const name = (payload.name || '').toString().trim();
  const startStr = (payload.start || '').toString().trim();
  const endStr = (payload.end || '').toString().trim();

  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
    return jsonResponse({ ok: false, message: 'Champs manquants ou invalides.' });
  }
  if (name.length > 60) {
    return jsonResponse({ ok: false, message: 'Prénom trop long.' });
  }

  const { windowStart, windowEnd } = computeWindow();
  const sections = computeSections(windowStart, windowEnd);

  const stillFree = sections.free.some((w) => w.startKey === startStr && w.endKey === endStr);
  if (!stillFree) {
    return jsonResponse({ ok: false, message: "Ce week-end vient d'être pris entre-temps, désolé — recharge la page." });
  }

  const start = parseDateKey(startStr);
  const end = parseDateKey(endStr);

  CalendarApp.getDefaultCalendar().createAllDayEvent(`${name} en visite à Londres`, start, end);

  try {
    notifyNewBooking(name, sections.free.find((w) => w.startKey === startStr));
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

// ---- Window & section computation ------------------------------------------

function computeWindow() {
  const tz = CONFIG.timeZone;
  const anchor = new Date(CONFIG.windowAnchor.year, CONFIG.windowAnchor.month - 1, CONFIG.windowAnchor.day);
  const today = dateOnly(new Date(), tz);
  const windowStart = today > anchor ? today : anchor;
  const windowEnd = new Date(windowStart);
  windowEnd.setMonth(windowEnd.getMonth() + CONFIG.windowMonths);
  return { windowStart, windowEnd };
}

function computeSections(windowStart, windowEnd) {
  const events = CalendarApp.getDefaultCalendar().getEvents(windowStart, windowEnd);

  const parisRanges = [];
  const visits = [];

  events.forEach((ev) => {
    const title = ev.getTitle().trim();
    const { start, end } = eventDateRange(ev);
    if (title === CONFIG.parisEventTitle) {
      parisRanges.push({ start, end });
      return;
    }
    const match = title.match(CONFIG.visitTitlePattern);
    if (match) {
      visits.push({ name: match[1].trim(), start, end });
    }
  });

  const weekends = enumerateWeekends(windowStart, windowEnd);

  const taken = [];
  const free = [];

  weekends.forEach((w) => {
    if (rangesOverlapWeekend(parisRanges, w)) return; // couvert par un séjour Paris
    const visit = visits.find((v) => rangeOverlapsWeekend(v, w));
    if (visit) {
      taken.push({ ...w, name: visit.name, visitStart: visit.start, visitEnd: visit.end });
    } else {
      free.push(w);
    }
  });

  return {
    paris: mergeAdjacentRanges(parisRanges).sort((a, b) => a.start - b.start),
    taken: dedupeTakenByVisit(taken),
    free,
  };
}

function eventDateRange(ev) {
  if (ev.isAllDayEvent()) {
    return { start: dateOnly(ev.getAllDayStartDate(), CONFIG.timeZone), end: dateOnly(ev.getAllDayEndDate(), CONFIG.timeZone) };
  }
  return { start: dateOnly(ev.getStartTime(), CONFIG.timeZone), end: dateOnly(addDays(ev.getEndTime(), 1), CONFIG.timeZone) };
}

/** Génère tous les week-ends (samedi+dimanche) dans [windowStart, windowEnd). */
function enumerateWeekends(windowStart, windowEnd) {
  const weekends = [];
  const cursor = new Date(windowStart);
  // avance jusqu'au premier samedi
  while (cursor.getDay() !== 6) cursor.setDate(cursor.getDate() + 1);
  while (cursor < windowEnd) {
    const saturday = new Date(cursor);
    const sunday = addDays(saturday, 1);
    const mondayExclusive = addDays(saturday, 2);
    weekends.push({
      start: saturday,
      end: mondayExclusive, // exclusive, cohérent avec le format all-day de Calendar
      startKey: formatDateKey(saturday),
      endKey: formatDateKey(mondayExclusive),
      label: formatWeekendLabel(saturday, sunday),
      monthLabel: FR_MONTHS_SHORT[sunday.getMonth()],
    });
    cursor.setDate(cursor.getDate() + 7);
  }
  return weekends;
}

function rangeOverlapsWeekend(range, weekend) {
  return range.start < weekend.end && range.end > weekend.start;
}
function rangesOverlapWeekend(ranges, weekend) {
  return ranges.some((r) => rangeOverlapsWeekend(r, weekend));
}

function dedupeTakenByVisit(taken) {
  const seen = new Set();
  const out = [];
  taken.forEach((t) => {
    const key = t.name + '|' + formatDateKey(t.visitStart) + '|' + formatDateKey(t.visitEnd);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  });
  return out;
}

function mergeAdjacentRanges(ranges) {
  // Chaque "KNL à Paris" est déjà un séjour complet ; pas de fusion nécessaire
  // sauf si deux événements se chevauchent littéralement (cas limite).
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

// ---- HTML rendering ---------------------------------------------------------

function publishSections(sections, windowStart, windowEnd) {
  const takenHtml = sections.taken.length
    ? sections.taken.map(renderTakenCard).join('\n    ')
    : '<p class="section-sub" style="margin:0">Aucune visite prévue pour l\'instant.</p>';

  const parisHtml = sections.paris.map(renderParisChip).join('\n      ');

  const freeHtml = sections.free.map(renderFreeChip).join('\n      ');

  const freecountHtml = `${sections.free.length} week-end${sections.free.length === 1 ? '' : 's'} encore sans plan, entre le ${formatFullDate(windowStart)} et le ${formatFullDate(windowEnd)}.`;

  const footerHtml = `Dernière mise à jour : ${formatFullDateWithWeekday(new Date())} — fenêtre glissante de 6 mois à partir du ${formatFullDate(windowStart)}`;

  const current = ghGetFile();
  let html = current.content;
  html = replaceBetweenMarkers(html, 'TAKEN', takenHtml);
  html = replaceBetweenMarkers(html, 'PARIS', parisHtml);
  html = replaceBetweenMarkers(html, 'FREE', freeHtml);
  html = replaceBetweenMarkers(html, 'FREECOUNT', freecountHtml);
  html = replaceBetweenMarkers(html, 'FOOTER', footerHtml);

  if (html === current.content) return; // rien à publier

  ghPutFile(html, current.sha, `Sync agenda: ${formatFullDateWithWeekday(new Date())}`);
}

function renderTakenCard(t) {
  return `<div class="taken-card">
      <span>🎉</span>
      <span><strong>${escapeHtml(t.name)}</strong> vient du ${formatDayMonth(t.visitStart)} au ${formatDayMonth(addDays(t.visitEnd, -1))}${yearSuffix(t.visitEnd)}</span>
      <span class="tag">Complet</span>
    </div>`;
}

function renderParisChip(range) {
  const lastDay = addDays(range.end, -1);
  const sameMonth = range.start.getMonth() === lastDay.getMonth() && range.start.getFullYear() === lastDay.getFullYear();
  const sameYear = range.start.getFullYear() === lastDay.getFullYear();
  const startLabel = sameMonth ? `${range.start.getDate()}` : `${range.start.getDate()} ${FR_MONTHS_SHORT[range.start.getMonth()].toLowerCase()}`;
  const endLabel = `${lastDay.getDate()}${sameMonth ? '' : ' ' + FR_MONTHS_SHORT[lastDay.getMonth()].toLowerCase()}`;
  const note = sameMonth ? FR_MONTHS_SHORT[range.start.getMonth()] : (sameYear ? FR_MONTHS_SHORT[lastDay.getMonth()] : String(lastDay.getFullYear()));
  return `<div class="paris-chip"><span class="dates">${startLabel}–${endLabel}</span><span class="note">${note}</span></div>`;
}

function renderFreeChip(w) {
  return `<button type="button" class="chip" data-start="${w.startKey}" data-end="${w.endKey}" data-label="${w.label} ${w.monthLabel}"><span class="chip-dates">${w.label}</span><span class="chip-month">${w.monthLabel}</span></button>`;
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

function notifyNewBooking(name, weekend) {
  const label = weekend ? `${weekend.label} ${weekend.monthLabel}` : '(date inconnue)';
  MailApp.sendEmail({
    to: CONFIG.notifyEmail,
    subject: `Nouvelle visite à Londres : ${name}`,
    body: `${name} vient de réserver le week-end du ${label} sur "Viens me voir à Londres".\n\nL'événement a été ajouté à ton agenda et la page a été republiée.`,
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
function formatWeekendLabel(saturday, sunday) {
  return `${saturday.getDate()}–${sunday.getDate()}`;
}
function formatDayMonth(d) {
  return `${d.getDate()} ${FR_MONTHS_FULL[d.getMonth()]}`;
}
function yearSuffix(endExclusive) {
  return ` ${addDays(endExclusive, -1).getFullYear()}`;
}
function formatFullDate(d) {
  return `${d.getDate()} ${FR_MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
}
function formatFullDateWithWeekday(d) {
  return `${FR_WEEKDAYS[d.getDay()]} ${formatFullDate(d)}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
