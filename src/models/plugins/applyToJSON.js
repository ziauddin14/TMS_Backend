// Shared toJSON transform (docs/04-db-models.md §1): renames _id -> id and strips the version
// key, so every model's API representation has the same clean shape. Imported into every model
// file per that section — no exceptions carved out there, so it is applied uniformly, including
// to the internal-only Counter model.
function applyToJSON(schema) {
  schema.set('toJSON', {
    virtuals: false,
    versionKey: false,
    transform: (doc, ret) => {
      ret.id = ret._id.toString();
      delete ret._id;
      return ret;
    },
  });
}

module.exports = applyToJSON;
