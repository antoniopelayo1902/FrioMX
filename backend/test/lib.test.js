const { localDate, isoWeekId } = require('../src/lib/time');
const v = require('../src/lib/validate');

describe('time', () => {
    test('semana ISO en cambio de año', () => {
        expect(isoWeekId(new Date('2026-12-31T18:00:00Z'))).toBe('2026-W53');
        expect(isoWeekId(new Date('2027-01-04T18:00:00Z'))).toBe('2027-W01');
        expect(isoWeekId(new Date('2026-10-08T18:00:00Z'))).toBe('2026-W41');
    });

    test('usa la fecha local de Ciudad de México', () => {
        // 2026-10-09 03:00 UTC es todavía 8 de octubre en CDMX
        expect(localDate(new Date('2026-10-09T03:00:00Z'))).toBe('2026-10-08');
    });
});

describe('validaciones', () => {
    test('apuesta entera de 1 a 10000', () => {
        expect(v.betAmount(1)).toBe(1);
        expect(() => v.betAmount(0)).toThrow();
        expect(() => v.betAmount(2.5)).toThrow();
        expect(() => v.betAmount('10')).toThrow();
        expect(() => v.betAmount(10001)).toThrow();
    });

    test('contraseña de 8 caracteres y máximo 72 bytes', () => {
        expect(() => v.password('corta')).toThrow();
        expect(v.password('a'.repeat(72))).toHaveLength(72);
        expect(() => v.password('ñ'.repeat(40))).toThrow(); // 80 bytes
    });

    test('edad acepta texto numérico', () => {
        expect(v.age('25')).toBe(25);
        expect(() => v.age('17')).toThrow();
        expect(() => v.age('abc')).toThrow();
    });

    test('correo se normaliza', () => {
        expect(v.email('  Ana@Correo.COM ')).toBe('ana@correo.com');
        expect(() => v.email('no-es-correo')).toThrow();
    });
});
