const mongoose = require('mongoose');
const User = require('../models/User');
const AppError = require('../utils/AppError');

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFilter({ role, isActive, search }) {
  const filter = {};
  if (role) filter.role = role;
  if (isActive !== undefined) filter.isActive = isActive;
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: regex }, { email: regex }];
  }
  return filter;
}

// docs/06-backend.md §2: listUsers(filters, pagination) — case-insensitive regex search on
// name/email, standard pagination meta (docs/05-apis.md §1).
async function listUsers(filters, pagination) {
  const filter = buildFilter(filters);
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

// docs/05-apis.md §3: "GET /users/:id | Admin or self" — an ownership rule, not a plain role
// check, so it lives here in the service per docs/06-backend.md's layering rule, not as ad hoc
// logic in the controller or a generic middleware.
async function getUserById(requestingUser, id) {
  if (requestingUser.role !== 'admin' && requestingUser.id !== id) {
    throw new AppError('You are not authorized to perform this action.', 403, 'FORBIDDEN_ROLE');
  }

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('User not found.', 404, 'USER_NOT_FOUND_BY_ID');
  }

  const user = await User.findById(id);
  if (!user) {
    throw new AppError('User not found.', 404, 'USER_NOT_FOUND_BY_ID');
  }
  return user;
}

// docs/06-backend.md §2: createUser — lowercases email before the uniqueness check; throws
// DUPLICATE_EMAIL (409) if already registered. New user defaults to isActive:true (model default).
async function createUser({ name, email, responsibility, role }) {
  const lowerEmail = email.toLowerCase();

  const existing = await User.findOne({ email: lowerEmail });
  if (existing) {
    // Exact text the frontend shows inline under the Email field (docs/09-frontend-features.md §9).
    throw new AppError('Yeh email pehle se register hai', 409, 'DUPLICATE_EMAIL');
  }

  return User.create({ name, email: lowerEmail, responsibility, role });
}

// docs/06-backend.md §2: updateUser — only name/responsibility/role/isActive may change. email is
// never read here even if somehow present (validator already rejects it outright — this allowlist
// is a second, structural layer that never touches the email field regardless).
async function updateUser(id, patch) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('User not found.', 404, 'USER_NOT_FOUND_BY_ID');
  }

  const user = await User.findById(id);
  if (!user) {
    throw new AppError('User not found.', 404, 'USER_NOT_FOUND_BY_ID');
  }

  const allowedFields = ['name', 'responsibility', 'role', 'isActive'];
  for (const field of allowedFields) {
    if (patch[field] !== undefined) {
      user[field] = patch[field];
    }
  }

  await user.save();
  return user;
}

module.exports = { listUsers, getUserById, createUser, updateUser };
