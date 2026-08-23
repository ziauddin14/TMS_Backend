const mongoose = require('mongoose');
const LookupList = require('../models/LookupList');
const AppError = require('../utils/AppError');

const MONGO_DUPLICATE_KEY_ERROR_CODE = 11000;

// docs/05-apis.md §4's exact quoted copy for this case: "Duplicate (listType, value) -> 409
// DUPLICATE_LOOKUP_VALUE, message: 'Yeh value pehle se is list mein maujood hai.'" — Phase 4 had
// missed this (its own comment cited only the Error Code Catalog, which doesn't give literal text
// for every code, without cross-referencing this section too). Corrected here in Phase 10.5 since
// this is the first phase to actually surface the message in a real user-facing UI element (the
// Lookup Lists admin panel's inline duplicate-value error) — a non-technical Urdu-speaking Admin
// would otherwise see an out-of-place English sentence.
const DUPLICATE_LOOKUP_MESSAGE = 'Yeh value pehle se is list mein maujood hai.';

// docs/06-backend.md §3: listActive(listType) — only active values, dropdown display order.
async function listActive(listType) {
  return LookupList.find({ listType, isActive: true }).sort({ sortOrder: 1 });
}

// docs/06-backend.md §3: createValue — "catch the Mongo duplicate-key error and translate it to
// an AppError, rather than leaking a raw Mongo error to the client." Deliberately create-then-
// catch, not find-then-create, per the Phase 4 instructions: a pre-query check would be a race
// condition (docs/04-db-models.md §5's unique index is what actually prevents the collision).
async function createValue({ listType, value, sortOrder }) {
  try {
    return await LookupList.create({ listType, value, sortOrder });
  } catch (err) {
    if (err && err.code === MONGO_DUPLICATE_KEY_ERROR_CODE) {
      throw new AppError(DUPLICATE_LOOKUP_MESSAGE, 409, 'DUPLICATE_LOOKUP_VALUE');
    }
    throw err;
  }
}

// docs/06-backend.md §3: updateValue — edits value/sortOrder/isActive. 404 LOOKUP_NOT_FOUND if
// missing; a rename that collides with another existing (listType, value) pair also has to go
// through the same unique-index-backed catch, for the same race-condition reason as createValue.
async function updateValue(id, patch) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('Lookup value not found.', 404, 'LOOKUP_NOT_FOUND');
  }

  const entry = await LookupList.findById(id);
  if (!entry) {
    throw new AppError('Lookup value not found.', 404, 'LOOKUP_NOT_FOUND');
  }

  const allowedFields = ['value', 'sortOrder', 'isActive'];
  for (const field of allowedFields) {
    if (patch[field] !== undefined) {
      entry[field] = patch[field];
    }
  }

  try {
    await entry.save();
  } catch (err) {
    if (err && err.code === MONGO_DUPLICATE_KEY_ERROR_CODE) {
      throw new AppError(DUPLICATE_LOOKUP_MESSAGE, 409, 'DUPLICATE_LOOKUP_VALUE');
    }
    throw err;
  }

  return entry;
}

module.exports = { listActive, createValue, updateValue };
