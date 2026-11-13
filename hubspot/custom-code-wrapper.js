/**
 * hubspot/custom-code-wrapper.js
 * ---------------------------------------------------------------------------
 * Paste this into a HubSpot workflow "Custom code" action (Node.js runtime) and
 * put your own logic inside runAction(). Any error thrown by runAction() is
 * reported to the n8n error handler, then re-thrown so HubSpot still marks the
 * action as failed and applies its own error handling.
 *
 * HubSpot setup for this action:
 *   Secrets (Custom code → Secrets):
 *     N8N_ERROR_WEBHOOK_URL     = REPLACE_WITH_N8N_ERROR_WEBHOOK_URL
 *                                 (e.g. https://n8n.example.com/webhook/hubspot/custom-code-errors)
 *     N8N_ERROR_WEBHOOK_SECRET  = REPLACE_WITH_ERROR_WEBHOOK_SECRET   (same value as ERROR_WEBHOOK_SECRET in n8n)
 *     HUBSPOT_PAT               = REPLACE_WITH_HUBSPOT_PAT            (only if runAction() calls HubSpot APIs)
 *   Property to include in code (inputFields):
 *     cca_retry_count           (number property created on the object; see README)
 *
 * Set WORKFLOW_ID / WORKFLOW_NAME / ACTION_NAME below so alerts say exactly
 * which workflow and step failed (HubSpot does not pass the workflow ID to code).
 *
 * Never put secrets in this file: always read them from process.env.
 *
 * DISCLAIMER: provided "AS IS", without warranty of any kind. Test in a HubSpot
 * sandbox before production use. See DISCLAIMER.md.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');

// --- Identify this action in alerts (edit these) ----------------------------
const WORKFLOW_ID = 'REPLACE_WITH_WORKFLOW_ID';
const WORKFLOW_NAME = 'REPLACE_WITH_WORKFLOW_NAME';
const ACTION_NAME = 'REPLACE_WITH_ACTION_NAME';

// Keep the report fast: HubSpot custom code actions have a short execution time limit.
const REPORT_TIMEOUT_MS = 3000;

/**
 * Your business logic. Return the outputFields object for HubSpot.
 * Throw (or let errors propagate) on failure: the wrapper reports and re-throws.
 */
async function runAction(event) {
  // Example only: replace with your own logic.
  const objectId = event.object.objectId;
  if (!objectId) throw new Error('Missing object ID in event');
  return { cca_status: 'SUCCESS' };
}

/** Send a sanitized error report to n8n. Never throws. */
async function reportError(error, event) {
  const url = process.env.N8N_ERROR_WEBHOOK_URL;
  const secret = process.env.N8N_ERROR_WEBHOOK_SECRET;
  if (!url || !secret) {
    console.error('Error reporter not configured: set N8N_ERROR_WEBHOOK_URL and N8N_ERROR_WEBHOOK_SECRET secrets.');
    return;
  }
  const response = error && error.response ? error.response : null;
  const payload = {
    source: 'hubspot-custom-code',
    portalId: event.origin && event.origin.portalId,
    workflowId: WORKFLOW_ID,
    workflowName: WORKFLOW_NAME,
    actionName: ACTION_NAME,
    actionId: event.origin && event.origin.actionDefinitionId,
    callbackId: event.callbackId,
    object: { objectType: event.object && event.object.objectType, objectId: event.object && event.object.objectId },
    attempt: Number((event.inputFields || {}).cca_retry_count || 0),
    occurredAt: new Date().toISOString(),
    // Only the NAMES of input fields are sent, never their values.
    inputFields: Object.fromEntries(Object.keys(event.inputFields || {}).map((k) => [k, '[omitted]'])),
    error: {
      name: error && error.name,
      message: error && error.message,
      stack: error && error.stack,
      code: error && error.code,
      statusCode: response ? response.status : undefined,
      // HubSpot API error bodies contain category / correlationId; keep them for diagnosis.
      response: response ? { status: response.status, data: response.data } : undefined,
    },
  };
  try {
    await axios.post(url, payload, {
      timeout: REPORT_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'x-hs-error-secret': secret },
    });
  } catch (reportFailure) {
    console.error('Could not report error to n8n:', reportFailure.message);
  }
}

exports.main = async (event, callback) => {
  try {
    const outputFields = await runAction(event);
    callback({ outputFields: outputFields || {} });
  } catch (error) {
    await reportError(error, event);
    throw error; // keep HubSpot's own failure handling and execution history
  }
};
