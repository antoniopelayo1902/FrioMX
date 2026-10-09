const { config } = require('../config/env');

// Fecha local YYYY-MM-DD en la zona de la app.
function localDate(now = new Date(), tz = config.tz) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
}

// Semana ISO 8601 de la fecha local, formato YYYY-Www.
function isoWeekId(now = new Date(), tz = config.tz) {
    const [y, m, d] = localDate(now, tz).split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const day = date.getUTCDay() || 7; // lunes = 1 ... domingo = 7
    date.setUTCDate(date.getUTCDate() + 4 - day); // jueves de esa semana
    const year = date.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

module.exports = { localDate, isoWeekId };
