# Privacy and Compliance

This project intentionally does not assume that recording is legal in all jurisdictions. Uploaded microphone clips are stored on the backend's configured local audio directory, served only through authenticated store-scoped endpoints, and deleted with their metadata at API startup after `AUDIO_RETENTION_DAYS` (7 days by default). Transcripts have a separate configured retention period. This is a technical default, not a legal determination that the retention duration is appropriate.

Important production considerations:
- state and federal recording law review
- employee and customer notification requirements
- short configurable raw-audio retention
- access control and audit logging
- future PII redaction support

Raw audio is retained temporarily to support playback and review; it is not retained permanently by default. Production object storage, scheduled deletion monitoring, encryption-at-rest policy, customer/employee notice, and jurisdiction-specific retention requirements still require client and legal review.
