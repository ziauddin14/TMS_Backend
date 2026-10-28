// Attachment file names stored before the upload fix are garbled: the browser sends a file name as
// UTF-8, and multer read it as Latin-1 (its default), so "اجلاس.pdf" was saved as "Ø§Ø¬ÙØ§Ø³.pdf"
// (validators/upload.validator.js now decodes UTF-8). repairFileName undoes that for display only —
// nothing stored is changed. It is guarded so it never harms a correct name: it acts only when every
// character fits in one Latin-1 byte and at least one is beyond ASCII (a garbled name; a correct
// Urdu name has characters beyond Latin-1 and is returned as it is), and only when those bytes are
// valid UTF-8 (so a real Latin-1 name such as "café.pdf" is returned as it is). Anything else —
// including a missing or empty name — comes back unchanged. The frontend has the same helper
// (src/utils/fileName.js).
function repairFileName(name) {
  if (typeof name !== 'string' || name === '') return name;
  let beyondAscii = false;
  for (const char of name) {
    const code = char.codePointAt(0);
    if (code > 0xff) return name;
    if (code > 0x7f) beyondAscii = true;
  }
  if (!beyondAscii) return name;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1'));
  } catch {
    return name;
  }
}

module.exports = { repairFileName };
