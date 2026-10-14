const validate = require('../src/lib/validate');
const { isUuidVersion } = require('../src/lib/uuid');

jest.mock('../src/lib/uuid', () => ({
    isUuidVersion: jest.fn()
}));

describe('validate.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('betAmount', () => {
        it('debe aceptar montos válidos', () => {
            expect(validate.betAmount(500)).toBe(500);
        });
        it('debe rechazar montos inválidos (no enteros o fuera de límite)', () => {
            expect(() => validate.betAmount(0)).toThrow('betAmount debe ser un entero entre 1 y 10000');
            expect(() => validate.betAmount(10001)).toThrow('betAmount debe ser un entero entre 1 y 10000');
            expect(() => validate.betAmount(50.5)).toThrow('betAmount debe ser un entero entre 1 y 10000');
            expect(() => validate.betAmount('50')).toThrow('betAmount debe ser un entero entre 1 y 10000');
        });
    });

    describe('uuidV4', () => {
        it('debe aceptar UUID v4 válido', () => {
            // Un UUID v4 real tiene un '4' en el bloque 3 y un '8,9,a,b' en el bloque 4
            expect(validate.uuidV4('123e4567-e89b-42d3-a456-426614174000', 'campo')).toBe('123e4567-e89b-42d3-a456-426614174000');
        });
        it('debe rechazar UUID inválido', () => {
            expect(() => validate.uuidV4(123, 'campo')).toThrow('campo inválido');
            expect(() => validate.uuidV4('no-es-uuid', 'campo')).toThrow('campo inválido');
            // Es UUID pero v1, no v4 (tiene un 1 en vez de un 4)
            expect(() => validate.uuidV4('123e4567-e89b-12d3-a456-426614174000', 'campo')).toThrow('campo inválido'); 
        });
    });

    describe('uuidV5', () => {
        it('debe aceptar UUID v5 y pasarlo a minúsculas', () => {
            isUuidVersion.mockReturnValue(true);
            expect(validate.uuidV5('123e4567-E89B-52d3-A456-426614174000', 'campo')).toBe('123e4567-e89b-52d3-a456-426614174000');
        });
        it('debe rechazar si la librería indica que no es v5', () => {
            isUuidVersion.mockReturnValue(false);
            expect(() => validate.uuidV5('any', 'campo')).toThrow('campo inválido');
        });
    });

    describe('email', () => {
        it('debe aceptar correos válidos y limpiarlos', () => {
            expect(validate.email(' TEST@iteso.mx ')).toBe('test@iteso.mx');
        });
        it('debe rechazar correos inválidos o demasiado largos', () => {
            expect(() => validate.email(123)).toThrow('Correo inválido');
            expect(() => validate.email('test@')).toThrow('Correo inválido');
            expect(() => validate.email('test@itesomx')).toThrow('Correo inválido');
            const longEmail = 'a'.repeat(250) + '@b.com'; // Más de 254 caracteres
            expect(() => validate.email(longEmail)).toThrow('Correo inválido');
        });
    });

    describe('name', () => {
        it('debe aceptar nombres válidos', () => {
            expect(validate.name(' Emilio ')).toBe('Emilio');
            expect(validate.name('Ana 👨‍👩‍👧')).toBe('Ana 👨‍👩‍👧');
        });
        it('debe rechazar nombres por longitud', () => {
            expect(() => validate.name(123)).toThrow('El nombre debe tener de 1 a 40 caracteres');
            expect(() => validate.name('   ')).toThrow('El nombre debe tener de 1 a 40 caracteres');
            expect(() => validate.name('a'.repeat(41))).toThrow('El nombre debe tener de 1 a 40 caracteres');
        });
        it('debe rechazar nombres con símbolos prohibidos (< o >)', () => {
            expect(() => validate.name('Emilio <script>')).toThrow('El nombre no puede llevar los caracteres < o >');
        });
        it('debe rechazar caracteres de control ocultos', () => {
            expect(() => validate.name('Emilio\u200B')).toThrow('El nombre tiene caracteres no permitidos');
        });
        it('debe rechazar si no hay letras o números', () => {
            expect(() => validate.name(' --- ')).toThrow('El nombre debe tener al menos una letra o número');
        });
    });

    describe('password', () => {
        it('debe aceptar contraseñas válidas', () => {
            expect(validate.password('mypassword123')).toBe('mypassword123');
        });
        it('debe rechazar contraseñas cortas o excesivamente largas en bytes', () => {
            expect(() => validate.password(123)).toThrow('La contraseña debe tener al menos 8 caracteres y máximo 72 bytes');
            expect(() => validate.password('short')).toThrow('La contraseña debe tener al menos 8 caracteres y máximo 72 bytes');
            const longPass = 'a'.repeat(73);
            expect(() => validate.password(longPass)).toThrow('La contraseña debe tener al menos 8 caracteres y máximo 72 bytes');
        });
    });

    describe('age', () => {
        it('debe aceptar edades válidas (número o string)', () => {
            expect(validate.age(22)).toBe(22);
            expect(validate.age(' 30 ')).toBe(30);
        });
        it('debe rechazar edades menores a 18, mayores a 99, o formatos inválidos', () => {
            expect(() => validate.age(17)).toThrow('La edad debe ser un entero entre 18 y 99');
            expect(() => validate.age(100)).toThrow('La edad debe ser un entero entre 18 y 99');
            expect(() => validate.age(25.5)).toThrow('La edad debe ser un entero entre 18 y 99');
            expect(() => validate.age('abc')).toThrow('La edad debe ser un entero entre 18 y 99');
            expect(() => validate.age(true)).toThrow('La edad debe ser un entero entre 18 y 99');
        });
    });
});