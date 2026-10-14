# Speech pipeline

`SpeechProvider` → MockSpeechProvider, WhisperSpeechProvider, CloudSpeechProvider (currently unconfigured).

Transcript segments always keep `original_text` and `translated_text`. English display uses translation for Spanish, identity for English.

## Desktop latency

The web monitor and desktop agent run local Web Audio voice-activity detection. The gate starts after two voiced frames, ends after five quiet frames (about 80-100 ms at a typical display cadence), and keeps active utterances in clips up to 5 seconds. During a phrase, the clients submit a local Whisper preview about every 900 ms and publish `transcript.partial`; the final clip is still submitted once for storage and the permanent transcript. Preview audio is not saved. This produces provisional phrase updates, not a dedicated streaming ASR model or guaranteed one-word-at-a-time output. The backend runs faster-whisper on CPU by default (`WHISPER_MODEL=tiny`, `WHISPER_COMPUTE_TYPE=int8`) with greedy beam size 1. `/api/v1/audio/transcribe` returns `transcription_ms`; it measures model processing, not collection, upload, or total speak-to-screen latency.

`WHISPER_TRANSLATE_SPANISH=false` avoids a second full model pass, so Spanish is shown in its detected original text without an English translation. Set it to `true` to enable translation at additional CPU and latency cost. `WHISPER_MODEL=base` or `small` improves accuracy with additional compute. Transcription stays on the configured backend and supports English, Spanish, Hindi, and Urdu. Rolling Whisper previews repeat inference over the current short phrase; if preview inference runs slower than speech, later updates wait until the in-flight preview finishes.
