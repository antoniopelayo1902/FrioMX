const { mockClient } = require('aws-sdk-client-mock');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { config } = require('../src/config/env');
const storage = require('../src/services/storageService');

jest.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: jest.fn(async (client, cmd) => `https://firmada/${cmd.input.Key}`),
}));

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const BUCKET = 'friomx-uploads-123456789012';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
    jest.clearAllMocks();
    config.uploadsBucket = BUCKET;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    config.uploadsBucket = undefined;
    jest.restoreAllMocks();
});

describe('filtro de multer', () => {
    // Corre el middleware de multer con un multipart armado a mano.
    function runUpload(mimetype) {
        const { Readable } = require('stream');
        const boundary = 'xyz';
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="profileImage"; filename="a"\r\nContent-Type: ${mimetype}\r\n\r\n`),
            PNG,
            Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const req = Readable.from([body]);
        req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
        return new Promise((resolve) => storage.upload(req, {}, (err) => resolve({ err, file: req.file })));
    }

    test('acepta PNG y deja el archivo en memoria', async () => {
        const { err, file } = await runUpload('image/png');
        expect(err).toBeUndefined();
        expect(file.buffer.equals(PNG)).toBe(true);
    });

    test('rechaza tipos que no son JPG, PNG o WebP con status 400', async () => {
        const { err } = await runUpload('image/gif');
        expect(err.status).toBe(400);
        expect(err.message).toBe('La foto debe ser JPG, PNG o WebP');
    });
});

describe('imageUrlOf', () => {
    test('sin usuario o sin foto regresa null', async () => {
        expect(await storage.imageUrlOf(null)).toBeNull();
        expect(await storage.imageUrlOf({ userId: 'u' })).toBeNull();
    });

    test('con foto firma la URL por 15 minutos', async () => {
        const url = await storage.imageUrlOf({ profileImageKey: 'profile-images/u/a.png' });
        expect(url).toBe('https://firmada/profile-images/u/a.png');
        const [, cmd, opts] = getSignedUrl.mock.calls[0];
        expect(cmd.input).toEqual({ Bucket: BUCKET, Key: 'profile-images/u/a.png' });
        expect(opts).toEqual({ expiresIn: storage.URL_TTL_SECONDS });
    });
});

describe('saveProfileImage', () => {
    test('sin archivo responde 400', async () => {
        await expect(storage.saveProfileImage({ userId: 'u' }, undefined)).rejects.toMatchObject({ status: 400 });
    });

    test('si los bytes no son de imagen responde 400 sin subir nada', async () => {
        const file = { mimetype: 'image/png', buffer: Buffer.alloc(32) };
        await expect(storage.saveProfileImage({ userId: 'u' }, file)).rejects.toMatchObject({ status: 400 });
        expect(s3Mock.calls()).toHaveLength(0);
    });

    test('sube, guarda la llave y borra la foto anterior', async () => {
        s3Mock.on(PutObjectCommand).resolves({});
        s3Mock.on(DeleteObjectCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({ Attributes: { profileImageKey: 'profile-images/u/vieja.png' } });
        const res = await storage.saveProfileImage({ userId: 'u' }, { mimetype: 'image/png', buffer: PNG });

        const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
        expect(put.Key).toMatch(/^profile-images\/u\/\d+-[0-9a-f-]{36}\.png$/);
        expect(put).toMatchObject({ Bucket: BUCKET, ContentType: 'image/png' });
        expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({ ':k': put.Key });
        expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe('profile-images/u/vieja.png');
        expect(res).toEqual({ success: true, profileImage: `https://firmada/${put.Key}` });
    });

    test('sin foto anterior no borra nada', async () => {
        s3Mock.on(PutObjectCommand).resolves({});
        ddbMock.on(UpdateCommand).resolves({});
        await storage.saveProfileImage({ userId: 'u' }, { mimetype: 'image/png', buffer: PNG });
        expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    });

    test('si borrar la foto vieja falla la petición sigue bien', async () => {
        s3Mock.on(PutObjectCommand).resolves({});
        s3Mock.on(DeleteObjectCommand).rejects(new Error('s3 caído'));
        ddbMock.on(UpdateCommand).resolves({ Attributes: { profileImageKey: 'profile-images/u/vieja.png' } });
        const res = await storage.saveProfileImage({ userId: 'u' }, { mimetype: 'image/png', buffer: PNG });
        expect(res.success).toBe(true);
        expect(console.warn).toHaveBeenCalled();
    });
});

describe('deleteProfileImage', () => {
    test('quita la llave y borra el objeto de S3', async () => {
        ddbMock.on(UpdateCommand).resolves({ Attributes: { profileImageKey: 'profile-images/u/a.png' } });
        s3Mock.on(DeleteObjectCommand).resolves({});
        expect(await storage.deleteProfileImage({ userId: 'u' })).toEqual({ success: true });
        expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.UpdateExpression).toBe('REMOVE profileImageKey');
        expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({ Bucket: BUCKET, Key: 'profile-images/u/a.png' });
    });

    test('sin foto no llama a S3', async () => {
        ddbMock.on(UpdateCommand).resolves({});
        expect(await storage.deleteProfileImage({ userId: 'u' })).toEqual({ success: true });
        expect(s3Mock.calls()).toHaveLength(0);
    });
});

test('getProfileImage con foto regresa la URL firmada', async () => {
    expect(await storage.getProfileImage({ profileImageKey: 'k.png' })).toEqual({
        success: true, available: true, profileImage: 'https://firmada/k.png',
    });
});
