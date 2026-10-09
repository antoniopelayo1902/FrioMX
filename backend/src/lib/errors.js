class AppError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const badRequest = (message) => new AppError(400, 'VALIDATION_ERROR', message);

module.exports = { AppError, badRequest };
