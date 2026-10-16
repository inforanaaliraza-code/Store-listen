from app.providers.speech_quality import (
    is_hallucinated_transcript,
    is_recent_duplicate,
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
    assert not is_hallucinated_transcript("Gracias")
    assert not is_hallucinated_transcript("¡Adiós!")


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
    assert not is_hallucinated_transcript("Necesito un cargador para iPhone")
    assert not is_hallucinated_transcript("How much is this cable?")
