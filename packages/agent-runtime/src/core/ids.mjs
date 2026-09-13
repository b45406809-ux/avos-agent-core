import { randomBytes } from "node:crypto";

export function opaqueId(prefix = "id") {
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(prefix)) throw new TypeError("Invalid ID prefix");
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

