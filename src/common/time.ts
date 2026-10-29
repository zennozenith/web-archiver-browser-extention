/**
 * seconds from unix epoch
 */
export type UnixEpochSeconds = number;

export function toDateFromSec(time: UnixEpochSeconds): Date {
  return new Date(time * 1000);
}

export const formatTimeFromSec = (time: UnixEpochSeconds): string => {
  const d = toDateFromSec(time);
  return d.toLocaleString();
};

export function timeAgoFromSec(time: UnixEpochSeconds): string {
  const d = toDateFromSec(time);

  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.round(h / 24);
  if (dd < 30) return `${dd}d ago`;
  const mo = Math.round(dd / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(dd / 365)}y ago`;
}

export function nowUnixEpochSeconds(): UnixEpochSeconds {
  return Math.floor(Date.now() / 1000);
}

export function toDate(dateTime: unknown): Date | null {
  if (dateTime == null || dateTime === "") {
    return null;
  }
  if (dateTime instanceof Date) {
    return Number.isNaN(dateTime.getTime()) ? null : dateTime;
  }
  if (typeof dateTime === "number") {
    return new Date(dateTime < 1e12 ? dateTime * 1000 : dateTime);
  }
  if (typeof dateTime !== "string") {
    return null;
  }

  const trimmed = dateTime.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return toDate(Number(trimmed));

  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const formatTime = (dateTime: unknown): string => {
  const d = toDate(dateTime);
  if (d) return d.toLocaleString();
  return typeof dateTime === "string" || typeof dateTime === "number"
    ? String(dateTime)
    : "unknown time";
};

export function timeAgo(t: unknown): string {
  const d = toDate(t);
  if (!d) return "";
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.round(h / 24);
  if (dd < 30) return `${dd}d ago`;
  const mo = Math.round(dd / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(dd / 365)}y ago`;
}
