export function createError({ error, message, extra: _extra, }) {
    console.error(message, _extra);
    const extra = [];
    if (_extra !== null || _extra !== undefined) {
        extra.push(_extra);
    }
    if (error) {
        return {
            ok: false,
            messages: [message, ...error.messages],
            extra: [...extra, ...error.extra],
        };
    }
    return {
        ok: false,
        messages: [message],
        extra,
    };
}
export function createOk(data) {
    return {
        ok: true,
        data,
    };
}
// 2. Create type guard functions
export function isNamedError(err) {
    return typeof err === "object" && err !== null && "name" in err;
}
export function isStandardError(err) {
    return typeof err === "object" && err !== null && "message" in err;
}
