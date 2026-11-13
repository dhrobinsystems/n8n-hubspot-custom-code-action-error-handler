# ⚠️ Disclaimer & Liability Limitation

Use at your own risk. The code, workflows, and scripts provided in this repository (`n8n-hubspot-custom-code-action-error-handler`) are for educational and architectural demonstration purposes.

- **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts.
- **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
- **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` enabled before connecting live HubSpot credentials.
- **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), anti-spam laws (e.g. CAN-SPAM, CASL, PECR), and security policies of HubSpot, Slack, Datadog and any connected services, including reviewing every automated retry, record update, task and workflow re-enrollment.

## Operational risks

### CRM automation

- **Retries re-run business logic.** A retry sets a record property that re-enrols the record in a HubSpot workflow. If the custom code action is not idempotent (for example it creates records, sends messages or calls external systems), a retry can create duplicates or repeat side effects. Design every retried action to be safe to run more than once.
- **Re-enrolment scope.** HubSpot re-enrolment runs the workflow from its first action. If a workflow contains other actions (emails, sequence enrolments, owner rotation), a retry can repeat them. Use a dedicated retry workflow or branch.
- **Property writes.** In live mode the handler writes `cca_*` properties on the failed record and can create tasks. A misconfigured object type, association type or property can produce incorrect or excessive writes.

### Webhook integrations

- **Delivery is not guaranteed.** Error reports are sent over HTTPS with a short timeout. Network failures, n8n downtime or payload limits can lose reports. Keep HubSpot's own workflow history and action logs as the source of truth.
- **Authentication.** The inbound webhook is protected only by the shared `ERROR_WEBHOOK_SECRET`. Rotate it if exposed, serve n8n over HTTPS, and restrict who can view n8n executions.
- **Rate limits.** Bursts of failures can trigger Slack, Datadog or HubSpot rate limits. Alert de-duplication and retry backoff reduce, but do not eliminate, this risk.

### Custom code execution

- **Stack traces and messages may contain sensitive data.** The parser redacts common secrets and email addresses, but cannot recognise every form of personal or confidential data. Review what your custom code puts into error messages.
- **Classification is heuristic.** Error types, severities and retry decisions are based on status codes, error names and message patterns. Misclassification can cause unnecessary retries or missed recoveries.
- **Execution limits.** HubSpot custom code actions have runtime and memory limits. Reporting an error uses part of that budget; the wrapper limits it with a short timeout, but cannot guarantee the report completes.

## User responsibility

By deploying this framework, the user (and the organisation they represent) accepts **sole responsibility** for:

- **Compliance:** lawful processing of CRM data and any personal data in error payloads under applicable law (including GDPR, UK GDPR and CCPA/CPRA), customer contracts, internal policies, and the terms of service of HubSpot, Slack, Datadog and n8n, including data residency and retention in each tool.
- **Data integrity:** designing idempotent custom code, validating retry and fallback behaviour in a sandbox portal, maintaining backups, and reviewing records flagged for fallback.
- **Security:** storing credentials only in the n8n credential store, HubSpot custom code secrets or a secret manager; limiting access to Slack channels, Datadog indexes and n8n execution data; and rotating secrets when people leave.
- **Monitoring:** watching the handler itself (n8n Error Workflow, execution history) so that failures in the error handler do not go unnoticed.

## Liability limitation

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. THE USER ASSUMES FULL RESPONSIBILITY FOR CRM DATA INTEGRITY, BACKUPS, API RATE LIMITS, RETRY SIDE EFFECTS, AND COMPLIANCE WITH THIRD-PARTY TERMS OF SERVICE AND DATA-PROTECTION LAW WHEN EXECUTING AUTOMATED WORKFLOWS IN PRODUCTION ENVIRONMENTS.

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).
