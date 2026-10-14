# Architecture Decisions

## 1. Monorepo structure

We use a monorepo to allow the platform, edge agent, and shared contracts to evolve independently while remaining easy to run locally.

## 2. Production vs demo mode

All environments use MongoDB Atlas for application persistence. Local development runs the FastAPI service and Next.js dashboard directly, with mock AI, speech, and POS providers; there is no local SQL fallback or container stack.

## 3. Provider abstraction

AI, speech, and POS services are abstracted behind provider interfaces. This allows the platform to support Grok/OpenAI/Whisper/Square/etc. without hardcoding vendor-specific implementations.

## 4. Demo-first workflow

The application ships with realistic seeded data and a live demo stream that mimics speech, translation, AI insights, sales tips, missed opportunities, and POS correlation. This satisfies the requirement to demo the complete product locally without real infrastructure.

## 5. Security stance

The product is designed around device-specific credentials, short-lived tokens, audit logging, and environment-based secrets. It does not claim formal compliance certification without an actual audit and legal review.

## 6. Decision on audio retention

Raw audio is not retained permanently by default. The default policy is short retention, with storage and deletion configuration driven by environment settings and legal review.

## 7. Unknowns and open questions

The architecture intentionally treats POS vendor, device hardware, voice recording legality, and retention policies as configuration and review items. Those are documented in documentation files rather than assumed.
