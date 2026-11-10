// Client-side guard for agent-editor API responses. Next.js development errors
// and reverse proxies may respond with HTML, even when the caller expects JSON.
// Never expose raw HTML or response bodies in user-facing error messages.
type Operation =
  | 'loadRevision'
  | 'loadTools'
  | 'loadConnections'
  | 'loadMembers'
  | 'loadBudget'
  | 'loadTestCases'
  | 'saveIdentity'
  | 'saveRevision'
  | 'saveTools'
  | 'saveBudget'
  | 'addTestCase'
  | 'deleteTestCase'
  | 'validate'
  | 'evaluate'
  | 'publish'
  | 'discard';

const labels: Record<Operation, { ar: string; en: string }> = {
  loadRevision: { ar: 'تحميل إعدادات الوكيل', en: 'load agent settings' },
  loadTools: { ar: 'تحميل أدوات الوكيل', en: 'load agent tools' },
  loadConnections: { ar: 'تحميل اتصالات المزود', en: 'load provider connections' },
  loadMembers: { ar: 'تحميل أعضاء الحساب', en: 'load account members' },
  loadBudget: { ar: 'تحميل الميزانية', en: 'load budget' },
  loadTestCases: { ar: 'تحميل حالات الاختبار', en: 'load test cases' },
  saveRevision: { ar: 'حفظ إعدادات الوكيل', en: 'save agent settings' },
  saveTools: { ar: 'حفظ صلاحيات الأدوات', en: 'save tool grants' },
  saveIdentity: { ar: 'حفظ هوية الوكيل', en: 'save agent identity' },
  saveBudget: { ar: 'حفظ الميزانية', en: 'save budget' },
  addTestCase: { ar: 'إضافة الاختبار', en: 'add test case' },
  deleteTestCase: { ar: 'حذف الاختبار', en: 'delete test case' },
  validate: { ar: 'التحقق من الوكيل', en: 'validate agent' },
  evaluate: { ar: 'محاكاة الوكيل', en: 'simulate agent' },
  publish: { ar: 'نشر النسخة', en: 'publish revision' },
  discard: { ar: 'حذف المسودة', en: 'discard draft' },
};

function responseFailure(
  locale: string,
  operation: Operation,
  status: number,
  reason: 'not-json' | 'invalid-json' | 'invalid-payload',
): Error {
  const ar = locale.toLowerCase().startsWith('ar');
  const label = labels[operation][ar ? 'ar' : 'en'];
  const detail = ar
    ? {
        'not-json': 'أعاد الخادم استجابة ليست JSON (قد تكون صفحة HTML).',
        'invalid-json': 'أعاد الخادم JSON غير صالح.',
        'invalid-payload': 'أعاد الخادم بيانات بصيغة غير متوقعة.',
      }[reason]
    : {
        'not-json': 'The server returned a non-JSON response (possibly HTML).',
        'invalid-json': 'The server returned malformed JSON.',
        'invalid-payload': 'The server returned an unexpected payload.',
      }[reason];
  const routeHint = status === 404 && reason === 'not-json'
    ? (ar
      ? ' تأكد أن الطلب يصل إلى خادم WACRM الصحيح على المنفذ الصحيح، وليس إلى خدمة أخرى أو نسخة قديمة.'
      : ' Confirm the request reaches the correct WACRM server and port, not another service or an outdated build.')
    : '';
  return new Error(ar
    ? `تعذّر ${label}: ${detail} (HTTP ${status}). راجع سجل Next.js وتبويب Network.${routeHint}`
    : `Could not ${label}: ${detail} (HTTP ${status}). Check the Next.js server log and Network tab.${routeHint}`);
}

export async function readAgentEditorJson<T>(
  response: Response,
  locale: string,
  operation: Operation,
): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('+json')) {
    throw responseFailure(locale, operation, response.status, 'not-json');
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw responseFailure(locale, operation, response.status, 'invalid-json');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw responseFailure(locale, operation, response.status, 'invalid-payload');
  }
  return data as T;
}

export async function tryReadAgentEditorJson<T>(
  response: Response | null,
  locale: string,
  operation: Operation,
): Promise<T | null> {
  if (!response?.ok) return null;
  try {
    return await readAgentEditorJson<T>(response, locale, operation);
  } catch {
    return null;
  }
}
