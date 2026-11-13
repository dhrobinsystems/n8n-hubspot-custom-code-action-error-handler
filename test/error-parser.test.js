'use strict';

/**
 * test/error-parser.test.js
 * Unit tests for error-parser.js (node:test). All payloads are synthetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const P = require('../error-parser');

const NOW = new Date('2026-06-01T08:00:05.000Z');
const SECRET = 'test-only-error-secret-0000';
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'error-reports.json'), 'utf8'));
const cfg = (o) => P.loadConfig(Object.assign({ ERROR_WEBHOOK_SECRET: SECRET, HUBSPOT_PORTAL_ID: '12345678' }, o || {}));
const webhookItem = (body, secret) => ({ json: { headers: { 'content-type': 'application/json', 'X-HS-Error-Secret': secret === undefined ? SECRET : secret }, params: {}, query: {}, body } });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('config: safe defaults, every key declared, placeholders unset', () => {
  const c = P.loadConfig({});
  assert.equal(c.sandboxMode, true);
  assert.equal(c.recovery.maxRetries, 3);
  assert.equal(c.datadog.intakeUrl, 'https://http-intake.logs.datadoghq.com/api/v2/logs');
  assert.deepEqual(c.hubspot.taskAssociationTypeIds, { contacts: 204, companies: 192, deals: 216, tickets: 228 });
  Object.keys(P.DEFAULTS).forEach((k) => assert.ok(P.ENV_KEYS.includes(k), k));
  assert.equal(P.loadConfig({ ERROR_WEBHOOK_SECRET: 'REPLACE_WITH_ERROR_WEBHOOK_SECRET' }).secret, '');
  assert.ok(c.warnings.some((w) => w.includes('ERROR_WEBHOOK_SECRET')));
});

test('config: webhook URLs are checked for presence but never stored', () => {
  const c = cfg({ SLACK_WEBHOOK_URL: 'https://slack-webhook.example/test-only', SLACK_CRITICAL_WEBHOOK_URL: 'https://slack-webhook.example/critical' });
  assert.equal(c.alerts.slackConfigured, true);
  assert.equal(c.alerts.slackCriticalConfigured, true);
  assert.ok(!JSON.stringify(c).includes('slack-webhook.example'));
});

test('config: fail fast with every problem listed; live mode requirements', () => {
  assert.throws(
    () =>
      P.loadConfig({
        SANDBOX_MODE: 'sometimes',
        ERROR_WEBHOOK_SECRET: 'short',
        MAX_RETRIES: '50',
        RETRY_BASE_DELAY_SECONDS: '600',
        RETRY_MAX_DELAY_SECONDS: '60',
        ALERT_MIN_SEVERITY: 'loud',
        DATADOG_SITE: 'datadog.example',
        TASK_ASSOCIATION_TYPE_IDS_JSON: '{bad',
        SLACK_WEBHOOK_URL: 'http://insecure.example',
      }),
    (err) => {
      assert.ok(err instanceof P.ConfigError);
      const t = err.problems.join('\n');
      ['SANDBOX_MODE', 'ERROR_WEBHOOK_SECRET', 'MAX_RETRIES', 'RETRY_MAX_DELAY_SECONDS', 'ALERT_MIN_SEVERITY', 'DATADOG_SITE', 'TASK_ASSOCIATION_TYPE_IDS_JSON', 'SLACK_WEBHOOK_URL'].forEach((n) => assert.ok(t.includes(n), n));
      return true;
    }
  );
  assert.throws(() => P.loadConfig({ SANDBOX_MODE: 'false' }), /ERROR_WEBHOOK_SECRET is required/);
  assert.throws(() => cfg({ SANDBOX_MODE: 'false' }), /SLACK_WEBHOOK_URL is required/);
  assert.equal(cfg({ SANDBOX_MODE: 'false', ENABLE_SLACK: 'false' }).sandboxMode, false);
});

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

test('parseStack finds the failed step in user code and skips internals', () => {
  const s = P.parseStack(FX.rate_limit.error.stack, 15);
  assert.equal(s.header, 'AxiosError: Request failed with status code 429');
  assert.equal(s.frames.length, 5);
  assert.deepEqual(s.failedStep, { function: 'runAction', file: '/var/task/file.js', line: 17, column: 22, internal: false });
  assert.equal(s.frames[0].internal, true, 'node_modules frame');
  assert.equal(s.frames[2].internal, true, 'node: internal frame');
  const anon = P.parseStack('Error: x\n    at /var/task/file.js:5:3', 15);
  assert.deepEqual([anon.failedStep.function, anon.failedStep.line], ['<anonymous>', 5]);
  assert.deepEqual(P.parseStack('', 15), { header: '', frames: [], failedStep: null, truncated: false });
  const long = P.parseStack('Error: deep\n' + Array.from({ length: 30 }, (_, i) => `    at fn${i} (/var/task/file.js:${i + 1}:1)`).join('\n'), 10);
  assert.equal(long.frames.length, 10);
  assert.equal(long.truncated, true);
});

test('parseEmbeddedApiError extracts HubSpot category and correlation ID', () => {
  const e = P.parseEmbeddedApiError('HTTP-Code: 400 Message: {"status":"error","message":"Property values were not valid","correlationId":"bbbbbbbb-1111","category":"VALIDATION_ERROR","errors":[{"message":"bad industry"}]}');
  assert.deepEqual([e.category, e.correlationId, e.errors[0]], ['VALIDATION_ERROR', 'bbbbbbbb-1111', 'bad industry']);
  assert.equal(P.parseEmbeddedApiError('no json here'), null);
  assert.equal(P.parseEmbeddedApiError('{"unrelated": true}'), null);
  assert.equal(P.parseEmbeddedApiError('{broken json'), null);
});

test('classifyError covers every error type', () => {
  const cases = [
    [{ statusCode: 429 }, 'RATE_LIMIT', true],
    [{ category: 'RATE_LIMITS' }, 'RATE_LIMIT', true],
    [{ statusCode: 401 }, 'AUTH', false],
    [{ category: 'MISSING_SCOPES' }, 'AUTH', false],
    [{ message: 'Task timed out after 20.02 seconds' }, 'TIMEOUT', true],
    [{ code: 'ETIMEDOUT' }, 'TIMEOUT', true],
    [{ code: 'ECONNRESET' }, 'NETWORK', true],
    [{ message: 'socket hang up' }, 'NETWORK', true],
    [{ statusCode: 502 }, 'SERVER', true],
    [{ statusCode: 404 }, 'NOT_FOUND', false],
    [{ statusCode: 409 }, 'CONFLICT', false],
    [{ statusCode: 400 }, 'VALIDATION', false],
    [{ message: 'Property values were not valid' }, 'VALIDATION', false],
    [{ name: 'TypeError', message: 'x is not a function' }, 'CODE', false],
    [{ name: 'ReferenceError' }, 'CODE', false],
    [{ message: 'something odd' }, 'UNKNOWN', true],
  ];
  cases.forEach(([input, type, retryable]) => {
    const c = P.classifyError(input);
    assert.equal(c.type, type, JSON.stringify(input));
    assert.equal(c.retryable, retryable, JSON.stringify(input));
  });
  assert.equal(P.classifyError({ statusCode: 401 }).severity, 'critical');
  assert.equal(P.classifyError({ name: 'TypeError' }).severity, 'critical');
});

test('extractReports and authenticate', () => {
  const single = P.extractReports(webhookItem(FX.network));
  assert.equal(single.reports.length, 1);
  assert.equal(P.extractReports(webhookItem({ errors: [FX.network, FX.auth, 'junk'] })).reports.length, 2);
  assert.equal(P.extractReports(webhookItem([FX.network, FX.auth])).reports.length, 2);
  assert.equal(P.extractReports(webhookItem('plain text failure')).reports[0].error.message, 'plain text failure');
  assert.equal(P.extractReports(webhookItem(JSON.stringify(FX.network))).reports[0].error.code, 'ECONNRESET');
  assert.deepEqual(P.extractReports(null).reports, []);

  const c = cfg();
  assert.deepEqual(P.authenticate({ 'x-hs-error-secret': SECRET }, c), { ok: true, unverified: false });
  assert.equal(P.authenticate({ 'x-hs-error-secret': 'wrong-secret-0000000000' }, c).reason, 'SECRET_MISMATCH');
  assert.equal(P.authenticate({}, c).reason, 'SECRET_MISSING');
  assert.deepEqual(P.authenticate({}, P.loadConfig({})), { ok: true, unverified: true }, 'sandbox without a secret accepts test calls');
});

test('normalizeObjectType maps HubSpot formats to CRM API paths', () => {
  assert.equal(P.normalizeObjectType('CONTACT'), 'contacts');
  assert.equal(P.normalizeObjectType('0-2'), 'companies');
  assert.equal(P.normalizeObjectType('DEAL'), 'deals');
  assert.equal(P.normalizeObjectType('ticket'), 'tickets');
  assert.equal(P.normalizeObjectType('p12345678_widgets'), 'p12345678_widgets');
});

// ---------------------------------------------------------------------------
// normalizeReport + planRecovery on each fixture
// ---------------------------------------------------------------------------

test('rate limit: retry with backoff, failed step and correlation ID', () => {
  const c = cfg();
  const e = P.normalizeReport(FX.rate_limit, c, NOW);
  assert.equal(e.error.type, 'RATE_LIMIT');
  assert.equal(e.severity, 'warning');
  assert.equal(e.error.statusCode, 429);
  assert.equal(e.error.hubspotCategory, 'RATE_LIMITS');
  assert.equal(e.error.correlationId, 'aaaaaaaa-1111-4222-8333-444444444444');
  assert.equal(e.error.message, 'You have reached your secondly limit.');
  assert.deepEqual(e.error.failedStep, { function: 'runAction', file: '/var/task/file.js', line: 17, column: 22 });
  assert.deepEqual(e.source, { portalId: '12345678', workflowId: '900001', workflowName: 'Synthetic Lead Routing', actionId: '1000099', actionName: 'Assign owner by territory', objectType: 'contacts', objectId: '501' });
  assert.deepEqual(e.inputFieldNames, ['email', 'cca_retry_count']);
  const r = P.planRecovery(e, c);
  assert.equal(r.action, 'RETRY');
  assert.ok(r.delaySeconds >= 60 && r.delaySeconds <= 72, String(r.delaySeconds));
  assert.equal(r.updatePath, '/crm/v3/objects/contacts/501');
  assert.equal(r.properties.cca_error_status, 'RETRY_REQUESTED');
  assert.equal(r.properties.cca_retry_count, '1');
});

test('TypeError in custom code: critical, fallback with task on the deal', () => {
  const c = cfg({ FALLBACK_OWNER_ID: '777' });
  const e = P.normalizeReport(FX.type_error, c, NOW);
  assert.deepEqual([e.error.type, e.severity, e.error.retryable], ['CODE', 'critical', false]);
  assert.deepEqual(e.error.failedStep, { function: 'calculateRenewal', file: '/var/task/file.js', line: 42, column: 31 });
  const r = P.planRecovery(e, c);
  assert.equal(r.action, 'FALLBACK');
  assert.equal(r.properties.cca_error_status, 'FALLBACK');
  assert.equal(r.task.properties.hubspot_owner_id, '777');
  assert.equal(r.task.properties.hs_task_priority, 'HIGH');
  assert.match(r.task.properties.hs_task_body, /calculateRenewal at \/var\/task\/file\.js:42/);
  assert.deepEqual(r.task.associations[0], { to: { id: '9001' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] });
});

test('validation error on a company (0-2): fallback, not retried', () => {
  const e = P.normalizeReport(FX.validation, cfg(), NOW);
  assert.deepEqual([e.error.type, e.source.objectType, e.error.hubspotCategory], ['VALIDATION', 'companies', 'VALIDATION_ERROR']);
  assert.match(e.error.message, /^Property values were not valid/);
  assert.equal(P.planRecovery(e, cfg()).action, 'FALLBACK');
});

test('timeout after max retries: fallback with exhausted-retries reason', () => {
  const e = P.normalizeReport(FX.timeout_exhausted, cfg(), NOW);
  assert.deepEqual([e.error.type, e.attempt, e.source.objectType], ['TIMEOUT', 3, 'tickets']);
  const r = P.planRecovery(e, cfg());
  assert.equal(r.action, 'FALLBACK');
  assert.match(r.reason, /Retries exhausted after 3/);
  assert.equal(r.task.associations[0].types[0].associationTypeId, 228);
});

test('auth error: critical, and tokens / emails are redacted everywhere', () => {
  const e = P.normalizeReport(FX.auth, cfg(), NOW);
  assert.deepEqual([e.error.type, e.severity], ['AUTH', 'critical']);
  const text = JSON.stringify(e);
  assert.ok(!text.includes('pat-na1-SYNTHETIC'), 'token redacted');
  assert.ok(!text.includes('ops@example.com'), 'email redacted');
  assert.match(e.error.message, /\[redacted-token\]/);
});

test('network error retries; report without a record alerts only', () => {
  assert.equal(P.planRecovery(P.normalizeReport(FX.network, cfg(), NOW), cfg()).action, 'RETRY');
  const none = P.normalizeReport(FX.no_record, cfg(), NOW);
  assert.equal(none.source.objectId, null);
  const r = P.planRecovery(none, cfg());
  assert.equal(r.action, 'NONE');
  assert.match(r.reason, /No record reference/);
});

test('HubSpot "Send a webhook" flat payload with { value } properties', () => {
  const e = P.normalizeReport(FX.send_a_webhook_flat, cfg(), NOW);
  assert.deepEqual([e.error.type, e.error.statusCode, e.attempt, e.source.objectId, e.source.objectType, e.source.workflowId], ['SERVER', 503, 1, '601', 'contacts', '900003']);
  const r = P.planRecovery(e, cfg());
  assert.equal(r.action, 'RETRY');
  assert.equal(r.properties.cca_retry_count, '2');
  assert.ok(r.delaySeconds >= 120 && r.delaySeconds <= 144);
});

test('recovery toggles and backoff cap', () => {
  const e = P.normalizeReport(FX.network, cfg(), NOW);
  assert.equal(P.planRecovery(e, cfg({ ENABLE_RETRY: 'false' })).action, 'FALLBACK');
  assert.equal(P.planRecovery(e, cfg({ ENABLE_RETRY: 'false', ENABLE_FALLBACK: 'false' })).action, 'NONE');
  assert.equal(P.planRecovery(P.normalizeReport(FX.type_error, cfg(), NOW), cfg({ ENABLE_FALLBACK_TASK: 'false' })).task, null);
  const c = cfg({ RETRY_BASE_DELAY_SECONDS: '100', RETRY_MAX_DELAY_SECONDS: '300' });
  assert.equal(P.backoffSeconds(5, c, 'ffff'), 300);
  assert.equal(P.backoffSeconds(0, c, '0000'), 100);
});

test('fingerprints are stable across attempts and record IDs, different across errors', () => {
  const c = cfg();
  const a = P.normalizeReport(FX.rate_limit, c, NOW);
  const b = P.normalizeReport(Object.assign({}, FX.rate_limit, { attempt: 2, object: { objectType: 'CONTACT', objectId: '999' } }), c, NOW);
  const other = P.normalizeReport(FX.type_error, c, NOW);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.eventId, b.eventId);
  assert.notEqual(a.fingerprint, other.fingerprint);
  assert.match(a.fingerprint, /^[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// Output formats and de-duplication
// ---------------------------------------------------------------------------

test('Slack alert: Block Kit, escaping, links and critical routing', () => {
  const c = cfg({ SLACK_CRITICAL_WEBHOOK_URL: 'https://slack-webhook.example/critical' });
  const e = P.normalizeReport(FX.type_error, c, NOW);
  const alert = P.buildSlackAlert(e, P.planRecovery(e, c), c, 2);
  assert.equal(alert.route, 'critical');
  const json = JSON.stringify(alert.payload.blocks);
  assert.match(json, /record\/0-3\/9001\|deals 9001/);
  assert.match(json, /calculateRenewal/);
  assert.match(json, /2 similar alert\(s\) suppressed/);
  assert.match(json, /Fallback/);
  alert.payload.blocks.filter((b) => b.type === 'section').forEach((b) => assert.ok(b.text.text.length <= 3000));
  assert.equal(P.buildSlackAlert(e, P.planRecovery(e, cfg()), cfg(), 0).route, 'default', 'no critical channel configured');
  const xss = P.normalizeReport({ error: { name: 'Error', message: '<script>&' } }, c, NOW);
  assert.match(JSON.stringify(P.buildSlackAlert(xss, P.planRecovery(xss, c), c, 0).payload), /&lt;script&gt;&amp;/);
});

test('Datadog entries and console line', () => {
  const c = cfg({ DATADOG_ENV: 'staging' });
  const e = P.normalizeReport(FX.rate_limit, c, NOW);
  const r = P.planRecovery(e, c);
  const [log] = P.buildDatadogLogs(e, r, c);
  assert.equal(log.ddsource, 'n8n');
  assert.equal(log.status, 'warn');
  assert.match(log.ddtags, /env:staging,error_type:rate_limit,severity:warning,recovery:retry,workflow_id:900001,object_type:contacts/);
  assert.equal(log.event.correlation_id, 'aaaaaaaa-1111-4222-8333-444444444444');
  const line = JSON.parse(P.buildConsoleLine(e, r));
  assert.deepEqual([line.level, line.type, line.recovery, line.failedStep], ['warning', 'RATE_LIMIT', 'RETRY', '/var/task/file.js:17']);
});

test('dedupeAlert suppresses repeats inside the window and counts them', () => {
  const c = cfg({ ALERT_DEDUPE_MINUTES: '30' });
  const store = {};
  const e = P.normalizeReport(FX.rate_limit, c, NOW);
  assert.deepEqual(P.dedupeAlert(store, e, c, NOW), { send: true, suppressedCount: 0 });
  assert.deepEqual(P.dedupeAlert(store, e, c, new Date(NOW.getTime() + 60000)), { send: false, suppressedCount: 1 });
  assert.deepEqual(P.dedupeAlert(store, e, c, new Date(NOW.getTime() + 120000)), { send: false, suppressedCount: 2 });
  assert.deepEqual(P.dedupeAlert(store, e, c, new Date(NOW.getTime() + 31 * 60000)), { send: true, suppressedCount: 2 });
  assert.deepEqual(P.dedupeAlert(null, e, c, NOW), { send: true, suppressedCount: 0 });
  assert.deepEqual(P.dedupeAlert({}, e, cfg({ ALERT_DEDUPE_MINUTES: '0' }), NOW).send, true);
});

test('processWebhookItems: batch, rejections, severity threshold and limits', () => {
  const c = cfg({ ALERT_MIN_SEVERITY: 'error' });
  const store = {};
  const items = [
    webhookItem({ errors: [FX.rate_limit, FX.type_error, FX.no_record] }),
    webhookItem(FX.network, 'wrong-secret-0000000000'),
    webhookItem({}),
    { json: { headers: {}, body: FX.network } },
  ];
  const out = P.processWebhookItems(items, c, NOW, { store, runId: 'r1' });
  assert.equal(out.events.length, 4, 'three batched reports plus the {} report');
  assert.deepEqual(out.rejected, { SECRET_MISMATCH: 1, SECRET_MISSING: 1 });
  const byType = Object.fromEntries(out.events.map((e) => [e.error.type, e]));
  assert.equal(byType.RATE_LIMIT.alert.send, false, 'warning is below ALERT_MIN_SEVERITY=error');
  assert.equal(byType.CODE.alert.send, true);
  assert.equal(byType.CODE.kind, 'error_event');
  assert.equal(byType.CODE.runId, 'r1');
  const limited = P.processWebhookItems([webhookItem({ errors: [FX.network, FX.network, FX.network] })], cfg({ MAX_EVENTS_PER_REQUEST: '2' }), NOW, {});
  assert.equal(limited.events.length, 2);
  assert.deepEqual(limited.rejected, { BATCH_LIMIT_EXCEEDED: 1 });
  assert.deepEqual(P.processWebhookItems(null, c, NOW).events, []);
});

test('buildDryRunReport summarizes planned actions', () => {
  const out = P.processWebhookItems([webhookItem({ errors: [FX.rate_limit, FX.type_error, FX.no_record] })], cfg(), NOW, { store: {} });
  const report = P.buildDryRunReport(out.events);
  assert.deepEqual(report.totals, { events: 3, alerts: 3, retries: 1, fallbacks: 1, fallbackTasks: 1 });
  assert.ok(report.lines.some((l) => /CRITICAL CODE deals:9001 recovery=FALLBACK/.test(l)));
});

test('redact removes secrets from free text', () => {
  const out = P.redact('ops@example.com Bearer abc.def hapikey=xyz https://hooks.slack.com/services/X/Y/Z "authorization": "Basic zzz" 0123456789abcdef0123456789abcdef');
  ['ops@example.com', 'abc.def', 'xyz', 'hooks.slack.com', 'Basic', '0123456789abcdef0123456789abcdef'].forEach((s) => assert.ok(!out.includes(s), s));
});
