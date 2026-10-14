# Store Listen Architecture

## Overview

Store Listen is a retail intelligence platform that captures in-store conversations, understands customer intent, correlates outcomes with POS data, and surfaces actionable alerts and reports. The system is designed around a modular architecture that supports live monitoring, demo mode, provider abstraction, and future production integrations.

## Key principles

- Build a real-time conversational intelligence platform, not a static dashboard.
- Keep AI, speech, and POS integrations behind interfaces.
- Prioritize secure device registration and short-lived tokens.
- Support both production-grade and demo-first operation.
- Separate the marketing website from the product application.

## System context

- Store agents capture audio and health telemetry.
- The backend ingests streaming audio, transcript events, and device states.
- AI processing interprets intent, sales opportunities, and missed opportunities.
- POS correlation compares conversation outcomes to transaction events.
- The web dashboard exposes live monitoring, dashboards, reports, and settings.

## Repository structure

- backend: FastAPI backend
- frontend: Vite-built React single-page application with lazy route chunks
- backend/store-agent: edge/Store agent service
- packages/event-contracts: typed event definitions
- docs: architecture, security, privacy, setup, etc.
- infrastructure: deployment, Helm, IaC placeholders
- scripts: maintenance and seeding scripts

## Runtime architecture

1. Audio source adapter
2. Store edge agent
3. Secure streaming and auth
4. FastAPI ingestion and event processing
5. AI analysis and sales recommendation pipeline
6. POS matching and correlation
7. MongoDB Atlas persistence with optional Redis event fanout
8. WebSocket dashboard updates
9. Vite-built React operations UI with route-level code splitting

## AI and speech provider abstraction

We deliberately avoid hard-coding a vendor. Providers are selected through environment configuration.

Supported examples:
- AI_PROVIDER=mock | grok | openai | gemini
- Gemini conversation reports use GEMINI_API_KEY and default to gemini-3.5-flash-lite.
- SPEECH_PROVIDER=mock | whisper | cloud
- POS_PROVIDER=mock | square | clover

## Security model

- Device-specific credentials only
- JWT/session tokens with expiration
- RBAC for store access
- Audit logging for device and user actions
- Secrets in environment variables only

## Known assumptions

- The client has not confirmed a POS vendor yet.
- The exact audio hardware and recording legality are not yet confirmed.
- Grok vs. other AI provider remains a configuration question.

## Open blockers

- POS API documentation
- Store device inventory and OS details
- Legal review for recording and retention

## Deliverables in this implementation

- Full monorepo scaffold
- Demo-capable backend and dashboard
- WebSocket event system
- Seeded store and conversation data
- Mock AI, speech, and POS providers
- Documentation and configuration templates
