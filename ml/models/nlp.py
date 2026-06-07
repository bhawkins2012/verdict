"""
NLP Enrichment for Reviews

Uses TextBlob (lightweight, no model download required) for MVP.
Can be swapped for a transformer model (e.g. distilbert-sentiment) in production.
"""

import re
import logging
from dataclasses import dataclass
from typing import Optional
from collections import Counter

logger = logging.getLogger(__name__)


@dataclass
class NLPResult:
    sentimentScore: float
    keyTopics: list[str]
    summaryAuto: Optional[str]


# Domain-specific topic keywords for product reviews
TOPIC_KEYWORDS = {
    "value": ["price", "worth", "value", "expensive", "cheap", "cost", "money", "budget", "afford"],
    "quality": ["quality", "build", "durable", "sturdy", "solid", "cheap", "flimsy", "premium", "material"],
    "performance": ["performance", "fast", "slow", "powerful", "speed", "efficient", "effective", "works"],
    "design": ["design", "beautiful", "ugly", "aesthetic", "look", "style", "color", "sleek", "elegant"],
    "ease-of-use": ["easy", "simple", "complicated", "confusing", "intuitive", "user-friendly", "setup", "learn"],
    "reliability": ["reliable", "broke", "failed", "consistent", "issue", "problem", "defect", "warranty"],
    "customer-service": ["support", "service", "customer", "return", "refund", "response", "help"],
    "packaging": ["packaging", "shipped", "box", "arrived", "delivery", "damaged"],
    "longevity": ["lasted", "years", "months", "weeks", "worn", "faded", "degraded", "held up", "durability"],
    "maintenance": ["clean", "maintenance", "upkeep", "repair", "replace", "filter", "parts"],
}


class NLPEnricher:
    def __init__(self):
        self.backend = "textblob"
        self._init_textblob()

    def _init_textblob(self):
        try:
            from textblob import TextBlob
            self._TextBlob = TextBlob
            logger.info("TextBlob NLP backend initialized")
        except ImportError:
            logger.warning("TextBlob not available — using rule-based fallback")
            self._TextBlob = None

    async def enrich(self, text: str) -> NLPResult:
        sentiment = self._compute_sentiment(text)
        topics = self._extract_topics(text)
        summary = self._generate_summary(text)
        return NLPResult(
            sentimentScore=round(sentiment, 3),
            keyTopics=topics[:6],
            summaryAuto=summary,
        )

    def _compute_sentiment(self, text: str) -> float:
        """
        Returns sentiment score from -1.0 (very negative) to +1.0 (very positive).
        """
        if self._TextBlob:
            blob = self._TextBlob(text)
            return float(blob.sentiment.polarity)

        # Rule-based fallback
        positive = ["great", "excellent", "love", "amazing", "perfect", "best", "good",
                    "recommend", "worth", "solid", "impressed", "satisfied", "happy"]
        negative = ["bad", "terrible", "awful", "broke", "failed", "disappointed",
                    "waste", "poor", "horrible", "regret", "avoid", "issue", "problem"]

        words = text.lower().split()
        pos = sum(1 for w in words if any(p in w for p in positive))
        neg = sum(1 for w in words if any(n in w for n in negative))
        total = pos + neg
        if total == 0:
            return 0.0
        return (pos - neg) / total

    def _extract_topics(self, text: str) -> list[str]:
        """Extract relevant product review topics from the text."""
        text_lower = text.lower()
        topic_scores: Counter = Counter()

        for topic, keywords in TOPIC_KEYWORDS.items():
            count = sum(1 for kw in keywords if kw in text_lower)
            if count > 0:
                topic_scores[topic] = count

        return [topic for topic, _ in topic_scores.most_common(6)]

    def _generate_summary(self, text: str) -> Optional[str]:
        """
        Generate a brief summary of the review.
        For MVP, extract the first meaningful sentence.
        In production, replace with a summarization model.
        """
        if not text:
            return None

        sentences = re.split(r'[.!?]+', text.strip())
        sentences = [s.strip() for s in sentences if len(s.strip()) > 20]

        if not sentences:
            return None

        # Return the most informative sentence (longest under 200 chars)
        candidates = [s for s in sentences[:5] if len(s) < 200]
        if not candidates:
            return sentences[0][:200]

        return max(candidates, key=len)
