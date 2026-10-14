# AI pipeline

`AIAnalysisProvider` supports MockAIProvider (demo default), OpenAIAIProvider, and Gemini conversation reports using the stable `gemini-3.5-flash-lite` model by default. The Gemini API key stays on the backend.

Conversation reports are generated from the ordered transcript, saved in `ai_processing_runs`, and include a summary, needs, sentiment, products, opportunity assessment, evidence, and follow-up recommendation. If a recording has no transcript, the report endpoint first tries local Whisper on retained audio. Speaker attribution is never inferred.

Set `AI_PROVIDER=gemini` and `GEMINI_API_KEY` in the backend environment to enable reports. `GEMINI_MODEL` can override the default. Google AI Studio currently offers a free tier, subject to model and rate limits; free-tier content may be used to improve Google products. Transcript text is sent to Google only after an operator requests report generation. Review Google’s current terms and your organization’s data policy before enabling it.

Existing per-utterance mock/OpenAI coaching remains separate from full conversation reports.
