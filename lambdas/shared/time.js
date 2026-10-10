// Fechas en la zona de la app (misma semántica que backend/src/lib/time.js).
const DAY_MS = 86400000;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

function appTz() {
    return process.env.APP_TZ || 'America/Mexico_City';
}

// Fecha local YYYY-MM-DD en la zona de la app.
function localDate(now = new Date(), tz = appTz()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
}

// Semana ISO 8601 de una fecha de calendario YYYY-MM-DD.
function weekIdOfDate(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const day = date.getUTCDay() || 7; // lunes = 1 ... domingo = 7
    date.setUTCDate(date.getUTCDate() + 4 - day); // jueves de esa semana
    const year = date.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil(((date - yearStart) / DAY_MS + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

// Semana ISO 8601 de la fecha local, formato YYYY-Www.
function isoWeekId(now = new Date(), tz = appTz()) {
    return weekIdOfDate(localDate(now, tz));
}

// Suma días a una fecha de calendario YYYY-MM-DD.
function addDays(ymd, days) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

// Semana ISO anterior a la semana local en curso.
function previousWeekId(now = new Date(), tz = appTz()) {
    return weekIdOfDate(addDays(localDate(now, tz), -7));
}

// Lunes (YYYY-MM-DD) de una semana ISO, o null si el weekId no existe (p. ej. W53 en un año de 52).
function weekMonday(weekId) {
    const match = typeof weekId === 'string' && WEEK_RE.exec(weekId);
    if (!match) return null;
    const year = Number(match[1]);
    const week = Number(match[2]);
    if (week < 1 || week > 53) return null;
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY_MS + (week - 1) * 7 * DAY_MS);
    const ymd = monday.toISOString().slice(0, 10);
    return weekIdOfDate(ymd) === weekId ? ymd : null;
}

function isValidWeekId(weekId) {
    return weekMonday(weekId) !== null;
}

module.exports = { localDate, isoWeekId, weekIdOfDate, addDays, previousWeekId, weekMonday, isValidWeekId };
