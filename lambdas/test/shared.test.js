const time = require('../shared/time');
const { cancellationCodes } = require('../shared/ddb');
const metrics = require('../shared/metrics');
const { txCanceled } = require('./helpers');

describe('shared/time', () => {
    test('localDate usa America/Mexico_City (UTC-6)', () => {
        // 05:59 UTC del 10 de oct = 23:59 del 9 de oct en CDMX.
        expect(time.localDate(new Date('2026-10-10T05:59:00Z'))).toBe('2026-10-09');
        expect(time.localDate(new Date('2026-10-10T06:00:00Z'))).toBe('2026-10-10');
    });

    test('isoWeekId en cambio de año', () => {
        expect(time.isoWeekId(new Date('2026-12-31T18:00:00Z'))).toBe('2026-W53');
        expect(time.isoWeekId(new Date('2027-01-04T18:00:00Z'))).toBe('2027-W01');
        expect(time.isoWeekId(new Date('2027-01-03T18:00:00Z'))).toBe('2026-W53');
        expect(time.isoWeekId(new Date('2026-01-01T18:00:00Z'))).toBe('2026-W01');
    });

    test('isoWeekId toma la fecha local, no la UTC', () => {
        // Lunes 2026-10-12 03:00 UTC = domingo 11 de oct 21:00 local -> todavía W41.
        expect(time.isoWeekId(new Date('2026-10-12T03:00:00Z'))).toBe('2026-W41');
        expect(time.isoWeekId(new Date('2026-10-12T07:10:00Z'))).toBe('2026-W42');
    });

    test('previousWeekId cruza el año', () => {
        expect(time.previousWeekId(new Date('2027-01-04T07:10:00Z'))).toBe('2026-W53');
        expect(time.previousWeekId(new Date('2026-10-12T07:10:00Z'))).toBe('2026-W41');
        expect(time.previousWeekId(new Date('2026-10-14T18:00:00Z'))).toBe('2026-W41');
    });

    test('weekMonday e isValidWeekId', () => {
        expect(time.weekMonday('2026-W41')).toBe('2026-10-05');
        expect(time.weekMonday('2027-W01')).toBe('2027-01-04');
        expect(time.isValidWeekId('2026-W53')).toBe(true);
        expect(time.isValidWeekId('2027-W53')).toBe(false); // 2027 tiene 52 semanas
        expect(time.isValidWeekId('2026-W00')).toBe(false);
        expect(time.isValidWeekId('2026-W54')).toBe(false);
        expect(time.isValidWeekId('2026-41')).toBe(false);
        expect(time.isValidWeekId(42)).toBe(false);
    });

    test('addDays', () => {
        expect(time.addDays('2026-12-28', 7)).toBe('2027-01-04');
        expect(time.addDays('2026-03-01', -1)).toBe('2026-02-28');
    });

    test('respeta APP_TZ', () => {
        const prev = process.env.APP_TZ;
        process.env.APP_TZ = 'UTC';
        try {
            expect(time.localDate(new Date('2026-10-10T05:59:00Z'))).toBe('2026-10-10');
        } finally {
            if (prev === undefined) delete process.env.APP_TZ; else process.env.APP_TZ = prev;
        }
    });
});

describe('shared/ddb', () => {
    test('cancellationCodes lee CancellationReasons en orden', () => {
        expect(cancellationCodes(txCanceled(['None', 'ConditionalCheckFailed']))).toEqual(['None', 'ConditionalCheckFailed']);
        expect(cancellationCodes(new Error('otro'))).toBeNull();
        expect(cancellationCodes(null)).toBeNull();
    });
});

describe('shared/metrics', () => {
    let logSpy;
    beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => { logSpy.mockRestore(); delete process.env.METRICS_NAMESPACE; });

    test('emite EMF en el namespace configurado', () => {
        process.env.METRICS_NAMESPACE = 'Pruebas';
        const line = metrics.emit({ BonusGranted: 3, BonusSkipped: 0 });
        expect(line._aws.CloudWatchMetrics[0].Namespace).toBe('Pruebas');
        expect(line._aws.CloudWatchMetrics[0].Metrics).toEqual([
            { Name: 'BonusGranted', Unit: 'Count' }, { Name: 'BonusSkipped', Unit: 'Count' },
        ]);
        expect(JSON.parse(logSpy.mock.calls[0][0]).BonusGranted).toBe(3);
    });

    test('namespace por defecto FrioMx y nada que emitir sin valores', () => {
        expect(metrics.emit({ X: 1 })._aws.CloudWatchMetrics[0].Namespace).toBe('FrioMx');
        expect(metrics.emit({})).toBeNull();
        expect(logSpy).toHaveBeenCalledTimes(1);
    });
});
