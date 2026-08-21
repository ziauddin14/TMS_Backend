const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const env = require('../config/env');
const AppError = require('../utils/AppError');
const User = require('../models/User');

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

// Same user-facing text the frontend shows inline on the login screen (docs/08-ui-ux.md §2,
// docs/01-architecture.md §5.1 step 6) — kept here so the backend and documented UI copy match.
const MESSAGES = {
  NOT_REGISTERED: 'Yeh email system mein register nahi hai. Admin se rabta karein.',
  INACTIVE: 'Aap ka account fi-alhaal band hai',
  GENERIC_LOGIN_FAILURE: 'Login mumkin nahi hua, dobara koshish karein',
};

/**
 * Verifies a Google ID token: signature, expiry, and audience (via google-auth-library), plus
 * the email_verified claim (docs/06-backend.md §1, docs/11-auth.md §3). Throws INVALID_TOKEN on
 * any failure — never trusts anything from the request body as proof of identity.
 */
async function verifyGoogleToken(idToken) {
  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
  } catch (err) {
    throw new AppError(MESSAGES.GENERIC_LOGIN_FAILURE, 400, 'INVALID_TOKEN');
  }

  const payload = ticket.getPayload();
  if (!payload || payload.email_verified !== true) {
    throw new AppError(MESSAGES.GENERIC_LOGIN_FAILURE, 400, 'INVALID_TOKEN');
  }

  return payload;
}

/**
 * Pure function (docs/06-backend.md §4.4 establishes this pattern for business rules elsewhere):
 * takes the verified token payload and the configured allowed-domain value explicitly, rather
 * than reading env internally, so it stays independently testable. Approved decision: empty/
 * unset allowedHd means no restriction; never hardcode a domain.
 */
function assertAllowedDomain(payload, allowedHd) {
  if (!allowedHd) return;

  if (!payload.hd || payload.hd.toLowerCase() !== allowedHd.toLowerCase()) {
    // Not in the documented Error Code Catalog — this implementation's own addition, since the
    // hd check itself is a Phase 3 approved-decision addition over docs/11-auth.md's original
    // "no hd restriction enforced" text (see Phase 3 report, section J). Same user-facing message
    // as USER_NOT_FOUND, since docs/01-architecture.md §5.1 item 7 frames a domain check as just
    // an earlier line of defense ahead of the same real gate — same denial, same wording.
    throw new AppError(MESSAGES.NOT_REGISTERED, 403, 'GOOGLE_DOMAIN_NOT_ALLOWED');
  }
}

function issueSessionToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

/**
 * docs/06-backend.md §1 loginWithGoogle: verify -> look up an EXISTING user by verified email ->
 * reject if not found/inactive -> issue token. No user is ever created here — first-login
 * auto-provisioning is not documented anywhere (Architecture §5.1, APIs §2, Backend §1 all
 * describe only a lookup-and-reject flow; accounts are created solely by Admin / the seed script,
 * per docs/04-db-models.md §9). See Phase 3 report, section J.
 */
async function loginWithGoogle(idToken) {
  const payload = await verifyGoogleToken(idToken);
  assertAllowedDomain(payload, env.GOOGLE_ALLOWED_HD);

  const email = payload.email.toLowerCase();
  const user = await User.findOne({ email });

  if (!user) {
    throw new AppError(MESSAGES.NOT_REGISTERED, 403, 'USER_NOT_FOUND');
  }
  if (!user.isActive) {
    throw new AppError(MESSAGES.INACTIVE, 403, 'USER_INACTIVE');
  }

  const token = issueSessionToken(user);
  return { token, user };
}

/** Backs GET /auth/me (docs/06-backend.md §1). */
async function getCurrentUser(userId) {
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
  }
  return user;
}

/**
 * Dev-only shortcut (docs/12-testing.md §5): "the backend accepts a test-only login shortcut
 * (e.g. POST /auth/dev-login { email }) that skips Google verification entirely and issues a
 * normal session JWT for a seeded test user". Never creates a user, never bypasses the
 * isActive/registered checks real login enforces — only the Google-verification step is skipped.
 * Route registration (not just this function) is gated to non-production — see auth.routes.js.
 */
async function devLogin(email) {
  const user = await User.findOne({ email: email.toLowerCase() });

  if (!user) {
    throw new AppError(MESSAGES.NOT_REGISTERED, 403, 'USER_NOT_FOUND');
  }
  if (!user.isActive) {
    throw new AppError(MESSAGES.INACTIVE, 403, 'USER_INACTIVE');
  }

  const token = issueSessionToken(user);
  return { token, user };
}

module.exports = {
  verifyGoogleToken,
  assertAllowedDomain,
  issueSessionToken,
  loginWithGoogle,
  getCurrentUser,
  devLogin,
};
