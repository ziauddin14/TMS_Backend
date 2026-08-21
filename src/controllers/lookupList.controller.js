const lookupListService = require('../services/lookupList.service');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/apiResponse');

function serializeLookup(entry) {
  return {
    id: entry.id,
    listType: entry.listType,
    value: entry.value,
    isActive: entry.isActive,
    sortOrder: entry.sortOrder,
  };
}

// GET /lookup-lists?type=responsibility — any authenticated user (docs/05-apis.md §4)
const listActive = asyncHandler(async (req, res) => {
  const entries = await lookupListService.listActive(req.query.type);
  sendSuccess(res, { data: entries.map(serializeLookup) });
});

// POST /lookup-lists — Admin only
const createValue = asyncHandler(async (req, res) => {
  const entry = await lookupListService.createValue(req.body);
  sendSuccess(res, { data: serializeLookup(entry), statusCode: 201 });
});

// PATCH /lookup-lists/:id — Admin only
const updateValue = asyncHandler(async (req, res) => {
  const entry = await lookupListService.updateValue(req.params.id, req.body);
  sendSuccess(res, { data: serializeLookup(entry) });
});

module.exports = { listActive, createValue, updateValue };
