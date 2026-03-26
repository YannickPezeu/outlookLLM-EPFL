"""Wrapper around LLM APIs — supports Gemini (default) and Anthropic."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

# Defaults
DEFAULT_MODEL = "gemini-2.5-flash-lite"
DEFAULT_BACKEND = "gemini"  # "gemini" or "anthropic"
MAX_RETRIES = 3
RETRY_DELAY = 2  # seconds

# Pricing per million tokens
PRICING = {
    "gemini": {"input": 0.10, "output": 0.40},
    "anthropic": {"input": 0.80, "output": 4.00},
}


class LLMClient:
    """Thin wrapper over Gemini or Anthropic APIs."""

    def __init__(self, model: str | None = None, backend: str | None = None):
        self.backend = backend or DEFAULT_BACKEND
        self.model = model or DEFAULT_MODEL
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_calls = 0

        if self.backend == "gemini":
            self._init_gemini()
        elif self.backend == "anthropic":
            self._init_anthropic()
        else:
            raise ValueError(f"Unknown backend: {self.backend}")

    def _init_gemini(self):
        from google import genai
        api_key = os.environ.get("GOOGLE_AI_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "GOOGLE_AI_API_KEY not set. Export it or add it to a .env file."
            )
        self.client = genai.Client(api_key=api_key)

    def _init_anthropic(self):
        import anthropic
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY not set. Export it or add it to a .env file."
            )
        self.client = anthropic.Anthropic(api_key=api_key)

    # ------------------------------------------------------------------
    def chat(
        self,
        system: str,
        user: str,
        *,
        temperature: float = 0.7,
        max_tokens: int = 1024,
    ) -> str:
        """Send a single system+user message and return the assistant text."""
        if self.backend == "gemini":
            return self._chat_gemini(system, user, temperature=temperature, max_tokens=max_tokens)
        else:
            return self._chat_anthropic(system, user, temperature=temperature, max_tokens=max_tokens)

    def _chat_gemini(self, system: str, user: str, *, temperature: float, max_tokens: int) -> str:
        from google import genai
        from google.genai import types

        for attempt in range(MAX_RETRIES):
            try:
                response = self.client.models.generate_content(
                    model=self.model,
                    contents=user,
                    config=types.GenerateContentConfig(
                        system_instruction=system,
                        temperature=temperature,
                        max_output_tokens=max_tokens,
                    ),
                )
                # Track tokens
                if response.usage_metadata:
                    self.total_input_tokens += response.usage_metadata.prompt_token_count or 0
                    self.total_output_tokens += response.usage_metadata.candidates_token_count or 0
                self.total_calls += 1
                return response.text
            except Exception as e:
                err_str = str(e)
                if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                    wait = RETRY_DELAY * (attempt + 1) * 2  # longer waits for Gemini
                    log.warning("Rate limited, waiting %ds...", wait)
                    time.sleep(wait)
                elif attempt < MAX_RETRIES - 1:
                    log.warning("API error: %s -- retrying...", e)
                    time.sleep(RETRY_DELAY)
                else:
                    raise
        raise RuntimeError("Max retries exceeded")

    def _chat_anthropic(self, system: str, user: str, *, temperature: float, max_tokens: int) -> str:
        import anthropic

        for attempt in range(MAX_RETRIES):
            try:
                response = self.client.messages.create(
                    model=self.model,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    system=system,
                    messages=[{"role": "user", "content": user}],
                )
                self.total_input_tokens += response.usage.input_tokens
                self.total_output_tokens += response.usage.output_tokens
                self.total_calls += 1
                return response.content[0].text
            except anthropic.RateLimitError:
                wait = RETRY_DELAY * (attempt + 1)
                log.warning("Rate limited, waiting %ds...", wait)
                time.sleep(wait)
            except anthropic.APIError as e:
                if attempt < MAX_RETRIES - 1:
                    log.warning("API error: %s -- retrying...", e)
                    time.sleep(RETRY_DELAY)
                else:
                    raise
        raise RuntimeError("Max retries exceeded")

    # ------------------------------------------------------------------
    def chat_json(
        self,
        system: str,
        user: str,
        *,
        temperature: float = 0.4,
        max_tokens: int = 1024,
    ) -> Any:
        """Like chat() but parse the response as JSON. Retries on parse failure."""
        for attempt in range(MAX_RETRIES):
            raw = self.chat(
                system, user, temperature=temperature, max_tokens=max_tokens
            )
            # Strip markdown fences if present
            cleaned = raw.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[-1]
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3]
                cleaned = cleaned.strip()
            try:
                return json.loads(cleaned)
            except json.JSONDecodeError:
                for start_char, end_char in [("{", "}"), ("[", "]")]:
                    start = cleaned.find(start_char)
                    end = cleaned.rfind(end_char)
                    if start != -1 and end != -1 and end > start:
                        try:
                            return json.loads(cleaned[start : end + 1])
                        except json.JSONDecodeError:
                            continue
                if attempt < MAX_RETRIES - 1:
                    log.warning(
                        "JSON parse failed (attempt %d), retrying. Raw: %s",
                        attempt + 1,
                        raw[:200],
                    )
                else:
                    log.error("JSON parse failed after %d attempts. Raw: %s", MAX_RETRIES, raw[:500])
                    raise ValueError(f"Could not parse JSON from LLM response: {raw[:200]}")

    # ------------------------------------------------------------------
    def usage_summary(self) -> str:
        pricing = PRICING.get(self.backend, PRICING["gemini"])
        cost_in = self.total_input_tokens * pricing["input"] / 1_000_000
        cost_out = self.total_output_tokens * pricing["output"] / 1_000_000
        return (
            f"LLM usage ({self.backend}/{self.model}): {self.total_calls} calls, "
            f"{self.total_input_tokens:,} input tokens (${cost_in:.3f}), "
            f"{self.total_output_tokens:,} output tokens (${cost_out:.3f}), "
            f"total ${cost_in + cost_out:.3f}"
        )
