// Locked blueprint §Phase 2/Template System — the AUTHORITATIVE template registry. The frontend
// has its own mirror (frontend/src/utils/notificationTemplates.js) purely for rendering the
// picker's labels; the server is what actually validates a submitted templateKey and resolves the
// real title/message that gets stored — the client is never trusted to supply final content for a
// template it merely names. Keys here must stay in sync with the frontend's own registry.
const NOTIFICATION_TEMPLATES = Object.freeze({
  GENERAL_REMINDER: {
    title: 'عمومی یاد دہانی',
    message: 'براہ کرم اپنے تمام کاموں کی تازہ ترین اپڈیٹ فراہم کریں۔',
  },
  COMPLETE_TASK_REMINDER: {
    title: 'کام مکمل کرنے کی یاد دہانی',
    message: 'براہ کرم اپنے زیرِ التواء کام کو مکمل کریں اور تازہ ترین صورتحال سے آگاہ کریں۔',
  },
  DEADLINE_APPROACHING: {
    title: 'کام کی آخری تاریخ قریب ہے',
    message: 'براہ کرم آخری تاریخ سے پہلے اس کام کی تازہ ترین اپڈیٹ فراہم کریں۔',
  },
  URGENT_ATTENTION: {
    title: 'فوری توجہ درکار ہے',
    message: 'براہ کرم اس معاملے پر فوری توجہ دیں اور صورتحال سے آگاہ کریں۔',
  },
});

// Returns the template's {title, message}, or null for an unregistered/absent key — the caller
// (notification.service.js) is responsible for turning a "provided but unknown" key into a
// VALIDATION-style error; a missing key is a normal, valid "no template selected" case.
function resolveTemplate(templateKey) {
  if (!templateKey) return null;
  return NOTIFICATION_TEMPLATES[templateKey] || null;
}

module.exports = { NOTIFICATION_TEMPLATES, resolveTemplate };
