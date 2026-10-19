from app.providers.speech_quality import (
    filter_whisper_segments,
    detect_transcript_language,
    english_display_text,
    is_hallucinated_transcript,
    is_recent_duplicate,
    is_usable_english_translation,
    looks_like_spanish,
    normalize_language,
    polish_spanish_translation,
)


def test_rejects_thank_you_spam():
    assert is_hallucinated_transcript("Thank you. Thank you. Thank you.")
    assert is_hallucinated_transcript("thank you")
    assert is_hallucinated_transcript("Thanks for watching!")
    assert is_hallucinated_transcript("Transcribe only clear spoken English or Spanish words")
    assert not is_hallucinated_transcript("Do you have an iPhone charger?")
    assert not is_hallucinated_transcript("Hola, necesito un cargador para mi telefono")


def test_rejects_portuguese_and_random_single_words():
    assert is_hallucinated_transcript("Tchau")
    assert is_hallucinated_transcript("Obrigado")
    assert is_hallucinated_transcript("tchau tchau")
    assert is_hallucinated_transcript("E aí")
    assert is_hallucinated_transcript("E ai")
    assert not is_hallucinated_transcript("Gracias")
    assert not is_hallucinated_transcript("¡Adiós!")
    assert not is_hallucinated_transcript("Price")
    assert not is_hallucinated_transcript("Phone")


def test_spanish_short_translation_is_stable():
    assert polish_spanish_translation("Gracias", "Is that the one?") == "Thank you"
    assert polish_spanish_translation("¡Adiós!", "See you later my friend how are you") == "Goodbye"


def test_recent_duplicate_window():
    assert is_recent_duplicate("conv-test-a", "Tchau") is False
    assert is_recent_duplicate("conv-test-a", "Tchau") is True
    assert is_recent_duplicate("conv-test-a", "Gracias") is False


def test_normalize_language_en_es_only():
    assert normalize_language("en-US") == "en"
    assert normalize_language("es") == "es"
    assert normalize_language("hi") is None


def test_spanish_heuristic():
    assert looks_like_spanish("Hola, necesito un cargador")
    assert looks_like_spanish("Gracias")
    assert looks_like_spanish("¡Adiós!")
    assert not looks_like_spanish("I need a phone charger please")


def test_rejects_filler_and_keeps_store_phrases():
    assert is_hallucinated_transcript("Ciao")
    assert is_hallucinated_transcript("ok")
    assert is_hallucinated_transcript("mmm")
    assert is_hallucinated_transcript("Terima kasih telah menonton!")
    assert not is_hallucinated_transcript("Necesito un cargador para iPhone")
    assert not is_hallucinated_transcript("How much is this cable?")


def test_usable_english_translation_rejects_spanish_echo():
    assert is_usable_english_translation(
        "Señor, tenemos este producto",
        "Sir, we have this product",
    )
    assert not is_usable_english_translation(
        "Señor, tenemos este producto",
        "Señor, tenemos este producto",
    )
    assert polish_spanish_translation("Gracias", "Gracias") == "Thank you"


def test_non_english_translation_rejects_foreign_echo_and_requires_english():
    assert is_usable_english_translation("Bonjour", "Hello", "fr")
    assert not is_usable_english_translation("Bonjour", "Bonjour", "fr")
    assert not is_usable_english_translation("Bonjour", "Je voudrais un telephone", "fr")
    assert not is_usable_english_translation("नमस्ते", "नमस्ते", "hi")
    assert is_usable_english_translation("Hola", "Hello", "es")
    assert english_display_text("Hello there", "Hello there", "en") == "Hello there"
    assert english_display_text("Bonjour", "", "fr") == "English translation pending"


def test_detects_source_language_when_transcription_provider_omits_it():
    assert detect_transcript_language("I need help") == "en"
    assert detect_transcript_language("Hello friend") == "en"
    assert detect_transcript_language("Bonjour") == "fr"
    assert detect_transcript_language("Hola, necesito un cargador") == "es"
    assert detect_transcript_language("Je voudrais un téléphone, s'il vous plaît", "en") == "fr"
    assert detect_transcript_language("नमस्ते, मुझे फ़ोन चार्जर चाहिए", "en") == "hi"


def test_detects_spanish_inside_mixed_transcript_even_when_provider_says_english():
    mixed = (
        "What is the accent of Barcelona in Spanish? I think it is more open. "
        "Yo me acuerdo que fui un dia a Madrid con amigas, que era con el core, "
        "y nos dijeron, eran bien los clientes de Madrid."
    )
    english = "I remember going to Madrid with friends; the customers there were very kind."

    assert detect_transcript_language(mixed, "en") == "es"
    assert english_display_text(mixed, english, "en") == english


def test_untranslated_foreign_text_never_uses_the_old_unavailable_sentinel():
    assert english_display_text("Hola, necesito un cargador", "", "es") == "English translation pending"


def test_whisper_segments_marked_as_silence_are_dropped():
    segments = [
        {"text": " Hello, do you have chargers?", "no_speech_prob": 0.02, "avg_logprob": -0.2, "compression_ratio": 1.2},
        {"text": " Thanks for watching", "no_speech_prob": 0.93, "avg_logprob": -0.4, "compression_ratio": 1.1},
        {"text": " you you you you", "no_speech_prob": 0.7, "avg_logprob": -1.4, "compression_ratio": 1.0},
        {"text": " la la la la la la la la", "no_speech_prob": 0.1, "avg_logprob": -0.5, "compression_ratio": 3.1},
    ]
    assert filter_whisper_segments(segments) == "Hello, do you have chargers?"


def test_whisper_segments_all_noise_returns_empty_and_missing_data_returns_none():
    noise = [{"text": " Bye.", "no_speech_prob": 0.97, "avg_logprob": -0.9, "compression_ratio": 0.8}]
    assert filter_whisper_segments(noise) == ""
    assert filter_whisper_segments(None) is None
    assert filter_whisper_segments([]) is None


def test_whisper_segments_accept_attribute_objects():
    class Segment:
        text = " Necesito un cargador"
        no_speech_prob = 0.05
        avg_logprob = -0.3
        compression_ratio = 1.4

    assert filter_whisper_segments([Segment()]) == "Necesito un cargador"
