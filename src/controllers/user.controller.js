const userService = require('../services/user.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

// The Users module's own representation includes isActive (needed for the Users page's Active/
// Inactive Status column — docs/08-ui-ux.md §8) — deliberately distinct from the slimmer identity
// shape auth.controller.js returns for login/me.
function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    responsibility: user.responsibility,
    role: user.role,
    isActive: user.isActive,
  };
}

// GET /users — Admin only (docs/05-apis.md §3)
const listUsers = asyncHandler(async (req, res) => {
  const { role, isActive, search, page, limit } = req.query;
  const { items, meta } = await userService.listUsers({ role, isActive, search }, { page, limit });
  sendSuccess(res, { data: items.map(serializeUser), meta });
});

// GET /users/:id — Admin or self (ownership rule enforced in the service)
const getUser = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user, req.params.id);
  sendSuccess(res, { data: serializeUser(user) });
});

// POST /users — Admin only
const createUser = asyncHandler(async (req, res) => {
  const user = await userService.createUser(req.body);
  sendSuccess(res, { data: serializeUser(user), statusCode: 201 });
});

// PATCH /users/:id — Admin only
const updateUser = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.params.id, req.body);
  sendSuccess(res, { data: serializeUser(user) });
});

module.exports = { listUsers, getUser, createUser, updateUser };
