from app.providers.speech_quality import (
    is_hallucinated_transcript,
    looks_like_spanish,
    normalize_language,
)


def test_rejects_thank_you_spam():
    assert is_hallucinated_transcript("Thank you. Thank you. Thank you.")
    assert is_hallucinated_transcript("thank you")
    assert is_hallucinated_transcript("Thanks for watching!")
    assert not is_hallucinated_transcript("Do you have an iPhone charger?")
    assert not is_hallucinated_transcript("Hola, necesito un cargador para mi telefono")


def test_normalize_language_en_es_only():
    assert normalize_language("en-US") == "en"
    assert normalize_language("es") == "es"
    assert normalize_language("hi") is None


def test_spanish_heuristic():
    assert looks_like_spanish("Hola, necesito un cargador")
    assert not looks_like_spanish("I need a phone charger please")
