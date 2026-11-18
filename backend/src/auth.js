// Authentication: scrypt password hashing, opaque bearer-token sessions stored hashed server-side.
import crypto from "node:crypto";
import { promisify } from "node:util";
import * as store from "./store.js";
import { HttpError, badRequest, cleanString, isValidEmail } from "./http.js";

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split("$");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(hashB64, "base64");
    const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, businessName: user.businessName || "", createdAt: user.createdAt };
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) throw badRequest("Password must be at least 8 characters.");
  if (password.length > 128) throw badRequest("Password must be at most 128 characters.");
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw badRequest("Password must contain at least one letter and one number.");
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await store.insert("sessions", { tokenHash: sha256(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function register(body = {}) {
  const name = cleanString(body.name, 80);
  const email = cleanString(body.email, 254).toLowerCase();
  const businessName = cleanString(body.businessName, 120);
  if (!name) throw badRequest("Name is required.");
  if (!isValidEmail(email)) throw badRequest("Enter a valid email address.");
  validatePassword(body.password);
  if (await store.findOne("users", { email })) throw new HttpError(409, "An account with this email already exists. Log in instead.");
  const passwordHash = await hashPassword(body.password);
  let user;
  try {
    user = await store.insert("users", { name, email, businessName, passwordHash });
  } catch (error) {
    if (error?.code === 11000) throw new HttpError(409, "An account with this email already exists. Log in instead.");
    throw error;
  }
  const session = await createSession(user.id);
  return { user: publicUser(user), ...session };
}

// Dummy hash so unknown emails take the same time as wrong passwords (no account enumeration via timing).
let dummyHash;
export async function login(body = {}) {
  const email = cleanString(body.email, 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) throw badRequest("Email and password are required.");
  const user = await store.findOne("users", { email });
  dummyHash ||= await hashPassword("timing-equaliser-not-a-real-password-1");
  const ok = await verifyPassword(password, user?.passwordHash || dummyHash);
  if (!user || !ok) throw new HttpError(401, "Invalid email or password.");
  const session = await createSession(user.id);
  return { user: publicUser(user), ...session };
}

export async function logout(token) {
  if (token) await store.remove("sessions", { tokenHash: sha256(token) });
}

export async function updateProfile(userId, body = {}) {
  const patch = {};
  if (body.name !== undefined) {
    patch.name = cleanString(body.name, 80);
    if (!patch.name) throw badRequest("Name cannot be empty.");
  }
  if (body.businessName !== undefined) patch.businessName = cleanString(body.businessName, 120);
  return publicUser(await store.update("users", { id: userId }, patch));
}

function bearer(req) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token.trim() : null;
}

export async function requireAuth(req, _res, next) {
  try {
    const token = bearer(req);
    if (!token) throw new HttpError(401, "Please log in to continue.");
    const session = await store.findOne("sessions", { tokenHash: sha256(token) });
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
      if (session) await store.remove("sessions", { id: session.id });
      throw new HttpError(401, "Your session has expired. Please log in again.");
    }
    const user = await store.findOne("users", { id: session.userId });
    if (!user) throw new HttpError(401, "Account not found. Please log in again.");
    req.user = publicUser(user);
    req.sessionToken = token;
    next();
  } catch (error) {
    next(error);
  }
}

export async function purgeExpiredSessions() {
  const sessions = await store.find("sessions", {});
  const expired = sessions.filter((s) => new Date(s.expiresAt).getTime() <= Date.now());
  for (const s of expired) await store.remove("sessions", { id: s.id });
  return expired.length;
}
