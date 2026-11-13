'use strict';

/**
 * error-parser.js
 * ---------------------------------------------------------------------------
 * Core logic for n8n-hubspot-custom-code-action-error-handler.
 *
 * Receives error reports from HubSpot custom code actions (via the wrapper in
 * hubspot/custom-code-wrapper.js, or a HubSpot "Send a webhook" action), and
 * turns each one into a clean diagnostic object plus routing decisions:
 *
 *   webhook item ──► authenticate (x-hs-error-secret) ──► extractReports()
 *                                                         │
 *        normalizeReport() ◄──────────────────────────────┘
 *          ├─ parseStack()        stack frames, failed step (file:line:col, function)
 *          ├─ parseEmbeddedApiError()  HubSpot API error JSON inside messages
 *          ├─ classifyError()     RATE_LIMIT · SERVER · NETWORK · TIMEOUT · AUTH ·
 *          │                      VALIDATION · NOT_FOUND · CONFLICT · CODE · UNKNOWN
 *          ├─ fingerprint()       stable ID for de-duplicating alerts
 *          └─ planRecovery()      RETRY (with backoff) · FALLBACK · NONE
 *        buildSlackAlert() · buildDatadogLogs() · buildConsoleLine()
 *
 * Zero dependencies and no require(): inlined into n8n Code nodes by
 * scripts/build-workflow.js, and unit-tested directly in Node.js.
 * Cross-realm safe (no instanceof), since n8n runs Code nodes in a separate VM.
 *
 * Security: all free text (messages, stacks, payload snippets) is redacted
 * for emails, bearer tokens, HubSpot private-app tokens, Slack webhook URLs and
 * API keys before it is logged or sent anywhere. Input field values sent by
 * HubSpot are never forwarded, only their names.
 *
 * DISCLAIMER: provided "AS IS", without warranty of any kind. The user is
 * responsible for CRM data integrity, API rate limits and compliance with
 * third-party terms of service. See DISCLAIMER.md.
 * ---------------------------------------------------------------------------
 */

const PARSER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENV_KEYS = Object.freeze([
  'SANDBOX_MODE',
  'ERROR_WEBHOOK_SECRET',
  'HUBSPOT_PORTAL_ID',
  'HUBSPOT_APP_BASE_URL',
  'MAX_RETRIES',
  'RETRY_BASE_DELAY_SECONDS',
  'RETRY_MAX_DELAY_SECONDS',
  'ENABLE_RETRY',
  'ENABLE_FALLBACK',
  'ENABLE_FALLBACK_TASK',
  'FALLBACK_OWNER_ID',
  'TASK_ASSOCIATION_TYPE_IDS_JSON',
  'ENABLE_SLACK',
  'SLACK_WEBHOOK_URL',
  'SLACK_CRITICAL_WEBHOOK_URL',
  'ALERT_MIN_SEVERITY',
  'ALERT_DEDUPE_MINUTES',
  'ENABLE_DATADOG',
  'DATADOG_SITE',
  'DATADOG_SERVICE',
  'DATADOG_ENV',
  'MAX_EVENTS_PER_REQUEST',
  'MAX_STACK_FRAMES',
]);

const DEFAULTS = Object.freeze({
  SANDBOX_MODE: 'true',
  ERROR_WEBHOOK_SECRET: '',
  HUBSPOT_PORTAL_ID: '',
  HUBSPOT_APP_BASE_URL: 'https://app.hubspot.com',
  MAX_RETRIES: '3',
  RETRY_BASE_DELAY_SECONDS: '60',
  RETRY_MAX_DELAY_SECONDS: '900',
  ENABLE_RETRY: 'true',
  ENABLE_FALLBACK: 'true',
  ENABLE_FALLBACK_TASK: 'true',
  FALLBACK_OWNER_ID: '',
  TASK_ASSOCIATION_TYPE_IDS_JSON: '{"contacts":204,"companies":192,"deals":216,"tickets":228}',
  ENABLE_SLACK: 'true',
  SLACK_WEBHOOK_URL: '',
  SLACK_CRITICAL_WEBHOOK_URL: '',
  ALERT_MIN_SEVERITY: 'warning',
  ALERT_DEDUPE_MINUTES: '30',
  ENABLE_DATADOG: 'false',
  DATADOG_SITE: 'datadoghq.com',
  DATADOG_SERVICE: 'hubspot-custom-code',
  DATADOG_ENV: 'production',
  MAX_EVENTS_PER_REQUEST: '50',
  MAX_STACK_FRAMES: '15',
});

const PLACEHOLDER = /^\{\{.*\}\}$|^<?(your[-_]|YOUR_|REPLACE_)/;
const SEVERITIES = Object.freeze(['info', 'warning', 'error', 'critical']);
const DATADOG_SITES = Object.freeze(['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ddog-gov.com']);
const MIN_SECRET_LENGTH = 16;

class ConfigError extends Error {
  constructor(problems) {
    super('Invalid error-handler configuration:\n  - ' + problems.join('\n  - '));
    this.name = 'ConfigError';
    this.problems = problems.slice();
  }
}

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER.test(value.trim());
}

function deepFreeze(obj) {
  Object.keys(obj).forEach((k) => {
    if (obj[k] && typeof obj[k] === 'object' && !Object.isFrozen(obj[k])) deepFreeze(obj[k]);
  });
  return Object.freeze(obj);
}

/**
 * Parse and validate configuration (fail fast: every problem reported together).
 * Webhook URLs are only checked for presence; their values are not stored.
 * @param {Record<string,string|undefined>} [env] process.env in Node, $env in n8n.
 */
function loadConfig(env) {
  const source = env !== undefined ? env : typeof process !== 'undefined' && process.env ? process.env : {};
  const problems = [];
  const warnings = [];
  const raw = (key) => {
    let v;
    try {
      v = source[key];
    } catch (err) {
      v = undefined; // n8n may block $env access
    }
    if (v === undefined || v === null || String(v).trim() === '') return DEFAULTS[key] || '';
    return String(v).trim();
  };
  const str = (key) => (isPlaceholder(raw(key)) ? '' : raw(key));
  const bool = (key) => {
    const v = raw(key).toLowerCase();
    if (['true', '1', 'yes', 'on'].indexOf(v) !== -1) return true;
    if (['false', '0', 'no', 'off'].indexOf(v) !== -1) return false;
    problems.push(`${key} must be true or false, received "${v}"`);
    return DEFAULTS[key] === 'true';
  };
  const num = (key, min, max) => {
    const v = raw(key);
    const n = Number(v);
    if (v === '' || !Number.isFinite(n) || !Number.isInteger(n)) {
      problems.push(`${key} must be an integer, received "${v}"`);
      return Number(DEFAULTS[key]);
    }
    if (n < min || n > max) problems.push(`${key} must be between ${min} and ${max}, received ${n}`);
    return n;
  };

  const sandboxMode = bool('SANDBOX_MODE');
  const secret = str('ERROR_WEBHOOK_SECRET');
  if (secret && secret.length < MIN_SECRET_LENGTH) problems.push(`ERROR_WEBHOOK_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);

  const hubspot = {
    portalId: str('HUBSPOT_PORTAL_ID'),
    appBaseUrl: raw('HUBSPOT_APP_BASE_URL').replace(/\/+$/, ''),
    fallbackOwnerId: str('FALLBACK_OWNER_ID'),
    taskAssociationTypeIds: {},
  };
  if (hubspot.portalId && !/^\d+$/.test(hubspot.portalId)) problems.push('HUBSPOT_PORTAL_ID must be numeric');
  if (!/^https:\/\/\S+$/.test(hubspot.appBaseUrl)) problems.push('HUBSPOT_APP_BASE_URL must be an https:// URL');
  if (hubspot.fallbackOwnerId && !/^\d+$/.test(hubspot.fallbackOwnerId)) problems.push('FALLBACK_OWNER_ID must be numeric');
  try {
    const parsed = JSON.parse(raw('TASK_ASSOCIATION_TYPE_IDS_JSON'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    Object.keys(parsed).forEach((k) => {
      const id = Number(parsed[k]);
      if (!Number.isInteger(id) || id <= 0) problems.push(`TASK_ASSOCIATION_TYPE_IDS_JSON value for "${k}" must be a positive integer`);
      else hubspot.taskAssociationTypeIds[k.toLowerCase()] = id;
    });
  } catch (err) {
    problems.push('TASK_ASSOCIATION_TYPE_IDS_JSON must be a JSON object like {"contacts":204,"deals":216}');
  }

  const recovery = {
    retryEnabled: bool('ENABLE_RETRY'),
    fallbackEnabled: bool('ENABLE_FALLBACK'),
    fallbackTaskEnabled: bool('ENABLE_FALLBACK_TASK'),
    maxRetries: num('MAX_RETRIES', 0, 10),
    baseDelaySeconds: num('RETRY_BASE_DELAY_SECONDS', 1, 86400),
    maxDelaySeconds: num('RETRY_MAX_DELAY_SECONDS', 1, 86400),
  };
  if (recovery.maxDelaySeconds < recovery.baseDelaySeconds) problems.push('RETRY_MAX_DELAY_SECONDS must be >= RETRY_BASE_DELAY_SECONDS');

  const alerts = {
    slackEnabled: bool('ENABLE_SLACK'),
    slackConfigured: Boolean(str('SLACK_WEBHOOK_URL')),
    slackCriticalConfigured: Boolean(str('SLACK_CRITICAL_WEBHOOK_URL')),
    minSeverity: raw('ALERT_MIN_SEVERITY').toLowerCase(),
    dedupeMinutes: num('ALERT_DEDUPE_MINUTES', 0, 10080),
  };
  if (SEVERITIES.indexOf(alerts.minSeverity) === -1) problems.push(`ALERT_MIN_SEVERITY must be one of ${SEVERITIES.join(', ')}`);
  ['SLACK_WEBHOOK_URL', 'SLACK_CRITICAL_WEBHOOK_URL'].forEach((key) => {
    const v = str(key);
    if (v && !/^https:\/\/\S+$/.test(v)) problems.push(`${key} must be an https:// URL`);
  });

  const datadog = {
    enabled: bool('ENABLE_DATADOG'),
    site: raw('DATADOG_SITE').toLowerCase(),
    service: raw('DATADOG_SERVICE'),
    env: raw('DATADOG_ENV'),
  };
  if (DATADOG_SITES.indexOf(datadog.site) === -1) problems.push(`DATADOG_SITE must be one of ${DATADOG_SITES.join(', ')}`);
  if (!/^[a-z0-9_.-]{1,100}$/i.test(datadog.service)) problems.push('DATADOG_SERVICE may contain letters, digits, ".", "_" and "-" only');
  if (!/^[a-z0-9_.-]{1,50}$/i.test(datadog.env)) problems.push('DATADOG_ENV may contain letters, digits, ".", "_" and "-" only');
  datadog.intakeUrl = `https://http-intake.logs.${datadog.site}/api/v2/logs`;

  const limits = {
    maxEventsPerRequest: num('MAX_EVENTS_PER_REQUEST', 1, 500),
    maxStackFrames: num('MAX_STACK_FRAMES', 1, 100),
  };

  // Live-mode requirements.
  const live = [];
  if (!secret) live.push('ERROR_WEBHOOK_SECRET is required to authenticate incoming error reports');
  if (alerts.slackEnabled && !alerts.slackConfigured) live.push('SLACK_WEBHOOK_URL is required when ENABLE_SLACK=true');
  if (sandboxMode) live.forEach((i) => warnings.push(`[sandbox] ${i}`));
  else live.forEach((i) => problems.push(i));
  if (!hubspot.portalId) warnings.push('HUBSPOT_PORTAL_ID is not set; record links use the portal ID from each payload when present');

  if (problems.length > 0) throw new ConfigError(problems);
  return deepFreeze({ sandboxMode, secret, hubspot, recovery, alerts, datadog, limits, warnings });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]') return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? new Date(value) : null;
  const t = String(value).trim();
  if (/^\d{12,13}$/.test(t)) return new Date(Number(t));
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function clean(value, max) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max || 1000);
}

/** Remove secrets and personal data from free text before it leaves this node. */
function redact(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted-token]')
    .replace(/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/https:\/\/hooks\.slack\.com\/\S+/gi, '[redacted-webhook]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/([?&](?:hapikey|api_?key|access_token|token|secret)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(["']?(?:authorization|x-api-key|dd-api-key|x-hs-error-secret|api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[redacted]')
    .replace(/\b[0-9a-f]{32}\b/gi, '[redacted-key]');
}

function constantTimeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/** Small, stable, non-cryptographic hash (FNV-1a, 32-bit) as 8 hex chars. */
function hash(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function pick(obj, keys) {
  for (const k of keys) {
    const parts = k.split('.');
    let cur = obj;
    for (const p of parts) cur = isPlainObject(cur) ? cur[p] : undefined;
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

function headerValue(headers, name) {
  if (!isPlainObject(headers)) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : headers[key];
  return Array.isArray(v) ? v[0] : v;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const FRAME_WITH_FN = /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/;
const FRAME_NO_FN = /^\s*at\s+(?:async\s+)?(.+?):(\d+):(\d+)\s*$/;
const INTERNAL_FILE = /^(node:|internal\/)|[\\/]node_modules[\\/]|^native$|<anonymous>/;

/**
 * Parse a V8 stack trace into frames and the failed step (first frame in user code).
 * @returns {{ header: string, frames: object[], failedStep: object|null, truncated: boolean }}
 */
function parseStack(stack, maxFrames) {
  const lines = String(stack || '').split(/\r?\n/);
  const header = clean(lines[0] && !/^\s*at\s/.test(lines[0]) ? lines[0] : '', 500);
  const frames = [];
  lines.forEach((line) => {
    let m = FRAME_WITH_FN.exec(line);
    if (m) {
      frames.push({ function: clean(m[1], 120), file: clean(m[2], 200), line: Number(m[3]), column: Number(m[4]) });
      return;
    }
    m = FRAME_NO_FN.exec(line);
    if (m) frames.push({ function: '<anonymous>', file: clean(m[1], 200), line: Number(m[2]), column: Number(m[3]) });
  });
  frames.forEach((f) => (f.internal = INTERNAL_FILE.test(f.file)));
  const failedStep = frames.find((f) => !f.internal) || frames[0] || null;
  const limit = maxFrames || 15;
  return { header, frames: frames.slice(0, limit), failedStep, truncated: frames.length > limit };
}

/** HubSpot API errors are JSON; they often arrive embedded in an error message. */
function parseEmbeddedApiError(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    if (!isPlainObject(obj)) return null;
    if (!obj.category && !obj.correlationId && !obj.message && !obj.errors) return null;
    return {
      status: obj.status || null,
      category: obj.category ? String(obj.category) : null,
      subCategory: obj.subCategory ? String(obj.subCategory) : null,
      message: obj.message ? clean(obj.message, 500) : null,
      correlationId: obj.correlationId ? String(obj.correlationId).slice(0, 64) : null,
      errors: Array.isArray(obj.errors) ? obj.errors.slice(0, 5).map((e) => clean(isPlainObject(e) ? e.message || e.code : e, 200)) : [],
    };
  } catch (err) {
    return null;
  }
}

/** Error taxonomy: drives severity and the retry / fallback decision. */
const ERROR_TYPES = Object.freeze({
  RATE_LIMIT: { retryable: true, severity: 'warning' },
  SERVER: { retryable: true, severity: 'error' },
  NETWORK: { retryable: true, severity: 'error' },
  TIMEOUT: { retryable: true, severity: 'error' },
  AUTH: { retryable: false, severity: 'critical' },
  VALIDATION: { retryable: false, severity: 'error' },
  NOT_FOUND: { retryable: false, severity: 'warning' },
  CONFLICT: { retryable: false, severity: 'warning' },
  CODE: { retryable: false, severity: 'critical' },
  UNKNOWN: { retryable: true, severity: 'error' },
});

/**
 * Classify an error from its status code, Node error code, name, HubSpot category and message.
 * @returns {{ type: string, retryable: boolean, severity: string, reason: string }}
 */
function classifyError(e) {
  const status = Number(e.statusCode) || null;
  const code = String(e.code || '').toUpperCase();
  const name = String(e.name || '');
  const category = String(e.category || '').toUpperCase();
  const msg = String(e.message || '').toLowerCase();
  const result = (type, reason) => Object.assign({ type, reason }, ERROR_TYPES[type]);

  if (status === 429 || category === 'RATE_LIMITS' || /rate.?limit|too many requests|secondly limit|daily limit/.test(msg)) return result('RATE_LIMIT', 'rate limited');
  if (status === 401 || status === 403 || ['INVALID_AUTHENTICATION', 'MISSING_SCOPES', 'EXPIRED_AUTHENTICATION'].indexOf(category) !== -1 || /unauthori[sz]ed|forbidden|invalid (api key|token|authentication)|missing scopes|secret .*not (found|defined)/.test(msg)) {
    return result('AUTH', 'authentication or permission failure');
  }
  if (/task timed out|timed out after|function timed out|execution timed out/.test(msg) || code === 'ECONNABORTED' || code === 'ETIMEDOUT' || status === 504 || status === 408) {
    return result('TIMEOUT', 'execution or request timed out');
  }
  if (['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH'].indexOf(code) !== -1 || /socket hang up|network error|getaddrinfo/.test(msg)) {
    return result('NETWORK', 'network failure');
  }
  if (status && status >= 500) return result('SERVER', `upstream ${status}`);
  if (status === 404 || category === 'OBJECT_NOT_FOUND' || /not found|does not exist/.test(msg)) return result('NOT_FOUND', 'record or resource not found');
  if (status === 409 || category === 'CONFLICT' || /already exists|conflict/.test(msg)) return result('CONFLICT', 'conflicting record');
  if (status === 400 || status === 422 || category === 'VALIDATION_ERROR' || /property values were not valid|invalid input|validation/.test(msg)) {
    return result('VALIDATION', 'invalid data sent to an API');
  }
  if (/^(TypeError|ReferenceError|SyntaxError|RangeError)$/.test(name) || /is not a function|is not defined|cannot read propert|undefined is not|unexpected token/.test(msg)) {
    return result('CODE', 'bug in custom code');
  }
  return result('UNKNOWN', 'unclassified error');
}

/**
 * Pull individual error reports out of an n8n webhook item.
 * Accepts: { headers, body } from the Webhook node, a single report, { errors: [...] } batches or arrays.
 */
function extractReports(item) {
  const j = isPlainObject(item) && isPlainObject(item.json) ? item.json : item;
  if (!isPlainObject(j)) return { headers: {}, reports: [] };
  const headers = isPlainObject(j.headers) ? j.headers : {};
  let body = 'body' in j && isPlainObject(j.headers) ? j.body : j;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      body = { error: { message: body } };
    }
  }
  let reports = [];
  if (Array.isArray(body)) reports = body;
  else if (isPlainObject(body) && Array.isArray(body.errors)) reports = body.errors;
  else if (isPlainObject(body)) reports = [body];
  return { headers, reports: reports.filter(isPlainObject) };
}

/** HubSpot sends CONTACT / 0-1 / contacts style object types; normalize to the CRM API path segment. */
function normalizeObjectType(value) {
  const v = String(value || '').trim().toLowerCase();
  const map = { contact: 'contacts', '0-1': 'contacts', company: 'companies', '0-2': 'companies', deal: 'deals', '0-3': 'deals', ticket: 'tickets', '0-5': 'tickets' };
  return map[v] || v;
}

/** Verify the shared secret header. In sandbox mode an unset secret is allowed (with a flag). */
function authenticate(headers, config) {
  const provided = headerValue(headers, 'x-hs-error-secret');
  if (!config.secret) return config.sandboxMode ? { ok: true, unverified: true } : { ok: false, reason: 'SECRET_NOT_CONFIGURED' };
  if (!provided) return { ok: false, reason: 'SECRET_MISSING' };
  return constantTimeEqual(provided, config.secret) ? { ok: true, unverified: false } : { ok: false, reason: 'SECRET_MISMATCH' };
}

/** Normalize one report (wrapper schema, HubSpot "Send a webhook" body, or flat fields). */
function normalizeReport(report, config, now) {
  const at = parseDate(now) || new Date();
  const r = isPlainObject(report) ? report : {};
  const err = isPlainObject(r.error) ? r.error : {};
  const props = isPlainObject(r.properties) ? r.properties : {};
  const val = (keys) => {
    const v = pick(r, keys);
    if (v !== undefined) return isPlainObject(v) && 'value' in v ? v.value : v;
    const p = pick(props, keys.map((k) => k.replace(/^properties\./, '')));
    return isPlainObject(p) && 'value' in p ? p.value : p;
  };

  const rawMessage = clean(err.message || val(['error_message', 'errorMessage', 'cca_error_message', 'message']) || '', 4000);
  const rawStack = clean(err.stack || val(['error_stack', 'errorStack', 'cca_error_stack', 'stack']) || '', 20000);
  const responseData = isPlainObject(err.response) ? err.response.data : undefined;
  const embedded =
    parseEmbeddedApiError(typeof responseData === 'string' ? responseData : responseData ? JSON.stringify(responseData) : '') ||
    parseEmbeddedApiError(rawMessage);

  const statusCode =
    Number(err.statusCode || err.status || (isPlainObject(err.response) ? err.response.status : undefined) || val(['error_status_code', 'statusCode', 'cca_error_status_code'])) ||
    (embedded && /^\d{3}$/.test(String(embedded.status)) ? Number(embedded.status) : null) ||
    null;
  const stack = parseStack(rawStack, config.limits.maxStackFrames);
  const name = clean(err.name || val(['error_name', 'errorName']) || (stack.header.match(/^([A-Za-z]*Error)\b/) || [])[1] || 'Error', 80);
  const message = clean((embedded && embedded.message) || rawMessage || stack.header || 'No error message provided', 1000);
  const classification = classifyError({ statusCode, code: err.code || val(['error_code']), name, category: embedded && embedded.category, message: `${message} ${rawMessage}` });

  const objectType = normalizeObjectType(val(['object.objectType', 'objectType', 'object_type']));
  const objectId = String(val(['object.objectId', 'objectId', 'hs_object_id', 'object_id']) || '').trim();
  const attemptRaw = Number(val(['attempt', 'retry_count', 'retryCount', 'cca_retry_count']));
  const attempt = Number.isFinite(attemptRaw) && attemptRaw >= 0 ? Math.floor(attemptRaw) : 0;
  const portalId = String(val(['portalId', 'portal_id']) || config.hubspot.portalId || '').replace(/[^0-9]/g, '');

  const source = {
    portalId: portalId || null,
    workflowId: clean(val(['workflowId', 'workflow_id', 'origin.workflowId']) || '', 40) || null,
    workflowName: clean(val(['workflowName', 'workflow_name']) || '', 200) || null,
    actionId: clean(val(['actionId', 'action_id', 'callbackId', 'callback_id']) || '', 80) || null,
    actionName: clean(val(['actionName', 'action_name']) || '', 200) || null,
    objectType: /^[a-z0-9_-]{1,64}$/.test(objectType) ? objectType : null,
    objectId: /^\d{1,20}$/.test(objectId) ? objectId : null,
  };
  const occurredAt = parseDate(val(['occurredAt', 'occurred_at', 'timestamp'])) || at;
  const inputFieldNames = isPlainObject(r.inputFields) ? Object.keys(r.inputFields).slice(0, 50) : [];

  const fingerprint = hash([source.workflowId, source.actionId || source.actionName, classification.type, name, message.replace(/\d+/g, '#').slice(0, 200), stack.failedStep ? `${stack.failedStep.file}:${stack.failedStep.line}` : ''].join('|'));

  return {
    eventId: `${fingerprint}-${occurredAt.getTime().toString(36)}-${hash(JSON.stringify([source.objectId, attempt, rawMessage.slice(0, 200)]))}`,
    fingerprint,
    receivedAt: at.toISOString(),
    occurredAt: occurredAt.toISOString(),
    source,
    error: {
      type: classification.type,
      retryable: classification.retryable,
      reason: classification.reason,
      name,
      message: redact(message),
      statusCode,
      code: err.code ? clean(err.code, 40) : null,
      hubspotCategory: embedded ? embedded.category : null,
      correlationId: embedded ? embedded.correlationId : null,
      details: embedded ? embedded.errors.map(redact) : [],
      failedStep: stack.failedStep ? { function: stack.failedStep.function, file: stack.failedStep.file, line: stack.failedStep.line, column: stack.failedStep.column } : null,
      stackFrames: stack.frames.map((f) => ({ function: f.function, file: f.file, line: f.line, column: f.column, internal: f.internal })),
      stackTruncated: stack.truncated,
      stackText: redact(rawStack.split(/\r?\n/).slice(0, config.limits.maxStackFrames + 1).join('\n')),
    },
    severity: classification.severity,
    attempt,
    inputFieldNames,
  };
}

// ---------------------------------------------------------------------------
// Decisions and output formats
// ---------------------------------------------------------------------------

/** Exponential backoff with deterministic jitter (from the fingerprint). */
function backoffSeconds(attempt, config, fingerprint) {
  const base = config.recovery.baseDelaySeconds * Math.pow(2, Math.max(0, attempt));
  const jitter = (parseInt(String(fingerprint || '0').slice(0, 4), 16) % 1000) / 1000; // 0..1
  const withJitter = base * (1 + jitter * 0.2);
  return Math.min(config.recovery.maxDelaySeconds, Math.round(withJitter));
}

/**
 * Decide RETRY / FALLBACK / NONE and build the HubSpot payloads that carry it out.
 * Retry = set cca_error_status=RETRY_REQUESTED and bump cca_retry_count on the record;
 * a HubSpot workflow re-enrolment trigger on that property re-runs the custom code action.
 */
function planRecovery(event, config) {
  const s = event.source;
  const now = event.receivedAt;
  const nextAttempt = event.attempt + 1;
  const base = { action: 'NONE', reason: '', delaySeconds: 0, objectType: s.objectType, objectId: s.objectId, updatePath: null, properties: null, task: null };
  if (!s.objectType || !s.objectId) return Object.assign(base, { reason: 'No record reference in the payload; alert only.' });
  const updatePath = `/crm/v3/objects/${encodeURIComponent(s.objectType)}/${encodeURIComponent(s.objectId)}`;
  const common = {
    cca_last_error_type: event.error.type,
    cca_last_error_at: now,
    cca_last_error_fingerprint: event.fingerprint,
    cca_last_error_message: event.error.message.slice(0, 500),
  };

  if (event.error.retryable && config.recovery.retryEnabled && event.attempt < config.recovery.maxRetries) {
    return Object.assign(base, {
      action: 'RETRY',
      reason: `${event.error.type} is retryable (attempt ${nextAttempt} of ${config.recovery.maxRetries}).`,
      delaySeconds: backoffSeconds(event.attempt, config, event.fingerprint),
      updatePath,
      properties: Object.assign({ cca_error_status: 'RETRY_REQUESTED', cca_retry_count: String(nextAttempt) }, common),
    });
  }
  if (!config.recovery.fallbackEnabled) {
    return Object.assign(base, { reason: event.error.retryable ? 'Retries exhausted; fallback disabled.' : `${event.error.type} is not retryable; fallback disabled.` });
  }
  const reason = event.error.retryable ? `Retries exhausted after ${event.attempt} attempt(s).` : `${event.error.type} is not retryable.`;
  let task = null;
  const assocId = config.hubspot.taskAssociationTypeIds[s.objectType];
  if (config.recovery.fallbackTaskEnabled) {
    const props = {
      hs_timestamp: now,
      hs_task_subject: `Custom code action failed: ${(s.actionName || s.actionId || 'unknown action').slice(0, 120)} (${event.error.type})`,
      hs_task_body: [
        `Workflow: ${s.workflowName || s.workflowId || 'unknown'}`,
        `Action: ${s.actionName || s.actionId || 'unknown'}`,
        `Error: ${event.error.name}: ${event.error.message}`,
        event.error.failedStep ? `Failed step: ${event.error.failedStep.function} at ${event.error.failedStep.file}:${event.error.failedStep.line}` : 'Failed step: not available',
        `Reason for fallback: ${reason}`,
        `Fingerprint: ${event.fingerprint}`,
        'Next step: fix the data or code, then set cca_error_status to RETRY_REQUESTED to re-run the action.',
      ].join('\n'),
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: event.severity === 'critical' ? 'HIGH' : 'MEDIUM',
      hs_task_type: 'TODO',
    };
    if (config.hubspot.fallbackOwnerId) props.hubspot_owner_id = config.hubspot.fallbackOwnerId;
    task = { properties: props, associations: assocId ? [{ to: { id: s.objectId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: assocId }] }] : [] };
  }
  return Object.assign(base, {
    action: 'FALLBACK',
    reason,
    updatePath,
    properties: Object.assign({ cca_error_status: 'FALLBACK' }, common),
    task,
  });
}

function severityRank(s) {
  return SEVERITIES.indexOf(s);
}

function recordUrl(event, config) {
  const s = event.source;
  if (!s.portalId || !s.objectId || !s.objectType) return null;
  const typeIds = { contacts: '0-1', companies: '0-2', deals: '0-3', tickets: '0-5' };
  const typeId = typeIds[s.objectType] || s.objectType;
  return `${config.hubspot.appBaseUrl}/contacts/${s.portalId}/record/${typeId}/${s.objectId}`;
}

function escapeSlack(v) {
  return String(v === undefined || v === null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SEVERITY_EMOJI = { info: 'ℹ️', warning: '⚠️', error: '🔴', critical: '🚨' };

/** Slack Incoming Webhook payload for one error event. */
function buildSlackAlert(event, recovery, config, suppressedCount) {
  const s = event.source;
  const url = recordUrl(event, config);
  const record = s.objectId ? `${s.objectType || 'record'} ${s.objectId}` : 'unknown record';
  const step = event.error.failedStep;
  const header = `${SEVERITY_EMOJI[event.severity]} HubSpot custom code ${event.error.type.replace(/_/g, ' ').toLowerCase()} · ${event.severity.toUpperCase()}`;
  const fields = [
    `*Workflow:* ${escapeSlack(s.workflowName || s.workflowId || 'unknown')}`,
    `*Action:* ${escapeSlack(s.actionName || s.actionId || 'unknown')}`,
    `*Record:* ${url ? `<${url}|${escapeSlack(record)}>` : escapeSlack(record)}`,
    `*Attempt:* ${event.attempt + 1}${event.error.statusCode ? ` · *HTTP:* ${event.error.statusCode}` : ''}${event.error.correlationId ? ` · *Correlation:* \`${escapeSlack(event.error.correlationId)}\`` : ''}`,
  ];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: header.slice(0, 150), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(event.error.name)}:* ${escapeSlack(event.error.message)}`.slice(0, 2900) } },
    { type: 'section', text: { type: 'mrkdwn', text: fields.join('\n') } },
  ];
  if (step) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Failed step:* \`${escapeSlack(step.function)}\` at \`${escapeSlack(step.file)}:${step.line}:${step.column}\`` } });
  }
  if (event.error.stackText) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + escapeSlack(event.error.stackText).slice(0, 2800) + '```' } });
  }
  const recoveryText =
    recovery.action === 'RETRY'
      ? `🔁 *Retry scheduled* in ${recovery.delaySeconds}s (${escapeSlack(recovery.reason)})`
      : recovery.action === 'FALLBACK'
        ? `🛟 *Fallback:* record flagged${recovery.task ? ' and task created' : ''} (${escapeSlack(recovery.reason)})`
        : `ℹ️ *No automatic recovery:* ${escapeSlack(recovery.reason)}`;
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: recoveryText } });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `fingerprint \`${event.fingerprint}\`${suppressedCount ? ` · ${suppressedCount} similar alert(s) suppressed` : ''}${config.sandboxMode ? ' · SANDBOX' : ''} · error-parser v${PARSER_VERSION}` }],
  });
  return {
    route: event.severity === 'critical' && config.alerts.slackCriticalConfigured ? 'critical' : 'default',
    payload: { text: `${header}: ${event.error.message}`.slice(0, 300), blocks },
  };
}

/** Datadog Logs intake entries (POST https://http-intake.logs.<site>/api/v2/logs). */
function buildDatadogLogs(event, recovery, config) {
  const s = event.source;
  return [
    {
      ddsource: 'n8n',
      service: config.datadog.service,
      hostname: 'n8n-error-handler',
      status: event.severity === 'critical' ? 'critical' : event.severity === 'warning' ? 'warn' : 'error',
      ddtags: [
        `env:${config.datadog.env}`,
        `error_type:${event.error.type.toLowerCase()}`,
        `severity:${event.severity}`,
        `recovery:${recovery.action.toLowerCase()}`,
        s.workflowId ? `workflow_id:${s.workflowId}` : null,
        s.objectType ? `object_type:${s.objectType}` : null,
      ]
        .filter(Boolean)
        .join(','),
      message: `${event.error.name}: ${event.error.message}`,
      error: { kind: event.error.name, message: event.error.message, stack: event.error.stackText },
      hubspot: Object.assign({}, s),
      event: {
        id: event.eventId,
        fingerprint: event.fingerprint,
        type: event.error.type,
        status_code: event.error.statusCode,
        correlation_id: event.error.correlationId,
        attempt: event.attempt,
        failed_step: event.error.failedStep,
        occurred_at: event.occurredAt,
      },
      recovery: { action: recovery.action, reason: recovery.reason, delay_seconds: recovery.delaySeconds },
    },
  ];
}

/** Single-line JSON log for console / stdout collectors when Datadog is disabled. */
function buildConsoleLine(event, recovery) {
  return JSON.stringify({
    level: event.severity,
    msg: 'hubspot_custom_code_error',
    type: event.error.type,
    name: event.error.name,
    message: event.error.message,
    workflowId: event.source.workflowId,
    action: event.source.actionName || event.source.actionId,
    objectType: event.source.objectType,
    objectId: event.source.objectId,
    statusCode: event.error.statusCode,
    failedStep: event.error.failedStep ? `${event.error.failedStep.file}:${event.error.failedStep.line}` : null,
    attempt: event.attempt,
    recovery: recovery.action,
    fingerprint: event.fingerprint,
  });
}

/**
 * Alert de-duplication. `store` is n8n workflow static data (persists between
 * production executions) or any plain object in tests.
 * @returns {{ send: boolean, suppressedCount: number }}
 */
function dedupeAlert(store, event, config, now) {
  const at = (parseDate(now) || new Date()).getTime();
  if (!isPlainObject(store)) return { send: true, suppressedCount: 0 };
  if (!isPlainObject(store.alerts)) store.alerts = {};
  // Prune entries older than 24 hours (or the dedupe window, whichever is longer).
  const ttl = Math.max(24 * 60, config.alerts.dedupeMinutes) * 60000;
  Object.keys(store.alerts).forEach((k) => {
    if (at - store.alerts[k].lastSentAt > ttl) delete store.alerts[k];
  });
  const entry = store.alerts[event.fingerprint];
  if (entry && config.alerts.dedupeMinutes > 0 && at - entry.lastSentAt < config.alerts.dedupeMinutes * 60000) {
    entry.suppressed += 1;
    return { send: false, suppressedCount: entry.suppressed };
  }
  const suppressedCount = entry ? entry.suppressed : 0;
  store.alerts[event.fingerprint] = { lastSentAt: at, suppressed: 0 };
  return { send: true, suppressedCount };
}

/**
 * Full pipeline for the n8n "Normalize & Parse Errors" Code node.
 * @param {object[]} items n8n input items (Webhook node output)
 * @param {object} config from loadConfig()
 * @param {Date|string} now
 * @param {{ store?: object, runId?: string }} [meta]
 * @returns {{ events: object[], rejected: Record<string, number> }}
 */
function processWebhookItems(items, config, now, meta) {
  const info = meta || {};
  const events = [];
  const rejected = {};
  const reject = (reason) => (rejected[reason] = (rejected[reason] || 0) + 1);

  (Array.isArray(items) ? items : []).forEach((item) => {
    const extracted = extractReports(item);
    const auth = authenticate(extracted.headers, config);
    if (!auth.ok) return reject(auth.reason);
    if (extracted.reports.length === 0) return reject('EMPTY_PAYLOAD');
    extracted.reports.slice(0, config.limits.maxEventsPerRequest).forEach((report) => {
      try {
        const event = normalizeReport(report, config, now);
        const recovery = planRecovery(event, config);
        const wantsAlert = config.alerts.slackEnabled && severityRank(event.severity) >= severityRank(config.alerts.minSeverity);
        const dedupe = wantsAlert ? dedupeAlert(info.store, event, config, now) : { send: false, suppressedCount: 0 };
        const slack = buildSlackAlert(event, recovery, config, dedupe.suppressedCount);
        events.push(
          Object.assign(event, {
            kind: 'error_event',
            sandbox: Boolean(config.sandboxMode),
            unverified: Boolean(auth.unverified),
            runId: info.runId || null,
            recovery,
            alert: { send: wantsAlert && dedupe.send, route: slack.route, suppressedCount: dedupe.suppressedCount, payload: slack.payload },
            log: { datadogEnabled: config.datadog.enabled, datadog: buildDatadogLogs(event, recovery, config), line: buildConsoleLine(event, recovery) },
          })
        );
      } catch (err) {
        reject('UNPARSEABLE_REPORT');
      }
    });
    if (extracted.reports.length > config.limits.maxEventsPerRequest) reject('BATCH_LIMIT_EXCEEDED');
  });
  return { events, rejected };
}

/** Sanitized dry-run summary for SANDBOX_MODE. */
function buildDryRunReport(events) {
  const list = (Array.isArray(events) ? events : []).filter((e) => isPlainObject(e) && e.kind === 'error_event');
  const lines = list.map(
    (e) =>
      `[cca-errors] DRY RUN ${e.severity.toUpperCase()} ${e.error.type} ${e.source.objectType || '-'}:${e.source.objectId || '-'} ` +
      `recovery=${e.recovery.action}${e.recovery.action === 'RETRY' ? `(${e.recovery.delaySeconds}s)` : ''} alert=${e.alert.send ? e.alert.route : 'no'} fp=${e.fingerprint}`
  );
  const count = (fn) => list.filter(fn).length;
  return {
    kind: 'dry_run_report',
    mode: 'SANDBOX',
    totals: {
      events: list.length,
      alerts: count((e) => e.alert.send),
      retries: count((e) => e.recovery.action === 'RETRY'),
      fallbacks: count((e) => e.recovery.action === 'FALLBACK'),
      fallbackTasks: count((e) => e.recovery.task),
    },
    lines: lines.map(redact),
  };
}

module.exports = {
  PARSER_VERSION,
  ENV_KEYS,
  DEFAULTS,
  ERROR_TYPES,
  ConfigError,
  isPlaceholder,
  loadConfig,
  redact,
  hash,
  constantTimeEqual,
  parseStack,
  parseEmbeddedApiError,
  classifyError,
  extractReports,
  normalizeObjectType,
  authenticate,
  normalizeReport,
  backoffSeconds,
  planRecovery,
  buildSlackAlert,
  buildDatadogLogs,
  buildConsoleLine,
  dedupeAlert,
  processWebhookItems,
  buildDryRunReport,
};
