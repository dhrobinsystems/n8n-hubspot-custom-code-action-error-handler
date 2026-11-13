'use strict';

/**
 * test/workflow.test.js
 * ---------------------------------------------------------------------------
 * 1. Structure: workflow.json is valid, matches a fresh build, and wires the
 *    pipeline Webhook → Parse → Slack router / log router / retry-fallback router.
 * 2. Execution: runs the generated Code nodes in an isolated VM that mimics the
 *    n8n runtime ($input, $env, $execution, $getWorkflowStaticData).
 * 3. Security scan: fails on live-looking tokens, webhook URLs, keys or
 *    non-placeholder email addresses anywhere in the repository.
 * ---------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildWorkflow, serialize } = require('../scripts/build-workflow');

const ROOT = path.resolve(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'error-reports.json'), 'utf8'));
const SECRET = 'test-only-error-secret-0000';
const ENV = Object.freeze({ SANDBOX_MODE: 'true', ERROR_WEBHOOK_SECRET: SECRET, HUBSPOT_PORTAL_ID: '12345678' });
const LIVE = Object.freeze(Object.assign({}, ENV, { SANDBOX_MODE: 'false', SLACK_WEBHOOK_URL: 'https://slack-webhook.example/test-only' }));

const node = (name) => {
  const n = workflow.nodes.find((x) => x.name === name);
  assert.ok(n, `missing node ${name}`);
  return n;
};
const webhookItem = (body, secret) => ({ headers: { 'x-hs-error-secret': secret === undefined ? SECRET : secret }, params: {}, query: {}, body });

async function runCodeNode(name, inputJsons, opts) {
  const o = opts || {};
  const items = (inputJsons || []).map((json) => ({ json }));
  const logs = [];
  const staticData = o.staticData || {};
  const ctx = {
    $input: { all: () => items, first: () => items[0] },
    $execution: { id: 'test-exec-1' },
    $getWorkflowStaticData: () => staticData,
    console: { log: (...a) => logs.push(a.join(' ')), warn: () => {}, error: () => {} },
  };
  if (o.blockEnv) {
    Object.defineProperty(ctx, '$env', {
      get() {
        throw new Error('access to env vars denied');
      },
    });
  } else ctx.$env = o.env || ENV;
  const result = await vm.runInNewContext(`(async () => {\n${node(name).parameters.jsCode}\n})()`, ctx, { timeout: 10000 });
  return { output: JSON.parse(JSON.stringify(result || [])), logs, staticData };
}

// ---------------------------------------------------------------------------
// 1. Structure
// ---------------------------------------------------------------------------

test('workflow.json is valid and matches a fresh build of error-parser.js', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'), serialize(buildWorkflow()), 'run npm run build');
  assert.equal(workflow.active, false);
  assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length);
});

test('pipeline: Webhook → Parse → Slack router, Datadog/console logger, retry/fallback router', () => {
  const expected = {
    'HubSpot Error Webhook': 'n8n-nodes-base.webhook',
    'Normalize & Parse Errors': 'n8n-nodes-base.code',
    'Sandbox Mode?': 'n8n-nodes-base.if',
    'Dry-Run Telemetry': 'n8n-nodes-base.code',
    'Slack Alert Router': 'n8n-nodes-base.switch',
    'Slack Critical Alert': 'n8n-nodes-base.httpRequest',
    'Slack Alert': 'n8n-nodes-base.httpRequest',
    'Datadog Enabled?': 'n8n-nodes-base.if',
    'Datadog Log Intake': 'n8n-nodes-base.httpRequest',
    'Console Logger': 'n8n-nodes-base.code',
    'Retry / Fallback Router': 'n8n-nodes-base.switch',
    'Retry Backoff': 'n8n-nodes-base.wait',
    'HubSpot Request Retry': 'n8n-nodes-base.httpRequest',
    'HubSpot Flag Fallback': 'n8n-nodes-base.httpRequest',
    'Fallback Task Needed?': 'n8n-nodes-base.if',
    'HubSpot Create Fallback Task': 'n8n-nodes-base.httpRequest',
  };
  Object.entries(expected).forEach(([name, type]) => assert.equal(node(name).type, type, name));
  const c = workflow.connections;
  assert.equal(c['HubSpot Error Webhook'].main[0][0].node, 'Normalize & Parse Errors');
  assert.equal(c['Sandbox Mode?'].main[0][0].node, 'Dry-Run Telemetry');
  assert.deepEqual(c['Sandbox Mode?'].main[1].map((l) => l.node), ['Slack Alert Router', 'Datadog Enabled?', 'Retry / Fallback Router']);
  assert.deepEqual(c['Retry / Fallback Router'].main[0].map((l) => l.node), ['Retry Backoff']);
  assert.deepEqual(c['Retry / Fallback Router'].main[1].map((l) => l.node), ['HubSpot Flag Fallback', 'Fallback Task Needed?']);
  const names = new Set(workflow.nodes.map((n) => n.name));
  Object.values(c).forEach((v) => v.main.forEach((b) => b.forEach((l) => assert.ok(names.has(l.node), l.node))));
  assert.equal(node('HubSpot Error Webhook').parameters.responseMode, 'onReceived');
  assert.equal(node('Slack Alert').parameters.url, '={{ $env.SLACK_WEBHOOK_URL }}');
  assert.equal(node('HubSpot Request Retry').parameters.method, 'PATCH');
});

test('credentials are placeholders; HTTP nodes retry and continue on error', () => {
  workflow.nodes.filter((n) => n.credentials).forEach((n) => Object.values(n.credentials).forEach((cr) => {
    assert.match(cr.id, /^REPLACE_WITH_/, n.name);
    assert.match(cr.name, /REPLACE_WITH_/, n.name);
  }));
  workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').forEach((n) => {
    assert.equal(n.retryOnFail, true, n.name);
    assert.equal(n.onError, 'continueRegularOutput', n.name);
  });
});

// ---------------------------------------------------------------------------
// 2. Code node execution
// ---------------------------------------------------------------------------

test('Normalize & Parse Errors: parses a batch, rejects bad secrets, persists dedupe state', async () => {
  const staticData = {};
  const inputs = [webhookItem({ errors: [FX.rate_limit, FX.type_error, FX.validation, FX.no_record] }), webhookItem(FX.network, 'wrong-secret-0000000000')];
  const { output, logs } = await runCodeNode('Normalize & Parse Errors', inputs, { staticData });
  const events = output.map((i) => i.json);
  assert.equal(events.length, 4);
  assert.ok(logs.some((l) => l.includes('SECRET_MISMATCH')));
  assert.ok(events.every((e) => e.sandbox === true && e.kind === 'error_event'));
  assert.equal(events[0].log.intakeUrl, 'https://http-intake.logs.datadoghq.com/api/v2/logs');
  assert.deepEqual(events.map((e) => e.recovery.action), ['RETRY', 'FALLBACK', 'FALLBACK', 'NONE']);
  assert.equal(Object.keys(staticData.alerts).length, 4, 'dedupe state stored in workflow static data');

  const again = await runCodeNode('Normalize & Parse Errors', [webhookItem(FX.rate_limit)], { staticData });
  assert.equal(again.output[0].json.alert.send, false, 'repeat inside the dedupe window is suppressed');
});

test('Normalize & Parse Errors: fails fast on bad config, survives blocked $env and junk input', async () => {
  await assert.rejects(() => runCodeNode('Normalize & Parse Errors', [], { env: { SANDBOX_MODE: 'false' } }), /ERROR_WEBHOOK_SECRET is required/);
  const blocked = await runCodeNode('Normalize & Parse Errors', [webhookItem(FX.network, '')], { blockEnv: true });
  assert.equal(blocked.output[0].json.sandbox, true, 'defaults keep sandbox on');
  const junk = await runCodeNode('Normalize & Parse Errors', [null, 'x', { headers: { 'x-hs-error-secret': SECRET }, body: [] }], {});
  assert.deepEqual(junk.output, []);
});

test('live mode events carry Slack, Datadog and recovery payloads for the routers', async () => {
  const { output } = await runCodeNode('Normalize & Parse Errors', [webhookItem({ errors: [FX.type_error, FX.network] })], { env: LIVE });
  const [code, net] = output.map((i) => i.json);
  assert.equal(code.sandbox, false);
  assert.deepEqual([code.alert.send, code.alert.route], [true, 'default']);
  assert.ok(Array.isArray(code.alert.payload.blocks));
  assert.equal(code.log.datadogEnabled, false);
  assert.equal(code.recovery.updatePath, '/crm/v3/objects/deals/9001');
  assert.equal(code.recovery.task.associations[0].types[0].associationTypeId, 216);
  assert.equal(net.recovery.action, 'RETRY');
  assert.ok(net.recovery.delaySeconds >= 60);
});

test('Dry-Run Telemetry and Console Logger', async () => {
  const parsed = await runCodeNode('Normalize & Parse Errors', [webhookItem({ errors: [FX.rate_limit, FX.type_error] })], {});
  const events = parsed.output.map((i) => i.json);
  const dry = await runCodeNode('Dry-Run Telemetry', events);
  assert.equal(dry.output[0].json.totals.events, 2);
  assert.ok(dry.logs.some((l) => l.includes('DRY RUN')));
  const cons = await runCodeNode('Console Logger', events);
  assert.equal(cons.output.length, 2);
  assert.equal(JSON.parse(cons.logs[0]).msg, 'hubspot_custom_code_error');
});

// ---------------------------------------------------------------------------
// 3. Security scan
// ---------------------------------------------------------------------------

test('security scan: no live tokens, webhook URLs, keys, portal IDs in credentials or real email addresses', () => {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (['node_modules', '.git', 'coverage'].includes(e.name)) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|json|md|yml|yaml|txt)$|^\.env\.example$|^\.gitignore$|^LICENSE$/.test(e.name)) files.push(full);
    });
  })(ROOT);
  assert.ok(files.length >= 12, `expected repository files, found ${files.length}`);
  const forbidden = [
    ['HubSpot private app token', /pat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}-/i],
    ['HubSpot legacy API key', /hapikey=[0-9a-f-]{20,}/i],
    ['Slack token', /xox[abposr]-\d{6,}-/],
    ['Slack incoming webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{12,}/],
    ['Datadog API key assignment', /(?:DD_API_KEY|DATADOG_API_KEY|DD-API-KEY)["'\s:=]+[0-9a-f]{32}/i],
    ['Bearer token', /Bearer\s+[A-Za-z0-9._-]{30,}/],
    ['AWS access key', /AKIA[0-9A-Z]{16}/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  const allowedEmail = /@([a-z0-9-]+\.)*(example\.(?:com|org|net)|[a-z0-9-]+\.example)$/i;
  files.forEach((file) => {
    if (file === __filename) return;
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    forbidden.forEach(([label, re]) => assert.ok(!re.test(text), `${label} found in ${rel}`));
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach((a) => assert.match(a, allowedEmail, `email ${a} in ${rel}`));
  });
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  ['SLACK_WEBHOOK_URL', 'ERROR_WEBHOOK_SECRET'].forEach((k) => assert.match(env, new RegExp(`^${k}=REPLACE_WITH_`, 'm'), `${k} must be a placeholder`));
});
