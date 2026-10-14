# MASTER ENGINEERING PROMPT
## Transform Existing Desktop Software into a Secure, Cloud-Connected, Multi-Store Production System

### 1. ROLE AND EXPECTATIONS

Act as a Senior Software Architect, Senior Full-Stack Engineer, Desktop Application Engineer, Cloud Infrastructure Engineer, Database Architect, DevOps Engineer, and Application Security Engineer.

You are working inside my EXISTING software project. Your responsibility is to inspect the complete codebase, understand its architecture, and implement the necessary changes directly in the existing project.

Do not treat this as a greenfield project. Do not replace the application with a newly generated demo or unrelated starter template.

Your objective is to convert my existing desktop application and dashboard into a secure, production-ready, centrally connected system that supports clients and stores operating in different countries, including the United States.

Work autonomously wherever the repository provides enough information. Ask questions only when an essential requirement cannot be established from the codebase or configuration.

Do not stop after giving me a plan, writing documentation, or generating example snippets. Implement the changes, run available tests, fix discovered issues, and document anything that genuinely requires external credentials or manual deployment.

---

### 2. PRIMARY BUSINESS REQUIREMENT

My software already exists and must continue to provide its existing business functionality.

I need the following deployment experience:

1. I build and release a Windows desktop installer or executable package.
2. I provide that package to a client in the United States.
3. The client installs the application on the PC in their store.
4. The client should not need to install Python, Node.js, a separate backend, a database server, or developer tools.
5. The client should not need to edit source code, configure API URLs, manually start backend services, or perform technical networking steps.
6. The application should connect automatically after installation, subject to a secure first-time authentication or activation process.
7. The application should reconnect automatically after closing and reopening, restarting Windows, or experiencing a temporary internet interruption.
8. The client's business data should be saved in a central cloud database rather than depending exclusively on a database file on the client's PC.
9. My existing dashboard should receive authorized client/store activity and updates in near real time.
10. The dashboard may run on my own PC in Pakistan, but it must connect to a stable central backend rather than depending on a backend process that exists only on my PC.
11. Client PCs must never require access to the source code of the desktop application, backend, or dashboard.
12. The system must support multiple authorized client PCs and multiple stores without mixing their data.

The finished product must be installable, secure, maintainable, and suitable for real customer use.

---

### 3. PHASE ONE: DEEPLY AUDIT THE EXISTING REPOSITORY

Before modifying files, inspect the entire repository.

Identify:

- Desktop application entry points and framework.
- Frontend framework and build tools.
- Backend framework, entry points, and startup procedures.
- Existing API endpoints and request/response contracts.
- Current database technology, models, schemas, migrations, and relationships.
- Authentication, authorization, sessions, and user roles.
- Existing dashboard architecture and data-fetching logic.
- Existing WebSocket, polling, event, or real-time mechanisms.
- Configuration files, environment variables, hardcoded URLs, and credentials.
- Build scripts, packaging configuration, installers, and executable generation.
- Logging, error handling, retry logic, and offline behavior.
- Existing tests and CI configuration.
- Dependencies, version constraints, and known compatibility risks.

Search for every location where the application assumes that:

- The backend is running on localhost.
- The database exists on the developer's computer.
- A fixed local port is available.
- An API URL is hardcoded.
- A backend process must be manually started.
- Local filesystem paths are required for business data.
- Dashboard data is available only within the local machine.

Trace the complete flow of a representative business operation from the desktop UI to the database and then to the dashboard.

Create a concise internal implementation checklist based on actual findings.

Do not guess the stack. Discover it from the repository.

Do not delete, rewrite, or replace working business logic merely to simplify deployment.

Before risky changes, preserve existing behavior and follow the repository's version-control conventions. Never overwrite user data or production databases.

---

### 4. PHASE TWO: DESIGN THE CORRECT PRODUCTION ARCHITECTURE

Use this target architecture unless repository constraints justify a documented alternative:

Windows Desktop Client
→ HTTPS REST API and/or secure WebSocket
→ Central Cloud Backend
→ Managed Cloud Database

The existing dashboard should connect to the same authenticated cloud backend.

The desktop application and dashboard must not communicate by directly reading each other's local files.

The cloud backend must remain available when my personal computer is turned off.

Do not assume Tailscale is a cloud hosting platform. It is a private networking tool, not a replacement for an application backend or managed database.

#### Networking decision

Evaluate these deployment options:

A. Publicly reachable HTTPS backend with strong authentication and restricted database access.

B. Private Tailscale networking between explicitly authorized devices and a continuously running server.

C. A hybrid architecture with public HTTPS application endpoints and Tailscale reserved for private administration, internal services, or explicitly authorized private communication.

Choose the approach that best satisfies zero-manual-configuration client deployment, reliable connectivity, and security.

For a client who should only install the application and sign in, prefer a secure HTTPS API architecture unless there is a specific requirement that justifies installing and enrolling a Tailscale client on every PC.

If Tailscale is required on client machines, implement a documented device-enrollment and authorization process. Never assume that embedding a Tailscale authentication key or reusing an administrator's credentials inside the desktop executable is safe.

Do not expose a private database directly to the public internet.

---

### 5. PHASE THREE: CLOUD BACKEND

Adapt the existing backend rather than creating a second competing backend.

Implement or improve:

- Production configuration through environment variables and secret management.
- Stable API endpoints with appropriate versioning where useful.
- Central authentication and authorization.
- Client, organization, store, and device identification as appropriate to the existing business model.
- Input validation and safe error responses.
- Database transaction handling.
- Connection pooling and resource cleanup.
- Request timeouts and sensible limits.
- Structured logging with sensitive information redacted.
- Health and readiness endpoints.
- Database migration support.
- Graceful shutdown.
- CORS configuration restricted to the actual dashboard origins where applicable.
- Rate limiting and abuse protection.
- Secure password handling and session/token management.
- Authorization checks on every sensitive operation.
- Idempotency for retryable operations where duplicate execution would cause harm.

Never trust a store ID, organization ID, role, or user ID merely because the desktop application sends it. Verify that the authenticated principal has permission to access that resource.

Do not expose internal stack traces, SQL details, secrets, or environment configuration to clients.

Preserve existing API contracts where practical. If an API contract must change, update all callers and tests together.

---

### 6. PHASE FOUR: CLOUD DATABASE MIGRATION

Inspect the current database before choosing a migration strategy.

If the existing database is SQLite or another local database, evaluate migration to managed PostgreSQL as the default relational database option, unless the existing architecture strongly favors another suitable managed database.

Do not assume a database migration is complete simply because a connection string has been changed.

Implement:

- A production database configuration.
- Schema migrations.
- Correct primary keys, foreign keys, indexes, and constraints.
- Appropriate transaction isolation and consistency.
- Connection pooling.
- Database backups and a documented restore procedure.
- Migration validation.
- A safe development/test database configuration.
- Data retention and deletion procedures appropriate to the application.
- UTC timestamps and consistent timezone handling.

For multiple stores and clients, establish explicit organization/store ownership and enforce isolation at the backend layer. Where appropriate, evaluate PostgreSQL row-level security as an additional defense.

Never place database administrator credentials in the desktop application.

Never allow a client to connect directly to the database using embedded credentials.

#### Existing data preservation

If local business data already exists:

1. Determine whether it must be migrated.
2. Create a backup before migration.
3. Build an explicit, repeatable migration/import process.
4. Validate record counts and important business totals.
5. Detect duplicates and partial imports.
6. Make retries safe.
7. Do not delete or overwrite the original data until the migration has been verified and approved.

Do not invent records or silently discard incompatible fields.

---

### 7. PHASE FIVE: DESKTOP APPLICATION AUTO-CONNECTION

Modify the existing desktop application to use the production backend without exposing backend implementation details.

Requirements:

- Bundle required runtime dependencies into the application package when appropriate.
- Load non-secret configuration from a managed configuration file or approved deployment configuration.
- Never hardcode production credentials into source code or the executable.
- Use a stable HTTPS base URL supplied through a secure release configuration or controlled configuration mechanism.
- Use the operating system's secure credential storage when persistent credentials are necessary.
- Implement login, activation, or another secure initial authorization flow.
- Persist only the minimum necessary authentication state.
- Refresh or renew credentials safely.
- Handle expired sessions.
- Revoke access when a device or user is deauthorized.
- Automatically reconnect after transient failures.
- Use exponential backoff with jitter to avoid aggressive retry loops.
- Apply connection and request timeouts.
- Provide meaningful connection status in the UI.
- Distinguish authentication failures, network failures, server failures, and validation errors.
- Prevent duplicate requests when retrying operations.
- Never freeze the UI while waiting for network requests.

Do not display confusing stack traces or raw API errors to end users.

#### Offline behavior

Determine which existing features can safely operate offline.

If offline functionality is required, implement a deliberate local cache or durable queue with:

- Unique operation IDs.
- Safe retries.
- Duplicate detection.
- Explicit conflict-resolution rules.
- Clear pending/synchronized status.
- A defined retention policy.

Do not claim that every operation is offline-capable unless it has actually been implemented and tested.

For business-critical transactions, explain what happens if the network disconnects before confirmation is received.

---

### 8. PHASE SIX: REAL-TIME DASHBOARD SYNCHRONIZATION

Inspect the existing dashboard and reuse its current framework and UI wherever possible.

The desktop application and dashboard must use the same authoritative backend and database.

Implement the most appropriate real-time mechanism, such as authenticated WebSockets or server-sent events, based on the existing stack.

Required behavior:

- A desktop event is persisted by the backend.
- The backend publishes an authorized event after the relevant transaction succeeds.
- Connected dashboard sessions receive the update.
- The dashboard updates relevant views without requiring a full page refresh.
- Reconnecting clients can recover missed updates using a suitable resynchronization strategy.
- Events are scoped to the authorized organization, store, and user.
- Duplicate events do not cause duplicate business records.
- The UI indicates connection state and the time of the last successful synchronization.

Use database-backed event delivery, an outbox pattern, or another suitable mechanism if required to avoid losing events between a database commit and event publication.

Do not treat an unverified client-side event as proof that a business transaction succeeded.

If the dashboard is running on my PC in Pakistan, it must connect outward to the cloud backend using an authenticated connection. Do not require inbound port forwarding to my home network unless a separately justified architecture requires it.

The dashboard should recover after my PC restarts or the internet connection returns.

---

### 9. PHASE SEVEN: WINDOWS EXECUTABLE AND INSTALLER

Inspect the current desktop framework and choose a compatible packaging tool.

Generate a production installer or distributable package that:

- Includes the required application runtime and dependencies.
- Does not include backend source code or dashboard source code.
- Does not require a separate Python or Node.js installation unless technically unavoidable and explicitly documented.
- Uses stable installation paths.
- Supports clean installation and application upgrades.
- Handles configuration and user data without destructive overwrites.
- Creates shortcuts where appropriate.
- Supports clean uninstall behavior.
- Preserves business data when uninstalling unless the user explicitly chooses to delete it.
- Includes useful startup and diagnostic logging.
- Handles missing permissions and unavailable network access gracefully.
- Uses a consistent application version.
- Supports code signing when a valid signing certificate is available.

If the application requires background startup or a Windows service, implement it only when justified by the existing requirements and with appropriate user consent and permissions.

Do not silently install network drivers, VPN clients, system services, or privileged components.

Produce reproducible build instructions and document any signing certificate or external build dependency that is unavailable.

---

### 10. PHASE EIGHT: CLOUD DEPLOYMENT AND ENVIRONMENT CONFIGURATION

Select a suitable deployment platform based on the discovered stack, expected workload, availability requirements, and cost constraints.

Do not deploy anything or incur paid charges without the necessary authorization.

Provide:

- Production environment configuration.
- Staging/test environment configuration.
- Database provisioning instructions.
- Secret-management instructions.
- Database migration commands.
- Backend deployment configuration.
- HTTPS and domain configuration requirements.
- Health checks.
- Logs and basic monitoring.
- Backup and restore instructions.
- Deployment and rollback procedures.
- A secure method to configure the desktop release with the correct backend endpoint.

Prefer managed database services where appropriate.

The deployment must not depend on my development PC remaining online.

Never commit `.env` files containing real secrets, database passwords, API keys, private certificates, or Tailscale authentication keys.

Create an `.env.example` containing placeholder values only.

If credentials, DNS changes, cloud accounts, or external authorization are missing, implement all code and configuration that can safely be completed, then provide precise instructions for the remaining external steps. Do not fabricate a successful deployment.

---

### 11. PHASE NINE: SECURITY HARDENING

Perform a security review covering:

- Authentication and authorization.
- Tenant/store data isolation.
- Password hashing and credential storage.
- Session expiration and revocation.
- TLS/HTTPS.
- Secrets management.
- SQL injection and unsafe input handling.
- Cross-site scripting and CSRF where relevant.
- CORS and origin restrictions.
- Rate limiting.
- Audit logging.
- Dependency vulnerabilities.
- Database permissions.
- Backup security.
- WebSocket authorization.
- Device activation and deactivation.
- Sensitive data in logs.
- Protection against unauthorized access to another store's data.

Use least-privilege credentials.

If the application contains financial, employee, customer, or other sensitive business information, minimize what is collected and transmitted, and document appropriate retention and access controls.

Do not implement a hidden backdoor or a mechanism that bypasses client authorization.

Do not put privileged API keys or shared administrator tokens into a distributed executable.

---

### 12. PHASE TEN: AUTOMATED TESTING

Create or update tests for the existing stack.

At minimum, cover:

1. Existing business functionality and regression behavior.
2. Backend startup and health checks.
3. Database connection and migrations.
4. Authentication and session expiration.
5. Authorization failures.
6. Cross-store and cross-tenant data isolation.
7. Desktop startup without a locally installed backend.
8. Successful API connection to a configured test server.
9. Temporary network failure and automatic reconnection.
10. Duplicate request handling.
11. Real-time event delivery.
12. Dashboard reconnection and data resynchronization.
13. Installation and upgrade behavior where testable.
14. Missing configuration and invalid credentials.
15. Backup/migration validation where applicable.

Use mocks or isolated test infrastructure for external services when appropriate.

Never run destructive tests against a production database.

Run the existing test suite first when feasible, then run relevant tests after each major change.

Do not report a test as passing unless it was actually executed and its result verified.

---

### 13. PHASE ELEVEN: DOCUMENTATION AND DELIVERY

Update the repository documentation with:

- Architecture overview.
- Component responsibilities.
- Required environment variables.
- Development startup instructions.
- Database setup and migrations.
- Cloud deployment instructions.
- Authentication and client activation workflow.
- Desktop installer build instructions.
- Release and upgrade procedure.
- Tailscale configuration, only if selected.
- Troubleshooting instructions.
- Backup and restore procedure.
- Security considerations.
- Known limitations.

Create an implementation summary that identifies:

- Files created.
- Files modified.
- Important architectural decisions.
- Database schema changes.
- APIs added or modified.
- Security improvements.
- Tests executed and their actual results.
- Build artifacts actually generated.
- External services that still require credentials or manual provisioning.
- Remaining risks and unresolved blockers.

---

### 14. NON-NEGOTIABLE ENGINEERING RULES

- Work within the existing project.
- Preserve existing features and business logic.
- Do not rebuild the project unnecessarily.
- Do not replace the existing UI without a strong technical reason.
- Do not hardcode localhost URLs into production releases.
- Do not expose database credentials to the desktop client.
- Do not require the client to run a separate backend.
- Do not assume Tailscale replaces backend hosting or database hosting.
- Do not promise zero-configuration networking if device enrollment is still required.
- Do not invent API endpoints, environment variables, framework details, or successful test results.
- Do not silently discard existing data.
- Do not leave critical paths implemented only as TODO comments or mock functions.
- Do not claim real-time functionality works until the relevant flow has been tested.
- Do not claim an installer is production-ready merely because a development executable launches.
- Do not make destructive migrations or production changes without appropriate safeguards and authorization.
- Prefer small, reviewable changes and verify each stage.
- If a requirement conflicts with the current architecture, explain the conflict and implement the safest compatible solution.

### 15. EXECUTION INSTRUCTIONS

Start by inspecting the repository and identifying its actual technology stack.

Then proceed in this order:

1. Audit the current codebase and existing behavior.
2. Establish the target architecture.
3. Implement the backend and database changes.
4. Implement secure desktop connectivity.
5. Implement real-time dashboard synchronization.
6. Implement cloud deployment configuration.
7. Implement Windows packaging and installer changes.
8. Add and run automated tests.
9. Update documentation.
10. Produce a final implementation report.

Do not stop after step 1 or return only a proposed plan. Continue implementing the work that can safely be completed in the available environment.

When blocked by an external dependency, finish the independent work, clearly identify the blocker, and provide the exact action required to resolve it.

The final objective is a reliable, secure, maintainable production system in which an authorized US client can install the desktop software, complete a secure first-time activation, and use it without manually installing or starting a backend or database. The application should reconnect automatically, synchronize data with the central cloud backend, and update my authorized dashboard in near real time.