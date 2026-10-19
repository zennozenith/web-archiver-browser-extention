export function toDate(dateTime) {
    if (dateTime == null || dateTime === "") {
        return null;
    }
    if (typeof dateTime === "number")
        return new Date(dateTime < 1e12 ? dateTime * 1000 : dateTime);
    if (/^\d+(\.\d+)?$/.test(String(dateTime)))
        return toDate(Number(dateTime));
    const d = new Date(dateTime);
    return isNaN(d) ? null : d;
}
export const formatTime = (dateTime) => {
    const d = toDate(dateTime);
    return d ? d.toLocaleString() : String(dateTime ?? "unknown time");
};
export function timeAgo(t) {
    const d = toDate(t);
    if (!d)
        return "";
    const s = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (s < 45)
        return "just now";
    const m = Math.round(s / 60);
    if (m < 60)
        return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24)
        return `${h}h ago`;
    const dd = Math.round(h / 24);
    if (dd < 30)
        return `${dd}d ago`;
    const mo = Math.round(dd / 30);
    if (mo < 12)
        return `${mo}mo ago`;
    return `${Math.round(dd / 365)}y ago`;
}
